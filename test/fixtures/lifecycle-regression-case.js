import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setImmediate as turn, setTimeout as delay } from 'node:timers/promises'

import { RequestPrefetchPlan, createApp, us_listen_socket_close } from '../../lib/index.js'
import { withTimeout, waitFor } from '../helpers/async.js'
import { NativeAppServer } from '../helpers/native-app-server.js'
import { rawHttpExchange } from '../helpers/raw-http.js'
import { DEFAULT_WEBSOCKET_KEY, readResponseHead, webSocketHandshakeRequest } from '../helpers/raw-websocket.js'
import { connectedSocket, rssSnapshot, write } from './resource/common.js'

const scenario = process.argv[2]
const app = createApp({ http: { keepAliveTimeoutMs: 1, maxHeaderSize: 2 * 1024 * 1024 } })
const sockets = []

let server

async function connect() {
  const socket = await connectedSocket(server.port)

  sockets.push(socket)

  return socket
}

async function exchange(request) {
  return rawHttpExchange({ host: '127.0.0.1', port: server.port }, request, {
    yieldBetweenChunks: true,
    timeoutMs: 12_000
  })
}

async function collectGarbage() {
  for (let index = 0; index < 6; index++) {
    await turn()
    global.gc()
  }
}

function trackHandler(register) {
  const payload = Buffer.alloc(1024)
  const handler = () => payload.byteLength
  const reference = new WeakRef(handler)

  register(handler)

  return reference
}

