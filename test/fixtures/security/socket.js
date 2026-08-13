import assert from 'node:assert/strict'

export const socketCases = {
  async listen(fixture) {
    const { app } = fixture
    const error = fixture.captureUncaught('listen callback failed')

    app.listen('127.0.0.1', 0, () => {
      throw new Error('listen callback failed')
    })
    await error

    const port = await fixture.listen()

    app.get('/ok', (res) => res.end('ok'))
    await fixture.assertNextRequestWorks(port)
  },

  async 'socket-user-data'(fixture) {
    const { app } = fixture
    const symbol = Symbol('socket-data')
    const inherited = { inherited: true }
    const source = Object.create(inherited)

    let getterCalls = 0
    let ownKeysCalls = 0

    const descriptorCalls = new Map()

    source.visible = 'yes'
    source.send = 'must not shadow the binding'
    Object.defineProperty(source, 'hidden', { value: 42 })
    Object.defineProperty(source, 'lazy', {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls++
        throw new Error('lazy getter must not run during wrapping')
      }
    })
    source[symbol] = 'symbol-value'
    const lazyGetter = Object.getOwnPropertyDescriptor(source, 'lazy').get
    const userData = new Proxy(source, {
      ownKeys(target) {
        ownKeysCalls++

        return Reflect.ownKeys(target)
      },
      getOwnPropertyDescriptor(target, key) {
        descriptorCalls.set(key, (descriptorCalls.get(key) || 0) + 1)

        return Reflect.getOwnPropertyDescriptor(target, key)
      }
    })

    app.ws('/data', {
      upgrade(res, req, context) {
        res.upgrade(
          userData,
          req.getHeader('sec-websocket-key'),
          req.getHeader('sec-websocket-protocol'),
          req.getHeader('sec-websocket-extensions'),
          context
        )
      },
      open(ws) {
        assert.equal(ws.visible, 'yes')
        assert.equal(ws.hidden, 42)
        assert.equal(ws[symbol], 'symbol-value')
        assert.equal(Object.hasOwn(ws, 'inherited'), false)
        assert.equal(Object.hasOwn(ws, 'send'), false)
        assert.equal(typeof ws.send, 'function')
        assert.equal(Object.getOwnPropertyDescriptor(ws, 'lazy').get, lazyGetter)
        assert.equal(getterCalls, 0)
        assert.equal(ownKeysCalls, 1)

        for (const key of Reflect.ownKeys(source)) {
          assert.equal(descriptorCalls.get(key), key === 'send' ? undefined : 1)
        }

        ws.send('ready')
      }
    })

    const ownKeysProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys failed')
        }
      }
    )

    app.ws('/proxy-data', {
      upgrade(res, req, context) {
        res.upgrade(ownKeysProxy, req.getHeader('sec-websocket-key'), '', '', context)
      }
    })
    const port = await fixture.listen()
    const client = new WebSocket(`ws://127.0.0.1:${port}/data`)
    const message = await fixture.event(client, 'message')

    assert.equal(message.data, 'ready')
    const closed = fixture.event(client, 'close')

    client.close()
    await closed
    assert.equal(getterCalls, 0)

    const error = fixture.captureUncaught('ownKeys failed')
    const proxyClient = new WebSocket(`ws://127.0.0.1:${port}/proxy-data`)

    proxyClient.addEventListener('error', () => {}, { once: true })
    await error
    await new Promise((resolve) => setImmediate(resolve))
  },

  async 'socket-user-data-descriptor-error'(fixture) {
    const { app } = fixture
    const descriptorProxy = new Proxy(
      { value: 1 },
      {
        getOwnPropertyDescriptor() {
          throw new Error('getOwnPropertyDescriptor failed')
        }
      }
    )

    app.ws('/descriptor-data', {
      upgrade(res, req, context) {
        res.upgrade(descriptorProxy, req.getHeader('sec-websocket-key'), '', '', context)
      }
    })

    const port = await fixture.listen()
    const descriptorError = fixture.captureUncaught('getOwnPropertyDescriptor failed')
    const descriptorClient = new WebSocket(`ws://127.0.0.1:${port}/descriptor-data`)

    descriptorClient.addEventListener('error', () => {}, { once: true })
    await descriptorError
    await new Promise((resolve) => setImmediate(resolve))
  },

  async 'socket-user-data-reentrant-close'(fixture) {
    const { app } = fixture
    const userData = new Proxy(
      {},
      {
        ownKeys() {
          fixture.closeApp()

          return []
        }
      }
    )

    let openCount = 0

    app.ws('/reentrant-close', {
      upgrade(res, req, context) {
        res.upgrade(userData, req.getHeader('sec-websocket-key'), '', '', context)
      },
      open() {
        openCount++
      }
    })

    const port = await fixture.listen()
    const client = new WebSocket(`ws://127.0.0.1:${port}/reentrant-close`)
    const terminated = new Promise((resolve) => {
      const settle = (event) => {
        client.removeEventListener('close', settle)
        client.removeEventListener('error', settle)
        resolve(event.type)
      }

      client.addEventListener('close', settle, { once: true })
      client.addEventListener('error', settle, { once: true })
    })
    const terminationEvent = await terminated

    await new Promise((resolve) => setImmediate(resolve))
    assert.match(terminationEvent, /^(close|error)$/)
    assert.equal(openCount, 0)
  },

  async 'socket-user-data-prototype-has-reentrant-close'(fixture) {
    const { app } = fixture

    let hasCount = 0
    let openCount = 0
    let socketPrototype

    app.ws('/seed', {
      open(socket) {
        socketPrototype = Object.getPrototypeOf(socket)
        socket.send('ready')
      }
    })
    app.ws('/trigger', {
      upgrade(res, req, context) {
        res.upgrade({ field: 1 }, req.getHeader('sec-websocket-key'), '', '', context)
      },
      open() {
        openCount++
      }
    })

    const port = await fixture.listen()
    const seed = new WebSocket(`ws://127.0.0.1:${port}/seed`)
    const seedMessage = await fixture.event(seed, 'message')

    assert.equal(seedMessage.data, 'ready')
    const seedClosed = fixture.event(seed, 'close')

    seed.close()
    await seedClosed

    const originalParent = Object.getPrototypeOf(socketPrototype)
    const parentProxy = new Proxy(originalParent, {
      has(target, key) {
        hasCount++
        fixture.closeApp()

        return Reflect.has(target, key)
      }
    })

    Object.setPrototypeOf(socketPrototype, parentProxy)

    const client = new WebSocket(`ws://127.0.0.1:${port}/trigger`)
    const terminationEvent = await new Promise((resolve) => {
      const settle = (event) => {
        client.removeEventListener('close', settle)
        client.removeEventListener('error', settle)
        resolve(event.type)
      }

      client.addEventListener('close', settle, { once: true })
      client.addEventListener('error', settle, { once: true })
    })

    await new Promise((resolve) => setImmediate(resolve))
    assert.match(terminationEvent, /^(close|error)$/)
    assert.equal(hasCount, 1)
    assert.equal(openCount, 0)
  }
}
