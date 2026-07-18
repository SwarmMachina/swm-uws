import assert from 'node:assert/strict'
import { createConnection } from 'node:net'

import {
  DISABLED,
  LIBUS_LISTEN_EXCLUSIVE_PORT,
  capabilities,
  createApp,
  us_socket_local_port,
  version
} from '../lib/index.js'
import { resolvePrebuildTarget } from '../lib/load-native.js'

assert.equal(version(), '0.4.1+uWebSockets-v20.69.0')
assert.deepEqual(capabilities(), {
  beginWrite: true,
  collectBody: true,
  requestSnapshot: true,
  responseBatch: true,
  requestPause: true
})
assert.equal(resolvePrebuildTarget('linux', 'x64'), 'linux-x64-glibc')
assert.equal(resolvePrebuildTarget('win32', 'x64'), 'win32-x64')
assert.equal(resolvePrebuildTarget('darwin', 'arm64'), 'darwin-arm64')
assert.equal(resolvePrebuildTarget('darwin', 'x64'), 'darwin-x64')
assert.equal(resolvePrebuildTarget('win32', 'arm64'), null)
assert.equal(DISABLED, 0)
assert.equal(LIBUS_LISTEN_EXCLUSIVE_PORT, 1)

const serveOnly = process.argv.includes('--serve')
const port = serveOnly ? Number(process.env.PORT || 3000) : 30_000 + (process.pid % 10_000)
const host = serveOnly ? '0.0.0.0' : '127.0.0.1'
const app = createApp()
const sharedRoute = new SharedArrayBuffer('/shared-route'.length)
new Uint8Array(sharedRoute).set(Buffer.from('/shared-route'))
const requiredAppMethods = [
  'any',
  'close',
  'connect',
  'del',
  'filter',
  'get',
  'head',
  'listen',
  'listen_unix',
  'numSubscribers',
  'options',
  'patch',
  'post',
  'publish',
  'put',
  'trace',
  'ws'
]
for (const method of requiredAppMethods) assert.equal(typeof app[method], 'function', `app.${method}`)

let completedResponse
let filterCallCount = 0
let emptyResponse
let asyncResponse
let completedRequest
let completedBodyResponse
let abortedResponse
let endWithoutBodyResponse
const v2Chunks = []
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
let pongPayload
let resolvePong
const pongReceived = new Promise((resolve) => {
  resolvePong = resolve
})
let resolveDrained
const drained = new Promise((resolve) => {
  resolveDrained = resolve
})
let abortCount = 0
let resolveAborted
const aborted = new Promise((resolve) => {
  resolveAborted = resolve
})
let resolveResponseClosed
const responseClosed = new Promise((resolve) => {
  resolveResponseClosed = resolve
})

assert.equal(
  app.filter((res, count) => {
    filterCallCount++
    assert.ok(count === 1 || count === -1)
    if (count === 1) assert.ok(res.getRemoteAddressAsText().byteLength > 0)
  }),
  app
)

app.get('/', (res, req) => {
  for (const method of [
    'beginWrite',
    'close',
    'collect',
    'collectBody',
    'cork',
    'end',
    'endWithoutBody',
    'getProxiedRemoteAddress',
    'getProxiedRemoteAddressAsText',
    'getProxiedRemotePort',
    'getRemoteAddress',
    'getRemoteAddressAsText',
    'getRemotePort',
    'getWriteOffset',
    'onAborted',
    'onData',
    'onDataV2',
    'onWritable',
    'pause',
    'resume',
    'tryEnd',
    'upgrade',
    'write',
    'writeHeader',
    'writeStatus'
  ]) {
    assert.equal(typeof res[method], 'function', `res.${method}`)
  }
  for (const method of [
    'forEach',
    'getCaseSensitiveMethod',
    'getHeader',
    'getMethod',
    'getParameter',
    'getQuery',
    'getUrl',
    'setYield'
  ]) {
    assert.equal(typeof req[method], 'function', `req.${method}`)
  }
  assert.equal(req.getCaseSensitiveMethod(), 'GET')
  assert.equal(req.setYield(false), req)
  assert.ok([4, 16].includes(res.getRemoteAddress().byteLength))
  assert.ok(res.getRemoteAddressAsText().byteLength > 0)
  assert.ok(res.getRemotePort() > 0)
  assert.equal(res.getProxiedRemoteAddress().byteLength, 0)
  assert.equal(res.getProxiedRemoteAddressAsText().byteLength, 0)
  assert.equal(res.getProxiedRemotePort(), 0)
  assert.equal(res.pause(), res)
  assert.equal(res.resume(), res)
  completedResponse = res
  res.end('ok')
})

