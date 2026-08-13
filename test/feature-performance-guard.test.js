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

test('PGO checker requires every expected feature guard to pass', async (context) => {
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
  const passing = spawnSync(process.execPath, [checker, directory], { encoding: 'utf8' })

  assert.equal(passing.status, 0, passing.stderr)
  assert.match(passing.stdout, /raw HTTP and feature performance regression guards passed/)

  passingPaths[0].guard = { status: 'fail', failures: ['collect path regressed'] }
  await writeFile(join(directory, 'summary.json'), JSON.stringify({ featurePaths: passingPaths }))

  const failing = spawnSync(process.execPath, [checker, directory], { encoding: 'utf8' })

  assert.equal(failing.status, 1)
  assert.match(failing.stderr, /feature performance regression: collect path regressed/)
})
