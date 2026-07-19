import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import test from 'node:test'

import { createApp, us_listen_socket_close } from '../lib/index.js'

test('snapshot preserves standard and variably shaped request headers in a null-prototype record', async () => {
  const app = createApp()
  const port = 35_000 + (process.pid % 10_000)

  let listenSocket

  app.get('/snapshot', (res, req) => {
    const snapshot = req.snapshot()

    res.onAborted(() => {})
    setImmediate(() => {
      res.end(
        JSON.stringify({
          prototypeIsNull: Object.getPrototypeOf(snapshot.headers) === null,
          headers: snapshot.headers
        })
      )
    })
  })

  await new Promise((resolve, reject) => {
    app.listen('127.0.0.1', port, (socket) => {
      if (!socket) {
        reject(new Error(`listen failed on 127.0.0.1:${port}`))

        return
      }

      listenSocket = socket
      resolve()
    })
  })

  try {
    const cases = [
      [],
      [
        ['X-Alpha', 'one'],
        ['X-Beta', 'two']
      ],
      [
        ['X-Beta', 'two'],
        ['X-Alpha', 'one']
      ],
      [
        ['X-Mixed-Value', 'Case-Sensitive_Value/123'],
        ['X-Number', '00123'],
        ['X-Third', 'three']
      ]
    ]

    for (const customHeaders of cases) {
      const result = await rawSnapshotRequest(port, customHeaders)

      assert.equal(result.prototypeIsNull, true)
      assert.equal(result.headers.host, 'snapshot.example')
      assert.equal(result.headers.connection, 'close')

      for (const [name, value] of customHeaders) {
        assert.equal(result.headers[name.toLowerCase()], value)
      }

      assert.deepEqual(
        Object.keys(result.headers).filter((name) => name.startsWith('x-')),
        customHeaders.map(([name]) => name.toLowerCase())
      )
    }
  } finally {
    us_listen_socket_close(listenSocket)
    app.close()
  }
})

function rawSnapshotRequest(port, customHeaders) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const chunks = []

    socket.once('connect', () => {
      const lines = [
        'GET /snapshot HTTP/1.1',
        'Host: snapshot.example',
        'Connection: close',
        ...customHeaders.map(([name, value]) => `${name}: ${value}`),
        '',
        ''
      ]

      socket.end(lines.join('\r\n'))
    })
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.once('error', reject)
    socket.once('end', () => {
      const response = Buffer.concat(chunks).toString('utf8')
      const headerEnd = response.indexOf('\r\n\r\n')

      assert.notEqual(headerEnd, -1)
      assert.match(response.slice(0, headerEnd), /^HTTP\/1\.1 200 /)
      resolve(JSON.parse(response.slice(headerEnd + 4)))
    })
  })
}
