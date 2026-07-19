import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const options = parseArgs(process.argv.slice(2))
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'swm-snapshot-bench-'))
const results = []
const activeServers = new Set()

try {
  for (let run = 1; run <= options.runs; run++) {
    const port = options.port + run - 1
    const metricsPath = path.join(temporaryDirectory, `run-${run}.json`)
    const server = startServer(port, metricsPath)

    await server.ready
    await runLoad(port, options.warmup)
    await fetch(`http://127.0.0.1:${port}/__reset`).then((response) => {
      if (!response.ok) {
        throw new Error(`metrics reset failed: ${response.status}`)
      }

      return response.text()
    })

    const load = await runLoad(port, options.duration)

    server.process.kill('SIGTERM')
    await server.exited

    const runtime = JSON.parse(fs.readFileSync(metricsPath, 'utf8'))

    if (load.errors !== 0) {
      throw new Error(`snapshot load reported ${load.errors} errors`)
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
  for (const server of activeServers) {
    server.kill('SIGTERM')
  }

  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
}

function parseArgs(argv) {
  const parsed = {
    binding: path.join(root, 'lib/index.js'),
    output: '',
    label: 'current',
    port: 47_000 + (process.pid % 1_000),
    runs: 3,
    connections: 64,
    pipelining: 1,
    headerVariants: 24,
    warmup: 3,
    duration: 10,
    workers: Math.min(4, os.availableParallelism())
  }

  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    const key = name?.startsWith('--') ? name.slice(2) : ''

    if (!value || !(key in parsed)) {
      throw new Error(`invalid argument: ${name}`)
    }

    parsed[key] = ['binding', 'output', 'label'].includes(key) ? value : Number(value)
  }

  for (const key of ['port', 'runs', 'connections', 'pipelining', 'headerVariants', 'warmup', 'duration', 'workers']) {
    if (!Number.isInteger(parsed[key]) || parsed[key] <= 0) {
      throw new Error(`--${key} must be a positive integer`)
    }
  }

  return parsed
}

function startServer(port, metricsPath) {
  const child = spawn(process.execPath, ['--expose-gc', path.join(root, 'scripts/bench-snapshot-server.js')], {
    cwd: root,
    env: {
      ...process.env,
      SWM_SNAPSHOT_BENCH_BINDING: path.resolve(options.binding),
      SWM_SNAPSHOT_BENCH_METRICS: metricsPath,
      SWM_SNAPSHOT_BENCH_PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  activeServers.add(child)
  let stderr = ''

  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  child.once('exit', () => activeServers.delete(child))

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server readiness timed out: ${stderr}`)), 10_000)

    child.stdout.on('data', (chunk) => {
      if (!chunk.toString().includes('ready ')) {
        return
      }

      clearTimeout(timer)
      resolve()
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`server exited before readiness (${code}): ${stderr}`))
    })
  })
  const exited = new Promise((resolve, reject) => {
    child.once('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`server exited with ${code}: ${stderr}`))
      }
    })
  })

  return { process: child, ready, exited }
}

async function runLoad(port, duration) {
  const { stdout } = await execFileAsync(process.execPath, [
    path.join(root, 'scripts/profile-http-raw-load.js'),
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

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}
