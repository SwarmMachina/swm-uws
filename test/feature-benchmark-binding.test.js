import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { terminateChildProcess, waitForMessage } from '@swarmmachina/benchkit/orchestration'

import { withTimeout } from './helpers/async.js'

for (const [implementation, entry, feature, bodySize] of [
  ['swm', '../lib/index.js', 'end-batch'],
  ['upstream', '../lib/index.js', 'end-batch'],
  ['upstream', './fixtures/commonjs-binding.cjs', 'end-batch'],
  ['upstream', './fixtures/owned-body-binding.cjs', 'collect-length', 256],
  ['upstream', './fixtures/owned-body-binding.cjs', 'collect-length', 4096]
]) {
  const scenario = bodySize ? `${feature} ${bodySize}` : feature

  test(
    `feature benchmark ${scenario} starts and closes ${implementation} using ${entry}`,
    { timeout: 10_000 },
    async (t) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL('../benchmark/benchmark-upstream-feature-paths.mjs', import.meta.url))],
        {
          env: {
            ...process.env,
            SWM_FEATURE_SERVER: '1',
            SWM_FEATURE_IMPLEMENTATION: implementation,
            SWM_FEATURE_KIND: feature,
            SWM_FEATURE_BINDING: fileURLToPath(new URL(entry, import.meta.url)),
            SWM_FEATURE_MAX_BODY: '67108864'
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
        const ownership = bodySize
          ? waitForMessage(child, (message) => message?.type === 'body-ownership', 5_000)
          : undefined
        const [response, contract] = await Promise.all([
          fetch(`http://127.0.0.1:${ready.port}/feature`, {
            ...(bodySize ? { method: 'POST', body: Buffer.alloc(bodySize, 0xa5) } : {}),
            signal: AbortSignal.timeout(5_000)
          }),
          ownership
        ])

        assert.equal(response.status, 200)

        if (bodySize) {
          assert.equal(await response.text(), 'ok')
          assert.equal(contract.bodyBytes, bodySize)
          assert.equal(contract.backingBytes, bodySize, 'manual collector must own an exact-size backing store')
          assert.equal(contract.byteOffset, 0)
          assert.equal(contract.transferable, true, contract.transferError)
          assert.equal(contract.payloadMatches, true)
        } else {
          assert.deepEqual(await response.json(), { ok: true })
        }

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
    }
  )
}
