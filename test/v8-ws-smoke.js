import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { App, us_listen_socket_close } = require('../build/Release/swm_uws.node')
const port = 40_000 + (process.pid % 10_000)
const app = App()

let nativeSocket
let detachedMessage
let openCount = 0
let closeCount = 0
const subscriptions = []
let resolveClosed
const closed = new Promise((resolve) => {
  resolveClosed = resolve
})

app.ws('/ws', {
  idleTimeout: 15,
  maxPayloadLength: 1024 * 1024,
  sendPingsAutomatically: true,
  upgrade(res, req, context) {
    res.upgrade(
      { connectionId: 'core-compatible' },
      req.getHeader('sec-websocket-key'),
      req.getHeader('sec-websocket-protocol'),
      req.getHeader('sec-websocket-extensions'),
      context
    )
  },
  open(ws) {
    nativeSocket = ws
    openCount++
    assert.deepEqual(ws.getUserData(), { connectionId: 'core-compatible' })
    assert.equal(ws.getBufferedAmount(), 0)
    assert.equal(ws.subscribe('room'), true)
    ws.send('open', false)
  },
  message(ws, message, isBinary) {
    assert.ok(message instanceof ArrayBuffer)
    detachedMessage = message
    ws.send(message, isBinary)
  },
  subscription(_ws, topic, newCount, oldCount) {
    subscriptions.push([Buffer.from(new Uint8Array(topic)).toString(), newCount, oldCount])
  },
  close(ws) {
    closeCount++
    assert.equal(ws, nativeSocket)
    resolveClosed()
  }
})

let listenSocket
await new Promise((resolve, reject) => {
  app.listen(port, (socket) => {
    if (!socket) reject(new Error(`listen failed on :${port}`))
    else {
      listenSocket = socket
      resolve()
    }
  })
})

const client = new WebSocket(`ws://127.0.0.1:${port}/ws`)
client.binaryType = 'arraybuffer'
const greeting = nextMessage(client)
await once(client, 'open')
assert.equal(await greeting, 'open')
assert.equal(openCount, 1)
assert.deepEqual(subscriptions, [['room', 1, 0]])
assert.equal(app.numSubscribers('room'), 1)

client.send('hello')
assert.equal(await nextMessage(client), 'hello')
assert.equal(detachedMessage.byteLength, 0)

const published = nextMessage(client)
assert.equal(app.publish('room', Uint8Array.from([1, 2, 3]), true), true)
assert.deepEqual(new Uint8Array(await published), Uint8Array.from([1, 2, 3]))

client.close()
await once(client, 'close')
await withTimeout(closed, 5_000, 'native close callback timed out')
assert.equal(closeCount, 1)
assert.equal(app.numSubscribers('room'), 0)
assert.throws(() => nativeSocket.send('late'), /WebSocket is no longer valid/)

us_listen_socket_close(listenSocket)
app.close()
console.log(`raw V8 WebSocket smoke ok on ${port}`)

function once(target, event) {
  return new Promise((resolve, reject) => {
    target.addEventListener(event, resolve, { once: true })
    target.addEventListener('error', () => reject(new Error(`WebSocket ${event} failed`)), { once: true })
  })
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.addEventListener('message', (event) => resolve(event.data), { once: true })
    socket.addEventListener('error', () => reject(new Error('WebSocket message failed')), { once: true })
  })
}

async function withTimeout(promise, milliseconds, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
