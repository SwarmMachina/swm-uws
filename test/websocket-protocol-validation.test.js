import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createConnection } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import { createApp } from '../lib/index.js'
import { waitFor, withTimeout } from './helpers/async.js'
import { NativeAppServer } from './helpers/native-app-server.js'
import { DEFAULT_WEBSOCKET_KEY, readResponseHead } from './helpers/raw-websocket.js'

const VALID_KEY = DEFAULT_WEBSOCKET_KEY

test('default WebSocket upgrade requires a complete RFC 6455 handshake', async () => {
  const app = createApp()
  const sockets = new Set()

  let openCount = 0

  app.ws('/ws', {
    open() {
      openCount++
    }
  })

  const server = await NativeAppServer.listen(app)

  try {
    const accepted = await rawHandshake(
      server.port,
      handshakeRequest({ connection: ['keep-alive', 'UpGrAdE'], upgrade: ['h2c', 'WebSocket'] })
    )

    sockets.add(accepted.socket)
    assert.match(accepted.response, /^HTTP\/1\.1 101 /)
    await waitFor(() => openCount === 1, 1_000, { description: 'valid WebSocket open callback' })
    accepted.socket.destroy()

    const invalidHandshakes = [
      ['missing Connection', { connection: null }],
      ['Connection without Upgrade token', { connection: 'keep-alive' }],
      ['Connection token prefix', { connection: 'upgraded' }],
      ['missing Upgrade', { upgrade: null }],
      ['wrong Upgrade protocol', { upgrade: 'h2c' }],
      ['missing version', { version: null }],
      ['wrong version', { version: '12' }],
      ['duplicate version', { versions: ['13', '12'] }],
      ['duplicate identical version', { versions: ['13', '13'] }],
      ['missing key', { keys: [] }],
      ['duplicate key', { keys: [VALID_KEY, VALID_KEY] }],
      ['invalid base64 alphabet', { keys: ['dGhlIHNhbXBsZSBub25jZQ=!'] }],
      ['17-byte decoded key', { keys: [Buffer.from('0123456789abcdefg').toString('base64')] }],
      ['non-canonical base64 pad bits', { keys: ['dGhlIHNhbXBsZSBub25jZR=='] }]
    ]

    for (const [name, options] of invalidHandshakes) {
      const rejected = await rawHandshake(server.port, handshakeRequest(options))

      sockets.add(rejected.socket)
      assert.doesNotMatch(rejected.response, /^HTTP\/1\.1 101 /, name)
      assert.equal(openCount, 1, `${name} invoked open`)
      rejected.socket.destroy()
    }
  } finally {
    for (const socket of sockets) {
      socket.destroy()
    }

    server.close()
  }
})

test('custom upgrade handler retains responsibility for handshake validation', async () => {
  const app = createApp()

  let customUpgradeCount = 0

  app.ws('/custom', {
    upgrade(res) {
      customUpgradeCount++
      res.writeStatus('400 Bad Request').end('custom validation')
    }
  })

  const server = await NativeAppServer.listen(app)

  try {
    const response = await rawHandshake(
      server.port,
      handshakeRequest({
        connection: null,
        upgrade: null,
        version: null,
        keys: ['!!!!!!!!!!!!!!!!!!!!!!!!'],
        path: '/custom'
      })
    )

    response.socket.destroy()
    assert.match(response.response, /^HTTP\/1\.1 400 /)
    assert.equal(customUpgradeCount, 1)
  } finally {
    server.close()
  }
})

