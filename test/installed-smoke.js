import assert from 'node:assert/strict'

import { createApp, version } from '@swarmmachina/swm-uws'

assert.equal(version(), '0.1.0+uWebSockets-v20.67.0')

const port = 30_000 + (process.pid % 10_000)
const app = createApp()

app.get('/', (res) => {
  res.end('ok')
})

await new Promise((resolve, reject) => {
  app.listen('127.0.0.1', port, (ok) => {
    if (ok) {
      resolve()
      return
    }

    reject(new Error(`listen failed on 127.0.0.1:${port}`))
  })
})

const response = await fetch(`http://127.0.0.1:${port}/`, {
  signal: AbortSignal.timeout(5_000)
})

assert.equal(response.status, 200)
assert.equal(await response.text(), 'ok')
assert.equal(app.close(), app)
console.log(`installed package smoke ok: ${version()}`)
