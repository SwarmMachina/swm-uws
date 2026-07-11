import assert from 'node:assert/strict'
import { createConnection } from 'node:net'

import { createApp, version } from '../lib/index.js'
import { resolvePrebuildTarget } from '../lib/load-native.js'

assert.equal(version(), '0.2.0+uWebSockets-v20.67.0')
assert.equal(resolvePrebuildTarget('linux', 'x64'), 'linux-x64-glibc')
assert.equal(resolvePrebuildTarget('win32', 'x64'), 'win32-x64')
assert.equal(resolvePrebuildTarget('darwin', 'arm64'), 'darwin-arm64')
assert.equal(resolvePrebuildTarget('darwin', 'x64'), 'darwin-x64')
assert.equal(resolvePrebuildTarget('win32', 'arm64'), null)

const serveOnly = process.argv.includes('--serve')
const port = serveOnly ? Number(process.env.PORT || 3000) : 30_000 + (process.pid % 10_000)
const host = serveOnly ? '0.0.0.0' : '127.0.0.1'
const app = createApp()

let completedResponse
let completedRequest
let completedBodyResponse
let abortedResponse
let closedSocket
let closeCount = 0
const socketCloses = []
let limitedMessageCount = 0
let limitedCloseCount = 0
let resolveLimitedClose
const limitedClosed = new Promise((resolve) => {
  resolveLimitedClose = resolve
})
let drainCount = 0
let backpressureObserved = false
let resolveDrained
const drained = new Promise((resolve) => {
  resolveDrained = resolve
})
let abortCount = 0
let resolveAborted
const aborted = new Promise((resolve) => {
  resolveAborted = resolve
})

app.get('/', (res) => {
  completedResponse = res
  res.end('ok')
})

