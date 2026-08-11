import assert from 'node:assert/strict'

export const requestCases = {
  async 'request-data'(fixture) {
    const { app } = fixture

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

    const port = await fixture.listen()
    const error = fixture.captureUncaught('request data failed')
    const socket = fixture.createSocket(port, async () => {
      socket.write('POST /bad HTTP/1.1\r\nHost: localhost\r\nContent-Length: 8\r\n\r\none')
      await new Promise((resolve) => setImmediate(resolve))

      if (!socket.destroyed) {
        socket.write('twoth')
      }
    })

    await error
    socket.destroy()
    assert.equal(callbackCount, 1)
    assert.equal(abortedCount, 0)
    await fixture.assertNextRequestWorks(port)
  },

  async 'collect-body'(fixture) {
    const { app } = fixture

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

    const port = await fixture.listen()
    const error = fixture.captureUncaught('collect body failed')

    await fixture.rawRequest(port, ['POST /bad HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\n\r\nbody'])
    await error
    assert.equal(callbackCount, 1)
    assert.equal(laterRan, false)
    await fixture.assertNextRequestWorks(port)
  }
}
