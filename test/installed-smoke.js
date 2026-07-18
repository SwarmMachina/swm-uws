import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const packageName = process.env.SWM_UWS_PACKAGE_NAME || '@swarmmachina/swm-uws'
const binding = await import(packageName)
const { App, us_listen_socket_close, version } = binding
const uWS = binding.default
const require = createRequire(import.meta.url)
const required = require(packageName)
const packageRoot = dirname(dirname(require.resolve(packageName)))
const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'))
const expectedBindingVersion = `${manifest.version}+uWebSockets-${manifest.upstream.uWebSocketsJs}`

assert.equal(version(), expectedBindingVersion)
assert.equal(uWS.App, App)
assert.equal(uWS.us_listen_socket_close, us_listen_socket_close)
assert.equal(uWS.version, version)
assert.equal(required.default, uWS)
assert.equal(required.App, App)

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
console.log(`installed package smoke ok via ${packageName}: ${version()}`)
