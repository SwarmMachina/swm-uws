import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createConnection } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import { createApp } from '../lib/index.js'
import { waitFor, withTimeout } from './helpers/async.js'
import { NativeAppServer } from './helpers/native-app-server.js'

const VALID_KEY = 'dGhlIHNhbXBsZSBub25jZQ=='

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

    serverSocket.end(1000, 'shutdown probe')
    assert.equal(closeCount, 1)

    socket.resume()
    await withTimeout(drainPulse, 1_000, 'could not trigger a writable event after WebSocket end()')
    await delay(4_500)

    const closed = waitForClose(socket, {
      timeoutMs: 3_000,
      message: 'WebSocket forced-close deadline did not close the unresponsive peer'
    })

    socket.resume()
    await closed

    const receivedByteCount = receivedFrames.reduce((total, chunk) => total + chunk.length, 0)
    const sentWireBytes = sentFrameCount * (payload.length + 10)

    assert.ok(
      receivedByteCount < sentWireBytes - minimumBufferedAmount / 2,
      'forced close drained the entire queued payload instead of discarding backpressure at the deadline'
    )
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

  const responseHead = readResponseHead(socket)

  socket.write(request)

  return {
    response: (await responseHead).toString('latin1'),
    socket
  }
}

function readResponseHead(socket) {
  return withTimeout(
    new Promise((resolve, reject) => {
      const chunks = []

      function cleanup() {
        socket.off('close', onClose)
        socket.off('data', onData)
        socket.off('error', onError)
      }

      function onClose() {
        cleanup()
        reject(new Error('socket closed before the HTTP response head'))
      }

      function onData(chunk) {
        chunks.push(chunk)

        const response = Buffer.concat(chunks)

        if (response.includes('\r\n\r\n')) {
          cleanup()
          resolve(response)
        }
      }

      function onError(error) {
        cleanup()
        reject(error)
      }

      socket.once('close', onClose)
      socket.on('data', onData)
      socket.once('error', onError)
    }),
    2_000,
    'WebSocket handshake response timed out'
  )
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
  const payload = Buffer.from(message)
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78])
  const frame = Buffer.alloc(6 + payload.length)

  assert.ok(payload.length < 126)
  frame[0] = 0x81
  frame[1] = 0x80 | payload.length
  mask.copy(frame, 2)

  for (let i = 0; i < payload.length; i++) {
    frame[6 + i] = payload[i] ^ mask[i % 4]
  }

  return frame
}
