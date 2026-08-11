import assert from 'node:assert/strict'

export const webSocketCases = {
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
