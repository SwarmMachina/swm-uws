import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  FEATURE_PERFORMANCE_PATH_NAMES,
  FEATURE_PERFORMANCE_THRESHOLDS,
  featurePerformanceGuard
} from '../benchmark/lib/feature-performance-guard.js'
import { WS_PERFORMANCE_PARAMETERS } from '../benchmark/lib/ws-performance-evidence.js'

function guard(overrides = {}) {
  return featurePerformanceGuard({
    label: 'request-prefetch',
    pairedThroughputDeltaPct: -5,
    upstream: { p95Ms: 1, p99Ms: 2, rssPeakMiB: 100 },
    candidate: { p95Ms: 1.45, p99Ms: 2.65, rssPeakMiB: 120 },
    ...overrides
  })
}

test('feature performance guard accepts every metric at its inclusive limit', () => {
  const result = guard()

  assert.equal(result.status, 'pass')
  assert.deepEqual(result.failures, [])
  assert.equal(result.metrics.length, 4)
  assert.ok(result.metrics.every((metric) => metric.status === 'pass'))
  assert.deepEqual(result.thresholds, FEATURE_PERFORMANCE_THRESHOLDS)
  assert.deepEqual(FEATURE_PERFORMANCE_PATH_NAMES, [
    'collect-body-with-length-256',
    'collect-body-with-length-4096',
    'end-batch',
    'request-prefetch',
    'discard-body'
  ])
})

test('feature performance guard reports throughput, latency, and RSS regressions', () => {
  const result = guard({
    pairedThroughputDeltaPct: -5.01,
    candidate: { p95Ms: 1.451, p99Ms: 2.651, rssPeakMiB: 120.01 }
  })

  assert.equal(result.status, 'fail')
  assert.equal(result.failures.length, 4)
  assert.match(result.failures[0], /paired throughput delta -5\.01% is below -5\.00%/)
  assert.match(result.failures[1], /median p95 latency 1\.451 ms exceeds 1\.450 ms/)
  assert.match(result.failures[2], /median p99 latency 2\.651 ms exceeds 2\.650 ms/)
  assert.match(result.failures[3], /median RSS peak 120\.010 MiB exceeds 120\.000 MiB/)
  assert.ok(result.metrics.every((metric) => metric.status === 'fail'))
})

test('feature performance guard rejects incomplete or non-finite measurements', () => {
  assert.throws(() => guard({ label: '' }), /label must be a non-empty string/)
  assert.throws(() => guard({ pairedThroughputDeltaPct: Number.NaN }), /pairedThroughputDeltaPct must be finite/)
  assert.throws(() => guard({ candidate: { p95Ms: -1, p99Ms: 2, rssPeakMiB: 100 } }), /p95Ms/)
  assert.throws(
    () => guard({ thresholds: { ...FEATURE_PERFORMANCE_THRESHOLDS, maxLatencyRegressionPct: Infinity } }),
    /maxLatencyRegressionPct must be finite/
  )
})

test('PGO checker requires every expected feature and WS guard to pass', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'swm-uws-feature-guard-'))

  context.after(() => rm(directory, { recursive: true, force: true }))

  await writeFile(
    join(directory, 'metadata.json'),
    JSON.stringify({
      guard: { status: 'pass', failures: [] },
      hardwareStat: { source: 'paired round; counters unavailable', perRequest: {} }
    })
  )

  const passingPaths = FEATURE_PERFORMANCE_PATH_NAMES.map((name) => ({
    name,
    guard: { status: 'pass', failures: [] }
  }))

  await writeFile(join(directory, 'summary.json'), JSON.stringify({ featurePaths: passingPaths }))

  const checker = fileURLToPath(new URL('../benchmark/pgo/check-pgo-benchmark.js', import.meta.url))
  const missingWs = spawnSync(process.execPath, [checker, directory], { encoding: 'utf8' })

  assert.equal(missingWs.status, 1)
  assert.match(missingWs.stderr, /ws\.json/)

  const passingRun = (depth, block, position, role) => ({
    depth,
    block,
    position,
    role,
    requestsPerSecond: 100_000,
    load: {
      errors: { total: 0 },
      latencyMs: { dropped: 0, outOfRange: 0, nonFinite: 0 },
      transport: { rateDropped: 0, backpressureEvents: 0 },
      loadGenerator: { parentEluPct: 10, maxWorkerEluPct: 80, saturated: false }
    }
  })
  const passingWs = {
    status: 'pass',
    node: 'v24.19.0',
    parameters: WS_PERFORMANCE_PARAMETERS,
    guards: [1, 16].map((depth) => ({
      depth,
      status: 'pass',
      comparison: { medianPairedDeltaPct: -4 }
    })),
    runs: [1, 16].flatMap((depth) =>
      Array.from({ length: 6 }, (_, index) => {
        const block = index + 1

        return [
          passingRun(depth, block, 1, 'baseline'),
          passingRun(depth, block, 2, 'candidate'),
          passingRun(depth, block, 3, 'candidate'),
          passingRun(depth, block, 4, 'baseline')
        ]
      }).flat()
    )
  }

  for (const ws of [
    { ...passingWs, status: 'incomplete' },
    { ...passingWs, node: 'v22.23.2' },
    { ...passingWs, parameters: { ...passingWs.parameters, protocol: 'ws-8workers-v1' } },
    { ...passingWs, parameters: { ...passingWs.parameters, workers: 8 } },
    { ...passingWs, parameters: { ...passingWs.parameters, durationMs: 3000 } },
    { ...passingWs, guards: passingWs.guards.slice(0, 1) },
    {
      ...passingWs,
      guards: [
        { depth: 1, status: 'pass' },
        { depth: 16, status: 'fail' }
      ]
    },
    { ...passingWs, guards: [passingWs.guards[0], passingWs.guards[0]] },
    { ...passingWs, runs: passingWs.runs.slice(0, -1) },
    {
      ...passingWs,
      runs: passingWs.runs.map((run, index) =>
        index === 0
          ? { ...run, load: { ...run.load, loadGenerator: { ...run.load.loadGenerator, saturated: true } } }
          : run
      )
    }
  ]) {
    await writeFile(join(directory, 'ws.json'), JSON.stringify(ws))

    const failingWs = spawnSync(process.execPath, [checker, directory], { encoding: 'utf8' })

    assert.equal(failingWs.status, 1)
    assert.match(failingWs.stderr, /WS comparison:/)
  }

  await writeFile(join(directory, 'ws.json'), JSON.stringify(passingWs))

  const passing = spawnSync(process.execPath, [checker, directory], { encoding: 'utf8' })

  assert.equal(passing.status, 0, passing.stderr)
  assert.match(passing.stdout, /HTTP, feature and WS performance regression guards passed/)

  passingPaths[0].guard = { status: 'fail', failures: ['collect path regressed'] }
  await writeFile(join(directory, 'summary.json'), JSON.stringify({ featurePaths: passingPaths }))

  const failing = spawnSync(process.execPath, [checker, directory], { encoding: 'utf8' })

  assert.equal(failing.status, 1)
  assert.match(failing.stderr, /feature performance regression: collect path regressed/)
})
