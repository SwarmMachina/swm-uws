import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import test from 'node:test'

import {
  RequestPrefetchPlan,
  capabilities,
  createApp,
  us_listen_socket_close,
  us_socket_local_port
} from '../lib/index.js'

test('HTTP transport options validate synchronously without coercion', () => {
  for (const http of [
    null,
    [],
    { unknown: 1 },
    { maxHeaderSize: 0 },
    { maxHeaderSize: -1 },
    { maxHeaderSize: 1.5 },
    { maxHeaderSize: '4096' },
    { maxHeaderCount: 101 },
    { headersTimeoutMs: 0 },
    { keepAliveTimeoutMs: Number.NaN },
    { bodyIdleTimeoutMs: Number.POSITIVE_INFINITY },
    { minBodyRateBytesPerSec: 0 },
    { responseWriteTimeoutMs: 2 ** 32 }
  ]) {
    assert.throws(() => createApp({ http }), TypeError)
  }

  const app = createApp({
    http: {
      maxHeaderSize: 8192,
      maxHeaderCount: 100,
      headersTimeoutMs: 1,
      keepAliveTimeoutMs: 1,
      bodyIdleTimeoutMs: 1,
      minBodyRateBytesPerSec: null,
      responseWriteTimeoutMs: 1
    }
  })

  assert.deepEqual(app.getHttpTransportStats(), emptyStats())
  app.close()
})

test('UWS_HTTP_MAX_HEADERS_SIZE is a strict deprecated fallback and App option wins', () => {
  const previous = process.env.UWS_HTTP_MAX_HEADERS_SIZE

  try {
    for (const value of ['', '-1', '1.5', '16kb']) {
      process.env.UWS_HTTP_MAX_HEADERS_SIZE = value
      assert.throws(() => createApp(), /UWS_HTTP_MAX_HEADERS_SIZE/)
    }

    process.env.UWS_HTTP_MAX_HEADERS_SIZE = '16384'
    const fallback = createApp()

    fallback.close()

    process.env.UWS_HTTP_MAX_HEADERS_SIZE = 'invalid'
    const override = createApp({ http: { maxHeaderSize: 4096 } })

    override.close()
  } finally {
    if (previous === undefined) {
      delete process.env.UWS_HTTP_MAX_HEADERS_SIZE
    } else {
      process.env.UWS_HTTP_MAX_HEADERS_SIZE = previous
    }
  }
})

test('per-App header size and count limits reject with 431 before HTTP or WebSocket callbacks', async () => {
  const small = createApp({ http: { maxHeaderSize: 96, maxHeaderCount: 3 } })
  const large = createApp({ http: { maxHeaderSize: 4096, maxHeaderCount: 100 } })

  let smallHttpCalls = 0
  let smallUpgradeCalls = 0

  small.get('/http', (res) => {
    smallHttpCalls++
    res.end('small')
  })
  small.ws('/ws', {
    upgrade(res) {
      smallUpgradeCalls++
      res.close()
    }
  })
  large.get('/http', (res) => res.end('large'))

  const smallServer = await listen(small)
  const largeServer = await listen(large)

  try {
    const largeHeader = 'x-long: ' + 'a'.repeat(100)
    const rejected = await rawExchange(smallServer.port, [
      `GET /http HTTP/1.1\r\nhost: localhost\r\n${largeHeader}\r\nconnection: close\r\n\r\n`
    ])

    assert.match(rejected.toString('latin1'), /^HTTP\/1\.1 431 /)

    const accepted = await rawExchange(largeServer.port, [
      `GET /http HTTP/1.1\r\nhost: localhost\r\n${largeHeader}\r\nconnection: close\r\n\r\n`
    ])

    assert.match(accepted.toString('latin1'), /^HTTP\/1\.1 200 /)
    assert.match(accepted.toString('latin1'), /large$/)

    for (const fields of [
      ['host: localhost', 'connection: close'],
      ['host: localhost', 'x-one: 1', 'connection: close']
    ]) {
      const response = await rawExchange(smallServer.port, [`GET /http HTTP/1.1\r\n${fields.join('\r\n')}\r\n\r\n`])

      assert.match(response.toString('latin1'), /^HTTP\/1\.1 200 /)
    }

    const tooMany = await rawExchange(smallServer.port, [
      'GET /http HTTP/1.1\r\nhost: localhost\r\nx-one: 1\r\nx-two: 2\r\nconnection: close\r\n\r\n'
    ])

    assert.match(tooMany.toString('latin1'), /^HTTP\/1\.1 431 /)

    const wsRejected = await rawExchange(smallServer.port, [
      `GET /ws HTTP/1.1\r\nhost: localhost\r\nupgrade: websocket\r\n${largeHeader}\r\n\r\n`
    ])

    assert.match(wsRejected.toString('latin1'), /^HTTP\/1\.1 431 /)
    assert.equal(smallUpgradeCalls, 0)
    assert.equal(smallHttpCalls, 2)

    const stats = small.getHttpTransportStats()

    assert.equal(stats.headerTooLarge, 2)
    assert.equal(stats.headerCountExceeded, 1)
  } finally {
    closeServer(small, smallServer.socket)
    closeServer(large, largeServer.socket)
  }
})

