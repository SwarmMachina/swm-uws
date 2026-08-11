import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const tests = readdirSync(join(root, 'test'))
  .filter((entry) => entry.endsWith('.test.js'))
  .sort()
  .map((entry) => join(root, 'test', entry))

const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' })

if (result.error) {
  throw result.error
}

process.exitCode = result.status ?? 1