test('server closes unmasked client frames, including a byte-split header', async () => {
  const app = createApp()
  const sockets = new Set()

  let closeCount = 0
  let messageCount = 0
  let openCount = 0

  app.ws('/ws', {
    open() {
      openCount++
    },
    message() {
      messageCount++
    },
    close() {
      closeCount++
    }
  })

  const server = await NativeAppServer.listen(app)

  try {
    const accepted = await upgradedSocket(server.port)

    sockets.add(accepted)
    accepted.write(maskedTextFrame('ok'))
    await waitFor(() => messageCount === 1, 1_000, { description: 'masked frame message callback' })
    accepted.destroy()

    for (const chunks of [
      [Buffer.from([0x81, 0x01, 0x78])],
      [Buffer.from([0x81]), Buffer.from([0x01]), Buffer.from([0x78])]
    ]) {
      const socket = await upgradedSocket(server.port)
      const closed = waitForClose(socket)

      sockets.add(socket)

      for (const chunk of chunks) {
        if (!socket.destroyed) {
          socket.write(chunk)
          await new Promise((resolve) => setImmediate(resolve))
        }
      }

      await closed
    }

    await waitFor(() => closeCount === 3, 1_000, { description: 'WebSocket close callbacks' })
    assert.equal(openCount, 3)
    assert.equal(messageCount, 1)
  } finally {
    for (const socket of sockets) {
      socket.destroy()
    }

    server.close()
  }
})

test('server rejects non-canonical and reserved WebSocket payload lengths', async () => {
  const app = createApp()
  const sockets = new Set()

  let messageCount = 0

  app.ws('/ws', {
    maxPayloadLength: 128 * 1024,
    message() {
      messageCount++
    }
  })

  const server = await NativeAppServer.listen(app)

  try {
    const frames = [
      maskedFrameWithEncodedLength(Buffer.from('x'), 126),
      maskedFrameWithEncodedLength(Buffer.from('x'), 127),
      maskedFrameWithEncodedLength(Buffer.alloc(0), 127, 1n << 63n)
    ]

    for (const [index, frame] of frames.entries()) {
      const socket = await upgradedSocket(server.port)
      const closed = waitForClose(socket, {
        message: `invalid WebSocket payload length ${index} did not close the connection`
      })

      sockets.add(socket)

      if (index === 1) {
        for (const byte of frame) {
          if (socket.destroyed) {
            break
          }

          socket.write(Buffer.of(byte))
          await new Promise((resolve) => setImmediate(resolve))
        }
      } else {
        socket.write(frame)
      }

      await closed
    }

    assert.equal(messageCount, 0)
  } finally {
    for (const socket of sockets) {
      socket.destroy()
    }

    server.close()
  }
})

test('server rejects a one-byte WebSocket close payload', async () => {
  const app = createApp()
  const closed = Promise.withResolvers()

  app.ws('/ws', {
    close(_socket, code) {
      closed.resolve(code)
    }
  })

  const server = await NativeAppServer.listen(app)
  const socket = await upgradedSocket(server.port)

  try {
    const socketClosed = waitForClose(socket, {
      message: 'one-byte WebSocket close payload did not close the connection'
    })

    socket.write(maskedShortFrame(0x08, Buffer.of(0)))
    assert.equal(await withTimeout(closed.promise, 1_000, 'close callback did not run'), 1006)
    await socketClosed
  } finally {
    socket.destroy()
    server.close()
  }
})