test('fragmented request heads use the same per-App size policy', async () => {
  const app = createApp({ http: { maxHeaderSize: 96 } })

  let calls = 0

  app.get('/', (res) => {
    calls++
    res.end('unexpected')
  })
  const server = await listen(app)

  try {
    const response = await rawExchange(
      server.port,
      ['GET / HTTP/1.1\r\nhost: local', 'host\r\nx-long: ', 'a'.repeat(80), '\r\n\r\n'],
      2
    )

    assert.match(response.toString('latin1'), /^HTTP\/1\.1 431 /)
    assert.equal(calls, 0)
    assert.equal(app.getHttpTransportStats().headerTooLarge, 1)
  } finally {
    closeServer(app, server.socket)
  }
})

test('pipelined requests reapply header policy without mixing responses', async () => {
  const app = createApp({ http: { maxHeaderCount: 3 } })
  const urls = []

  app.get('/*', (res, req) => {
    urls.push(req.getUrl())
    res.end(req.getUrl())
  })
  const server = await listen(app)

  try {
    const accepted = await rawExchange(server.port, [
      'GET /first HTTP/1.1\r\nhost: localhost\r\n\r\n' +
        'GET /second HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n'
    ])

    assert.equal(accepted.toString('latin1').match(/HTTP\/1\.1 200 /g)?.length, 2)
    assert.deepEqual(urls, ['/first', '/second'])

    const rejected = await rawExchange(server.port, [
      'GET /before-limit HTTP/1.1\r\nhost: localhost\r\n\r\n' +
        'GET /over-limit HTTP/1.1\r\nhost: localhost\r\nx-one: 1\r\nx-two: 2\r\nconnection: close\r\n\r\n'
    ])

    assert.doesNotMatch(rejected.toString('latin1'), /HTTP\/1\.1 200 /)
    assert.match(rejected.toString('latin1'), /^HTTP\/1\.1 431 /)
    assert.deepEqual(urls, ['/first', '/second', '/before-limit'])
    assert.equal(app.getHttpTransportStats().headerCountExceeded, 1)
  } finally {
    closeServer(app, server.socket)
  }
})

test('RequestPrefetchPlan is normalized, deduplicated, immutable, and strict', () => {
  const plan = new RequestPrefetchPlan({
    headers: ['Authorization', 'authorization', 'X-Empty']
  })

  assert.deepEqual(plan.headerNames, ['authorization', 'x-empty'])
  assert.equal(Object.isFrozen(plan.headerNames), true)
  assert.equal(Object.isFrozen(plan), true)
  assert.deepEqual(new RequestPrefetchPlan({ headers: [] }).headerNames, [])
  assert.deepEqual(new RequestPrefetchPlan({ headers: 'all' }).headerNames, [])

  for (const count of [1, 2, 4, 8]) {
    const names = Array.from({ length: count }, (_, index) => `x-selected-${index}`)

    assert.deepEqual(new RequestPrefetchPlan({ headers: names }).headerNames, names)
  }

  const cloned = structuredClone(plan)

  assert.equal(cloned instanceof RequestPrefetchPlan, false)

  for (const options of [
    {},
    { headers: 'selected' },
    { headers: [42] },
    { headers: ['bad name'] },
    { headers: [], extra: true }
  ]) {
    assert.throws(() => new RequestPrefetchPlan(options), TypeError)
  }
})

