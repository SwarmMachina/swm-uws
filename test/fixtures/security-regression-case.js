import assert from 'node:assert/strict'
import { createConnection } from 'node:net'

import { createApp, us_listen_socket_close, us_socket_local_port } from '../../lib/index.js'

const scenario = process.argv[2]
const app = createApp()

let listenSocket

const timeout = setTimeout(() => {
  throw new Error(`security case timed out: ${scenario}`)
}, 10_000)

function captureUncaught(message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`uncaught exception was not observed: ${message}`)), 5_000)

    process.on('uncaughtException', (error) => {
      if (error.message !== message) {
        process.removeAllListeners('uncaughtException')
        throw error
      }

      clearTimeout(timer)
      resolve(error)
    })
  })
}

function listen() {
  return new Promise((resolve, reject) => {
    app.listen('127.0.0.1', 0, (socket) => {
      if (!socket) {
        return reject(new Error('listen failed'))
      }

      listenSocket = socket
      resolve(us_socket_local_port(socket))
    })
  })
}

function rawRequest(port, chunks) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const response = []

    socket.setTimeout(5_000, () => socket.destroy(new Error('raw request timed out')))
    socket.on('connect', async () => {
      for (const chunk of chunks) {
        if (socket.destroyed) {
          break
        }

        socket.write(chunk)
        await new Promise((resolve) => setImmediate(resolve))
      }
    })
    socket.on('data', (chunk) => response.push(chunk))
    socket.on('close', () => resolve(Buffer.concat(response).toString()))
    socket.on('error', reject)
  })
}

async function assertNextRequestWorks(port) {
  const response = await rawRequest(port, ['GET /ok HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'])

  assert.match(response, /^HTTP\/1\.1 200/m)
  assert.match(response, /ok$/)
}

