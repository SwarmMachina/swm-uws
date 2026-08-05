import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runHttp1Load } from '@swarmmachina/benchkit/load/http1'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const options = parseOptions(process.argv.slice(2))
const target = await startTarget()
const cells = options.quick ? quickCells() : fullCells()
const results = []

let messageId = 0

process.stderr.write(
  `request-prefetch benchmark: node=${process.version} target=${target.node} ` +
    `connections=${options.connections} pipelining=${options.pipelining} ` +
    `warmup=${options.warmupMs}ms duration=${options.durationMs}ms ` +
    `workers=${options.workers} ABBA-blocks=${options.blocks} cells=${cells.length}\n`
)

try {
  for (const cell of cells) {
    const schedule = Array.from({ length: options.blocks }, (_, block) =>
      block % 2 === 0
        ? [cell.baseline, cell.candidate, cell.candidate, cell.baseline]
        : [cell.candidate, cell.baseline, cell.baseline, cell.candidate]
    ).flat()

    for (let run = 0; run < schedule.length; run++) {
      const mode = schedule[run]
      const targetMetrics = await collectTargetMetrics(target.child, async () => {
        return runHttp1Load({
          name: `${cell.name}:${mode}`,
          url: `http://127.0.0.1:${target.port}/${mode}`,
          headers: requestHeaders(cell),
          connections: options.connections,
          pipelining: options.pipelining,
          workers: options.workers,
          warmupMs: options.warmupMs,
          durationMs: options.durationMs
        })
      })
      const result = targetMetrics.value

      if (result.errors.total || result.non2xx) {
        throw new Error(`${cell.name}:${mode} failed: errors=${result.errors.total} non2xx=${result.non2xx}`)
      }

      results.push({
        cell: cell.name,
        role: mode === cell.baseline ? 'baseline' : 'candidate',
        mode,
        run,
        requestsPerSecond: result.requests.averagePerSecond,
        p50Ms: result.latencyMs.p50Ms,
        p95Ms: result.latencyMs.p95Ms,
        p99Ms: result.latencyMs.p99Ms,
        target: targetMetrics.metrics,
        loadGenerator: {
          cpuCorePct: result.loadGenerator.cpuCorePct,
          eluPct: result.loadGenerator.maxWorkerEluPct,
          rssPeakBytes: result.loadGenerator.processMemory.rss.peakBytes,
          heapUsedPeakBytes: result.loadGenerator.workerHeapUsedPeakBytes
        }
      })
      process.stderr.write(
        `${cell.name.padEnd(34)} ${mode.padEnd(30)} ` +
          `${Math.round(result.requests.averagePerSecond).toString().padStart(9)} req/s ` +
          `p95=${result.latencyMs.p95Ms.toFixed(3)}ms p99=${result.latencyMs.p99Ms.toFixed(3)}ms ` +
          `targetELU=${targetMetrics.metrics.eluPct.toFixed(1)}%\n`
      )
    }
  }
} finally {
  target.child.send({ type: 'shutdown' })
}

