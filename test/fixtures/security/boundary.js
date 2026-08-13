import assert from 'node:assert/strict'

import { RequestPrefetchPlan, createApp, us_listen_socket_close, us_socket_local_port } from '../../../lib/index.js'

export const boundaryCases = {
  async 'upgrade-async-context'(fixture) {
    const { app } = fixture

    let abortedCount = 0

    app.ws('/async', {
      async upgrade(res, req, context) {
        res.onAborted(() => {
          abortedCount++
        })
        const key = req.getHeader('sec-websocket-key')
        const protocol = req.getHeader('sec-websocket-protocol')
        const extensions = req.getHeader('sec-websocket-extensions')

        await Promise.resolve()
        res.upgrade({ ready: true }, key, protocol, extensions, context)
      },
      open(ws) {
        ws.send(ws.ready ? 'ready' : 'missing')
      }
    })

    const port = await fixture.listen()
    const client = new WebSocket(`ws://127.0.0.1:${port}/async`)
    const message = await fixture.event(client, 'message')

    assert.equal(message.data, 'ready')
    const closed = fixture.event(client, 'close')

    client.close()
    await closed
    assert.equal(abortedCount, 0)
  },

  async 'filter-reentrant-registration'(fixture) {
    const { app } = fixture

    let abortedCount = 0
    let openCount = 0
    let retainedResponse

    app.filter((res, count) => {
      if (count !== 1) {
        return
      }

      openCount++
      retainedResponse = res
      res.onAborted(() => {
        abortedCount++
      })
      assert.throws(() => app.filter(() => {}), /app\.filter\(\) cannot be called from a filter callback/)
    })
    app.get('/ok', (res) => res.end('ok'))

    const port = await fixture.listen()

    await fixture.assertNextRequestWorks(port)
    assert.equal(openCount, 1)
    assert.equal(abortedCount, 0)
    assert.throws(() => retainedResponse.end('late'), /HTTP response is no longer valid/)
  },

  async 'filter-nested-close-registration'(fixture) {
    const { app } = fixture

    let closeCount = 0
    let openCallbackActive = false
    let openCount = 0

    app.filter((res, count) => {
      if (count < 0) {
        assert.equal(openCallbackActive, true)
        closeCount++

        return
      }

      openCount++
      openCallbackActive = true
      res.close()
      assert.equal(closeCount, 1)
      assert.throws(() => app.filter(() => {}), /app\.filter\(\) cannot be called from a filter callback/)
      openCallbackActive = false
    })

    const port = await fixture.listen()

    try {
      await fixture.rawRequest(port, ['GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'])
    } catch (error) {
      assert.equal(error.code, 'ECONNRESET')
    }
    assert.equal(openCount, 1)
    assert.equal(closeCount, 1)
  },

  async 'route-reentrant-registration'(fixture) {
    const { app } = fixture

    let callbackCount = 0

    app.get('/mutate', (res) => {
      callbackCount++
      assert.throws(
        () => app.get('/late', () => {}),
        /app routes cannot be registered from an active HTTP route callback/
      )
      assert.throws(() => app.ws('/late', {}), /app\.ws\(\) cannot be called from an active HTTP route callback/)
      res.end('ok')
    })

    const port = await fixture.listen()
    const response = await fixture.rawRequest(port, [
      'GET /mutate HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    ])

    assert.match(response, /ok$/)
    assert.equal(callbackCount, 1)
  },

  async 'array-prototype-output-boundaries'(fixture) {
    const { app } = fixture

    let plan
    let setterCount = 0

    const selectedHeaders = ['host']

    Object.defineProperty(selectedHeaders, 0, {
      get() {
        selectedHeaders.length = 65_536

        return 'host'
      }
    })

    const installSetter = () => {
      Object.defineProperty(Array.prototype, 0, {
        configurable: true,
        set() {
          setterCount++
        }
      })
    }

    installSetter()
    try {
      plan = new RequestPrefetchPlan({ headers: selectedHeaders })
    } finally {
      delete Array.prototype[0]
    }

    assert.equal(setterCount, 0)
    assert.deepEqual(plan.headerNames, ['host'])

    app.get('/prefetch', (res, req) => {
      const snapshot = req.prefetch(plan)

      let entries
      let values

      installSetter()
      try {
        values = snapshot.getHeaderValues('host')
        entries = snapshot.getHeaderEntries()
      } finally {
        delete Array.prototype[0]
      }

      assert.equal(setterCount, 0)
      assert.deepEqual(values, ['localhost'])
      assert.deepEqual(entries, ['host', 'localhost'])
      res.end('ok')
    })

    const port = await fixture.listen()
    const response = await fixture.rawRequest(port, [
      'GET /prefetch HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    ])

    assert.match(response, /ok$/)
    assert.equal(setterCount, 0)
  },

  async 'app-closed-lifecycle'() {
    const app = createApp()

    assert.equal(app.close(), app)
    assert.equal(app.close(), app)
    assert.throws(() => app.get('/late', () => {}), /cannot be registered after app\.close\(\)/)
    assert.throws(() => app.filter(() => {}), /cannot be called after app\.close\(\)/)
    assert.throws(() => app.ws('/late', {}), /cannot be called after app\.close\(\)/)
    assert.throws(() => app.listen(0, () => {}), /cannot be called after app\.close\(\)/)
    assert.equal(app.publish('topic', 'message'), false)
    assert.equal(app.numSubscribers('topic'), 0)

    const reentrantApp = createApp()
    const behavior = new Proxy(
      {},
      {
        get() {
          reentrantApp.close()

          return undefined
        }
      }
    )

    assert.throws(() => reentrantApp.ws('/reentrant', behavior), /cannot be called after app\.close\(\)/)
  },

  async 'receiver-guards'(fixture) {
    const { app } = fixture
    const plan = new RequestPrefetchPlan({ headers: ['host'] })

    assert.throws(() => app.get.call({}, '/', () => {}), /App method called with incompatible receiver/)

    app.get('/receiver', (res, req) => {
      const snapshot = req.prefetch(plan)

      assert.throws(() => app.get.call(req, '/wrong', () => {}), /App method called with incompatible receiver/)
      assert.throws(() => req.getUrl.call(app), /HTTP request method called with incompatible receiver/)
      assert.throws(() => res.end.call(req, 'wrong'), /HTTP response method called with incompatible receiver/)
      assert.throws(() => snapshot.getHeader.call(res, 'host'), /invalid RequestPrefetchSnapshot receiver/)
      res.end('ok')
    })

    app.ws('/receiver', {
      open(ws) {
        assert.throws(() => ws.send.call(app, 'wrong'), /WebSocket method called with incompatible receiver/)
        assert.throws(() => app.ws.call(ws, '/wrong', {}), /App method called with incompatible receiver/)
        ws.send('ready')
      }
    })

    const port = await fixture.listen()
    const response = await fixture.rawRequest(port, [
      'GET /receiver HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    ])

    assert.match(response, /ok$/)

    const client = new WebSocket(`ws://127.0.0.1:${port}/receiver`)
    const message = await fixture.event(client, 'message')

    assert.equal(message.data, 'ready')
    const closed = fixture.event(client, 'close')

    client.close()
    await closed
  },

  async 'external-token-guards'(fixture) {
    const { app } = fixture

    let previousUpgradeContext

    const behavior = {
      upgrade(res, req, context) {
        const key = req.getHeader('sec-websocket-key')

        assert.throws(
          () => us_socket_local_port(context),
          /us_socket_local_port\(socket\) expects a live listen socket/
        )
        assert.throws(
          () => us_listen_socket_close(context),
          /us_listen_socket_close\(socket\) expects a live listen socket/
        )
        assert.throws(() => res.upgrade({}, key, '', '', fixture.listenSocket), /active WebSocket upgrade context/)

        if (previousUpgradeContext) {
          assert.throws(() => res.upgrade({}, key, '', '', previousUpgradeContext), /active WebSocket upgrade context/)
        }

        previousUpgradeContext = context
        res.upgrade({}, key, '', '', context)
      },
      open(ws) {
        ws.send('ready')
      }
    }

    app.ws('/first', behavior)
    app.ws('/second', behavior)

    const port = await fixture.listen()

    assert.equal(us_socket_local_port(fixture.listenSocket), port)

    for (const path of ['/first', '/second']) {
      const client = new WebSocket(`ws://127.0.0.1:${port}${path}`)
      const message = await fixture.event(client, 'message')

      assert.equal(message.data, 'ready')
      const closed = fixture.event(client, 'close')

      client.close()
      await closed
    }

    assert.throws(
      () => us_socket_local_port(previousUpgradeContext),
      /us_socket_local_port\(socket\) expects a live listen socket/
    )

    const secondaryApp = createApp()
    const secondarySocket = await new Promise((resolve, reject) => {
      secondaryApp.listen('127.0.0.1', 0, (socket) => {
        if (socket) {
          resolve(socket)
        } else {
          reject(new Error('secondary listen failed'))
        }
      })
    })

    assert.ok(us_socket_local_port(secondarySocket) > 0)
    us_listen_socket_close(secondarySocket)
    assert.throws(
      () => us_listen_socket_close(secondarySocket),
      /us_listen_socket_close\(socket\) expects a live listen socket/
    )
    assert.throws(
      () => us_socket_local_port(secondarySocket),
      /us_socket_local_port\(socket\) expects a live listen socket/
    )
    secondaryApp.close()
  }
}