const cases = {
  async 'response-cork'() {
    let laterRan = false

    app.get('/bad', (res) => {
      res.cork(() => {
        throw new Error('response cork failed')
      })
      laterRan = true
      res.end('unsafe')
    })
    app.get('/ok', (res) => res.end('ok'))

    const port = await listen()
    const error = captureUncaught('response cork failed')

    await rawRequest(port, ['GET /bad HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'])
    await error
    assert.equal(laterRan, false)
    await assertNextRequestWorks(port)
  },

  async 'framing-exception'() {
    app.get('/bad', (res) => {
      res.beginWrite()
      throw new Error('framing callback failed')
    })
    app.get('/ok', (res) => res.end('ok'))

    const port = await listen()
    const error = captureUncaught('framing callback failed')

    await rawRequest(port, ['GET /bad HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'])
    await error
    await assertNextRequestWorks(port)
  },

  async 'response-writable'() {
    const payload = new Uint8Array(128 * 1024 * 1024)

    let callbackCount = 0
    let abortedCount = 0

    const normalCounts = { true: 0, false: 0, close: 0 }
    const normalResolvers = {}
    const normalResults = Object.fromEntries(
      Object.keys(normalCounts).map((name) => [
        name,
        new Promise((resolve) => {
          normalResolvers[name] = resolve
        })
      ])
    )

    for (const [name, result] of [
      ['true', true],
      ['false', false]
    ]) {
      app.get(`/writable-${name}`, (res) => {
        res.onWritable(() => {
          normalCounts[name]++
          normalResolvers[name]()

          return result
        })
        const [, done] = res.tryEnd(payload, payload.length)

        assert.equal(done, false)
      })
    }

    app.get('/writable-close', (res) => {
      res.onWritable(() => {
        normalCounts.close++
        res.close()
        assert.throws(() => res.end('late'), /HTTP response is no longer valid/)
        normalResolvers.close()

        return true
      })
      const [, done] = res.tryEnd(payload, payload.length)

      assert.equal(done, false)
    })

    app.get('/bad', (res) => {
      res.onAborted(() => abortedCount++)
      res.onWritable(() => {
        callbackCount++
        throw new Error('response writable failed')
      })
      const [, done] = res.tryEnd(payload, payload.length)

      assert.equal(done, false)
    })
    app.get('/ok', (res) => res.end('ok'))

    const port = await listen()

    for (const name of Object.keys(normalCounts)) {
      const socket = createConnection({ host: '127.0.0.1', port }, () => {
        socket.pause()
        socket.write(`GET /writable-${name} HTTP/1.1\r\nHost: localhost\r\n\r\n`)
        setTimeout(() => socket.resume(), 25)
      })

      socket.on('error', () => {})
      await normalResults[name]
      socket.destroy()
      assert.equal(normalCounts[name], 1)
      await assertNextRequestWorks(port)
    }

    const error = captureUncaught('response writable failed')
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.pause()
      socket.write('GET /bad HTTP/1.1\r\nHost: localhost\r\n\r\n')
      setTimeout(() => socket.resume(), 25)
    })

    socket.on('error', () => {})
    await error
    socket.destroy()
    assert.equal(callbackCount, 1)
    assert.equal(abortedCount, 0)
    await assertNextRequestWorks(port)
  },

  async 'request-data'() {
    let callbackCount = 0
    let abortedCount = 0

    app.post('/bad', (res) => {
      res.onAborted(() => abortedCount++)
      res.onData(() => {
        callbackCount++
        throw new Error('request data failed')
      })
    })
    app.get('/ok', (res) => res.end('ok'))

    const port = await listen()
    const error = captureUncaught('request data failed')
    const socket = createConnection({ host: '127.0.0.1', port }, async () => {
      socket.write('POST /bad HTTP/1.1\r\nHost: localhost\r\nContent-Length: 8\r\n\r\none')
      await new Promise((resolve) => setImmediate(resolve))

      if (!socket.destroyed) {
        socket.write('twoth')
      }
    })

    socket.on('error', () => {})
    await error
    socket.destroy()
    assert.equal(callbackCount, 1)
    assert.equal(abortedCount, 0)
    await assertNextRequestWorks(port)
  },

  async 'collect-body'() {
    let callbackCount = 0
    let laterRan = false

    app.post('/bad', (res) => {
      res.collectBody(8, () => {
        callbackCount++
        throw new Error('collect body failed')
      })
      res.onAborted(() => {
        laterRan = true
      })
    })
    app.get('/ok', (res) => res.end('ok'))

    const port = await listen()
    const error = captureUncaught('collect body failed')

    await rawRequest(port, ['POST /bad HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\n\r\nbody'])
    await error
    assert.equal(callbackCount, 1)
    assert.equal(laterRan, false)
    await assertNextRequestWorks(port)
  },

  async 'response-aborted'() {
    let callbackCount = 0

    app.post('/bad', (res) => {
      res.onData(() => {})
      res.onAborted(() => {
        callbackCount++
        throw new Error('response aborted failed')
      })
    })
    app.get('/ok', (res) => res.end('ok'))

    const port = await listen()
    const error = captureUncaught('response aborted failed')
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.write('POST /bad HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\npartial')
      setImmediate(() => socket.destroy())
    })

    socket.on('error', () => {})
    await error
    assert.equal(callbackCount, 1)
    await assertNextRequestWorks(port)
  },

  async 'websocket-message'() {
    let closeCallbackRan = false

    app.ws('/bad', {
      message() {
        throw new Error('websocket message failed')
      },
      close() {
        closeCallbackRan = true
      }
    })

    const port = await listen()
    const error = captureUncaught('websocket message failed')
    const client = new WebSocket(`ws://127.0.0.1:${port}/bad`)

    await event(client, 'open')
    const closed = event(client, 'close')

    client.send('fail')
    await error
    await closed
    assert.equal(closeCallbackRan, false)
  },

  async 'websocket-close'() {
    let callbackCount = 0

    app.ws('/bad', {
      close() {
        callbackCount++
        throw new Error('websocket close failed')
      }
    })

    const port = await listen()
    const error = captureUncaught('websocket close failed')
    const client = new WebSocket(`ws://127.0.0.1:${port}/bad`)

    await event(client, 'open')
    const closed = event(client, 'close')

    client.close()
    await Promise.all([error, closed])
    assert.equal(callbackCount, 1)
  },

  async 'socket-cork'() {
    let laterRan = false
    let closeCallbackRan = false

    app.ws('/bad', {
      message(ws) {
        ws.cork(() => {
          throw new Error('socket cork failed')
        })
        laterRan = true
      },
      close() {
        closeCallbackRan = true
      }
    })

    const port = await listen()
    const error = captureUncaught('socket cork failed')
    const client = new WebSocket(`ws://127.0.0.1:${port}/bad`)

    await event(client, 'open')
    const closed = event(client, 'close')

    client.send('fail')
    await error
    await closed
    assert.equal(laterRan, false)
    assert.equal(closeCallbackRan, false)
  },

  async upgrade() {
    let laterRan = false

    app.ws('/bad', {
      upgrade() {
        throw new Error('upgrade failed')
      },
      open() {
        laterRan = true
      }
    })
    app.get('/ok', (res) => res.end('ok'))

    const port = await listen()
    const error = captureUncaught('upgrade failed')
    const client = new WebSocket(`ws://127.0.0.1:${port}/bad`)

    client.addEventListener('error', () => {}, { once: true })
    await error
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(laterRan, false)
    await assertNextRequestWorks(port)
  },

  async listen() {
    const error = captureUncaught('listen callback failed')

    app.listen('127.0.0.1', 0, () => {
      throw new Error('listen callback failed')
    })
    await error

    const port = await listen()

    app.get('/ok', (res) => res.end('ok'))
    await assertNextRequestWorks(port)
  },

  async 'ws-options'() {
    const proxied = new Proxy(
      {},
      {
        get() {
          throw new Error('proxy get failed')
        }
      }
    )
    const withGetter = {}

    Object.defineProperty(withGetter, 'compression', {
      get() {
        throw new Error('getter failed')
      }
    })

    assert.throws(() => app.ws('/proxy', proxied), /proxy get failed/)
    assert.throws(() => app.ws('/getter', withGetter), /getter failed/)
    assert.throws(() => app.ws('/fractional', { compression: 0.5 }), /compression is disabled/)
    assert.equal(app.ws('/ok', { message() {} }), app)
  },

  async 'socket-user-data'() {
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
    const port = await listen()
    const client = new WebSocket(`ws://127.0.0.1:${port}/data`)
    const message = await event(client, 'message')

    assert.equal(message.data, 'ready')
    const closed = event(client, 'close')

    client.close()
    await closed
    assert.equal(getterCalls, 0)

    const error = captureUncaught('ownKeys failed')
    const proxyClient = new WebSocket(`ws://127.0.0.1:${port}/proxy-data`)

    proxyClient.addEventListener('error', () => {}, { once: true })
    await error
    await new Promise((resolve) => setImmediate(resolve))
  },

  async 'socket-user-data-descriptor-error'() {
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

    const port = await listen()
    const descriptorError = captureUncaught('getOwnPropertyDescriptor failed')
    const descriptorClient = new WebSocket(`ws://127.0.0.1:${port}/descriptor-data`)

    descriptorClient.addEventListener('error', () => {}, { once: true })
    await descriptorError
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function event(target, name) {
  return new Promise((resolve, reject) => {
    target.addEventListener(name, resolve, { once: true })

    if (name !== 'close') {
      target.addEventListener('error', () => reject(new Error(`WebSocket ${name} failed`)), { once: true })
    }
  })
}

try {
  assert.equal(typeof cases[scenario], 'function', `unknown security case: ${scenario}`)
  await cases[scenario]()
  console.log(`security case ok: ${scenario}`)
} finally {
  clearTimeout(timeout)

  if (listenSocket) {
    us_listen_socket_close(listenSocket)
  }

  app.close()
}
