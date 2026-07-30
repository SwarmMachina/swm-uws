import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { getFreePort, parseArgs } from '@swarmmachina/benchkit/orchestration'
import { median } from '@swarmmachina/benchkit/statistics'

import { SnapshotBenchmarkServerProcess } from './snapshot-benchmark-server-process.js'

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const options = parseCommandLine(process.argv)
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'swm-snapshot-bench-'))
const results = []
const activeServers = new Set()

try {
  for (let run = 1; run <= options.runs; run++) {
    const port = options.port === null ? await getFreePort() : options.port + run - 1
    const metricsPath = path.join(temporaryDirectory, `run-${run}.json`)
    const server = new SnapshotBenchmarkServerProcess({
      binding: options.binding,
      metricsPath,
      mode: options.mode,
      port,
      root
    })

    activeServers.add(server)
    await server.start()
    await runLoad(port, options.warmup)
    await fetch(`http://127.0.0.1:${port}/__reset`).then((response) => {
      if (!response.ok) {
        throw new Error(`metrics reset failed: ${response.status}`)
      }

      return response.text()
    })

    const load = await runLoad(port, options.duration)

    await server.stop()
    activeServers.delete(server)

    const runtime = JSON.parse(fs.readFileSync(metricsPath, 'utf8'))

    if (load.requests.total === 0) {
      throw new Error('snapshot load completed zero requests')
    }

    if (load.errors !== 0) {
      throw new Error(`snapshot load reported ${load.errors} errors`)
    }

    if (runtime.mode !== options.mode) {
      throw new Error(`snapshot server ran ${runtime.mode}, expected ${options.mode}`)
    }

    if (runtime.snapshotRequests < load.requests.total) {
      throw new Error(
        `server observed ${runtime.snapshotRequests} snapshots for ${load.requests.total} completed requests`
      )
    }

    const result = { run, load, runtime }

    results.push(result)
    process.stderr.write(
      `run ${run}/${options.runs}: ${load.requests.average.toFixed(0)} req/s, ` +
        `p95=${load.latency.p95.toFixed(3)}ms, p99=${load.latency.p99.toFixed(3)}ms, ` +
        `ELU=${runtime.eluPct.toFixed(2)}%\n`
    )
  }

  const report = {
    label: options.label,
    node: process.versions.node,
    parameters: {
      mode: options.mode,
      runs: options.runs,
      connections: options.connections,
      pipelining: options.pipelining,
      headerVariants: options.headerVariants,
      warmupSeconds: options.warmup,
      durationSeconds: options.duration,
      workers: options.workers
    },
    summary: summarize(results),
    results
  }
  const json = `${JSON.stringify(report, null, 2)}\n`

  if (options.output) {
    fs.writeFileSync(path.resolve(options.output), json)
  }

  process.stdout.write(json)
} finally {
  await Promise.allSettled([...activeServers].map((server) => server.stop()))

  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
}

function parseCommandLine(argv) {
  const parsed = parseArgs(
    argv,
    {
      binding: path.join(root, 'lib/index.js'),
      mode: 'snapshot',
      output: '',
      label: 'current',
      port: null,
      runs: 3,
      connections: 64,
      pipelining: 1,
      headerVariants: 24,
      warmup: 3,
      duration: 10,
      workers: Math.min(4, os.availableParallelism())
    },
    {
      '--binding': (out, value) => assignString(out, 'binding', '--binding', value),
      '--mode': (out, value) => assignString(out, 'mode', '--mode', value),
      '--output': (out, value) => assignString(out, 'output', '--output', value),
      '--label': (out, value) => assignString(out, 'label', '--label', value),
      '--port': (out, value) => assignNumber(out, 'port', '--port', value),
      '--runs': (out, value) => assignNumber(out, 'runs', '--runs', value),
      '--connections': (out, value) => assignNumber(out, 'connections', '--connections', value),
      '--pipelining': (out, value) => assignNumber(out, 'pipelining', '--pipelining', value),
      '--headerVariants': (out, value) => assignNumber(out, 'headerVariants', '--headerVariants', value),
      '--warmup': (out, value) => assignNumber(out, 'warmup', '--warmup', value),
      '--duration': (out, value) => assignNumber(out, 'duration', '--duration', value),
      '--workers': (out, value) => assignNumber(out, 'workers', '--workers', value)
    },
    { strict: true, offset: 2 }
  )

  if (parsed.mode !== 'snapshot' && parsed.mode !== 'forEach') {
    throw new Error('--mode must be snapshot or forEach')
  }

  for (const key of ['port', 'runs', 'connections', 'pipelining', 'headerVariants', 'warmup', 'duration', 'workers']) {
    if (key === 'port' && parsed.port === null) {
      continue
    }

    if (!Number.isInteger(parsed[key]) || parsed[key] <= 0) {
      throw new Error(`--${key} must be a positive integer`)
    }
  }

  if (parsed.port !== null && parsed.port + parsed.runs - 1 > 65_535) {
    throw new Error('--port range exceeds 65535')
  }

  return parsed
}

function assignString(out, key, name, value) {
  if (!value) {
    throw new TypeError(`${name} requires a value`)
  }

  out[key] = value
}

function assignNumber(out, key, name, value) {
  assignString(out, key, name, value)
  out[key] = Number(value)
}

async function runLoad(port, duration) {
  const { stdout } = await execFileAsync(process.execPath, [
    path.join(root, 'scripts/snapshot-header-load.js'),
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--path',
    '/snapshot',
    '--connections',
    String(options.connections),
    '--pipelining',
    String(options.pipelining),
    '--headerVariants',
    String(options.headerVariants),
    '--duration',
    String(duration),
    '--workers',
    String(options.workers)
  ])

  return JSON.parse(stdout)
}

function summarize(runResults) {
  return {
    requestsPerSecondMedian: median(runResults.map(({ load }) => load.requests.average)),
    latencyP95MsMedian: median(runResults.map(({ load }) => load.latency.p95)),
    latencyP99MsMedian: median(runResults.map(({ load }) => load.latency.p99)),
    eluPctMedian: median(runResults.map(({ runtime }) => runtime.eluPct)),
    heapUsedPeakBytesMedian: median(runResults.map(({ runtime }) => runtime.heapUsedPeakBytes)),
    heapUsedDeltaBytesMedian: median(runResults.map(({ runtime }) => runtime.heapUsedDeltaBytes)),
    sampledAllocationBytesPerRequestMedian: median(
      runResults.map(({ runtime }) => runtime.sampledAllocationBytesPerRequest)
    )
  }
}
