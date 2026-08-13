import assert from 'node:assert/strict'
import { once } from 'node:events'

import { readResponseHead, webSocketHandshakeRequest } from '../../helpers/raw-websocket.js'

export const webSocketCases = {
  async 'websocket-fragmented-payload-reentrant-close'(fixture) {
    await exerciseFragmentedPayloadClose(fixture, false)
  },

  async 'websocket-fragmented-payload-reentrant-app-close'(fixture) {
    await exerciseFragmentedPayloadClose(fixture, true)
  },

  async 'websocket-open-route-registration'(fixture) {
    const { app } = fixture

    app.ws('/guard', {
      open(socket) {
        assert.throws(
          () => app.get('/late', () => {}),
          /app routes cannot be registered from an active HTTP route callback/
        )
        assert.throws(() => app.ws('/late', {}), /app\.ws\(\) cannot be called from an active HTTP route callback/)
        socket.send('ready')
      }
    })

    const port = await fixture.listen()
    const client = new WebSocket(`ws://127.0.0.1:${port}/guard`)
    const message = await fixture.event(client, 'message')

    assert.equal(message.data, 'ready')
    const closed = fixture.event(client, 'close')

    client.close()
    await closed
  },

  async 'websocket-get-topics-array-prototype'(fixture) {
    const { app } = fixture

    let setterCount = 0

    app.ws('/topics', {
      open(socket) {
        socket.subscribe('a')
        socket.subscribe('b')

        let topics

        Object.defineProperty(Array.prototype, 0, {
          configurable: true,
          set() {
            setterCount++
            socket.close()
          }
        })

        try {
          topics = socket.getTopics()
        } finally {
          delete Array.prototype[0]
        }

        assert.equal(setterCount, 0)
        assert.deepEqual(topics.toSorted(), ['a', 'b'])
        socket.send('ready')
      }
    })

    const port = await fixture.listen()
    const client = new WebSocket(`ws://127.0.0.1:${port}/topics`)
    const message = await fixture.event(client, 'message')

    assert.equal(message.data, 'ready')
    const closed = fixture.event(client, 'close')

    client.close()
    await closed
    assert.equal(setterCount, 0)
  },

  async 'websocket-callback-buffer-transfer-guard'(fixture) {
    const { app } = fixture

    let retainedPayload

    app.ws('/transfer', {
      message(socket, payload) {
        retainedPayload = payload
        assert.equal(Buffer.from(payload).toString(), 'payload')
        assert.throws(() => structuredClone(payload, { transfer: [payload] }), /detachkey/i)
        assert.equal(payload.byteLength, 'payload'.length)
        socket.send('ready')
      }
    })

    const port = await fixture.listen()
    const client = new WebSocket(`ws://127.0.0.1:${port}/transfer`)

    await fixture.event(client, 'open')
    const message = fixture.event(client, 'message')

    client.send('payload')
    assert.equal((await message).data, 'ready')
    assert.equal(retainedPayload.byteLength, 0)

    const closed = fixture.event(client, 'close')

    client.close()
    await closed
  },

  async 'websocket-auto-pong-dropped-reentrant-app-close'(fixture) {
    const { app } = fixture
    const opened = Promise.withResolvers()
    const dropped = Promise.withResolvers()
    const payload = new Uint8Array(1024 * 1024)

    let droppedCount = 0
    let pingCount = 0
    let serverSocket

    app.ws('/ws', {
      maxBackpressure: 1,
      open(socket) {
        serverSocket = socket
        opened.resolve()
      },
      dropped() {
        droppedCount++
        fixture.closeApp()
        dropped.resolve()
      },
      ping() {
        pingCount++
      }
    })

    const port = await fixture.listen()
    const client = fixture.createSocket(port)

    try {
      await once(client, 'connect')
      const response = readResponseHead(client)

      client.write(webSocketHandshakeRequest())
      await response
      client.pause()
      await opened.promise

      let backpressured = false

      for (let attempt = 0; attempt < 256; attempt++) {
        if (serverSocket.send(payload, true) === 0) {
          backpressured = true
          break
        }
      }

      assert.equal(backpressured, true)
      await new Promise((resolve, reject) => {
        client.write(Buffer.from([0x89, 0x80, 0, 0, 0, 0]), (error) => {
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        })
      })
      await dropped.promise
      assert.equal(droppedCount, 1)
      assert.equal(pingCount, 0)
    } finally {
      client.destroy()
    }
  },

  async 'websocket-auto-pong-dropped-reentrant-end'(fixture) {
    const { app } = fixture
    const opened = Promise.withResolvers()
    const closed = Promise.withResolvers()
    const endRequested = Promise.withResolvers()
    const payload = new Uint8Array(1024 * 1024)

    let closeCount = 0
    let droppedCount = 0
    let pingCount = 0
    let serverSocket

    app.ws('/ws', {
      maxBackpressure: 1,
      open(socket) {
        serverSocket = socket

        let backpressured = false

        for (let attempt = 0; attempt < 256; attempt++) {
          if (serverSocket.send(payload, true) === 0) {
            backpressured = true
            break
          }
        }

        opened.resolve(backpressured)
      },
      dropped(socket) {
        droppedCount++

        if (droppedCount === 1) {
          socket.end(1000, 'shutdown')
          endRequested.resolve()
        }
      },
      ping() {
        pingCount++
      },
      close() {
        closeCount++
        closed.resolve()
      }
    })

    const port = await fixture.listen()
    const client = fixture.createSocket(port)

    try {
      await once(client, 'connect')
      client.pause()
      client.write(webSocketHandshakeRequest())
      assert.equal(await opened.promise, true)
      // Queue the ping only after the native upgrade callback has returned and
      // the deliberate backpressure is observable. Sending it from open() can
      // race the HTTP-to-WebSocket parser handoff on some runner architectures.
      await new Promise((resolve, reject) => {
        client.write(Buffer.from([0x89, 0x80, 0, 0, 0, 0]), (error) => {
          if (error) reject(error)
          else resolve()
        })
      })
      await endRequested.promise
      // The peer was paused only to make auto-pong and close hit the dropped
      // path. Drain the deliberate backpressure before waiting for FIN so the
      // assertion does not depend on the platform's kernel send-buffer size.
      client.resume()
      await closed.promise
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(droppedCount, 2)
      assert.equal(pingCount, 0)
      assert.equal(closeCount, 1)
      assert.throws(() => serverSocket.send('late'), /WebSocket is no longer valid/)
    } finally {
      client.destroy()
    }
  },

  async 'websocket-subscription-close-throw'(fixture) {
    const { app } = fixture
    const opened = Promise.withResolvers()

    let closeCallbackRan = false
    let removalCount = 0

    app.ws('/ws', {
      open(socket) {
        socket.subscribe('a')
        socket.subscribe('b')
        opened.resolve()
      },
      subscription(_socket, _topic, newCount, oldCount) {
        if (newCount >= oldCount) {
          return
        }

        removalCount++
        throw new Error('subscription removal failed')
      },
      close() {
        closeCallbackRan = true
      }
    })

    const port = await fixture.listen()
    const error = fixture.captureUncaught('subscription removal failed')
    const client = fixture.createSocket(port)

    try {
      await once(client, 'connect')
      const response = readResponseHead(client)

      client.write(webSocketHandshakeRequest())
      await response
      await opened.promise
      client.destroy()
      await error
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(removalCount, 1)
      assert.equal(closeCallbackRan, false)
    } finally {
      client.destroy()
    }
  },

  async 'websocket-subscription-close-reentrancy'(fixture) {
    const { app } = fixture
    const opened = Promise.withResolvers()
    const removalsComplete = Promise.withResolvers()
    const removedTopics = []

    app.ws('/ws', {
      open(socket) {
        socket.subscribe('a')
        socket.subscribe('b')
        opened.resolve()
      },
      subscription(socket, topic, newCount, oldCount) {
        if (newCount >= oldCount) {
          return
        }

        removedTopics.push(Buffer.from(topic).toString())
        assert.throws(() => socket.unsubscribe('b'), /WebSocket is no longer valid/)
        assert.throws(() => socket.subscribe('late'), /WebSocket is no longer valid/)

        if (removedTopics.length === 2) {
          removalsComplete.resolve()
        }
      }
    })

    const port = await fixture.listen()
    const client = fixture.createSocket(port)

    try {
      await once(client, 'connect')
      const response = readResponseHead(client)

      client.write(webSocketHandshakeRequest())
      await response
      await opened.promise

      client.destroy()
      await removalsComplete.promise
      assert.deepEqual(removedTopics.toSorted(), ['a', 'b'])
      assert.equal(app.numSubscribers('late'), 0)
    } finally {
      client.destroy()
    }
  },

  async 'websocket-end-subscription-lifecycle'(fixture) {
    const { app } = fixture
    const opened = Promise.withResolvers()
    const removalsComplete = Promise.withResolvers()
    const closed = Promise.withResolvers()
    const removedTopics = []

    app.ws('/ws', {
      open(socket) {
        socket.subscribe('a')
        socket.subscribe('b')
        opened.resolve()
        socket.end(1000, 'shutdown')
      },
      subscription(socket, topic, newCount, oldCount) {
        if (newCount >= oldCount) {
          return
        }

        removedTopics.push(Buffer.from(topic).toString())
        assert.throws(() => socket.getTopics(), /WebSocket is no longer valid/)
        assert.throws(() => socket.subscribe('late'), /WebSocket is no longer valid/)

        if (removedTopics.length === 2) {
          removalsComplete.resolve()
        }
      },
      close() {
        closed.resolve()
      }
    })

    const port = await fixture.listen()
    const client = fixture.createSocket(port)

    try {
      await once(client, 'connect')
      const response = readResponseHead(client)

      client.write(webSocketHandshakeRequest())
      await response
      await opened.promise
      await removalsComplete.promise
      await closed.promise
      assert.deepEqual(removedTopics.toSorted(), ['a', 'b'])
      assert.equal(app.numSubscribers('late'), 0)
    } finally {
      client.destroy()
    }
  },

  async 'websocket-end-dropped-reentrant-app-close'(fixture) {
    const { app } = fixture
    const opened = Promise.withResolvers()
    const closed = Promise.withResolvers()
    const payload = new Uint8Array(1024 * 1024)

    let closeCode
    let droppedCount = 0
    let serverSocket

    app.ws('/ws', {
      maxBackpressure: 1,
      open(socket) {
        serverSocket = socket
        opened.resolve()
      },
      dropped() {
        droppedCount++
        fixture.closeApp()
      },
      close(_socket, code) {
        closeCode = code
        closed.resolve()
      }
    })

    const port = await fixture.listen()
    const client = fixture.createSocket(port)

    try {
      await once(client, 'connect')
      const response = readResponseHead(client)

      client.write(webSocketHandshakeRequest())
      await response
      client.pause()
      await opened.promise

      let backpressured = false

      for (let attempt = 0; attempt < 256; attempt++) {
        if (serverSocket.send(payload, true) === 0) {
          backpressured = true
          break
        }
      }

      assert.equal(backpressured, true)
      serverSocket.end(1000, 'shutdown')
      await closed.promise
      assert.equal(droppedCount, 1)
      assert.equal(closeCode, 1006)
      assert.throws(() => serverSocket.send('late'), /WebSocket is no longer valid/)
    } finally {
      client.destroy()
    }
  },

  async 'websocket-end-dropped-throw'(fixture) {
    const { app } = fixture
    const opened = Promise.withResolvers()
    const payload = new Uint8Array(1024 * 1024)

    let closeCallbackRan = false
    let droppedCount = 0
    let serverSocket

    app.ws('/ws', {
      maxBackpressure: 1,
      open(socket) {
        serverSocket = socket
        opened.resolve()
      },
      dropped() {
        droppedCount++
        throw new Error('end dropped failed')
      },
      close() {
        closeCallbackRan = true
      }
    })

    const port = await fixture.listen()
    const error = fixture.captureUncaught('end dropped failed')
    const client = fixture.createSocket(port)

    try {
      await once(client, 'connect')
      const response = readResponseHead(client)

      client.write(webSocketHandshakeRequest())
      await response
      client.pause()
      await opened.promise

      let backpressured = false

      for (let attempt = 0; attempt < 256; attempt++) {
        if (serverSocket.send(payload, true) === 0) {
          backpressured = true
          break
        }
      }

      assert.equal(backpressured, true)
      serverSocket.end(1000, 'shutdown')
      await error
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(droppedCount, 1)
      assert.equal(closeCallbackRan, false)
    } finally {
      client.destroy()
    }
  },

  async 'websocket-dropped-reentrant-close'(fixture) {
    const { app } = fixture
    const opened = Promise.withResolvers()
    const payload = new Uint8Array(1024 * 1024)

    let droppedCount = 0
    let serverSocket

    app.ws('/ws', {
      maxBackpressure: 1,
      open(socket) {
        serverSocket = socket
        socket.subscribe('topic')
        opened.resolve()
      },
      dropped() {
        droppedCount++
        fixture.closeApp()
      }
    })

    const port = await fixture.listen()
    const client = fixture.createSocket(port)

    try {
      await once(client, 'connect')
      const response = readResponseHead(client)

      client.write(webSocketHandshakeRequest())
      await response
      client.pause()
      await opened.promise

      let backpressured = false

      for (let attempt = 0; attempt < 256; attempt++) {
        if (serverSocket.send(payload, true) === 0) {
          backpressured = true
          break
        }
      }

      assert.equal(backpressured, true)
      assert.equal(app.publish('topic', payload, true), true)
      assert.equal(droppedCount, 1)
      assert.throws(() => serverSocket.send('late'), /WebSocket is no longer valid/)
    } finally {
      client.destroy()
    }
  },

  async 'websocket-buffered-publish-dropped-reentrant-app-close'(fixture) {
    const { app } = fixture
    const opened = Promise.withResolvers()
    const dropped = Promise.withResolvers()
    const payload = new Uint8Array(1024 * 1024)

    let droppedCount = 0
    let serverSocket

    app.ws('/ws', {
      maxBackpressure: 1,
      open(socket) {
        serverSocket = socket
        socket.subscribe('topic')
        opened.resolve()
      },
      dropped(_socket, droppedPayload) {
        droppedCount++
        assert.equal(Buffer.from(droppedPayload).toString(), 'queued')
        fixture.closeApp()
        dropped.resolve()
      }
    })

    const port = await fixture.listen()
    const client = fixture.createSocket(port)

    try {
      await once(client, 'connect')
      const response = readResponseHead(client)

      client.write(webSocketHandshakeRequest())
      await response
      client.pause()
      await opened.promise

      let backpressured = false

      for (let attempt = 0; attempt < 256; attempt++) {
        if (serverSocket.send(payload, true) === 0) {
          backpressured = true
          break
        }
      }

      assert.equal(backpressured, true)
      assert.equal(app.publish('topic', 'queued'), true)
      await dropped.promise
      assert.equal(droppedCount, 1)
      assert.throws(() => serverSocket.send('late'), /WebSocket is no longer valid/)
    } finally {
      client.destroy()
    }
  },

  async 'websocket-open-close-then-throw'(fixture) {
    const { app } = fixture
    const error = fixture.captureUncaught('websocket open close failed')

    app.ws('/bad', {
      open() {
        fixture.closeApp()
        throw new Error('websocket open close failed')
      }
    })

    const port = await fixture.listen()
    const client = new WebSocket(`ws://127.0.0.1:${port}/bad`)

    client.addEventListener('error', () => {}, { once: true })
    await error
    await new Promise((resolve) => setImmediate(resolve))
  },

  async 'websocket-message'(fixture) {
    const { app } = fixture

    let closeCallbackRan = false

    app.ws('/bad', {
      message() {
        throw new Error('websocket message failed')
      },
      close() {
        closeCallbackRan = true
      }
    })

    const port = await fixture.listen()
    const error = fixture.captureUncaught('websocket message failed')
    const client = new WebSocket(`ws://127.0.0.1:${port}/bad`)

    await fixture.event(client, 'open')
    const closed = fixture.event(client, 'close')

    client.send('fail')
    await error
    await closed
    assert.equal(closeCallbackRan, false)
  },

  async 'websocket-close'(fixture) {
    const { app } = fixture

    let callbackCount = 0

    app.ws('/bad', {
      close() {
        callbackCount++
        throw new Error('websocket close failed')
      }
    })

    const port = await fixture.listen()
    const error = fixture.captureUncaught('websocket close failed')
    const client = new WebSocket(`ws://127.0.0.1:${port}/bad`)

    await fixture.event(client, 'open')
    const closed = fixture.event(client, 'close')

    client.close()
    await Promise.all([error, closed])
    assert.equal(callbackCount, 1)
  },

  async 'socket-cork'(fixture) {
    const { app } = fixture

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

    const port = await fixture.listen()
    const error = fixture.captureUncaught('socket cork failed')
    const client = new WebSocket(`ws://127.0.0.1:${port}/bad`)

    await fixture.event(client, 'open')
    const closed = fixture.event(client, 'close')

    client.send('fail')
    await error
    await closed
    assert.equal(laterRan, false)
    assert.equal(closeCallbackRan, false)
  },

  async 'socket-cork-reentrant-app-close'(fixture) {
    const { app } = fixture

    let callbackCount = 0

    app.ws('/close', {
      message(socket) {
        socket.cork(() => {
          callbackCount++
          fixture.closeApp()
        })
        assert.throws(() => socket.send('late'), /WebSocket is no longer valid/)
      }
    })

    const port = await fixture.listen()
    const client = new WebSocket(`ws://127.0.0.1:${port}/close`)

    client.addEventListener('error', () => {}, { once: true })
    await fixture.event(client, 'open')
    const closed = fixture.event(client, 'close')

    client.send('close')
    await closed
    assert.equal(callbackCount, 1)
  },

  async upgrade(fixture) {
    const { app } = fixture

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

    const port = await fixture.listen()
    const error = fixture.captureUncaught('upgrade failed')
    const client = new WebSocket(`ws://127.0.0.1:${port}/bad`)

    client.addEventListener('error', () => {}, { once: true })
    await error
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(laterRan, false)
    await fixture.assertNextRequestWorks(port)
  },

  async 'upgrade-reentrant-boundaries'(fixture) {
    const { app } = fixture

    let retainedContext
    let retainedKey
    let retainedResponse

    app.ws('/upgrade', {
      upgrade(res, req, context) {
        retainedContext = context
        retainedKey = req.getHeader('sec-websocket-key')
        retainedResponse = res

        assert.throws(
          () => app.get('/late', () => {}),
          /app routes cannot be registered from an active HTTP route callback/
        )
        assert.throws(() => app.ws('/late', {}), /app\.ws\(\) cannot be called from an active HTTP route callback/)
        res.upgrade({}, retainedKey, '', '', context)
      },
      open(socket) {
        assert.throws(
          () => retainedResponse.upgrade({}, retainedKey, '', '', retainedContext),
          /HTTP response is no longer valid/
        )
        socket.send('ready')
      }
    })

    const port = await fixture.listen()
    const client = new WebSocket(`ws://127.0.0.1:${port}/upgrade`)
    const message = await fixture.event(client, 'message')

    assert.equal(message.data, 'ready')
    const closed = fixture.event(client, 'close')

    client.close()
    await closed
  },

  async 'response-cork-upgrade-reentrant-app-close'(fixture) {
    const { app } = fixture

    let openCount = 0
    let resolveOpened

    const opened = new Promise((resolve) => {
      resolveOpened = resolve
    })

    app.ws('/cork-upgrade', {
      upgrade(res, req, context) {
        const key = req.getHeader('sec-websocket-key')

        // Overflow the loop cork buffer so the explicit cork below owns the
        // HTTP-to-WebSocket transition and must follow the reallocated socket.
        res.writeHeader('x-cork-flush', 'x'.repeat(32 * 1024))
        res.cork(() => res.upgrade({}, key, '', '', context))
      },
      open() {
        openCount++
        fixture.closeApp()
        resolveOpened()
      }
    })

    const port = await fixture.listen()
    const client = fixture.createSocket(port)

    try {
      client.on('error', () => {})
      await once(client, 'connect')
      client.write(webSocketHandshakeRequest({ path: '/cork-upgrade' }))
      await opened
      assert.equal(openCount, 1)
    } finally {
      client.destroy()
    }
  },

  async 'ws-options'(fixture) {
    const { app } = fixture
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
  }
}

