import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { runHttp1Load } from '@swarmmachina/benchkit/load/http1'

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
  for (let block = 1; block <= options.blocks; block++) {
    const baseline = ['baseline', options.baseline]
    const candidate = ['candidate', options.candidate]
    const schedule =
      block % 2 === 1 ? [baseline, candidate, candidate, baseline] : [candidate, baseline, baseline, candidate]

    for (let position = 0; position < schedule.length; position++) {
      const [role, binding] = schedule[position]
      const result = await runSide({ binding, role, block, position })

      results.push(result)
      process.stderr.write(
        `block=${block} position=${position + 1} ${role.padEnd(9)} ` +
          `${Math.round(result.requestsPerSecond)} req/s ` +
          `p95=${result.p95Ms.toFixed(3)}ms p99=${result.p99Ms.toFixed(3)}ms ` +
          `ELU=${result.runtime.eluPct.toFixed(1)}% RSS=${mib(result.runtime.rssPeakBytes).toFixed(1)}MiB\n`
      )
    }
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
      ? ['taskset', ['-c', String(options.serverCpu), process.execPath, 'scripts/profile-http-raw-server.js']]
      : [process.execPath, ['scripts/profile-http-raw-server.js']]
  const child = spawn(serverCommand[0], serverCommand[1], {
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
    const port = await waitForReady(child)
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

    child.kill('SIGTERM')
    await waitForExit(child)

    return {
      block,
      position: position + 1,
      role,
      requestsPerSecond: load.requests.averagePerSecond,
      p95Ms: load.latencyMs.p95Ms,
      p99Ms: load.latencyMs.p99Ms,
      runtime: JSON.parse(await readFile(metrics, 'utf8'))
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await waitForExit(child)
    }
  }
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const onExit = (code, signal) => reject(new Error(`benchmark server exited before ready: ${code ?? signal}`))

    child.once('exit', onExit)
    child.once('error', reject)
    child.on('message', (message) => {
      if (message?.type !== 'ready') {
        return
      }

      child.off('exit', onExit)
      resolve(message.port)
    })
  })
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    child.once('exit', resolve)
    child.once('error', reject)
  })
}

function summarize() {
  const baseline = medians(results.filter((result) => result.role === 'baseline'))
  const candidate = medians(results.filter((result) => result.role === 'candidate'))
  const pairedThroughputDeltaPct = median(
    Array.from({ length: options.blocks }, (_, index) => {
      const block = results.filter((result) => result.block === index + 1)
      const baselineRps = mean(
        block.filter((result) => result.role === 'baseline').map((result) => result.requestsPerSecond)
      )
      const candidateRps = mean(
        block.filter((result) => result.role === 'candidate').map((result) => result.requestsPerSecond)
      )

      return percent(candidateRps, baselineRps)
    })
  )

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
      pairedThroughputDeltaPct,
      deltaPct: {
        requestsPerSecond: percent(candidate.requestsPerSecond, baseline.requestsPerSecond),
        p95Ms: percent(candidate.p95Ms, baseline.p95Ms),
        p99Ms: percent(candidate.p99Ms, baseline.p99Ms),
        eluPct: percent(candidate.eluPct, baseline.eluPct),
        rssPeakBytes: percent(candidate.rssPeakBytes, baseline.rssPeakBytes)
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

function median(values) {
  const sorted = values.toSorted((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function percent(candidate, baseline) {
  return (candidate / baseline - 1) * 100
}

function mib(bytes) {
  return bytes / 1024 ** 2
}

function renderReport(artifact) {
  const { baseline, candidate, deltaPct } = artifact.medians

  return `# Native binding ABBA benchmark

Node ${artifact.environment.node}; ${artifact.parameters.blocks} alternating ABBA/BAAB blocks; ${artifact.parameters.method} ${artifact.parameters.path}; body ${artifact.parameters.bodySize} bytes; connections ${artifact.parameters.connections}; pipelining ${artifact.parameters.pipelining}; warmup ${artifact.parameters.warmupMs} ms; duration ${artifact.parameters.durationMs} ms; workers ${artifact.parameters.workers}; server CPU ${artifact.parameters.serverCpu < 0 ? 'unrestricted' : artifact.parameters.serverCpu}.

| Metric | Baseline | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Throughput | ${Math.round(baseline.requestsPerSecond)} req/s | ${Math.round(candidate.requestsPerSecond)} req/s | ${signed(deltaPct.requestsPerSecond)} |
| p95 | ${baseline.p95Ms.toFixed(3)} ms | ${candidate.p95Ms.toFixed(3)} ms | ${signed(deltaPct.p95Ms)} |
| p99 | ${baseline.p99Ms.toFixed(3)} ms | ${candidate.p99Ms.toFixed(3)} ms | ${signed(deltaPct.p99Ms)} |
| Target ELU | ${baseline.eluPct.toFixed(1)}% | ${candidate.eluPct.toFixed(1)}% | ${signed(deltaPct.eluPct)} |
| Target RSS peak | ${mib(baseline.rssPeakBytes).toFixed(1)} MiB | ${mib(candidate.rssPeakBytes).toFixed(1)} MiB | ${signed(deltaPct.rssPeakBytes)} |
| Target heap peak | ${mib(baseline.heapUsedPeakBytes).toFixed(1)} MiB | ${mib(candidate.heapUsedPeakBytes).toFixed(1)} MiB | — |

Paired throughput delta across ABBA blocks: **${signed(artifact.medians.pairedThroughputDeltaPct)}**.

Local runs are diagnostic. The release regression gate remains the isolated Linux x86-64 PGO/LTO comparison.
`
}

function signed(value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function parseOptions(arguments_) {
  const values = {
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
  }

  for (let index = 0; index < arguments_.length; index++) {
    const name = arguments_[index]
    const key = name.startsWith('--') ? name.slice(2) : ''

    if (!key || !(key in values) || index + 1 === arguments_.length) {
      throw new Error(`unknown or incomplete option: ${name}`)
    }

    const value = arguments_[++index]

    if (['baseline', 'candidate', 'output'].includes(key)) {
      values[key] = path.resolve(value)
    } else if (['method', 'path'].includes(key)) {
      values[key] = value
    } else {
      values[key] = Number(value)
    }
  }

  if (!values.baseline) {
    throw new Error('--baseline is required')
  }

  if (!Number.isInteger(values.blocks) || values.blocks <= 0) {
    throw new Error('--blocks must be a positive integer')
  }

  for (const key of ['connections', 'pipelining', 'warmupMs', 'durationMs', 'workers']) {
    if (!Number.isInteger(values[key]) || values[key] <= 0) {
      throw new Error(`--${key} must be a positive integer`)
    }
  }

  if (!Number.isInteger(values.serverCpu) || values.serverCpu < -1) {
    throw new Error('--serverCpu must be -1 or a non-negative integer')
  }

  values.method = values.method.toUpperCase()

  if (values.method !== 'GET' && values.method !== 'POST') {
    throw new Error('--method must be GET or POST')
  }

  if (!values.path.startsWith('/')) {
    throw new Error('--path must start with /')
  }

  if (!Number.isInteger(values.bodySize) || values.bodySize < 0) {
    throw new Error('--bodySize must be a non-negative integer')
  }

  return values
}
