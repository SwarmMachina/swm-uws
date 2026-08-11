import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { relativeMetricGuard } from '@swarmmachina/benchkit/regression'
import { metricMedians, pairedComparison } from '@swarmmachina/benchkit/statistics'

if (process.argv.length !== 5) {
  throw new Error('usage: collect-pgo-benchmark.js <raw-dir> <out-dir> <candidate-binary>')
}

const [, , rawDirectoryValue, outputDirectoryValue, candidateBinaryValue] = process.argv
const rawDirectory = resolve(rawDirectoryValue)
const outputDirectory = resolve(outputDirectoryValue)
const candidateBinary = resolve(candidateBinaryValue)
const referenceBinding = resolve(requiredEnvironment('SWM_BENCH_REFERENCE'))
const runCount = numberEnvironment('SWM_BENCH_RUNS', 6)
const packageJson = readJson(resolve('package.json'))
const referencePackageJson = readJson(resolve(dirname(referenceBinding), 'package.json'))
const runs = []

for (let round = 1; round <= runCount; round++) {
  const swm = readJson(resolve(rawDirectory, `round-${round}-swm`, 'summary.json'))
  const uws = readJson(resolve(rawDirectory, `round-${round}-uws`, 'summary.json'))

  runs.push({
    round,
    order: round % 2 ? 'swm/uws' : 'uws/swm',
    swmRps: swm.requestsPerSecond,
    uwsRps: uws.requestsPerSecond,
    swmLatencyMs: latency(swm),
    uwsLatencyMs: latency(uws),
    swmRuntime: swm.runtime,
    uwsRuntime: uws.runtime,
    swmErrors: readJson(resolve(rawDirectory, `round-${round}-swm`, 'load.json')).errors,
    uwsErrors: readJson(resolve(rawDirectory, `round-${round}-uws`, 'load.json')).errors
  })
}

const hardware = readJson(resolve(rawDirectory, 'hardware', 'summary.json'))
const binary = readFileSync(candidateBinary)
const binaryStat = statSync(candidateBinary)
const fileDescription = commandOutput('file', [candidateBinary])
const dynamicDependencies = parseDynamicDependencies(commandOutput('ldd', [candidateBinary]))
const upstreamVersions = readFileSync(resolve('vendor/VERSIONS.md'), 'utf8')
const upstreamCommit = /v20\.69\.0` \/ `([0-9a-f]{40})`/.exec(upstreamVersions)?.[1]
const throughputComparison = pairedComparison(runs.map((run) => ({ candidate: run.swmRps, reference: run.uwsRps })))
const swmRpsMedian = throughputComparison.medianCandidate
const uwsRpsMedian = throughputComparison.medianReference
const swmLatencyMedian = metricMedians(runs.map((run) => run.swmLatencyMs))
const uwsLatencyMedian = metricMedians(runs.map((run) => run.uwsLatencyMs))
const swmRuntimeMedian = metricMedians(runs.map((run) => run.swmRuntime))
const uwsRuntimeMedian = metricMedians(runs.map((run) => run.uwsRuntime))

if (!upstreamCommit) {
  throw new Error('failed to read the pinned upstream release commit')
}

const guard = performanceGuard({
  swmRpsMedian,
  uwsRpsMedian,
  swmLatencyMedian,
  uwsLatencyMedian,
  swmRuntimeMedian,
  uwsRuntimeMedian,
  errors: runs.reduce((sum, run) => sum + run.swmErrors + run.uwsErrors, 0)
})
const metadata = {
  environment: {
    package: `${packageJson.name} ${packageJson.version}`,
    upstream: `uWebSockets.js ${referencePackageJson.version}`,
    upstreamCommit,
    node: process.versions.node,
    abi: Number(process.versions.modules),
    os: `Linux ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model || 'unknown',
    logicalCpus: os.availableParallelism(),
    ramGiB: Math.round(os.totalmem() / 1024 ** 3)
  },
  build: {
    profile: process.env.SWM_PGO_PROFILE || 'balanced',
    compiler: process.env.SWM_BENCH_COMPILER || 'Clang 18',
    lto: true,
    march: null,
    mtune: null,
    sha256: createHash('sha256').update(binary).digest('hex'),
    sizeBytes: binaryStat.size,
    stripped: /stripped/.test(fileDescription),
    dynamicDependencies
  },
  parameters: {
    runs: runCount,
    order: 'balanced AB/BA',
    connections: numberEnvironment('SWM_BENCH_CONNECTIONS', 100),
    pipelining: numberEnvironment('SWM_BENCH_PIPELINING', 10),
    warmupSeconds: numberEnvironment('SWM_BENCH_WARMUP', 2),
    durationSeconds: numberEnvironment('SWM_BENCH_DURATION', 5),
    serverCpu: numberEnvironment('SWM_BENCH_SERVER_CPU', 2),
    clientCpus: process.env.SWM_BENCH_CLIENT_CPUS || '3-6',
    clientWorkers: numberEnvironment('SWM_BENCH_CLIENT_WORKERS', 4)
  },
  measurements: {
    swmLatencyMsMedian: swmLatencyMedian,
    uwsLatencyMsMedian: uwsLatencyMedian,
    swmRuntimeMedian,
    uwsRuntimeMedian,
    errors: guard.errors
  },
  guard,
  hardwareStat: {
    source: process.env.SWM_BENCH_HARDWARE_SOURCE || 'independent stat-only run',
    requests: hardware.requests,
    requestsPerSecond: hardware.requestsPerSecond,
    latencyMs: {
      p95: hardware.latencyP95Ms,
      p97_5: hardware.latencyP97_5Ms,
      p99: hardware.latencyP99Ms
    },
    perRequest: {
      cycles: hardware.perRequest.cycles ?? null,
      instructions: hardware.perRequest.instructions ?? null,
      branches: hardware.perRequest.branches ?? null,
      branchMisses: hardware.perRequest['branch-misses'] ?? null,
      cacheReferences: hardware.perRequest['cache-references'] ?? null,
      cacheMisses: hardware.perRequest['cache-misses'] ?? null
    }
  }
}