test('selective prefetch preserves missing, empty, duplicates, wire order, and callback lifetime', async () => {
  const app = createApp()
  const selected = new RequestPrefetchPlan({
    headers: ['authorization', 'x-empty', 'cookie', 'set-cookie']
  })
  const all = new RequestPrefetchPlan({ headers: 'all' })
  const none = new RequestPrefetchPlan({ headers: [] })
  const cloned = structuredClone(selected)

  app.get('/selected', (res, req) => respondWithSnapshot(res, req.prefetch(selected)))
  app.get('/all', (res, req) => respondWithSnapshot(res, req.prefetch(all)))
  app.get('/none', (res, req) => respondWithSnapshot(res, req.prefetch(none)))
  app.get('/cloned', (res, req) => {
    assert.throws(() => req.prefetch(cloned), TypeError)
    res.end('rejected')
  })

  const server = await listen(app)
  const request =
    'GET /selected HTTP/1.1\r\n' +
    'host: localhost\r\n' +
    'authorization: first\r\n' +
    'x-empty:\r\n' +
    'cookie: a=1\r\n' +
    'authorization: second\r\n' +
    'cookie: b=2\r\n' +
    'set-cookie: request-value\r\n' +
    'x-unselected: secret\r\n' +
    'connection: close\r\n\r\n'

  try {
    const selectedResult = parseJsonResponse(await rawExchange(server.port, [request]))

    assert.equal(selectedResult.firstAuthorization, 'first')
    assert.deepEqual(selectedResult.authorizations, ['first', 'second'])
    assert.equal(selectedResult.empty, '')
    assert.equal(selectedResult.missing, true)
    assert.equal(selectedResult.nullPrototype, true)
    assert.equal(selectedResult.headers.authorization, 'second')
    assert.equal(selectedResult.headers.cookie, 'b=2')
    assert.equal(selectedResult.headers['x-unselected'], undefined)
    assert.deepEqual(selectedResult.entries, [
      'authorization',
      'first',
      'x-empty',
      '',
      'cookie',
      'a=1',
      'authorization',
      'second',
      'cookie',
      'b=2',
      'set-cookie',
      'request-value'
    ])

    const nextRequest = request
      .replace('authorization: first', 'authorization: third')
      .replace('authorization: second', 'authorization: fourth')
    const nextResult = parseJsonResponse(await rawExchange(server.port, [nextRequest]))

    assert.deepEqual(nextResult.authorizations, ['third', 'fourth'])
    assert.deepEqual(selectedResult.authorizations, ['first', 'second'])

    const allResult = parseJsonResponse(await rawExchange(server.port, [request.replace('/selected', '/all')]))

    assert.equal(allResult.headers['x-unselected'], 'secret')
    assert.equal(allResult.entries[0], 'host')

    const noneResult = parseJsonResponse(await rawExchange(server.port, [request.replace('/selected', '/none')]))

    assert.deepEqual(noneResult.headers, {})
    assert.deepEqual(noneResult.entries, [])

    const clonedResult = await rawExchange(server.port, [request.replace('/selected', '/cloned')])

    assert.match(clonedResult.toString('latin1'), /rejected$/)
  } finally {
    closeServer(app, server.socket)
  }
})

