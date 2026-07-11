import assert from 'node:assert/strict'

import { App, us_listen_socket_close, version } from '@swarmmachina/swm-uws'

assert.equal(version(), '0.3.1+uWebSockets-v20.67.0')

const port = 30_000 + (process.pid % 10_000)
const app = App()

app.get('/', (res) => {
  res.end('ok')
})

let listenSocket
await new Promise((resolve, reject) => {
  app.listen(port, (socket) => {
    if (socket) {
      listenSocket = socket
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
us_listen_socket_close(listenSocket)
assert.equal(app.close(), app)
console.log(`installed package smoke ok: ${version()}`)
