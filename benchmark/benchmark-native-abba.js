import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { runHttp1Load } from '@swarmmachina/benchkit/load/http1'
import { parseArgs } from '@swarmmachina/benchkit/orchestration'
import { median, percentDelta } from '@swarmmachina/benchkit/statistics'
import { bytesToMiB } from '@swarmmachina/benchkit/units'

import { benchmarkBlockSchedule } from './lib/benchmark-block-schedule.js'
import { BenchmarkTargetProcess } from './lib/benchmark-target-process.js'
import { pairedThroughputComparison } from './lib/paired-throughput-comparison.js'
import {
  cpuIndexOption,
  expandEqualsArguments,
  nonNegativeIntegerOption,
  positiveIntegerOption,
  requiredOption
} from './lib/option-values.js'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const options = parseOptions(process.argv.slice(2))
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'swm-uws-native-abba-'))
const results = []

process.stderr.write(
  `native ABBA benchmark: node=${process.version} blocks=${options.blocks} ` +
    `connections=${options.connections} pipelining=${options.pipelining} ` +
    `warmup=${options.warmupMs}ms duration=${options.durationMs}ms workers=${options.workers}\n`
)

try {
  const schedule = benchmarkBlockSchedule(options.blocks, {
    baseline: options.baseline,
    candidate: options.candidate
  })

  for (const { block, position, role, value: binding } of schedule) {
    const result = await runSide({ binding, role, block, position })

    results.push(result)
    process.stderr.write(
      `block=${block} position=${position} ${role.padEnd(9)} ` +
        `${Math.round(result.requestsPerSecond)} req/s ` +
        `p95=${result.p95Ms.toFixed(3)}ms p99=${result.p99Ms.toFixed(3)}ms ` +
        `ELU=${result.runtime.eluPct.toFixed(1)}% RSS=${bytesToMiB(result.runtime.rssPeakBytes).toFixed(1)}MiB\n`
    )
  }

  const artifact = summarize()
  const output = path.resolve(root, options.output)

  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`)
  await writeFile(output.replace(/\.json$/, '.md'), renderReport(artifact))
  process.stdout.write(`${output.replace(/\.json$/, '.md')}\n`)
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}

async function runSide({ binding, role, block, position }) {
  const metrics = path.join(temporaryDirectory, `${block}-${position}-${role}.json`)
  const serverCommand =
    process.platform === 'linux' && options.serverCpu >= 0
      ? ['taskset', ['-c', String(options.serverCpu), process.execPath, 'benchmark/pgo/profile-http-raw-server.js']]
      : [process.execPath, ['benchmark/pgo/profile-http-raw-server.js']]
  const target = await BenchmarkTargetProcess.start({
    command: serverCommand[0],
    arguments_: serverCommand[1],
    cwd: root,
    env: {
      ...process.env,
      SWM_PROFILE_BINDING: binding,
      SWM_PROFILE_METRICS: metrics,
      SWM_PROFILE_PORT: '0'
    },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc']
  })

  try {
    const { port } = target.ready
    const loadOptions = {
      url: `http://127.0.0.1:${port}${options.path}`,
      method: options.method,
      body: options.bodySize ? Buffer.alloc(options.bodySize, 0x61) : undefined,
      connections: options.connections,
      pipelining: options.pipelining,
      workers: options.workers
    }

    await runHttp1Load({ ...loadOptions, durationMs: options.warmupMs })
    await fetch(`http://127.0.0.1:${port}/__swm_profile_reset`)
    const load = await runHttp1Load({ ...loadOptions, durationMs: options.durationMs })

    if (load.errors.total || load.non2xx) {
      throw new Error(`${role} block ${block} failed: errors=${load.errors.total}, non2xx=${load.non2xx}`)
    }

    await target.stop()

    return {
      block,
      position,
      role,
      requestsPerSecond: load.requests.averagePerSecond,
      p95Ms: load.latencyMs.p95Ms,
      p99Ms: load.latencyMs.p99Ms,
      runtime: JSON.parse(await readFile(metrics, 'utf8'))
    }
  } finally {
    await target.stop()
  }
}

function summarize() {
  const baseline = medians(results.filter((result) => result.role === 'baseline'))
  const candidate = medians(results.filter((result) => result.role === 'candidate'))
  const pairedThroughput = pairedThroughputComparison(results, options.blocks)

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.availableParallelism()
    },
    parameters: options,
    medians: {
      baseline,
      candidate,
      pairedThroughputDeltaPct: pairedThroughput.medianPairedDeltaPct,
      pairedThroughputIqrPct: [pairedThroughput.iqr.q1, pairedThroughput.iqr.q3],
      pairedThroughputWinningBlocks: pairedThroughput.winningPairs,
      deltaPct: {
        requestsPerSecond: percentDelta(candidate.requestsPerSecond, baseline.requestsPerSecond),
        p95Ms: percentDelta(candidate.p95Ms, baseline.p95Ms),
        p99Ms: percentDelta(candidate.p99Ms, baseline.p99Ms),
        eluPct: percentDelta(candidate.eluPct, baseline.eluPct),
        rssPeakBytes: percentDelta(candidate.rssPeakBytes, baseline.rssPeakBytes)
      }
    },
    results
  }
}

