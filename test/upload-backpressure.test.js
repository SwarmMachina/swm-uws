import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

import { createApp } from '../lib/index.js'
import { NativeAppServer } from './helpers/native-app-server.js'

const run = promisify(execFile)
const client = fileURLToPath(new URL('./fixtures/upload-backpressure-client.js', import.meta.url))
const RECEIVE_BUFFER_BYTES = 512 * 1024
const BODY_BYTES = 32 * 1024 * 1024

for (const framing of ['fixed', 'chunked', 'fixed-fin']) {
  test(
    `HTTP ${framing} upload pause bounds delivery and resume preserves every byte`,
    { timeout: 15_000 },
    async (t) => {
      const app = createApp()

      let timer
      let paused = false
      let pauses = 0
      let received = 0
      let deliveredWhilePaused = 0
      let maximumWhilePaused = 0
      let largestChunk = 0

      const hash = createHash('sha256')

      app.post('/upload', (res) => {
        res.onAborted(() => clearTimeout(timer))
        res.onData((chunk, last) => {
          received += chunk.byteLength
          largestChunk = Math.max(largestChunk, chunk.byteLength)
          hash.update(new Uint8Array(chunk))

          if (paused) {
            deliveredWhilePaused += chunk.byteLength
            maximumWhilePaused = Math.max(maximumWhilePaused, deliveredWhilePaused)
          }

          if (last) {
            clearTimeout(timer)

            if (paused) {
              res.resume()
            }

            res.cork(() => res.end(hash.digest('hex')))
          } else if (!paused) {
            paused = true
            pauses++
            deliveredWhilePaused = 0
            res.pause()
            timer = setTimeout(() => {
              paused = false
              res.resume()
            }, 2)
          }
        })
      })

      const server = await NativeAppServer.listen(app)

      try {
        await run(process.execPath, [client, String(server.port), framing, String(BODY_BYTES)], { timeout: 12_000 })
        assert.equal(received, BODY_BYTES)
        assert.ok(pauses > 1, `expected repeated pause/resume, observed ${pauses}`)
        // Chunked framing can deliver multiple chunks from the already-received
        // parser buffer. It must not receive another buffer while paused.
        const allowance = framing.startsWith('fixed') ? 0 : RECEIVE_BUFFER_BYTES

        assert.ok(
          maximumWhilePaused <= allowance,
          `delivered ${maximumWhilePaused} bytes while paused (limit ${allowance})`
        )
        t.diagnostic(JSON.stringify({ framing, received, pauses, largestChunk, maximumWhilePaused }))
      } finally {
        clearTimeout(timer)
        server.close()
      }
    }
  )
}
