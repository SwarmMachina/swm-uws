import assert from 'node:assert/strict'

import { createApp, version } from '../lib/index.js'
import { resolvePrebuildTarget } from '../lib/load-native.js'

assert.equal(version(), '0.1.0+uWebSockets-v20.67.0')
assert.equal(resolvePrebuildTarget('linux', 'x64'), 'linux-x64-glibc')
assert.equal(resolvePrebuildTarget('win32', 'x64'), 'win32-x64')
assert.equal(resolvePrebuildTarget('win32', 'arm64'), null)

const serveOnly = process.argv.includes('--serve')
const port = serveOnly ? Number(process.env.PORT || 3000) : 30_000 + (process.pid % 10_000)
const host = serveOnly ? '0.0.0.0' : '127.0.0.1'
const app = createApp()

let completedResponse
let closedSocket
let closeCount = 0

app.get('/', (res) => {
  completedResponse = res
  res.end('ok')
})

app.get('/metadata', (res) => {
  assert.throws(() => res.writeStatus(418), /expects a string/)
  assert.throws(() => res.writeStatus('418\r\nX-Injected: yes'), /without control characters/)
  assert.throws(() => res.writeHeader('invalid name', 'value'), /valid HTTP header name/)
  assert.throws(() => res.writeHeader('x-test', 'value\r\nX-Injected: yes'), /control characters/)

  assert.equal(res.writeStatus('418 I am a teapot'), res)
  assert.equal(res.writeHeader('content-type', 'application/json'), res)
  assert.equal(res.writeHeader('x-swm-test', 'metadata'), res)
  assert.equal(res.end('{"ok":false}'), res)
  assert.throws(() => res.writeHeader('x-late', 'value'), /HTTP response is no longer valid/)
})

app.ws('/ws', {
  open(ws) {
    ws.send('open')
  },
  message(ws, message, isBinary) {
    ws.send(message, isBinary)
  },
  close(ws) {
    closedSocket = ws
    closeCount++
  }
})

await new Promise((resolve, reject) => {
  app.listen(host, port, (ok) => {
    if (!ok) {
      reject(new Error(`listen failed on ${host}:${port}`))
      return
    }

    resolve()
  })
})

if (serveOnly) {
  console.log(`listening on ${host}:${port}`)
} else {
  await runSelfTest()
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.addEventListener('message', (event) => resolve(event.data), { once: true })
    socket.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true })
  })
}

async function runSelfTest() {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    signal: AbortSignal.timeout(5_000)
  })

  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'ok')
  assert.throws(() => completedResponse.end('late'), /HTTP response is no longer valid/)

  const metadataResponse = await fetch(`http://127.0.0.1:${port}/metadata`, {
    signal: AbortSignal.timeout(5_000)
  })

  assert.equal(metadataResponse.status, 418)
  assert.equal(metadataResponse.headers.get('content-type'), 'application/json')
  assert.equal(metadataResponse.headers.get('x-swm-test'), 'metadata')
  assert.deepEqual(await metadataResponse.json(), { ok: false })

  const client = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  client.binaryType = 'arraybuffer'
  const greeting = nextMessage(client)

  await new Promise((resolve, reject) => {
    client.addEventListener('open', resolve, { once: true })
    client.addEventListener('error', () => reject(new Error('WebSocket open failed')), {
      once: true
    })
  })

  assert.equal(await greeting, 'open')

  const textEcho = nextMessage(client)
  client.send('hello')
  assert.equal(await textEcho, 'hello')

  const binaryEcho = nextMessage(client)
  client.send(Uint8Array.from([1, 2, 3, 255]))
  assert.deepEqual(new Uint8Array(await binaryEcho), Uint8Array.from([1, 2, 3, 255]))

  assert.equal(app.close(), app)
  assert.equal(app.close(), app)
  assert.throws(() => app.listen(host, port, () => {}), /app\.listen\(\) cannot be called after app\.close\(\)/)

  const echoAfterClose = nextMessage(client)
  client.send('still connected')
  assert.equal(await echoAfterClose, 'still connected')

  await new Promise((resolve) => {
    client.addEventListener('close', resolve, { once: true })
    client.close(1000, 'done')
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(closeCount, 1)
  assert.throws(() => closedSocket.send('late'), /WebSocket is no longer valid/)

  console.log(`smoke ok: ${version()}, HTTP + WebSocket on ${port}`)
}
