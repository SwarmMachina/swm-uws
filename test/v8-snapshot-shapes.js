import assert from 'node:assert/strict'
import { createConnection } from 'node:net'

import { createApp, us_listen_socket_close } from '../lib/index.js'

const app = createApp()
const port = 45_000 + (process.pid % 10_000)
const snapshots = []
let listenSocket

app.get('/snapshot', (res, req) => {
  snapshots.push(req.snapshot())
  res.end('ok')
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
  for (let index = 0; index < 64; index++) {
    await sendVariant(port, index % 24)
  }

  const warmup = snapshots.slice(0, 32)
  const measured = snapshots.slice(32)

  for (let iteration = 0; iteration < 1_000; iteration++) {
    for (const snapshot of warmup) readHeaders(snapshot.headers)
  }

  const first = measured[0]

  assert.equal(Object.getPrototypeOf(first.headers), null)
  assert.equal(%HasFastProperties(first), true)
  assert.equal(%HasFastProperties(first.headers), false)

  for (const [index, snapshot] of measured.slice(1).entries()) {
    assert.equal(%HaveSameMap(first, snapshot), true, 'outer snapshot map changed')
    assert.equal(
      %HaveSameMap(first.headers, snapshot.headers),
      true,
      `headers map changed at ${index + 1}: ${Object.keys(snapshot.headers).join(',')}`
    )
    assert.equal(%HasFastProperties(snapshot), true, 'outer snapshot left fast-properties mode')
    assert.equal(%HasFastProperties(snapshot.headers), false, 'headers left dictionary mode')
    readHeaders(snapshot.headers)
  }

  assert.equal(%HaveSameMap(warmup[0], first), true, 'outer map changed after warmup')
  assert.equal(%HaveSameMap(warmup[0].headers, first.headers), true, 'headers map changed after warmup')
} finally {
  us_listen_socket_close(listenSocket)
  app.close()
}

console.log(`V8 snapshot shape test ok on Node ${process.versions.node}`)

function readHeaders(headers) {
  const variant = headers['x-variant']

  return `${headers.host}|${headers['x-common-a']}|${headers['x-common-b']}|${headers[`x-dynamic-${variant}`]}`
}

function sendVariant(port, variant) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const dynamic = [`X-Dynamic-${variant}`, `value-${variant}`]
    const commonA = ['X-Common-A', 'alpha']
    const commonB = ['X-Common-B', 'beta']
    const orders = [
      [commonA, dynamic, commonB],
      [dynamic, commonB, commonA],
      [commonB, commonA, dynamic]
    ]
    const lines = [
      `GET /snapshot?variant=${variant} HTTP/1.1`,
      'Host: shapes.example',
      ...orders[variant % orders.length].map(([name, value]) => `${name}: ${value}`),
      `X-Variant: ${variant}`,
      'Connection: close',
      '',
      ''
    ]

    socket.once('connect', () => socket.end(lines.join('\r\n')))
    socket.once('error', reject)
    socket.once('end', resolve)
    socket.resume()
  })
}
