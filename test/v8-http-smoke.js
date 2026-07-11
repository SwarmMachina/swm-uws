import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createConnection } from 'node:net'

const require = createRequire(import.meta.url)
const { App, createApp, us_listen_socket_close, version } = require('../build/Release/swm_uws.node')
const port = 40_000 + (process.pid % 10_000)
const app = App()

assert.equal(version(), '0.3.1+uWebSockets-v20.67.0')
assert.equal(typeof createApp, 'function')

let completedResponse
let completedRequest
let completedBodyResponse
let abortedResponse
let detachedChunk
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
  const headers = new Map()
  req.forEach((name, value) => headers.set(name, value))
  assert.equal(headers.get('x-request-test'), 'request-metadata')

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

app.get('/query/:id', (res, req) => {
  assert.equal(req.getParameter(0), '42')
  assert.equal(req.getQuery(), 'key=value&empty=')
  assert.equal(req.getQuery('key'), 'value')
  assert.equal(req.getQuery('empty'), '')
  assert.equal(req.getQuery('missing'), undefined)
  const address = res.getRemoteAddressAsText()
  assert.ok(address instanceof ArrayBuffer)
  assert.ok(Buffer.from(address).toString('utf8').length > 0)
  assert.equal(
    res.cork(() => {
      res.writeStatus('200 OK')
      res.writeHeader('content-type', 'application/octet-stream')
      res.end(Uint8Array.from([1, 2, 3]))
    }),
    res
  )
})

app.get('/stream', (res) => {
  assert.equal(typeof res.getWriteOffset(), 'number')
  assert.equal(res.write('a'), true)
  assert.equal(res.write(Uint8Array.from([98])), true)
  res.end('c')
})

app.get('/try-end', (res) => {
  res.onAborted(() => assert.fail('completed tryEnd request must not abort'))
  assert.deepEqual(res.tryEnd(Uint8Array.from([111, 107]), 2), [true, true])
  assert.throws(() => res.getWriteOffset(), /HTTP response is no longer valid/)
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
    res.onAborted(() => assert.fail('completed body request must not abort')),
    res
  )
  assert.equal(
    res.onData((chunk, isLast) => {
      assert.ok(chunk instanceof ArrayBuffer)
      chunks.push(Buffer.from(new Uint8Array(chunk)))
      detachedChunk = chunk
      if (isLast) {
        res.writeHeader('content-type', 'application/octet-stream').end(Buffer.concat(chunks).toString('hex'))
      }
    }),
    res
  )
  assert.throws(() => res.onData(() => {}), /already registered/)
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

let listenSocket
await new Promise((resolve, reject) => {
  app.listen(port, (socket) => {
    if (socket) {
      listenSocket = socket
      resolve()
    } else reject(new Error(`listen failed on 127.0.0.1:${port}`))
  })
})

const response = await fetch(`http://127.0.0.1:${port}/`)
assert.equal(response.status, 200)
assert.equal(await response.text(), 'ok')
assert.throws(() => completedResponse.end('late'), /HTTP response is no longer valid/)

const metadataResponse = await fetch(`http://127.0.0.1:${port}/metadata`, {
  headers: { 'x-request-test': 'request-metadata' }
})
assert.equal(metadataResponse.status, 418)
assert.equal(metadataResponse.headers.get('content-type'), 'application/json')
assert.equal(metadataResponse.headers.get('x-swm-test'), 'metadata')
assert.deepEqual(await metadataResponse.json(), { ok: false })
assert.throws(() => completedRequest.getUrl(), /HTTP request is no longer valid/)

const queryResponse = await fetch(`http://127.0.0.1:${port}/query/42?key=value&empty=`)
assert.equal(queryResponse.status, 200)
assert.deepEqual(new Uint8Array(await queryResponse.arrayBuffer()), Uint8Array.from([1, 2, 3]))

const streamResponse = await fetch(`http://127.0.0.1:${port}/stream`)
assert.equal(await streamResponse.text(), 'abc')

const tryEndResponse = await fetch(`http://127.0.0.1:${port}/try-end`)
assert.equal(await tryEndResponse.text(), 'ok')

for (const [method, path, expectedBody] of [
  ['POST', '/method/post', 'post'],
  ['PUT', '/method/put', 'put'],
  ['PATCH', '/method/patch', 'patch'],
  ['DELETE', '/method/delete', 'delete'],
  ['OPTIONS', '/method/options', 'options'],
  ['HEAD', '/method/head', ''],
  ['DELETE', '/method/any', 'delete']
]) {
  const methodResponse = await fetch(`http://127.0.0.1:${port}${path}`, { method })
  assert.equal(methodResponse.status, 200)
  assert.equal(methodResponse.headers.get('x-request-method'), method.toLowerCase())
  assert.equal(await methodResponse.text(), expectedBody)
}

const requestBody = Uint8Array.from({ length: 128 * 1024 }, (_, index) => index % 251)
const bodyResponse = await fetch(`http://127.0.0.1:${port}/body`, {
  method: 'POST',
  body: requestBody
})
assert.equal(bodyResponse.status, 200)
assert.equal(bodyResponse.headers.get('content-type'), 'application/octet-stream')
assert.equal(await bodyResponse.text(), Buffer.from(requestBody).toString('hex'))
assert.equal(detachedChunk.byteLength, 0)
assert.throws(() => completedBodyResponse.end('late'), /HTTP response is no longer valid/)

await abortRequest()
await withTimeout(aborted, 5_000, 'HTTP abort callback timed out')
assert.equal(abortCount, 1)
assert.throws(() => abortedResponse.onData(() => {}), /HTTP response is no longer valid/)

us_listen_socket_close(listenSocket)
assert.equal(app.close(), app)
assert.equal(app.close(), app)
assert.throws(() => app.close('invalid'), /does not accept arguments/)
assert.throws(() => app.listen('127.0.0.1', port, () => {}), /cannot be called after app\.close/)
console.log(`raw V8 HTTP smoke ok on ${port}`)

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