test('header and stalled-body timeout phases increment only their own counters', { timeout: 15_000 }, async () => {
  const app = createApp({
    http: {
      headersTimeoutMs: 250,
      bodyIdleTimeoutMs: 250,
      keepAliveTimeoutMs: 10_000,
      minBodyRateBytesPerSec: null
    }
  })

  let aborts = 0

  app.post('/body', (res) => {
    res.onData(() => {})
    res.onAborted(() => {
      aborts++
    })
  })
  app.get('/ping', (res) => res.end('ok'))
  const rateApp = createApp({
    http: {
      bodyIdleTimeoutMs: 250,
      minBodyRateBytesPerSec: 1_000_000
    }
  })

  let rateAborts = 0

  rateApp.post('/body', (res) => {
    res.onData(() => {})
    res.onAborted(() => {
      rateAborts++
    })
  })
  const writeApp = createApp({ http: { responseWriteTimeoutMs: 250 } })

  let writeAborts = 0

  const blockedPayload = Buffer.alloc(8 * 1024 * 1024, 0x61)

  writeApp.get('/blocked', (res) => {
    res.onAborted(() => {
      writeAborts++
    })
    res.onWritable(() => false)
    res.tryEnd(blockedPayload, blockedPayload.length * 2)
  })
  const idleApp = createApp({
    http: {
      headersTimeoutMs: 10_000,
      keepAliveTimeoutMs: 250
    }
  })

  idleApp.get('/ping', (res) => res.end('ok'))
  const server = await listen(app)
  const rateServer = await listen(rateApp)
  const writeServer = await listen(writeApp)
  const idleServer = await listen(idleApp)

  try {
    const headerSocket = createConnection({ host: '127.0.0.1', port: server.port })
    const bodySocket = createConnection({ host: '127.0.0.1', port: server.port })
    const nextHeaderSocket = createConnection({ host: '127.0.0.1', port: server.port })
    const rateSocket = createConnection({ host: '127.0.0.1', port: rateServer.port })
    const writeSocket = createConnection({ host: '127.0.0.1', port: writeServer.port })
    const stableKeepAliveSocket = createConnection({ host: '127.0.0.1', port: server.port })
    const idleSocket = createConnection({ host: '127.0.0.1', port: idleServer.port })

    await Promise.all([
      onceConnected(headerSocket),
      onceConnected(bodySocket),
      onceConnected(nextHeaderSocket),
      onceConnected(rateSocket),
      onceConnected(writeSocket),
      onceConnected(stableKeepAliveSocket),
      onceConnected(idleSocket)
    ])
    headerSocket.write('GET / HTTP/1.1\r\nhost: localhost')
    bodySocket.write('POST /body HTTP/1.1\r\nhost: localhost\r\ncontent-length: 10\r\n\r\na')
    const firstResponse = onceData(nextHeaderSocket)

    nextHeaderSocket.write('GET /ping HTTP/1.1\r\nhost: localhost\r\n\r\n')
    assert.match((await firstResponse).toString('latin1'), /^HTTP\/1\.1 200 /)
    nextHeaderSocket.write('GET /ping HTTP/1.1\r\nhost: localhost')
    rateSocket.write('POST /body HTTP/1.1\r\nhost: localhost\r\ncontent-length: 10\r\n\r\na')
    writeSocket.pause()
    writeSocket.write('GET /blocked HTTP/1.1\r\nhost: localhost\r\n\r\n')
    const stableResponse = onceData(stableKeepAliveSocket)

    stableKeepAliveSocket.write('GET /ping HTTP/1.1\r\nhost: localhost\r\n\r\n')
    assert.match((await stableResponse).toString('latin1'), /^HTTP\/1\.1 200 /)
    const idleResponse = onceData(idleSocket)

    idleSocket.write('GET /ping HTTP/1.1\r\nhost: localhost\r\n\r\n')
    assert.match((await idleResponse).toString('latin1'), /^HTTP\/1\.1 200 /)

    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(headerSocket.destroyed, false)
    assert.equal(bodySocket.destroyed, false)
    assert.equal(nextHeaderSocket.destroyed, false)
    assert.equal(rateSocket.destroyed, false)
    assert.equal(writeSocket.destroyed, false)
    assert.equal(stableKeepAliveSocket.destroyed, false)
    assert.equal(idleSocket.destroyed, false)

    await waitFor(() => {
      const stats = app.getHttpTransportStats()

      return (
        stats.headerTimeouts === 2 &&
        stats.bodyTimeouts === 1 &&
        rateApp.getHttpTransportStats().bodyRateViolations === 1 &&
        writeApp.getHttpTransportStats().responseWriteTimeouts === 1
      )
    }, 12_000)
    await waitFor(() => idleSocket.destroyed, 12_000)
    assert.equal(stableKeepAliveSocket.destroyed, false)

    for (const socket of [
      headerSocket,
      bodySocket,
      nextHeaderSocket,
      rateSocket,
      writeSocket,
      stableKeepAliveSocket,
      idleSocket
    ]) {
      socket.destroy()
    }

    await new Promise((resolve) => setImmediate(resolve))
    const stats = app.getHttpTransportStats()

    assert.equal(stats.headerTimeouts, 2)
    assert.equal(stats.bodyTimeouts, 1)
    assert.equal(stats.bodyRateViolations, 0)
    assert.equal(stats.responseWriteTimeouts, 0)
    assert.equal(aborts, 1)
    const rateStats = rateApp.getHttpTransportStats()

    assert.equal(rateStats.bodyTimeouts, 0)
    assert.equal(rateStats.bodyRateViolations, 1)
    assert.equal(rateAborts, 1)
    assert.equal(writeApp.getHttpTransportStats().responseWriteTimeouts, 1)
    assert.equal(writeAborts, 1)
  } finally {
    closeServer(app, server.socket)
    closeServer(rateApp, rateServer.socket)
    closeServer(writeApp, writeServer.socket)
    closeServer(idleApp, idleServer.socket)
  }
})

