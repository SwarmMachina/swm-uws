const EXPECTED_PARAMETERS = Object.freeze({
  protocol: 'ws-12workers-v1',
  serverCpu: '2',
  clientCpus: '1,3-13',
  blocks: 6,
  connections: 100,
  workers: 12,
  warmupMs: 2000,
  durationMs: 5000,
  payloadBytes: 256,
  maxThroughputRegressionPct: 5,
  maxGeneratorEluPct: 95
})
const DEPTHS = Object.freeze([1, 16])

function isFinitePositive(value) {
  return Number.isFinite(value) && value > 0
}

function runFailures(run) {
  const failures = []
  const load = run?.load

  if (!isFinitePositive(run?.requestsPerSecond)) {
    failures.push('throughput is missing or non-positive')
  }

  if (load?.errors?.total !== 0) {
    failures.push('errors.total is not zero')
  }

  if (load?.latencyMs?.dropped !== 0) {
    failures.push('latency samples were dropped')
  }

  if (load?.latencyMs?.outOfRange !== 0) {
    failures.push('latency samples were out of range')
  }

  if (load?.latencyMs?.nonFinite !== 0) {
    failures.push('latency samples were non-finite')
  }

  if (load?.transport?.rateDropped !== 0) {
    failures.push('rateDropped is not zero')
  }

  if (load?.transport?.backpressureEvents !== 0) {
    failures.push('backpressureEvents is not zero')
  }

  for (const name of ['parentEluPct', 'maxWorkerEluPct']) {
    const value = load?.loadGenerator?.[name]

    if (!Number.isFinite(value)) {
      failures.push(`${name} is missing`)
    } else if (value >= EXPECTED_PARAMETERS.maxGeneratorEluPct) {
      failures.push(`${name} reached saturation`)
    }
  }

  if (load?.loadGenerator?.saturated !== false) {
    failures.push('load generator saturation flag is not false')
  }

  return failures
}

export function wsPerformanceEvidenceFailures(evidence) {
  const failures = []

  if (evidence?.status !== 'pass') {
    failures.push('status is not pass')
  }

  if (typeof evidence?.node !== 'string' || !evidence.node.startsWith('v24.')) {
    failures.push('driver must be Node 24')
  }

  for (const [name, expected] of Object.entries(EXPECTED_PARAMETERS)) {
    if (evidence?.parameters?.[name] !== expected) {
      failures.push(`parameters.${name} must equal ${expected}`)
    }
  }

  if (!Array.isArray(evidence?.guards)) {
    failures.push('guards are missing')
  } else {
    for (const depth of DEPTHS) {
      const matching = evidence.guards.filter((guard) => guard?.depth === depth)

      if (matching.length !== 1) {
        failures.push(`depth ${depth} must have exactly one guard`)
        continue
      }

      const guard = matching[0]

      if (guard.status !== 'pass') {
        failures.push(`depth ${depth} guard did not pass`)
      }

      if (!Number.isFinite(guard.comparison?.medianPairedDeltaPct)) {
        failures.push(`depth ${depth} paired throughput delta is missing`)
      } else if (guard.comparison.medianPairedDeltaPct < -EXPECTED_PARAMETERS.maxThroughputRegressionPct) {
        failures.push(`depth ${depth} paired throughput delta exceeds the regression budget`)
      }
    }

    if (evidence.guards.length !== DEPTHS.length) {
      failures.push('unexpected guard count')
    }
  }

  if (!Array.isArray(evidence?.runs)) {
    failures.push('runs are missing')

    return failures
  }

  const expectedRunCount = EXPECTED_PARAMETERS.blocks * 4 * DEPTHS.length

  if (evidence.runs.length !== expectedRunCount) {
    failures.push(`expected ${expectedRunCount} runs`)
  }

  for (const depth of DEPTHS) {
    for (let block = 1; block <= EXPECTED_PARAMETERS.blocks; block += 1) {
      const blockRuns = evidence.runs.filter((run) => run?.depth === depth && run?.block === block)
      const positions = blockRuns.map((run) => run.position).sort((a, b) => a - b)
      const roles = blockRuns.map((run) => run.role).sort()

      if (JSON.stringify(positions) !== '[1,2,3,4]') {
        failures.push(`depth ${depth} block ${block} positions are incomplete`)
      }

      if (JSON.stringify(roles) !== '["baseline","baseline","candidate","candidate"]') {
        failures.push(`depth ${depth} block ${block} roles are incomplete`)
      }

      for (const run of blockRuns) {
        for (const failure of runFailures(run)) {
          failures.push(`depth ${depth} block ${block} position ${run.position}: ${failure}`)
        }
      }
    }
  }

  return failures
}

export { EXPECTED_PARAMETERS as WS_PERFORMANCE_PARAMETERS }
