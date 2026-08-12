import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runHttp1Load } from '@swarmmachina/benchkit/load/http1'
import { parseArgs } from '@swarmmachina/benchkit/orchestration'
import { median, percentDelta } from '@swarmmachina/benchkit/statistics'

import { benchmarkBlockSchedule } from './lib/benchmark-block-schedule.js'
import { BenchmarkTargetProcess } from './lib/benchmark-target-process.js'
import { cpuIndexOption, expandEqualsArguments, positiveIntegerOption, requiredOption } from './lib/option-values.js'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const options = parseOptions(process.argv.slice(2))
const target = await startTarget()
const cells = options.quick ? quickCells() : fullCells()
const results = []

process.stderr.write(
  `request-prefetch benchmark: node=${process.version} target=${target.ready.node} ` +
    `connections=${options.connections} pipelining=${options.pipelining} ` +
    `warmup=${options.warmupMs}ms duration=${options.durationMs}ms ` +
    `workers=${options.workers} ABBA-blocks=${options.blocks} cells=${cells.length}\n`
)

try {
  for (const cell of cells) {
    const schedule = benchmarkBlockSchedule(options.blocks, {
      baseline: cell.baseline,
      candidate: cell.candidate
    })

    for (const [run, { role, value: mode }] of schedule.entries()) {
      const targetMetrics = await target.measure(async () => {
        return runHttp1Load({
          name: `${cell.name}:${mode}`,
          url: `http://127.0.0.1:${target.ready.port}/${mode}`,
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
        role,
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
  await target.stop({ shutdownMessage: { type: 'shutdown' } })
}

const artifact = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: {
    loadNode: process.version,
    targetNode: target.ready.node,
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
  return parseArgs(
    expandEqualsArguments(args),
    {
      quick: false,
      blocks: 6,
      connections: 100,
      pipelining: 10,
      workers: Math.min(4, os.availableParallelism()),
      warmupMs: 3000,
      durationMs: 10000,
      serverCpu: -1,
      output: 'benchmark/request-prefetch/results.json'
    },
    {
      '--quick': (out) => {
        out.quick = true

        return false
      },
      '--blocks': (out, value) => {
        out.blocks = positiveIntegerOption('--blocks', value)
      },
      '--connections': (out, value) => {
        out.connections = positiveIntegerOption('--connections', value)
      },
      '--pipelining': (out, value) => {
        out.pipelining = positiveIntegerOption('--pipelining', value)
      },
      '--workers': (out, value) => {
        out.workers = positiveIntegerOption('--workers', value)
      },
      '--warmupMs': (out, value) => {
        out.warmupMs = positiveIntegerOption('--warmupMs', value)
      },
      '--durationMs': (out, value) => {
        out.durationMs = positiveIntegerOption('--durationMs', value)
      },
      '--serverCpu': (out, value) => {
        out.serverCpu = cpuIndexOption('--serverCpu', value)
      },
      '--output': (out, value) => {
        out.output = requiredOption('--output', value)
      }
    },
    { strict: true, offset: 0 }
  )
}

function startTarget() {
  const targetCommand =
    process.platform === 'linux' && options.serverCpu >= 0
      ? [
          'taskset',
          ['-c', String(options.serverCpu), process.execPath, 'benchmark/benchmark-prefetch-server.js']
        ]
      : [process.execPath, ['benchmark/benchmark-prefetch-server.js']]

  return BenchmarkTargetProcess.start({
    command: targetCommand[0],
    arguments_: targetCommand[1],
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
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
    const delta = percentDelta(candidate.rps, baseline.rps).toFixed(1)

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