test('capabilities negotiate both native fast paths', () => {
  assert.equal(capabilities().httpTransportConfig, true)
  assert.equal(capabilities().requestPrefetch, true)
})

test('activeConnections counts HTTP sockets and transfers ownership on WebSocket upgrade', async () => {
  const app = createApp()

  let activeAtOpen

  app.ws('/ws', {
    open() {
      activeAtOpen = app.getHttpTransportStats().activeConnections
    }
  })
  const server = await listen(app)
  const socket = createConnection({ host: '127.0.0.1', port: server.port })

  try {
    await onceConnected(socket)
    await waitFor(() => app.getHttpTransportStats().activeConnections === 1, 1000)
    const upgraded = onceData(socket)

    socket.write(
      'GET /ws HTTP/1.1\r\n' +
        'host: localhost\r\n' +
        'connection: Upgrade\r\n' +
        'upgrade: websocket\r\n' +
        'sec-websocket-version: 13\r\n' +
        'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'
    )
    assert.match((await upgraded).toString('latin1'), /^HTTP\/1\.1 101 /)
    await waitFor(() => activeAtOpen !== undefined, 1000)
    assert.equal(activeAtOpen, 0)
    assert.equal(app.getHttpTransportStats().activeConnections, 0)
  } finally {
    socket.destroy()
    closeServer(app, server.socket)
  }
})

function respondWithSnapshot(res, snapshot) {
  res.onAborted(() => {})
  setImmediate(() => {
    const headers = snapshot.getHeaders()

    res.end(
      JSON.stringify({
        firstAuthorization: snapshot.getHeader('authorization'),
        authorizations: snapshot.getHeaderValues('authorization'),
        empty: snapshot.getHeader('x-empty'),
        missing: snapshot.getHeader('x-missing') === undefined,
        nullPrototype: Object.getPrototypeOf(headers) === null,
        headers,
        entries: snapshot.getHeaderEntries()
      })
    )
  })
}

function emptyStats() {
  return {
    activeConnections: 0,
    headerTooLarge: 0,
    headerCountExceeded: 0,
    headerTimeouts: 0,
    bodyTimeouts: 0,
    bodyRateViolations: 0,
    responseWriteTimeouts: 0
  }
}

function listen(app) {
  return new Promise((resolve, reject) => {
    app.listen('127.0.0.1', 0, (socket) => {
      if (!socket) {
        return reject(new Error('listen failed'))
      }

      resolve({ socket, port: us_socket_local_port(socket) })
    })
  })
}

function closeServer(app, socket) {
  if (socket) {
    us_listen_socket_close(socket)
  }

  app.close()
}

function rawExchange(port, chunks, delayMs = 0) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const response = []

    socket.setTimeout(12_000, () => socket.destroy(new Error('raw exchange timed out')))
    socket.on('data', (chunk) => response.push(chunk))
    socket.on('error', reject)
    socket.on('end', () => resolve(Buffer.concat(response)))
    socket.on('connect', async () => {
      for (const chunk of chunks) {
        socket.write(chunk)

        if (delayMs) {
          await delay(delayMs)
        }
      }
    })
  })
}

function parseJsonResponse(response) {
  assert.match(response.toString('latin1'), /^HTTP\/1\.1 200 /)
  const offset = response.indexOf('\r\n\r\n')

  assert.notEqual(offset, -1)

  return JSON.parse(response.subarray(offset + 4).toString())
}

function onceConnected(socket) {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
}

function onceData(socket) {
  return new Promise((resolve, reject) => {
    socket.once('data', resolve)
    socket.once('error', reject)
  })
}

function waitFor(predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const poll = () => {
      if (predicate()) {
        return resolve()
      }

      if (Date.now() >= deadline) {
        return reject(new Error('condition timed out'))
      }

      setTimeout(poll, 25)
    }

    poll()
  })
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