test('native ArrayBuffer ownership survives re-entrant dropped callbacks', async () => {
  const app = createApp()
  const opened = Promise.withResolvers()
  const dropped = Promise.withResolvers()
  const payloadBytes = 1024 * 1024
  const original = new ArrayBuffer(payloadBytes)
  const originalView = new Uint8Array(original)

  originalView.fill(0x5a)

  const serverSockets = []

  let droppedCount = 0

  app.ws('/ws', {
    maxBackpressure: 1,
    open(ws) {
      serverSockets.push(ws)
      ws.subscribe('ownership')

      if (serverSockets.length === 2) {
        opened.resolve()
      }
    },
    dropped(_ws, message, isBinary) {
      droppedCount++
      assert.equal(isBinary, true)

      if (droppedCount === 1) {
        assert.equal(original.transfer(0).byteLength, 0)
        assert.equal(original.byteLength, 0)
      }

      const churn = new Uint8Array(payloadBytes)

      churn.fill(0xa5)
      assert.equal(message.byteLength, payloadBytes)
      assert.equal(new Uint8Array(message)[0], 0x5a)
      assert.equal(new Uint8Array(message).at(-1), 0x5a)

      if (droppedCount === 2) {
        dropped.resolve()
      }
    }
  })

  const server = await NativeAppServer.listen(app)
  const sockets = [await upgradedSocket(server.port), await upgradedSocket(server.port)]

  try {
    for (const socket of sockets) {
      socket.pause()
    }

    await withTimeout(opened.promise, 1_000, 'server WebSocket did not open')

    const filler = new Uint8Array(payloadBytes)

    for (const serverSocket of serverSockets) {
      let backpressureObserved = false

      for (let attempt = 0; attempt < 256; attempt++) {
        if (serverSocket.send(filler, true) === 0) {
          backpressureObserved = true
          break
        }
      }

      assert.equal(backpressureObserved, true)
    }

    assert.equal(app.publish('ownership', original, true), true)
    await withTimeout(dropped.promise, 1_000, 'both dropped callbacks did not run')
    assert.equal(droppedCount, 2)
  } finally {
    for (const socket of sockets) {
      socket.destroy()
    }

    server.close()
  }
})

test('idleTimeout 0 disables automatic pings but retains the forced-close deadline', { timeout: 20_000 }, async () => {
  const app = createApp()
  const opened = Promise.withResolvers()

  let closeCount = 0
  let serverSocket

  app.ws('/idle-zero', {
    idleTimeout: 0,
    maxBackpressure: 0,
    sendPingsAutomatically: true,
    open(ws) {
      serverSocket = ws
      opened.resolve()
    },
    close() {
      closeCount++
    }
  })

  const server = await NativeAppServer.listen(app)

  let socket

  try {
    const upgraded = await rawHandshake(server.port, handshakeRequest({ path: '/idle-zero' }))

    socket = upgraded.socket
    assert.match(upgraded.response, /^HTTP\/1\.1 101 /)
    await withTimeout(opened.promise, 1_000, 'idle-timeout WebSocket open callback did not run')

    const receivedFrames = []

    let drainPulseRemaining = 0
    let resolveDrainPulse

    socket.on('data', (chunk) => {
      receivedFrames.push(chunk)

      if (resolveDrainPulse) {
        drainPulseRemaining -= chunk.length

        if (drainPulseRemaining <= 0) {
          socket.pause()
          resolveDrainPulse()
          resolveDrainPulse = undefined
        }
      }
    })
    await delay(4_500)

    assert.equal(socket.closed, false)
    assert.deepEqual(receivedFrames, [], 'idleTimeout 0 emitted an automatic ping or close frame')

    socket.pause()

    const payload = Buffer.alloc(256 * 1024, 0x78)
    const minimumBufferedAmount = 16 * 1024 * 1024

    let backpressureObserved = false
    let sentFrameCount = 0

    for (let attempt = 0; attempt < 256; attempt++) {
      if (serverSocket.send(payload, true) === 0) {
        backpressureObserved = true
      }

      sentFrameCount++

      if (backpressureObserved && serverSocket.getBufferedAmount() >= minimumBufferedAmount) {
        break
      }
    }

    assert.equal(backpressureObserved, true, 'could not create the backpressure needed to exercise forced close')
    assert.ok(serverSocket.getBufferedAmount() >= minimumBufferedAmount)

    const drainPulse = new Promise((resolve) => {
      drainPulseRemaining = 1024 * 1024
      resolveDrainPulse = resolve
    })
    const closeStartedAt = Date.now()
    const closed = waitForClose(socket, {
      timeoutMs: 8_000,
      message: 'WebSocket forced-close deadline did not close the unresponsive peer'
    })

    serverSocket.end(1000, 'shutdown probe')
    assert.equal(closeCount, 1)

    socket.resume()
    await withTimeout(drainPulse, 1_000, 'could not trigger a writable event after WebSocket end()')
    await delay(4_500)

    socket.resume()
    await closed

    const closeElapsedMs = Date.now() - closeStartedAt

    assert.ok(closeElapsedMs >= 4_000, `forced close fired before its deadline: ${closeElapsedMs}ms`)
    assert.ok(closeElapsedMs < 8_000, `forced close exceeded its deadline allowance: ${closeElapsedMs}ms`)

    const receivedByteCount = receivedFrames.reduce((total, chunk) => total + chunk.length, 0)
    const sentWireBytes = sentFrameCount * (payload.length + 10)

    // Winsock may move the full userspace backlog into its kernel send buffer
    // during the drain pulse, making client-visible bytes non-diagnostic there.
    if (process.platform !== 'win32') {
      assert.ok(
        receivedByteCount < sentWireBytes - minimumBufferedAmount / 2,
        'forced close drained the entire queued payload instead of discarding backpressure at the deadline'
      )
    }
  } finally {
    socket?.destroy()
    server.close()
  }
})

