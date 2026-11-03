import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { terminateChildProcess, waitForMessage } from '@swarmmachina/benchkit/orchestration'

import { withTimeout } from './helpers/async.js'

for (const [implementation, entry] of [
  ['swm', '../lib/index.js'],
  ['upstream', '../lib/index.js'],
  ['upstream', './fixtures/commonjs-binding.cjs']
]) {
  test(`feature benchmark starts and closes ${implementation} using ${entry}`, { timeout: 10_000 }, async (t) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../benchmark/benchmark-upstream-feature-paths.mjs', import.meta.url))],
      {
        env: {
          ...process.env,
          SWM_FEATURE_SERVER: '1',
          SWM_FEATURE_IMPLEMENTATION: implementation,
          SWM_FEATURE_KIND: 'end-batch',
          SWM_FEATURE_BINDING: fileURLToPath(new URL(entry, import.meta.url)),
          SWM_FEATURE_MAX_BODY: '1024'
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      }
    )
    const exited = once(child, 'exit')

    let stderr = ''

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    try {
      const ready = await waitForMessage(child, (message) => message?.type === 'ready', 5_000)
      const response = await fetch(`http://127.0.0.1:${ready.port}/feature`, { signal: AbortSignal.timeout(5_000) })

      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { ok: true })
      child.send({ type: 'shutdown' })
      const [code, signal] = await withTimeout(exited, 5_000, 'feature benchmark shutdown')

      assert.equal(code, 0, stderr)
      assert.equal(signal, null)
    } finally {
      await terminateChildProcess(child, { graceMs: 500, killMs: 500 })

      if (child.exitCode !== 0) {
        t.diagnostic(stderr)
      }
    }
  })
}
