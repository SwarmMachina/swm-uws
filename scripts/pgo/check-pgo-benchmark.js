import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

if (process.argv.length !== 3) {
  throw new Error('usage: check-pgo-benchmark.js <benchmark-dir>')
}

const directory = resolve(process.argv[2])
const metadata = JSON.parse(await readFile(resolve(directory, 'metadata.json'), 'utf8'))
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

console.log('performance regression guard passed')