app.get('/metadata', (res, req) => {
  completedRequest = req
  assert.equal(req.getMethod(), 'get')
  assert.equal(req.getUrl(), '/metadata')
  assert.equal(req.getHeader('X-Request-Test'), 'request-metadata')
  assert.equal(req.getHeader('x-missing'), '')
  assert.throws(() => req.getHeader('invalid name'), /valid HTTP header name/)

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

const methodHandler = (res, req) => {
  const method = req.getMethod()
  res.writeHeader('x-request-method', method).end(method)
}

assert.equal(app.post('/method/post', methodHandler), app)
assert.equal(app.put('/method/put', methodHandler), app)
assert.equal(app.patch('/method/patch', methodHandler), app)
assert.equal(app.del('/method/delete', methodHandler), app)
assert.equal(app.options('/method/options', methodHandler), app)
assert.equal(app.head('/method/head', methodHandler), app)
assert.equal(app.any('/method/any', methodHandler), app)

app.post('/body', (res) => {
  const chunks = []
  completedBodyResponse = res

  assert.equal(
    res.onAborted(() => {
      assert.fail('completed body request must not abort')
    }),
    res
  )
  assert.equal(
    res.onData((chunk, isLast) => {
      assert.ok(chunk instanceof ArrayBuffer)
      chunks.push(Buffer.from(new Uint8Array(chunk)))

      if (isLast) {
        res.writeHeader('content-type', 'application/octet-stream').end(Buffer.concat(chunks).toString('hex'))
      }
    }),
    res
  )
})

app.post('/abort', (res) => {
  abortedResponse = res
  res.onData(() => {})
  res.onAborted(() => {
    abortCount++
    assert.throws(() => res.end('late'), /HTTP response is no longer valid/)
    resolveAborted()
  })
})

app.ws('/ws', {
  open(ws) {
    assert.equal(ws.getBufferedAmount(), 0)
    assert.throws(() => ws.getBufferedAmount(1), /does not accept arguments/)
    assert.throws(() => ws.close(1000), /does not accept arguments/)
    assert.throws(() => ws.end('invalid'), /expects a number and a string/)
    assert.throws(() => ws.end(1000.5), /must be an integer/)
    assert.throws(() => ws.end(1005), /valid WebSocket close code/)
    assert.throws(() => ws.end(0, 'ignored'), /requires a non-zero close code/)
    assert.throws(() => ws.end(1000, 'x'.repeat(124)), /at most 123 UTF-8 bytes/)
    ws.send('open')
  },
  message(ws, message, isBinary) {
    const text = isBinary ? null : Buffer.from(message).toString()

    if (text === 'server-close') {
      assert.equal(ws.close(), ws)
      return
    }

    if (text === 'server-end') {
      assert.equal(ws.end(4001, 'server done'), ws)
      return
    }

    ws.send(message, isBinary)
  },
  close(ws, code, reason) {
    closedSocket = ws
    closeCount++
    socketCloses.push({ code, reason: Buffer.from(reason).toString() })
    assert.throws(() => ws.getBufferedAmount(), /WebSocket is no longer valid/)
  }
})

assert.throws(() => app.ws('/invalid-idle', { idleTimeout: 1 }), /must be 0 or between 8 and 960/)
assert.throws(() => app.ws('/invalid-payload', { maxPayloadLength: 0 }), /between 1 and/)
assert.throws(() => app.ws('/invalid-backpressure', { maxBackpressure: -1 }), /between 0 and/)
assert.throws(() => app.ws('/invalid-close-limit', { closeOnBackpressureLimit: 'yes' }), /must be a boolean/)
assert.throws(() => app.ws('/invalid-drain', { drain: true }), /handlers must be functions/)

app.ws('/limited', {
  maxPayloadLength: 16,
  idleTimeout: 8,
  maxBackpressure: 1024,
  closeOnBackpressureLimit: true,
  message() {
    limitedMessageCount++
  },
  close() {
    limitedCloseCount++
    resolveLimitedClose()
  }
})

app.ws('/drain', {
  maxPayloadLength: 1024,
  idleTimeout: 120,
  maxBackpressure: 32 * 1024 * 1024,
  closeOnBackpressureLimit: false,
  open(ws) {
    const payload = 'x'.repeat(256 * 1024)

    for (let index = 0; index < 64; index++) {
      if (ws.send(payload) === 0) {
        backpressureObserved = true
        return
      }
    }

    ws.end(4500, 'backpressure not observed')
  },
  drain(ws) {
    drainCount++
    assert.ok(ws.getBufferedAmount() >= 0)
    ws.end(1000, 'drained')
    resolveDrained()
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
    headers: { 'x-request-test': 'request-metadata' },
    signal: AbortSignal.timeout(5_000)
  })

  assert.equal(metadataResponse.status, 418)
  assert.equal(metadataResponse.headers.get('content-type'), 'application/json')
  assert.equal(metadataResponse.headers.get('x-swm-test'), 'metadata')
  assert.deepEqual(await metadataResponse.json(), { ok: false })
  assert.throws(() => completedRequest.getUrl(), /HTTP request is no longer valid/)

  for (const [method, path, expectedBody] of [
    ['POST', '/method/post', 'post'],
    ['PUT', '/method/put', 'put'],
    ['PATCH', '/method/patch', 'patch'],
    ['DELETE', '/method/delete', 'delete'],
    ['OPTIONS', '/method/options', 'options'],
    ['HEAD', '/method/head', ''],
    ['DELETE', '/method/any', 'delete']
  ]) {
    const methodResponse = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      signal: AbortSignal.timeout(5_000)
    })

    assert.equal(methodResponse.status, 200)
    assert.equal(methodResponse.headers.get('x-request-method'), method.toLowerCase())
    assert.equal(await methodResponse.text(), expectedBody)
  }

  const requestBody = Uint8Array.from({ length: 128 * 1024 }, (_, index) => index % 251)
  const bodyResponse = await fetch(`http://127.0.0.1:${port}/body`, {
    method: 'POST',
    body: requestBody,
    signal: AbortSignal.timeout(5_000)
  })

  assert.equal(bodyResponse.status, 200)
  assert.equal(bodyResponse.headers.get('content-type'), 'application/octet-stream')
  assert.equal(await bodyResponse.text(), Buffer.from(requestBody).toString('hex'))
  assert.throws(() => completedBodyResponse.end('late'), /HTTP response is no longer valid/)

  await abortRequest()
  await withTimeout(aborted, 5_000, 'HTTP abort callback timed out')
  assert.equal(abortCount, 1)
  assert.throws(() => abortedResponse.onData(() => {}), /HTTP response is no longer valid/)

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

  const immediateClient = await openWebSocketClient()
  const immediateClose = nextClose(immediateClient)
  immediateClient.send('server-close')
  const immediateCloseEvent = await immediateClose
  assert.equal(immediateCloseEvent.code, 1006)

  const limitedClient = new WebSocket(`ws://127.0.0.1:${port}/limited`)
  const limitedClientClose = nextClose(limitedClient)
  await nextOpen(limitedClient)
  limitedClient.send('this payload is too long')
  await withTimeout(limitedClosed, 5_000, 'limited WebSocket close callback timed out')
  const limitedCloseEvent = await withTimeout(limitedClientClose, 5_000, 'limited WebSocket client close timed out')
  assert.equal(limitedCloseEvent.code, 1006)
  assert.equal(limitedMessageCount, 0)
  assert.equal(limitedCloseCount, 1)

  const drainClient = new WebSocket(`ws://127.0.0.1:${port}/drain`)
  const drainClientClose = nextClose(drainClient)
  await nextOpen(drainClient)
  await withTimeout(drained, 5_000, 'WebSocket drain callback timed out')
  const drainCloseEvent = await withTimeout(drainClientClose, 5_000, 'drain WebSocket close timed out')
  assert.equal(backpressureObserved, true)
  assert.equal(drainCount, 1)
  assert.equal(drainCloseEvent.code, 1000)
  assert.equal(drainCloseEvent.reason, 'drained')

  const forcedClose = nextClose(client)
  assert.equal(app.close(), app)
  assert.equal(app.close(), app)
  assert.throws(() => app.listen(host, port, () => {}), /app\.listen\(\) cannot be called after app\.close\(\)/)
  const forcedCloseEvent = await forcedClose
  assert.equal(forcedCloseEvent.code, 1006)

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(closeCount, 2)
  assert.deepEqual(socketCloses, [
    { code: 1006, reason: '' },
    { code: 1006, reason: '' }
  ])
  assert.throws(() => closedSocket.send('late'), /WebSocket is no longer valid/)

  console.log(`smoke ok: ${version()}, HTTP + WebSocket on ${port}`)
}

async function openWebSocketClient() {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const greeting = nextMessage(socket)

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('WebSocket open failed')), {
      once: true
    })
  })

  assert.equal(await greeting, 'open')
  return socket
}

function nextClose(socket) {
  return new Promise((resolve) => {
    socket.addEventListener('close', resolve, { once: true })
  })
}

function nextOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('WebSocket open failed')), {
      once: true
    })
  })
}

function abortRequest() {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(`POST /abort HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 1048576\r\n\r\npartial`)
      setImmediate(() => {
        socket.destroy()
        resolve()
      })
    })

    socket.once('error', reject)
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