function medians(values) {
  return {
    requestsPerSecond: median(values.map((value) => value.requestsPerSecond)),
    p95Ms: median(values.map((value) => value.p95Ms)),
    p99Ms: median(values.map((value) => value.p99Ms)),
    eluPct: median(values.map((value) => value.runtime.eluPct)),
    rssPeakBytes: median(values.map((value) => value.runtime.rssPeakBytes)),
    heapUsedPeakBytes: median(values.map((value) => value.runtime.heapUsedPeakBytes))
  }
}

function renderReport(artifact) {
  const {
    baseline,
    candidate,
    deltaPct,
    pairedThroughputDeltaPct,
    pairedThroughputIqrPct,
    pairedThroughputWinningBlocks
  } = artifact.medians

  return `# Native binding ABBA benchmark

Node ${artifact.environment.node}; ${artifact.parameters.blocks} alternating ABBA/BAAB blocks; ${artifact.parameters.method} ${artifact.parameters.path}; body ${artifact.parameters.bodySize} bytes; connections ${artifact.parameters.connections}; pipelining ${artifact.parameters.pipelining}; warmup ${artifact.parameters.warmupMs} ms; duration ${artifact.parameters.durationMs} ms; workers ${artifact.parameters.workers}; server CPU ${artifact.parameters.serverCpu < 0 ? 'unrestricted' : artifact.parameters.serverCpu}.

| Metric | Baseline | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Throughput | ${Math.round(baseline.requestsPerSecond)} req/s | ${Math.round(candidate.requestsPerSecond)} req/s | ${signed(deltaPct.requestsPerSecond)} |
| p95 | ${baseline.p95Ms.toFixed(3)} ms | ${candidate.p95Ms.toFixed(3)} ms | ${signed(deltaPct.p95Ms)} |
| p99 | ${baseline.p99Ms.toFixed(3)} ms | ${candidate.p99Ms.toFixed(3)} ms | ${signed(deltaPct.p99Ms)} |
| Target ELU | ${baseline.eluPct.toFixed(1)}% | ${candidate.eluPct.toFixed(1)}% | ${signed(deltaPct.eluPct)} |
| Target RSS peak | ${bytesToMiB(baseline.rssPeakBytes).toFixed(1)} MiB | ${bytesToMiB(candidate.rssPeakBytes).toFixed(1)} MiB | ${signed(deltaPct.rssPeakBytes)} |
| Target heap peak | ${bytesToMiB(baseline.heapUsedPeakBytes).toFixed(1)} MiB | ${bytesToMiB(candidate.heapUsedPeakBytes).toFixed(1)} MiB | — |

Paired throughput delta across ABBA blocks: **${signed(pairedThroughputDeltaPct)}**; IQR **[${signed(pairedThroughputIqrPct[0])}, ${signed(pairedThroughputIqrPct[1])}]**; ${pairedThroughputWinningBlocks} of ${artifact.parameters.blocks} blocks favored the candidate.

Local runs are diagnostic. The release regression gate remains the isolated Linux x86-64 PGO/LTO comparison.
`
}

function signed(value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function parseOptions(arguments_) {
  const values = parseArgs(
    expandEqualsArguments(arguments_),
    {
      baseline: '',
      candidate: path.resolve(root, 'build/Release/swm_uws.node'),
      output: '/private/tmp/swm-uws-native-abba.json',
      blocks: 3,
      method: 'GET',
      path: '/base',
      bodySize: 0,
      connections: 100,
      pipelining: 10,
      warmupMs: 1_000,
      durationMs: 5_000,
      workers: Math.min(4, os.availableParallelism()),
      serverCpu: -1
    },
    {
      '--baseline': (out, value) => {
        out.baseline = path.resolve(requiredOption('--baseline', value))
      },
      '--candidate': (out, value) => {
        out.candidate = path.resolve(requiredOption('--candidate', value))
      },
      '--output': (out, value) => {
        out.output = path.resolve(requiredOption('--output', value))
      },
      '--blocks': (out, value) => {
        out.blocks = positiveIntegerOption('--blocks', value)
      },
      '--method': (out, value) => {
        out.method = requiredOption('--method', value).toUpperCase()
      },
      '--path': (out, value) => {
        out.path = requiredOption('--path', value)
      },
      '--bodySize': (out, value) => {
        out.bodySize = nonNegativeIntegerOption('--bodySize', value)
      },
      '--connections': (out, value) => {
        out.connections = positiveIntegerOption('--connections', value)
      },
      '--pipelining': (out, value) => {
        out.pipelining = positiveIntegerOption('--pipelining', value)
      },
      '--warmupMs': (out, value) => {
        out.warmupMs = positiveIntegerOption('--warmupMs', value)
      },
      '--durationMs': (out, value) => {
        out.durationMs = positiveIntegerOption('--durationMs', value)
      },
      '--workers': (out, value) => {
        out.workers = positiveIntegerOption('--workers', value)
      },
      '--serverCpu': (out, value) => {
        out.serverCpu = cpuIndexOption('--serverCpu', value)
      }
    },
    { strict: true, offset: 0 }
  )

  if (!values.baseline) {
    throw new Error('--baseline is required')
  }

  if (values.blocks < 2) {
    throw new RangeError('--blocks must be at least 2 for paired comparison')
  }

  if (values.method !== 'GET' && values.method !== 'POST') {
    throw new Error('--method must be GET or POST')
  }

  if (!values.path.startsWith('/')) {
    throw new Error('--path must start with /')
  }

  return values
}