app.get('/without-body', (res) => {
  endWithoutBodyResponse = res
  assert.equal(res.endWithoutBody(0), res)
})

app.get('/close-response', (res) => {
  res.onAborted(() => {
    assert.throws(() => res.end('late'), /HTTP response is no longer valid/)
    resolveResponseClosed()
  })
  assert.equal(res.close(), res)
})

app.post('/data-v2', (res) => {
  res.onAborted(() => assert.fail('onDataV2 request must not abort'))
  assert.equal(
    res.onDataV2((chunk, maxRemainingBodyLength) => {
      assert.ok(chunk instanceof ArrayBuffer)
      assert.equal(typeof maxRemainingBodyLength, 'bigint')
      v2Chunks.push(chunk)
      if (maxRemainingBodyLength === 0n) res.end('v2')
    }),
    res
  )
})

app.get('/parameter/:name', (res, req) => {
  assert.equal(req.getParameter(0), 'alice')
  assert.equal(req.getParameter('name'), 'alice')
  res.end('parameter')
})

app.get('/proxy-info', (res) => {
  assert.deepEqual([...new Uint8Array(res.getProxiedRemoteAddress())], [203, 0, 113, 7])
  assert.equal(Buffer.from(res.getProxiedRemoteAddressAsText()).toString(), '203.0.113.7')
  // Pinned upstream exposes the PROXY v2 network-order field without swapping it.
  assert.equal(res.getProxiedRemotePort(), 0x6eb2)
  res.end('proxy')
})

app.get(sharedRoute, (res) => {
  res.writeHeader(Uint8Array.from(Buffer.from('x-buffer-header')), Uint8Array.from(Buffer.from('yes')))
  res.end('shared')
})

app.get('/empty', (res) => {
  emptyResponse = res
  assert.equal(res.end(), res)
})

const cachedHeaderName = 'x-swm-cached'
const cachedHeaderValue = 'validated'

app.get('/cached-headers', (res) => {
  assert.equal(res.writeHeader(cachedHeaderName, cachedHeaderValue), res)
  assert.throws(() => res.writeHeader(cachedHeaderName, 'value\r\nX-Injected: yes'), /control characters/)
  assert.throws(() => res.writeHeader('invalid name', cachedHeaderValue), /valid HTTP header name/)
  res.end('cached')
})

