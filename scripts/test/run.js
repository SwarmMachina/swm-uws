import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const tests = readdirSync(join(root, 'test'))
  .filter((entry) => entry.endsWith('.test.js'))
  .sort()
  .map((entry) => join(root, 'test', entry))
// Resource probes touch large allocations and compile native fixtures. Keep
// unrelated files from competing for CPU within their wall-clock deadlines.
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], { stdio: 'inherit' })

if (result.error) {
  throw result.error
}

process.exitCode = result.status ?? 1