try {
  if (scenario.startsWith('yield-') || scenario === 'upgrade-yield') {
    let firstResponse
    let callbacks = 0

    const first = (res, req) => {
      firstResponse = res

      if (scenario === 'yield-promoted') {
        res.onAborted(() => assert.fail('yielded response aborted'))
      }

      req.setYield(true)
    }

    if (scenario === 'upgrade-yield') {
      app.ws('/yield', { upgrade: first })
    } else {
      app.get('/yield', first)
    }

    app.any('/*', (res, req) => {
      callbacks++
      assert.throws(() => firstResponse.end('stale'), /no longer valid/)
      assert.equal(req.getHeader('x-long').length, 8192)
      res.end(req.getUrl())
    })
    server = await NativeAppServer.listen(app)
    const result = await exchange([
      'GET /yield HTTP/1.1\r\nHost: localhost\r\nx-long: ',
      `${'x'.repeat(8192)}\r\nSec-WebSocket-Key: ${DEFAULT_WEBSOCKET_KEY}\r\nConnection: close\r\n\r\n`
    ])

    assert.match(result.toString(), /200 OK/)
    assert.match(result.toString(), /\/yield$/)
    assert.equal(callbacks, 1)
  } else if (scenario.startsWith('upgrade-')) {
    let deliveries = 0
    let opened = 0

    const handler = scenario.replace(/-(fixed|chunked)$/, '')

    app.ws('/ws', {
      upgrade(res, req, context) {
        const key = req.getHeader('sec-websocket-key')
        const upgrade = () => {
          deliveries++
          res.upgrade({ marker: 'alive' }, key, '', '', context)
        }

        if (handler === 'upgrade-on-data') {
          res.onData((chunk, final) => {
            if (final) {
              upgrade()
            }
          })
        } else if (handler === 'upgrade-on-data-v2') {
          res.onDataV2((chunk, remaining) => {
            if (remaining === 0n) {
              upgrade()
            }
          })
        } else if (handler === 'upgrade-collect') {
          res.collectBody(64, upgrade)
        } else {
          res.collectBodyWithLength(64, upgrade)
        }
      },
      open(ws) {
        opened++
        ws.send(ws.marker)
        ws.end(1000, 'done')
      }
    })
    server = await NativeAppServer.listen(app)
    const request = webSocketHandshakeRequest()

    let chunks = [request]

    if (scenario.endsWith('-fixed')) {
      chunks = [request.replace(/\r\n\r\n$/, '\r\nContent-Length: 2\r\n\r\na'), 'b']
    } else if (scenario.endsWith('-chunked')) {
      chunks = [request.replace(/\r\n\r\n$/, '\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n'), '1\r\nb\r\n0\r\n\r\n']
    }

    const result = await exchange(chunks)

    assert.match(result.toString(), /101 Switching Protocols/)
    assert.ok(result.includes('alive'))
    assert.equal(deliveries, 1)
    assert.equal(opened, 1)
  } else if (scenario === 'filter-closed-response') {
    let response
    let aborted = 0
    let closedFilters = 0

    app.filter((res, count) => {
      if (count >= 0) {
        return
      }

      closedFilters++
      assert.throws(() => res.onAborted(() => {}), /no longer valid/)
      assert.throws(() => res.onData(() => {}), /no longer valid/)
      assert.throws(() => res.end('closed'), /no longer valid/)
      assert.ok(res.getRemoteAddress() instanceof ArrayBuffer)
    })
    app.get('/', (res) => {
      response = res
      res.onAborted(() => aborted++)
    })
    server = await NativeAppServer.listen(app)
    const socket = await connect()

    socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n')
    await waitFor(() => response !== undefined, 5000)
    socket.destroy()
    await waitFor(() => aborted === 1, 5000)
    await collectGarbage()
    assert.equal(closedFilters, 1)
    assert.throws(() => response.end('stale'), /no longer valid/)
  } else if (scenario.endsWith('response-timeout')) {
    app.post('/', (res) => {
      if (scenario === 'early-response-timeout') {
        res.onData(() => assert.fail('ended response received data'))
        res.end('early')
      } else {
        res.collectBody(1, (body) => {
          assert.equal(body, null)
          res.writeStatus('413 Payload Too Large').end('limit')
        })
      }
    })
    server = await NativeAppServer.listen(app)
    const socket = await connect()
    const head = readResponseHead(socket)
    const closed = once(socket, 'close')

    socket.write('POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 3\r\n\r\nab')
    await head
    socket.write('c')
    socket.resume()
    await withTimeout(closed, 12_000, 'completed response lost its keep-alive timeout')
    assert.equal(app.getHttpTransportStats().activeConnections, 0)
  } else if (scenario === 'handler-collection') {
    const references = []
    const filters = []

    for (let index = 0; index < 32; index++) {
      references.push(trackHandler((handler) => app.get('/replace', handler)))
      filters.push(trackHandler((handler) => app.filter(handler)))
      references.push(
        trackHandler((handler) => {
          app.listen('127.0.0.1', 0, (token) => {
            handler()
            us_listen_socket_close(token)
          })
        })
      )
      const closedApp = createApp()

      references.push(trackHandler((handler) => closedApp.ws('/*', { open: handler })))
      closedApp.close()
    }

    app.get('/replace', (res) => res.end('ok'))
    await collectGarbage()
    assert.equal(references.filter((ref) => ref.deref() !== undefined).length, 0)
    // Filters are additive and stay registered until their application closes.
    assert.equal(filters.filter((ref) => ref.deref() !== undefined).length, 32)
    app.close()
    await collectGarbage()
    assert.equal(filters.filter((ref) => ref.deref() !== undefined).length, 0)
    assert.equal(app.getHttpTransportStats().activeConnections, 0)
    assert.throws(() => app.get('/', () => {}), /after app.close/)
    app.close()
  } else if (scenario === 'ws-handler-lifetime') {
    const names = ['upgrade', 'open', 'message', 'dropped', 'drain', 'ping', 'pong', 'subscription', 'close']
    const references = names.map((name) => trackHandler((handler) => app.ws(`/${name}`, { [name]: handler })))

    await collectGarbage()

    for (const [index, reference] of references.entries()) {
      assert.notEqual(reference.deref(), undefined, `${names[index]} handler collected while route is active`)
    }

    app.close()
    await collectGarbage()

    for (const [index, reference] of references.entries()) {
      assert.equal(reference.deref(), undefined, `${names[index]} handler retained after app.close()`)
    }
  } else if (scenario === 'ws-handler-registration-failure') {
    const references = []
    const failure = new Error('late handler getter failed')

    references.push(
      trackHandler((handler) => {
        assert.throws(() => app.ws('/invalid', { message: handler, close: 1 }), /handlers must be functions/)
      })
    )
    references.push(
      trackHandler((handler) => {
        assert.throws(
          () =>
            app.ws('/throwing', {
              message: handler,
              get close() {
                throw failure
              }
            }),
          (error) => error === failure
        )
      })
    )

    await collectGarbage()
    assert.equal(references.filter((reference) => reference.deref() !== undefined).length, 0)
    assert.equal(app.getHttpTransportStats().activeConnections, 0)
  } else if (scenario === 'try-end-empty') {
    app.get('/', (res) => {
      assert.deepEqual(res.tryEnd('', 6), [true, false])
      assert.deepEqual(res.tryEnd('abc', 6), [true, false])
      assert.deepEqual(res.tryEnd('', 6), [true, false])
      assert.deepEqual(res.tryEnd('def', 6), [true, true])
      assert.throws(() => res.end('late'), /no longer valid/)
    })
    server = await NativeAppServer.listen(app)
    const result = await exchange(['GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'])

    assert.match(result.toString(), /Content-Length: 6\r\n/)
    assert.match(result.toString(), /\r\n\r\nabcdef$/)
  } else if (scenario === 'prefetch-accounting') {
    const snapshots = []
    const plan = new RequestPrefetchPlan({ headers: 'all' })

    app.get('/', (res, req) => {
      snapshots.push(req.prefetch(plan))
      res.end('ok')
    })
    server = await NativeAppServer.listen(app)
    await collectGarbage()
    const before = process.memoryUsage().external
    const value = 'x'.repeat(1024 * 1024)

    for (let index = 0; index < 12; index++) {
      await exchange([`GET / HTTP/1.1\r\nHost: localhost\r\nX-Large: ${value}\r\nConnection: close\r\n\r\n`])
    }

    await collectGarbage()
    const retained = process.memoryUsage().external

    assert.ok(retained - before >= 12 * 1024 * 1024, 'prefetch payload missing from V8 external memory')
    assert.equal(snapshots[0].getHeader('x-large'), value)
    snapshots.length = 0
    await collectGarbage()
    assert.ok(retained - process.memoryUsage().external > 10 * 1024 * 1024, 'snapshot backing stores retained after GC')
  } else if (scenario === 'collector-buffer-lifetime') {
    const payload = Buffer.alloc(64 * 1024, 0x5a)
    const bodies = []
    const responses = []
    const methods = ['collectBody', 'collectBodyWithLength']

    for (const method of methods) {
      app.post(`/${method}`, (res) => {
        responses.push(new WeakRef(res))
        res[method](payload.length, (body) => {
          bodies.push(body)
          res.end('ok')
        })
      })
    }

    server = await NativeAppServer.listen(app)

    for (const method of methods) {
      const result = await exchange([
        `POST /${method} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: ${payload.length}\r\n\r\n`,
        payload.subarray(0, payload.length / 2),
        payload.subarray(payload.length / 2)
      ])

      assert.match(result.toString(), /200 OK/)
    }

    server.close()
    await collectGarbage()
    assert.equal(bodies.length, methods.length)
    assert.ok(responses.every((reference) => reference.deref() === undefined))

    for (const body of bodies) {
      assert.ok(body instanceof ArrayBuffer)
      assert.deepEqual(Buffer.from(body), payload, 'collected body must outlive its response and application')
    }
  } else if (scenario.startsWith('collector-')) {
    const responses = []
    const chunkBytes = 16 * 1024 * 1024

    let overflowCount = 0

    app.post('/', (res) => {
      responses.push(res)
      res.collectBody(scenario === 'collector-overflow' ? chunkBytes : 64 * 1024 * 1024, (body) => {
        assert.equal(body, null)
        overflowCount++
      })
    })
    server = await NativeAppServer.listen(app)
    const payload = Buffer.alloc(chunkBytes, 65)
    const baseline = await rssSnapshot()

    for (let index = 0; index < 5; index++) {
      const socket = await connect()

      await write(socket, 'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 67108864\r\n\r\n')
      await write(socket, payload)
    }

    await waitFor(() => process.memoryUsage().rss - baseline.rssBytes > 64 * 1024 * 1024, 5000, {
      description: 'collector allocations'
    })
    await delay(250)
    const retained = await rssSnapshot()

    if (scenario === 'collector-discard') {
      for (const res of responses) {
        res.discardBody()
      }
    } else {
      for (const socket of sockets) {
        await write(socket, 'x')
      }

      await waitFor(() => overflowCount === 5, 5000)
    }

    const released = await rssSnapshot()

    assert.ok(
      retained.rssBytes - released.rssBytes > 48 * 1024 * 1024,
      `cancelled collectors retained memory: before=${retained.rssBytes}, after=${released.rssBytes}`
    )
    assert.equal(app.getHttpTransportStats().activeConnections, 5)
    assert.equal(overflowCount, scenario === 'collector-overflow' ? 5 : 0)
  } else {
    assert.fail(`unknown scenario: ${scenario}`)
  }

  console.log(`lifecycle case ok: ${scenario}`)
} finally {
  for (const socket of sockets) {
    socket.destroy()
  }

  if (server) {
    server.close()
  } else {
    app.close()
  }
}
