export const FEATURE_PERFORMANCE_PATH_NAMES = Object.freeze([
  'collect-body-with-length-256',
  'collect-body-with-length-4096',
  'end-batch',
  'request-prefetch',
  'discard-body'
])

export const FEATURE_PERFORMANCE_THRESHOLDS = Object.freeze({
  maxThroughputRegressionPct: 5,
  maxLatencyRegressionPct: 20,
  latencySlackMs: 0.25,
  maxRssRegressionPct: 15,
  rssSlackMiB: 5
})

export function featurePerformanceGuard({
  label,
  pairedThroughputDeltaPct,
  upstream,
  candidate,
  thresholds = FEATURE_PERFORMANCE_THRESHOLDS
}) {
  if (typeof label !== 'string' || !label) {
    throw new TypeError('feature performance label must be a non-empty string')
  }

  const limits = validateThresholds(thresholds)
  const metrics = [
    throughputMetric(label, pairedThroughputDeltaPct, limits.maxThroughputRegressionPct),
    lowerIsBetterMetric({
      label,
      name: 'median p95 latency',
      unit: 'ms',
      candidate: metric(candidate, 'p95Ms'),
      reference: metric(upstream, 'p95Ms'),
      maxRegressionPct: limits.maxLatencyRegressionPct,
      absoluteSlack: limits.latencySlackMs
    }),
    lowerIsBetterMetric({
      label,
      name: 'median p99 latency',
      unit: 'ms',
      candidate: metric(candidate, 'p99Ms'),
      reference: metric(upstream, 'p99Ms'),
      maxRegressionPct: limits.maxLatencyRegressionPct,
      absoluteSlack: limits.latencySlackMs
    }),
    lowerIsBetterMetric({
      label,
      name: 'median RSS peak',
      unit: 'MiB',
      candidate: metric(candidate, 'rssPeakMiB'),
      reference: metric(upstream, 'rssPeakMiB'),
      maxRegressionPct: limits.maxRssRegressionPct,
      absoluteSlack: limits.rssSlackMiB
    })
  ]
  const failures = metrics.filter((entry) => entry.status === 'fail').map((entry) => entry.failure)

  return {
    status: failures.length ? 'fail' : 'pass',
    thresholds: limits,
    failures,
    metrics: metrics.map(({ failure: _failure, ...entry }) => entry)
  }
}

function throughputMetric(label, deltaPct, maxRegressionPct) {
  assertFinite('pairedThroughputDeltaPct', deltaPct)

  const limit = -maxRegressionPct
  const status = deltaPct >= limit ? 'pass' : 'fail'

  return {
    name: 'paired throughput delta',
    candidate: deltaPct,
    limit,
    unit: '%',
    status,
    failure:
      status === 'fail'
        ? `${label} paired throughput delta ${fixed(deltaPct, 2)}% is below ${fixed(limit, 2)}%`
        : undefined
  }
}

function lowerIsBetterMetric({ label, name, unit, candidate, reference, maxRegressionPct, absoluteSlack }) {
  const limit = reference * (1 + maxRegressionPct / 100) + absoluteSlack
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(candidate), Math.abs(limit)) * 8
  const status = candidate <= limit + tolerance ? 'pass' : 'fail'

  return {
    name,
    candidate,
    reference,
    limit,
    unit,
    status,
    failure:
      status === 'fail'
        ? `${label} ${name} ${fixed(candidate, 3)} ${unit} exceeds ${fixed(limit, 3)} ${unit}`
        : undefined
  }
}

function metric(value, name) {
  if (!value || typeof value !== 'object') {
    throw new TypeError('feature performance sides must be objects')
  }

  const result = value[name]

  assertFinite(name, result)

  if (result < 0) {
    throw new RangeError(`${name} must be non-negative`)
  }

  return result
}

function validateThresholds(value) {
  if (!value || typeof value !== 'object') {
    throw new TypeError('feature performance thresholds must be an object')
  }

  const result = {}

  for (const name of [
    'maxThroughputRegressionPct',
    'maxLatencyRegressionPct',
    'latencySlackMs',
    'maxRssRegressionPct',
    'rssSlackMiB'
  ]) {
    const threshold = value[name]

    assertFinite(name, threshold)

    if (threshold < 0) {
      throw new RangeError(`${name} must be non-negative`)
    }

    result[name] = threshold
  }

  return result
}

function assertFinite(name, value) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be finite`)
  }
}

function fixed(value, digits) {
  return value.toFixed(digits)
}
