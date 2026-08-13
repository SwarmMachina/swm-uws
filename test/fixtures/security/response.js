import assert from 'node:assert/strict'

export const responseCases = {
  async 'response-data-reentrant-close'(fixture) {
    await exerciseBorrowedRequestPayloadClose(fixture, false)
  },

  async 'response-data-reentrant-app-close'(fixture) {
    await exerciseBorrowedRequestPayloadClose(fixture, true)
  },

  async 'response-data-terminal-close-connection'(fixture) {
    const { app } = fixture
    const callbackComplete = Promise.withResolvers()
    const nativeCloseObserved = Promise.withResolvers()

    let callbackActive = false
    let nativeCloseCount = 0

    app.filter((_res, count) => {
      if (count >= 0) {
        return
      }

      assert.equal(callbackActive, false)
      nativeCloseCount++
      nativeCloseObserved.resolve()
    })
    app.post('/payload', (res) => {
      res.onData((payload, isLast) => {
        callbackActive = true
        assert.equal(Buffer.from(payload).toString(), 'body')
        assert.equal(isLast, true)

        res.end('ok', true)

        assert.equal(nativeCloseCount, 0)
        assert.throws(() => res.close(), /HTTP response is no longer valid/)
        callbackActive = false
        callbackComplete.resolve()
      })
    })

    const port = await fixture.listen()
    const socket = fixture.createSocket(port, () => {
      socket.write('POST /payload HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\n\r\nbody')
    })

    try {
      await callbackComplete.promise
      await nativeCloseObserved.promise
      assert.equal(nativeCloseCount, 1)
    } finally {
      socket.destroy()
    }
  },

  async 'response-collect-reentrant-close'(fixture) {
    await exerciseCollectCallbackClose(fixture, false)
  },

  async 'response-collect-reentrant-app-close'(fixture) {
    await exerciseCollectCallbackClose(fixture, true)
  },

  async 'response-cork-reentrant-app-close'(fixture) {
    const { app } = fixture

    let callbackCount = 0

    app.get('/close', (res) => {
      assert.throws(
        () =>
          res.cork(() => {
            callbackCount++
            fixture.closeApp()
            throw new Error('closed inside response cork')
          }),
        /closed inside response cork/
      )
      assert.throws(() => res.end('late'), /HTTP response is no longer valid/)
    })

    const port = await fixture.listen()

    await fixture.rawRequest(port, ['GET /close HTTP/1.1\r\nHost: localhost\r\n\r\n'])
    assert.equal(callbackCount, 1)
  },

  async 'response-writable-reentrant-app-close'(fixture) {
    const { app } = fixture
    const writable = Promise.withResolvers()
    const payload = new Uint8Array(1024 * 1024)

    let callbackCount = 0
    let callbackActive = false
    let nativeCloseDuringCallback = false

    app.filter((_res, count) => {
      if (count < 0 && callbackActive) {
        nativeCloseDuringCallback = true
      }
    })

    app.get('/close', (res) => {
      res.onWritable(() => {
        callbackCount++
        callbackActive = true
        fixture.closeApp()
        assert.equal(nativeCloseDuringCallback, false)
        callbackActive = false
        writable.resolve()

        return true
      })

      for (let write = 0; write < 256; write++) {
        if (!res.write(payload)) {
          return
        }
      }

      throw new Error('failed to trigger HTTP response backpressure')
    })

    const port = await fixture.listen()
    const socket = fixture.createSocket(port, () => {
      socket.pause()
      socket.write('GET /close HTTP/1.1\r\nHost: localhost\r\n\r\n')
      setTimeout(() => socket.resume(), 25)
    })

    try {
      await writable.promise
      assert.equal(callbackCount, 1)
      assert.equal(nativeCloseDuringCallback, false)
    } finally {
      socket.destroy()
    }
  },

  async 'response-try-end-backpressure-lifecycle'(fixture) {
    const { app } = fixture
    const checked = Promise.withResolvers()
    const payload = new Uint8Array(32 * 1024 * 1024)

    app.get('/partial', (res) => {
      const [ok, done] = res.tryEnd(payload, payload.length)

      assert.equal(ok, false)
      assert.equal(done, false)
      assert.ok(res.getWriteOffset() >= 0)
      assert.ok(res.getWriteOffset() < payload.length)
      res.close()
      checked.resolve()
    })

    const port = await fixture.listen()
    const socket = fixture.createSocket(port, () => {
      socket.pause()
      socket.write('GET /partial HTTP/1.1\r\nHost: localhost\r\n\r\n')
    })

    try {
      await checked.promise
    } finally {
      socket.destroy()
    }
  },

  async 'response-end-batch-reentrant-close'(fixture) {
    const { app } = fixture

    let getterCount = 0

    app.get('/close', (res) => {
      const headers = ['x-safe', 'yes']

      Object.defineProperty(headers, 0, {
        get() {
          getterCount++
          res.close()

          return 'x-safe'
        }
      })

      assert.throws(() => res.endBatch('200 OK', headers, 'late'), /HTTP response is no longer valid/)
    })

    const port = await fixture.listen()

    await fixture.rawRequest(port, ['GET /close HTTP/1.1\r\nHost: localhost\r\n\r\n'])
    assert.equal(getterCount, 1)
  },

  async 'response-end-batch-limit'(fixture) {
    const { app } = fixture

    app.get('/limit', (res) => {
      assert.throws(() => res.endBatch('200 OK', new Array(131_072)), /at most 65535 header name\/value pairs/)

      const mutableHeaders = ['x-safe', 'yes']

      Object.defineProperty(mutableHeaders, 0, {
        get() {
          mutableHeaders.length = 0xffff_ffff

          return 'x-safe'
        }
      })
      res.endBatch('200 OK', mutableHeaders, 'ok')
    })

    const port = await fixture.listen()
    const response = await fixture.rawRequest(port, [
      'GET /limit HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    ])

    assert.match(response, /ok$/)
  },

  async 'response-route-cleanup-reentrant-filter'(fixture) {
    const { app } = fixture
    const closeObserved = Promise.withResolvers()

    let retainedResponse

    app.filter((_res, count) => {
      if (count >= 0 || !retainedResponse) {
        return
      }

      assert.throws(() => retainedResponse.end('late'), /HTTP response is no longer valid/)
      assert.throws(
        () => app.get('/late', () => {}),
        /app routes cannot be registered from an active HTTP route callback/
      )
      closeObserved.resolve()
    })
    app.get('/cleanup', (res) => {
      retainedResponse = res
    })

    const port = await fixture.listen()

    try {
      await fixture.rawRequest(port, ['GET /cleanup HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'])
    } catch (error) {
      assert.equal(error.code, 'ECONNRESET')
    }
    await closeObserved.promise
  },

  async 'response-terminal-reentrant-filter'(fixture) {
    const { app } = fixture
    const closeObserved = Promise.withResolvers()

    let abortedCount = 0
    let retainedResponse

    app.filter((_res, count) => {
      if (count >= 0 || !retainedResponse) {
        return
      }

      assert.throws(() => retainedResponse.end('late'), /HTTP response is no longer valid/)
      closeObserved.resolve()
    })
    app.get('/close', (res) => {
      retainedResponse = res
      res.onAborted(() => {
        abortedCount++
        assert.throws(() => res.end('late'), /HTTP response is no longer valid/)
      })
      res.close()
    })

    const port = await fixture.listen()

    try {
      await fixture.rawRequest(port, ['GET /close HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'])
    } catch (error) {
      assert.equal(error.code, 'ECONNRESET')
    }
    await closeObserved.promise
    assert.equal(abortedCount, 1)
  },

  async 'response-detached-buffer'(fixture) {
    const { app } = fixture

    app.get('/detached', (res) => {
      const buffer = new ArrayBuffer(8)
      const view = new Uint8Array(buffer)

      structuredClone(buffer, { transfer: [buffer] })
      assert.equal(view.byteLength, 0)
      res.end(view)
    })

    const port = await fixture.listen()
    const response = await fixture.rawRequest(port, [
      'GET /detached HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    ])

    assert.match(response, /^HTTP\/1\.1 200/m)
  },

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

async function exerciseBorrowedRequestPayloadClose(fixture, closeApp) {
  const { app } = fixture
  const callbackComplete = Promise.withResolvers()
  const nativeCloseObserved = Promise.withResolvers()

  let callbackActive = false
  let nativeCloseCount = 0
  let retainedPayload

  app.filter((_res, count) => {
    if (count >= 0) {
      return
    }

    assert.equal(callbackActive, false)
    nativeCloseCount++
    nativeCloseObserved.resolve()
  })
  app.post('/payload', (res) => {
    res.onData((payload) => {
      callbackActive = true
      retainedPayload = payload
      const expected = Buffer.from(payload)

      assert.ok(expected.length > 0)

      if (closeApp) {
        fixture.closeApp()
        assert.throws(() => res.close(), /HTTP response is no longer valid/)
      } else {
        res.close()
        assert.throws(() => res.close(), /HTTP response is no longer valid/)
      }

      assert.equal(nativeCloseCount, 0)
      assert.deepEqual(Buffer.from(payload), expected)
      callbackActive = false
      callbackComplete.resolve()
    })
  })

  const port = await fixture.listen()
  const socket = fixture.createSocket(port, () => {
    socket.write('POST /payload HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\nfrag')
  })

  try {
    await callbackComplete.promise
    await nativeCloseObserved.promise
    assert.equal(nativeCloseCount, 1)
    assert.equal(retainedPayload.byteLength, 0)
  } finally {
    socket.destroy()
  }
}

async function exerciseCollectCallbackClose(fixture, closeApp) {
  const { app } = fixture
  const callbackComplete = Promise.withResolvers()
  const nativeCloseObserved = Promise.withResolvers()

  let callbackActive = false
  let nativeCloseCount = 0

  app.filter((_res, count) => {
    if (count >= 0) {
      return
    }

    assert.equal(callbackActive, false)
    nativeCloseCount++
    nativeCloseObserved.resolve()
  })
  app.post('/collect', (res) => {
    res.collectBody(32, (body) => {
      callbackActive = true
      assert.equal(Buffer.from(body).toString(), 'body')

      if (closeApp) {
        fixture.closeApp()
      } else {
        res.close()
      }

      assert.equal(nativeCloseCount, 0)
      assert.equal(Buffer.from(body).toString(), 'body')
      callbackActive = false
      callbackComplete.resolve()
    })
  })

  const port = await fixture.listen()
  const socket = fixture.createSocket(port, () => {
    socket.write('POST /collect HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\n\r\nbody')
  })

  try {
    await callbackComplete.promise
    await nativeCloseObserved.promise
    assert.equal(nativeCloseCount, 1)
  } finally {
    socket.destroy()
  }
}
