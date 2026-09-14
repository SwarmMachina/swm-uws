import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import os from 'node:os'
import { runWebSocketLoad } from '@swarmmachina/benchkit/load/websocket'
import { BenchmarkTargetProcess } from '../lib/benchmark-target-process.js'
import { benchmarkBlockSchedule } from '../lib/benchmark-block-schedule.js'
import { pairedThroughputComparison } from '../lib/paired-throughput-comparison.js'
import { WS_PERFORMANCE_PARAMETERS, wsPerformanceEvidenceFailures } from '../lib/ws-performance-evidence.js'

if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error('WS comparison requires a Node 24 driver; set SWM_BENCH_WS_DRIVER_NODE')
}

const targetNode = process.env.SWM_BENCH_WS_TARGET_NODE || process.execPath
const targetIdentity = JSON.parse(
  execFileSync(targetNode, ['-p', 'JSON.stringify({node:process.version,abi:process.versions.modules})'], {
    encoding: 'utf8'
  })
)

// Apply the WS client affinity before starting load workers, including standalone runs.
execFileSync('taskset', ['-apc', process.env.SWM_BENCH_WS_CLIENT_CPUS || '1,3-13', String(process.pid)], {
  stdio: 'ignore'
})

const directory = resolve(process.argv[2])
const candidate = resolve(`prebuilds/linux-x64-glibc/node-v${targetIdentity.abi}.node`)
const baseline = process.env.SWM_BENCH_REFERENCE

if (!baseline) {
  throw new Error('SWM_BENCH_REFERENCE is required')
}

await mkdir(directory, { recursive: true })
const evidence = {
  node: process.version,
  targetNode: targetIdentity,
  candidateSha256: createHash('sha256')
    .update(await readFile(candidate))
    .digest('hex'),
  baseline,
  baselineNativeSha256: createHash('sha256')
    .update(await readFile(resolve(dirname(baseline), `uws_linux_x64_${targetIdentity.abi}.node`)))
    .digest('hex'),
  kernel: os.release(),
  cpus: os.cpus(),
  parameters: {
    ...WS_PERFORMANCE_PARAMETERS,
    serverCpu: process.env.SWM_BENCH_SERVER_CPU || WS_PERFORMANCE_PARAMETERS.serverCpu,
    clientCpus: process.env.SWM_BENCH_WS_CLIENT_CPUS || WS_PERFORMANCE_PARAMETERS.clientCpus
  },
  runs: [],
  guards: [],
  status: 'incomplete'
}
const save = () => writeFile(resolve(directory, 'ws.json'), `${JSON.stringify(evidence, null, 2)}\n`)

await save()

for (const depth of [1, 16]) {
  const runs = []

  for (const entry of benchmarkBlockSchedule(6, { baseline, candidate })) {
    const metrics = resolve(directory, `ws-${depth}-${entry.block}-${entry.position}.json`)
    const target = await BenchmarkTargetProcess.start({
      command: 'taskset',
      arguments_: [
        '-c',
        process.env.SWM_BENCH_SERVER_CPU || '2',
        targetNode,
        'benchmark/pgo/profile-http-raw-server.js'
      ],
      cwd: process.cwd(),
      env: { ...process.env, SWM_PROFILE_BINDING: entry.value, SWM_PROFILE_PORT: '0', SWM_PROFILE_METRICS: metrics },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc']
    })

    try {
      const load = await runWebSocketLoad({
        url: `ws://127.0.0.1:${target.ready.port}/ws`,
        message: new Uint8Array(256),
        connections: 100,
        maxInFlight: depth,
        workers: 12,
        warmupMs: 2000,
        durationMs: 5000
      })
      const row = { ...entry, depth, requestsPerSecond: load.messages.averagePerSecond, load }

      runs.push(row)
      evidence.runs.push(row)
      await save()
      console.error(
        `WS depth=${depth} block=${entry.block}/6 position=${entry.position}/4 role=${entry.role} messages/s=${row.requestsPerSecond.toFixed(0)}`
      )

      if (
        load.errors.total ||
        load.latencyMs.dropped ||
        load.latencyMs.outOfRange ||
        load.latencyMs.nonFinite ||
        load.transport.rateDropped ||
        load.transport.backpressureEvents ||
        !Number.isFinite(load.loadGenerator.maxWorkerEluPct) ||
        !Number.isFinite(load.loadGenerator.parentEluPct) ||
        !Number.isFinite(row.requestsPerSecond) ||
        row.requestsPerSecond <= 0 ||
        load.loadGenerator.saturated !== false ||
        load.loadGenerator.maxWorkerEluPct >= WS_PERFORMANCE_PARAMETERS.maxGeneratorEluPct ||
        load.loadGenerator.parentEluPct >= WS_PERFORMANCE_PARAMETERS.maxGeneratorEluPct
      ) {
        throw new Error(
          'WS comparison invalid: errors, drops, backpressure, missing telemetry, or generator saturation'
        )
      }
    } finally {
      await target.stop()
    }
  }

  const comparison = pairedThroughputComparison(runs, 6)

  evidence.guards.push({ depth, comparison, status: comparison.medianPairedDeltaPct >= -5 ? 'pass' : 'fail' })
  await save()
}

evidence.status = evidence.guards.every((guard) => guard.status === 'pass') ? 'pass' : 'fail'
await save()

const failures = wsPerformanceEvidenceFailures(evidence)

if (failures.length) {
  throw new Error(`WS comparison failed: ${failures.join('; ')}`)
}