async function upgradedSocket(port) {
  const result = await rawHandshake(port, handshakeRequest())

  assert.match(result.response, /^HTTP\/1\.1 101 /)

  return result.socket
}

async function rawHandshake(port, request) {
  const socket = createConnection({ host: '127.0.0.1', port })

  socket.on('error', () => {})
  await once(socket, 'connect')

  const responseHead = readResponseHead(socket, {
    closeMessage: 'socket closed before the HTTP response head'
  })

  socket.write(request)

  return {
    response: (await responseHead).toString('latin1'),
    socket
  }
}

function waitForClose(
  socket,
  { timeoutMs = 2_000, message = 'unmasked WebSocket frame did not close the connection' } = {}
) {
  if (socket.closed) {
    return Promise.resolve()
  }

  return withTimeout(new Promise((resolve) => socket.once('close', resolve)), timeoutMs, message)
}

function handshakeRequest({
  connection = 'Upgrade',
  keys = [VALID_KEY],
  path = '/ws',
  upgrade = 'websocket',
  version = '13',
  versions
} = {}) {
  const headers = [`GET ${path} HTTP/1.1`, 'Host: localhost']

  for (const selectedConnection of connection === null ? [] : [connection].flat()) {
    headers.push(`Connection: ${selectedConnection}`)
  }

  for (const selectedUpgrade of upgrade === null ? [] : [upgrade].flat()) {
    headers.push(`Upgrade: ${selectedUpgrade}`)
  }

  for (const selectedVersion of versions ?? (version === null ? [] : [version])) {
    headers.push(`Sec-WebSocket-Version: ${selectedVersion}`)
  }

  for (const key of keys) {
    headers.push(`Sec-WebSocket-Key: ${key}`)
  }

  return `${headers.join('\r\n')}\r\n\r\n`
}

function maskedTextFrame(message) {
  return maskedShortFrame(0x01, Buffer.from(message))
}

function maskedShortFrame(opcode, payload) {
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78])
  const frame = Buffer.alloc(6 + payload.length)

  assert.ok(payload.length < 126)
  frame[0] = 0x80 | opcode
  frame[1] = 0x80 | payload.length
  mask.copy(frame, 2)

  for (let i = 0; i < payload.length; i++) {
    frame[6 + i] = payload[i] ^ mask[i % 4]
  }

  return frame
}

function maskedFrameWithEncodedLength(payload, lengthCode, declaredLength = BigInt(payload.length)) {
  const extendedBytes = lengthCode === 126 ? 2 : 8
  const frame = Buffer.alloc(2 + extendedBytes + 4 + payload.length)

  frame[0] = 0x82
  frame[1] = 0x80 | lengthCode

  if (lengthCode === 126) {
    frame.writeUInt16BE(Number(declaredLength), 2)
  } else {
    frame.writeBigUInt64BE(declaredLength, 2)
  }

  payload.copy(frame, 2 + extendedBytes + 4)

  return frame
}
