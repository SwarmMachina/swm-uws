import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { FEATURE_PERFORMANCE_PATH_NAMES } from '../lib/feature-performance-guard.js'

if (process.argv.length !== 3) {
  throw new Error('usage: check-pgo-benchmark.js <benchmark-dir>')
}

const directory = resolve(process.argv[2])
const metadata = JSON.parse(await readFile(resolve(directory, 'metadata.json'), 'utf8'))
const summary = JSON.parse(await readFile(resolve(directory, 'summary.json'), 'utf8'))
const hardwareCounters = metadata.hardwareStat?.perRequest || {}
const requiredHardwareCounters = [
  'cycles',
  'instructions',
  'branches',
  'branchMisses',
  'cacheReferences',
  'cacheMisses'
]
const unavailableHardwareCounters = requiredHardwareCounters.filter((name) => !Number.isFinite(hardwareCounters[name]))

if (metadata.hardwareStat?.source === 'independent stat-only run' && unavailableHardwareCounters.length > 0) {
  console.error(`hardware counters unavailable: ${unavailableHardwareCounters.join(', ')}`)
  process.exit(1)
}

if (metadata.guard?.status !== 'pass') {
  for (const failure of metadata.guard?.failures || ['performance guard result is missing']) {
    console.error(`performance regression: ${failure}`)
  }

  process.exit(1)
}

const featurePaths = summary.featurePaths

if (!Array.isArray(featurePaths)) {
  console.error('feature performance guard results are missing')
  process.exit(1)
}

const actualFeatureNames = featurePaths.map((path) => path.name).sort()
const expectedFeatureNames = [...FEATURE_PERFORMANCE_PATH_NAMES].sort()

if (JSON.stringify(actualFeatureNames) !== JSON.stringify(expectedFeatureNames)) {
  console.error(`feature performance paths do not match: ${actualFeatureNames.join(', ') || 'none'}`)
  process.exit(1)
}

const featureFailures = featurePaths.flatMap((path) => {
  if (path.guard?.status === 'pass' && Array.isArray(path.guard.failures) && path.guard.failures.length === 0) {
    return []
  }

  return path.guard?.failures?.length ? path.guard.failures : [`${path.name} performance guard failed or is missing`]
})

if (featureFailures.length) {
  for (const failure of featureFailures) {
    console.error(`feature performance regression: ${failure}`)
  }

  process.exit(1)
}

console.log('raw HTTP and feature performance regression guards passed')