app.get('/async-end', (res) => {
  asyncResponse = res
  res.onAborted(() => assert.fail('completed async response must not abort'))
  setImmediate(() => res.end('async'))
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

app.get('/batch', (res, req) => {
  const snapshot = req.snapshot()
  assert.equal(snapshot.method, 'get')
  assert.equal(snapshot.url, '/batch')
  assert.equal(snapshot.query, 'mode=fast')
  assert.equal(snapshot.headers['x-snapshot-test'], 'yes')
  assert.equal(Object.getPrototypeOf(snapshot.headers), null)
  assert.throws(() => res.endBatch('200 OK', ['bad header', 'value'], 'bad'), /invalid header/)
  assert.equal(
    res.endBatch('201 Created', ['content-type', 'application/json', 'x-batch', 'yes'], '{"batch":true}'),
    res
  )
})

app.post('/collect', (res) => {
  res.onAborted(() => assert.fail('collected request must not abort'))
  res.collectBody(256 * 1024, (body) => {
    assert.ok(body instanceof ArrayBuffer)
    res.endBatch('200 OK', ['content-type', 'application/octet-stream'], Buffer.from(body).toString('hex'))
  })
})

app.post('/collect-overflow', (res) => {
  res.onAborted(() => assert.fail('overflow request must not abort'))
  res.collectBody(4, (body) => {
    assert.equal(body, null)
    res.endBatch('413 Payload Too Large', [], 'too large')
  })
})

app.get('/stream-begin', (res) => {
  res.onAborted(() => assert.fail('stream request must not abort'))
  res.cork(() => {
    res.writeStatus('200 OK')
    res.writeHeader('content-type', 'text/plain')
    res.beginWrite()
  })
  setImmediate(() => res.end('streamed'))
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
    for (const method of [
      'close',
      'cork',
      'end',
      'getBufferedAmount',
      'getRemoteAddress',
      'getRemoteAddressAsText',
      'getRemotePort',
      'getTopics',
      'getUserData',
      'isSubscribed',
      'ping',
      'publish',
      'send',
      'sendFirstFragment',
      'sendFragment',
      'sendLastFragment',
      'subscribe',
      'unsubscribe'
    ]) {
      assert.equal(typeof ws[method], 'function', `ws.${method}`)
    }
    assert.equal(ws.getBufferedAmount(), 0)
    assert.equal(ws.getUserData(), ws)
    assert.ok([4, 16].includes(ws.getRemoteAddress().byteLength))
    assert.ok(ws.getRemoteAddressAsText().byteLength > 0)
    assert.ok(ws.getRemotePort() > 0)
    assert.equal(ws.subscribe('compat'), true)
    assert.equal(ws.isSubscribed('compat'), true)
    assert.deepEqual(ws.getTopics(), ['compat'])
    assert.ok([0, 1, 2].includes(ws.ping('health')))
    assert.throws(() => ws.getBufferedAmount(1), /does not accept arguments/)
    assert.throws(() => ws.close(1000), /does not accept arguments/)
    assert.throws(() => ws.end('invalid'), /expects a number and a string/)
    assert.throws(() => ws.end(1000.5), /must be an integer/)
    assert.throws(() => ws.end(1005), /valid WebSocket close code/)
    assert.throws(() => ws.end(0, 'ignored'), /requires a non-zero close code/)
    assert.throws(() => ws.end(1000, 'x'.repeat(124)), /at most 123 UTF-8 bytes/)
    assert.equal(
      ws.cork(() => ws.send('open')),
      ws
    )
  },
  message(ws, message, isBinary) {
    const text = isBinary ? null : Buffer.from(message).toString()

    if (text === 'server-close') {
      assert.equal(ws.close(), undefined)
      return
    }

    if (text === 'server-end') {
      assert.equal(ws.end(4001, 'server done'), undefined)
      return
    }

    if (text === 'fragment') {
      ws.cork(() => {
        ws.sendFirstFragment('frag', false, false)
        ws.sendFragment('ment', false)
        ws.sendLastFragment('ed', false)
      })
      return
    }

    ws.send(message, isBinary)
  },
  pong(ws, message) {
    assert.equal(ws.getUserData(), ws)
    assert.equal(Buffer.from(message).toString(), 'health')
    pongPayload = message
    resolvePong()
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
assert.throws(() => app.ws('/unsupported-compression', { compression: 1 }), /compression is disabled/)

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
  app.listen(host, port, 0, (ok) => {
    if (!ok) {
      reject(new Error(`listen failed on ${host}:${port}`))
      return
    }

    assert.equal(us_socket_local_port(ok), port)
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

  const noBodyResponse = await fetch(`http://127.0.0.1:${port}/without-body`, {
    signal: AbortSignal.timeout(5_000)
  })
  assert.equal(noBodyResponse.status, 200)
  assert.equal(await noBodyResponse.text(), '')
  assert.throws(() => endWithoutBodyResponse.end(), /HTTP response is no longer valid/)

  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/close-response`, {
      signal: AbortSignal.timeout(5_000)
    })
  )
  await withTimeout(responseClosed, 5_000, 'response close callback timed out')

  const v2Response = await fetch(`http://127.0.0.1:${port}/data-v2`, {
    method: 'POST',
    body: 'onDataV2',
    signal: AbortSignal.timeout(5_000)
  })
  assert.equal(await v2Response.text(), 'v2')
  assert.ok(v2Chunks.length > 0)
  assert.ok(v2Chunks.every((chunk) => chunk.byteLength === 0))

  const parameterResponse = await fetch(`http://127.0.0.1:${port}/parameter/alice`, {
    signal: AbortSignal.timeout(5_000)
  })
  assert.equal(await parameterResponse.text(), 'parameter')

  const sharedResponse = await fetch(`http://127.0.0.1:${port}/shared-route`, {
    signal: AbortSignal.timeout(5_000)
  })
  assert.equal(sharedResponse.headers.get('x-buffer-header'), 'yes')
  assert.equal(await sharedResponse.text(), 'shared')

  assert.match(await proxyRequest(), /proxy$/)

  const emptyBodyResponse = await fetch(`http://127.0.0.1:${port}/empty`, {
    signal: AbortSignal.timeout(5_000)
  })
  assert.equal(emptyBodyResponse.status, 200)
  assert.equal(await emptyBodyResponse.text(), '')
  assert.throws(() => emptyResponse.end(), /HTTP response is no longer valid/)

  for (let attempt = 0; attempt < 2; attempt++) {
    const cachedHeaderResponse = await fetch(`http://127.0.0.1:${port}/cached-headers`, {
      signal: AbortSignal.timeout(5_000)
    })
    assert.equal(cachedHeaderResponse.headers.get(cachedHeaderName), cachedHeaderValue)
    assert.equal(await cachedHeaderResponse.text(), 'cached')
  }

  const deferredResponse = await fetch(`http://127.0.0.1:${port}/async-end`, {
    signal: AbortSignal.timeout(5_000)
  })
  assert.equal(await deferredResponse.text(), 'async')
  assert.throws(() => asyncResponse.end('late'), /HTTP response is no longer valid/)

  const metadataResponse = await fetch(`http://127.0.0.1:${port}/metadata`, {
    headers: { 'x-request-test': 'request-metadata' },
    signal: AbortSignal.timeout(5_000)
  })

  assert.equal(metadataResponse.status, 418)
  assert.equal(metadataResponse.headers.get('content-type'), 'application/json')
  assert.equal(metadataResponse.headers.get('x-swm-test'), 'metadata')
  assert.deepEqual(await metadataResponse.json(), { ok: false })
  assert.throws(() => completedRequest.getUrl(), /HTTP request is no longer valid/)

  const batchResponse = await fetch(`http://127.0.0.1:${port}/batch?mode=fast`, {
    headers: { 'x-snapshot-test': 'yes' },
    signal: AbortSignal.timeout(5_000)
  })
  assert.equal(batchResponse.status, 201)
  assert.equal(batchResponse.headers.get('x-batch'), 'yes')
  assert.deepEqual(await batchResponse.json(), { batch: true })

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

  const collectedResponse = await fetch(`http://127.0.0.1:${port}/collect`, {
    method: 'POST',
    body: requestBody,
    signal: AbortSignal.timeout(5_000)
  })
  assert.equal(collectedResponse.status, 200)
  assert.equal(await collectedResponse.text(), Buffer.from(requestBody).toString('hex'))

  const overflowResponse = await fetch(`http://127.0.0.1:${port}/collect-overflow`, {
    method: 'POST',
    body: 'overflow',
    signal: AbortSignal.timeout(5_000)
  })
  assert.equal(overflowResponse.status, 413)
  assert.equal(await overflowResponse.text(), 'too large')

  const streamResponse = await fetch(`http://127.0.0.1:${port}/stream-begin`, {
    signal: AbortSignal.timeout(5_000)
  })
  assert.equal(streamResponse.status, 200)
  assert.equal(streamResponse.headers.get('transfer-encoding'), 'chunked')
  assert.equal(await streamResponse.text(), 'streamed')

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
  await withTimeout(pongReceived, 5_000, 'WebSocket pong callback timed out')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(pongPayload.byteLength, 0)

  const textEcho = nextMessage(client)
  client.send('hello')
  assert.equal(await textEcho, 'hello')

  const binaryEcho = nextMessage(client)
  client.send(Uint8Array.from([1, 2, 3, 255]))
  assert.deepEqual(new Uint8Array(await binaryEcho), Uint8Array.from([1, 2, 3, 255]))

  const fragmented = nextMessage(client)
  client.send('fragment')
  assert.equal(await fragmented, 'fragmented')

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
  assert.ok(filterCallCount > 0)

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

function proxyRequest() {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const chunks = []
    socket.setTimeout(5_000, () => socket.destroy(new Error('PROXY request timed out')))
    socket.on('connect', () => {
      const proxyHeader = Buffer.alloc(28)
      Buffer.from('\r\n\r\n\0\r\nQUIT\n', 'binary').copy(proxyHeader)
      proxyHeader[12] = 0x21
      proxyHeader[13] = 0x11
      proxyHeader.writeUInt16BE(12, 14)
      Buffer.from([203, 0, 113, 7, 127, 0, 0, 1]).copy(proxyHeader, 16)
      proxyHeader.writeUInt16BE(45_678, 24)
      proxyHeader.writeUInt16BE(port, 26)
      socket.write(proxyHeader)
      socket.write('GET /proxy-info HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
    })
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('end', () => resolve(Buffer.concat(chunks).toString()))
    socket.on('error', reject)
  })
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