async function exerciseFragmentedPayloadClose(fixture, closeApp) {
  const { app } = fixture
  const callbackComplete = Promise.withResolvers()
  const nativeCloseObserved = Promise.withResolvers()

  let callbackActive = false
  let closeCount = 0
  let retainedPayload

  app.ws('/payload', {
    message(socket, payload) {
      callbackActive = true
      retainedPayload = payload

      assert.equal(Buffer.from(payload).toString(), 'fragmented')

      if (closeApp) {
        fixture.closeApp()
      } else {
        socket.close()
      }

      assert.equal(closeCount, 0)
      assert.equal(Buffer.from(payload).toString(), 'fragmented')
      assert.throws(() => socket.send('late'), /WebSocket is no longer valid/)
      callbackActive = false
      callbackComplete.resolve()
    },
    close() {
      assert.equal(callbackActive, false)
      closeCount++
      nativeCloseObserved.resolve()
    }
  })

  const port = await fixture.listen()
  const client = fixture.createSocket(port)

  try {
    await once(client, 'connect')
    const response = readResponseHead(client)

    client.write(webSocketHandshakeRequest({ path: '/payload' }))
    await response
    client.write(
      Buffer.concat([
        maskedShortFrame(0x01, Buffer.from('frag'), false),
        maskedShortFrame(0x00, Buffer.from('mented'), true)
      ])
    )

    await callbackComplete.promise
    await nativeCloseObserved.promise
    assert.equal(closeCount, 1)
    assert.equal(retainedPayload.byteLength, 0)
  } finally {
    client.destroy()
  }
}

function maskedShortFrame(opcode, payload, fin) {
  const mask = Buffer.from([0x13, 0x37, 0x42, 0x99])
  const frame = Buffer.alloc(6 + payload.length)

  frame[0] = (fin ? 0x80 : 0) | opcode
  frame[1] = 0x80 | payload.length
  mask.copy(frame, 2)

  for (let index = 0; index < payload.length; index++) {
    frame[6 + index] = payload[index] ^ mask[index % mask.length]
  }

  return frame
}