writeJson(resolve(outputDirectory, 'runs.json'), runs)
writeJson(resolve(outputDirectory, 'metadata.json'), metadata)

function requiredEnvironment(name) {
  const value = process.env[name]

  if (!value) {
    throw new Error(`${name} is required`)
  }

  return value
}

function numberEnvironment(name, fallback) {
  const value = Number(process.env[name] || fallback)

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be positive`)
  }

  return value
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function latency(summary) {
  return {
    p95: summary.latencyP95Ms,
    p97_5: summary.latencyP97_5Ms,
    p99: summary.latencyP99Ms
  }
}

function performanceGuard(input) {
  const thresholds = {
    maxThroughputRegressionPct: numberEnvironment('SWM_BENCH_MAX_THROUGHPUT_REGRESSION_PCT', 5),
    maxLatencyRegressionPct: numberEnvironment('SWM_BENCH_MAX_LATENCY_REGRESSION_PCT', 20),
    latencySlackMs: numberEnvironment('SWM_BENCH_LATENCY_SLACK_MS', 0.25),
    maxRssRegressionPct: numberEnvironment('SWM_BENCH_MAX_RSS_REGRESSION_PCT', 15),
    rssSlackMiB: numberEnvironment('SWM_BENCH_RSS_SLACK_MIB', 5)
  }
  const result = relativeMetricGuard({
    metrics: [
      {
        name: 'median throughput',
        candidate: input.swmRpsMedian,
        reference: input.uwsRpsMedian,
        direction: 'higher',
        maxRegressionPct: thresholds.maxThroughputRegressionPct
      },
      {
        name: 'median p97.5 latency',
        candidate: input.swmLatencyMedian.p97_5,
        reference: input.uwsLatencyMedian.p97_5,
        direction: 'lower',
        maxRegressionPct: thresholds.maxLatencyRegressionPct,
        absoluteSlack: thresholds.latencySlackMs
      },
      {
        name: 'median p99 latency',
        candidate: input.swmLatencyMedian.p99,
        reference: input.uwsLatencyMedian.p99,
        direction: 'lower',
        maxRegressionPct: thresholds.maxLatencyRegressionPct,
        absoluteSlack: thresholds.latencySlackMs
      },
      {
        name: 'median RSS',
        candidate: input.swmRuntimeMedian.rssBytes,
        reference: input.uwsRuntimeMedian.rssBytes,
        direction: 'lower',
        maxRegressionPct: thresholds.maxRssRegressionPct,
        absoluteSlack: thresholds.rssSlackMiB * 1024 ** 2
      }
    ]
  })
  const failures = [...result.failures]

  if (input.errors) {
    failures.unshift(`request errors: ${input.errors}`)
  }

  return {
    status: failures.length ? 'fail' : 'pass',
    thresholds,
    errors: input.errors,
    failures,
    metrics: result.rows
  }
}

function commandOutput(command, arguments_) {
  const result = spawnSync(command, arguments_, { encoding: 'utf8' })

  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr}`)
  }

  return result.stdout
}

function parseDynamicDependencies(lddOutput) {
  const dependencies = new Set()

  for (const line of lddOutput.split('\n')) {
    const name = /^\s*([^\s]+)\s+=>/.exec(line)?.[1]

    if (name) {
      dependencies.add(name)
    }

    const loader = /^\s*(\/[^\s]+)/.exec(line)?.[1]

    if (loader) {
      dependencies.add(loader.split('/').at(-1))
    }
  }

  return [...dependencies].sort()
}