const artifact = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: {
    loadNode: process.version,
    targetNode: target.node,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().map(({ model }) => model),
    availableParallelism: os.availableParallelism()
  },
  parameters: options,
  cells,
  results
}
const outputPath = path.resolve(root, options.output)

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`)
const reportPath = outputPath.replace(/\.json$/, '.md')

await writeFile(reportPath, renderReport(artifact))
process.stdout.write(`${reportPath}\n`)

function quickCells() {
  return [
    {
      name: '20h-2s-present-never-sync',
      incoming: 20,
      selected: 2,
      shape: 'present',
      baseline: 'baseline-sync',
      candidate: 'prefetch-2-never-sync'
    },
    {
      name: '20h-2s-present-materialized-sync',
      incoming: 20,
      selected: 2,
      shape: 'present',
      baseline: 'foreach-filter-sync',
      candidate: 'prefetch-2-materialized-sync'
    }
  ]
}

function fullCells() {
  const cells = []

  for (const incoming of [5, 20, 60]) {
    for (const selected of [0, 1, 2, 4, 8]) {
      for (const shape of ['present', 'absent', 'empty', 'duplicates']) {
        for (const consumer of ['never-sync', 'materialized-sync', 'never-async', 'materialized-async']) {
          const asyncConsumer = consumer.endsWith('async')
          const materialized = consumer.startsWith('materialized')

          cells.push({
            name: `${incoming}h-${selected}s-${shape}-${consumer}`,
            incoming,
            selected,
            shape,
            baseline: materialized
              ? asyncConsumer
                ? 'foreach-filter-async'
                : 'foreach-filter-sync'
              : asyncConsumer
                ? 'baseline-async'
                : 'baseline-sync',
            candidate: `prefetch-${selected}-${consumer}`
          })
        }
      }
    }
  }

  return cells
}

function requestHeaders(cell) {
  const headers = {}
  const selected = Array.from({ length: cell.selected }, (_, index) => `x-selected-${index}`)

  let filler = 0

  for (let index = 0; index < cell.incoming; index++) {
    const name = cell.shape !== 'absent' && index < selected.length ? selected[index] : `x-input-${filler++}`

    headers[name] = cell.shape === 'empty' && index < selected.length ? '' : 'value'
  }

  if (cell.shape === 'duplicates') {
    for (const name of selected) {
      headers[name] = ['first', 'second']
    }
  }

  return headers
}

function parseOptions(args) {
  const values = {
    quick: false,
    blocks: 6,
    connections: 100,
    pipelining: 10,
    workers: Math.min(4, os.availableParallelism()),
    warmupMs: 3000,
    durationMs: 10000,
    serverCpu: -1,
    output: 'benchmark/request-prefetch/results.json'
  }

  for (const argument of args) {
    if (argument === '--quick') {
      values.quick = true
    } else {
      const match = /^--([^=]+)=(.+)$/.exec(argument)

      if (!match || !(match[1] in values)) {
        throw new Error(`unknown option: ${argument}`)
      }

      values[match[1]] = match[1] === 'output' ? match[2] : Number(match[2])
    }
  }

  for (const name of ['blocks', 'connections', 'pipelining', 'workers', 'warmupMs', 'durationMs']) {
    if (!Number.isInteger(values[name]) || values[name] <= 0) {
      throw new Error(`--${name} must be a positive integer`)
    }
  }

  if (!Number.isInteger(values.serverCpu) || values.serverCpu < -1) {
    throw new Error('--serverCpu must be -1 or a non-negative integer')
  }

  return values
}

function startTarget() {
  return new Promise((resolve, reject) => {
    const targetCommand =
      process.platform === 'linux' && options.serverCpu >= 0
        ? ['taskset', ['-c', String(options.serverCpu), process.execPath, 'scripts/benchmark-prefetch-server.js']]
        : [process.execPath, ['scripts/benchmark-prefetch-server.js']]
    const child = spawn(targetCommand[0], targetCommand[1], {
      cwd: root,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    })

    child.once('error', reject)
    child.once('exit', (code) => {
      if (code && code !== 0) {
        reject(new Error(`benchmark target exited ${code}`))
      }
    })
    child.on('message', (message) => {
      if (message?.type === 'ready') {
        resolve({ child, ...message })
      }
    })
  })
}

async function collectTargetMetrics(child, run) {
  const id = ++messageId

  await requestMessage(child, { type: 'metrics:start', id }, 'metrics:started')
  const value = await run()
  const response = await requestMessage(child, { type: 'metrics:stop', id }, 'metrics:result')

  return { value, metrics: response.metrics }
}

function requestMessage(child, request, responseType) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`target did not answer ${request.type}`)), 5000)
    const onMessage = (message) => {
      if (message?.type !== responseType || message.id !== request.id) {
        return
      }

      clearTimeout(timeout)
      child.off('message', onMessage)
      resolve(message)
    }

    child.on('message', onMessage)
    child.send(request)
  })
}

function renderReport(artifact) {
  const rows = artifact.cells.map((cell) => {
    const baseline = summarize(
      artifact.results.filter((result) => result.cell === cell.name && result.role === 'baseline')
    )
    const candidate = summarize(
      artifact.results.filter((result) => result.cell === cell.name && result.role === 'candidate')
    )
    const delta = ((candidate.rps / baseline.rps - 1) * 100).toFixed(1)

    return `| ${cell.name} | ${Math.round(baseline.rps)} | ${Math.round(candidate.rps)} | ${delta}% | ${candidate.p95.toFixed(3)} | ${candidate.p99.toFixed(3)} | ${candidate.elu.toFixed(1)}% | ${candidate.rss.toFixed(1)} |`
  })

  return (
    `# Request prefetch benchmark\n\nGenerated: ${artifact.generatedAt}\n\n` +
    `Node: ${artifact.environment.targetNode}; connections: ${artifact.parameters.connections}; ` +
    `pipelining: ${artifact.parameters.pipelining}; workers: ${artifact.parameters.workers}; ` +
    `warmup: ${artifact.parameters.warmupMs} ms; duration: ${artifact.parameters.durationMs} ms; ` +
    `balanced ABBA/BAAB blocks: ${artifact.parameters.blocks}; ` +
    `server CPU: ${artifact.parameters.serverCpu < 0 ? 'unrestricted' : artifact.parameters.serverCpu}. ` +
    `Target and load generator are separate processes.\n\n` +
    `| Cell | Baseline req/s | Prefetch req/s | RPS delta | Prefetch p95 ms | Prefetch p99 ms | Target ELU | Target RSS MiB |\n` +
    `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows.join('\n')}\n\n` +
    `Results are medians across all role runs. Treat quick/local runs as suite validation, not a release gate; ` +
    `the release gate requires an even number of balanced ABBA/BAAB blocks on isolated Node 22 and Node 24 hosts.\n`
  )
}

function summarize(results) {
  return {
    rps: median(results.map((result) => result.requestsPerSecond)),
    p95: median(results.map((result) => result.p95Ms)),
    p99: median(results.map((result) => result.p99Ms)),
    elu: median(results.map((result) => result.target.eluPct)),
    rss: median(results.map((result) => result.target.memMB.rssPeak))
  }
}

function median(values) {
  const ordered = values.toSorted((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)

  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2
}
