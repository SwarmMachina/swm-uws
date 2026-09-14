import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BenchmarkTargetProcess } from '../benchmark/lib/benchmark-target-process.js'

const run = promisify(execFile)

test('PGO training completes exact uneven budgets for HTTP and both WS depths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pgo-training-test-'))
  const target = await BenchmarkTargetProcess.start({
    command: process.execPath,
    arguments_: ['benchmark/pgo/profile-http-raw-server.js'],
    cwd: process.cwd(),
    env: { ...process.env, SWM_PROFILE_PORT: '0', SWM_PROFILE_METRICS: join(directory, 'metrics.json') },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc']
  })

  try {
    for (const [protocol, depth] of [
      ['GET', 1],
      ['POST', 1],
      ['WS', 1],
      ['WS', 16]
    ]) {
      const { stdout } = await run(
        process.execPath,
        ['benchmark/pgo/train-fixed-work.js', protocol, String(target.ready.port), '103', '4', String(depth)],
        { timeout: 15000 }
      )
      const result = JSON.parse(stdout)

      assert.equal(result.completed, 103)
      assert.equal(result.requested, 103)
    }
  } finally {
    await target.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
test('PGO training rejects invalid work counts', async () => {
  await assert.rejects(run(process.execPath, ['benchmark/pgo/train-fixed-work.js', 'GET', '1', '0', '4']))
})
