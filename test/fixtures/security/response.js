import assert from 'node:assert/strict'

export const responseCases = {
  async 'response-cork'(fixture) {
    let laterRan = false

    const { app } = fixture

    app.get('/bad', (res) => {
      res.cork(() => {
        throw new Error('response cork failed')
      })
      laterRan = true
      res.end('unsafe')
    })
    app.get('/ok', (res) => res.end('ok'))

    const port = await fixture.listen()
    const error = fixture.captureUncaught('response cork failed')

    await fixture.rawRequest(port, ['GET /bad HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'])
    await error
    assert.equal(laterRan, false)
    await fixture.assertNextRequestWorks(port)
  },

  async 'framing-exception'(fixture) {
    const { app } = fixture

    app.get('/bad', (res) => {
      res.beginWrite()
      throw new Error('framing callback failed')
    })
    app.get('/ok', (res) => res.end('ok'))

    const port = await fixture.listen()
    const error = fixture.captureUncaught('framing callback failed')

    await fixture.rawRequest(port, ['GET /bad HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'])
    await error
    await fixture.assertNextRequestWorks(port)
  },

  async 'response-writable'(fixture) {
    const { app } = fixture
    const payload = new Uint8Array(1024 * 1024)

    let callbackCount = 0
    let abortedCount = 0

    const startBackpressuredResponse = (res) => {
      for (let write = 0; write < 256; write++) {
        if (!res.write(payload)) {
          return
        }
      }

      throw new Error('failed to trigger HTTP response backpressure')
    }
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
        startBackpressuredResponse(res)
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
      startBackpressuredResponse(res)
    })

    app.get('/bad', (res) => {
      res.onAborted(() => abortedCount++)
      res.onWritable(() => {
        callbackCount++
        throw new Error('response writable failed')
      })
      startBackpressuredResponse(res)
    })
    app.get('/ok', (res) => res.end('ok'))

    const port = await fixture.listen()

    for (const name of Object.keys(normalCounts)) {
      const socket = fixture.createSocket(port, () => {
        socket.pause()
        socket.write(`GET /writable-${name} HTTP/1.1\r\nHost: localhost\r\n\r\n`)
        setTimeout(() => socket.resume(), 25)
      })

      await normalResults[name]
      socket.destroy()
      assert.equal(normalCounts[name], 1)
      await fixture.assertNextRequestWorks(port)
    }

    const error = fixture.captureUncaught('response writable failed')
    const socket = fixture.createSocket(port, () => {
      socket.pause()
      socket.write('GET /bad HTTP/1.1\r\nHost: localhost\r\n\r\n')
      setTimeout(() => socket.resume(), 25)
    })

    await error
    socket.destroy()
    assert.equal(callbackCount, 1)
    assert.equal(abortedCount, 0)
    await fixture.assertNextRequestWorks(port)
  },

  async 'response-aborted'(fixture) {
    const { app } = fixture

    let callbackCount = 0

    app.post('/bad', (res) => {
      res.onData(() => {})
      res.onAborted(() => {
        callbackCount++
        throw new Error('response aborted failed')
      })
    })
    app.get('/ok', (res) => res.end('ok'))

    const port = await fixture.listen()
    const error = fixture.captureUncaught('response aborted failed')
    const socket = fixture.createSocket(port, () => {
      socket.write('POST /bad HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\npartial')
      setImmediate(() => socket.destroy())
    })

    await error
    assert.equal(callbackCount, 1)
    await fixture.assertNextRequestWorks(port)
  }
}
