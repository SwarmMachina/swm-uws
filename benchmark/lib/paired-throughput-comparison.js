import { pairedComparison } from '@swarmmachina/benchkit/statistics'

export function pairedThroughputComparison(results, blocks) {
  if (!Number.isSafeInteger(blocks) || blocks < 2) {
    throw new RangeError('blocks must be an integer of at least 2 for paired comparison')
  }

  return pairedComparison(
    Array.from({ length: blocks }, (_, index) => {
      const block = index + 1
      const runs = results.filter((result) => result.block === block)

      return {
        candidate: meanThroughput(runs, block, 'candidate'),
        reference: meanThroughput(runs, block, 'baseline')
      }
    })
  )
}

function meanThroughput(runs, block, role) {
  const values = runs.filter((run) => run.role === role).map((run) => run.requestsPerSecond)

  if (values.length !== 2 || !values.every(Number.isFinite)) {
    throw new Error(`block ${block} must contain two finite ${role} throughput measurements`)
  }

  return (values[0] + values[1]) / values.length
}
