import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { createApp } from '../../../lib/index.js'
import { withTimeout } from '../../helpers/async.js'
import { NativeAppServer } from '../../helpers/native-app-server.js'
import { readResponseHead, webSocketHandshakeRequest } from '../../helpers/raw-websocket.js'
import { MAX_INBOUND_BYTES, RETENTION_PROBE_BYTES, retentionClientFixture } from './constants.js'
import { connectedSocket, maskedFrameHeader, rssDelta, rssSnapshot, write } from './common.js'

export async function probeWebSocketAllocation() {
  const app = createApp()
  const opened = Promise.withResolvers()

  app.ws('/ws', {
    maxPayloadLength: MAX_INBOUND_BYTES,
    open() {
      opened.resolve()
    }
  })

  const server = await NativeAppServer.listen(app)
  const socket = await connectedSocket(server.port)

  try {
    const responseHead = readResponseHead(socket)

    socket.write(webSocketHandshakeRequest())
    assert.match((await responseHead).toString('latin1'), /^HTTP\/1\.1 101 /)
    await withTimeout(opened.promise, 2_000, 'WebSocket open callback did not run')

    const baseline = await rssSnapshot()

    await write(socket, maskedFrameHeader(MAX_INBOUND_BYTES))
    const afterDeclaration = await rssSnapshot()

    return rssDelta(baseline, afterDeclaration)
  } finally {
    socket.destroy()
    await delay(10)
    server.close()
  }
}

export async function probeWebSocketRetention() {
  const app = createApp()
  const pendingMessages = []

  app.ws('/retention', {
    maxPayloadLength: MAX_INBOUND_BYTES,
    message(_socket, payload, isBinary) {
      assert.equal(isBinary, true)
      assert.equal(payload.byteLength, RETENTION_PROBE_BYTES)

      const pending = pendingMessages.shift()

      assert.ok(pending, 'fragmented message arrived without a pending probe')
      pending.resolve(payload.byteLength)
    }
  })

  const server = await NativeAppServer.listen(app)
  const clients = []

  let baseline
  let afterFirstMessage
  let afterAllMessages
  let cleanupError
  let result

  try {
    for (let connection = 0; connection < 4; connection++) {
      const client = retentionClient(server.port)

      clients.push(client)
      await waitForOutputLine(client.process.stdout, 'OPEN')

      if (connection === 0) {
        baseline = await rssSnapshot()
      }

      const messageReceived = Promise.withResolvers()

      pendingMessages.push(messageReceived)
      client.process.stdin.write('SEND\n')
      const receivedBytes = await withTimeout(
        messageReceived.promise,
        5_000,
        'large fragmented WebSocket message was not delivered'
      )

      assert.equal(receivedBytes, RETENTION_PROBE_BYTES)
      await delay(10)

      if (connection === 0) {
        afterFirstMessage = await rssSnapshot()
      }
    }

    afterAllMessages = await rssSnapshot()

    for (const client of clients) {
      assert.equal(client.process.exitCode, null, 'WebSocket client closed before retention sampling')
    }

    result = {
      activeConnections: clients.length,
      additionalPeakRssBytes: Math.max(0, afterAllMessages.peakRssBytes - afterFirstMessage.peakRssBytes),
      additionalRssBytes: Math.max(0, afterAllMessages.rssBytes - afterFirstMessage.rssBytes),
      firstMessage: rssDelta(baseline, afterFirstMessage),
      messageBytes: RETENTION_PROBE_BYTES
    }
  } finally {
    const exits = await Promise.all(clients.map(stopRetentionClient))
    const failedClient = exits.find(({ cleanupError: error, exit }) => error || exit.code !== 0 || exit.signal !== null)

    server.close()

    if (failedClient) {
      cleanupError = new Error(
        `retention probe client exited ${failedClient.exit.code ?? failedClient.exit.signal}: ${[
          failedClient.cleanupError?.message,
          Buffer.concat(failedClient.errors).toString()
        ]
          .filter(Boolean)
          .join('\n')}`
      )
    }
  }

  if (cleanupError) {
    throw cleanupError
  }

  return result
}

export async function probeWebSocketCancellation() {
  const app = createApp()
  const callbackCompleted = Promise.withResolvers()

  app.ws('/retention', {
    maxPayloadLength: MAX_INBOUND_BYTES,
    message(socket, payload, isBinary) {
      assert.equal(isBinary, true)
      assert.equal(payload.byteLength, RETENTION_PROBE_BYTES)

      const view = new Uint8Array(payload)

      socket.end(1000, 'cancel fragmented input')
      // end() requests a fragment-buffer clear, but the external view must stay
      // valid until this callback returns.
      assert.equal(view[0], 0)
      assert.equal(view[view.length - 1], 0)
      callbackCompleted.resolve(view.length)
    }
  })

  const server = await NativeAppServer.listen(app)
  const client = retentionClient(server.port)

  let cleanupError
  let result

  try {
    await waitForOutputLine(client.process.stdout, 'OPEN')
    client.process.stdin.write('SEND\n')

    result = {
      callbackBytes: await withTimeout(
        callbackCompleted.promise,
        5_000,
        'fragmented cancellation callback did not complete'
      )
    }
  } finally {
    const stoppedClient = await stopRetentionClient(client)

    server.close()

    if (stoppedClient.cleanupError || stoppedClient.exit.code !== 0 || stoppedClient.exit.signal !== null) {
      cleanupError = new Error(
        `cancellation probe client failed: ${[
          stoppedClient.cleanupError?.message,
          Buffer.concat(stoppedClient.errors).toString()
        ]
          .filter(Boolean)
          .join('\n')}`
      )
    }
  }

  if (cleanupError) {
    throw cleanupError
  }

  return result
}

function waitForOutputLine(stream, expected) {
  return withTimeout(
    new Promise((resolve, reject) => {
      let pending = ''

      function cleanup() {
        stream.off('data', onData)
        stream.off('error', onError)
      }

      function onData(chunk) {
        pending += chunk.toString()

        if (pending.split('\n').includes(expected)) {
          cleanup()
          resolve()
        }
      }

      function onError(error) {
        cleanup()
        reject(error)
      }

      stream.on('data', onData)
      stream.once('error', onError)
    }),
    2_000,
    `retention probe client did not report ${expected}`
  )
}

function childExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }

  return withTimeout(
    new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
    }),
    2_000,
    'retention probe client did not exit'
  )
}

async function stopRetentionClient(client) {
  if (client.process.exitCode === null && client.process.signalCode === null) {
    client.process.stdin.end('CLOSE\n')
  }

  try {
    return { ...client, exit: await childExit(client.process) }
  } catch (cleanupError) {
    if (client.process.exitCode === null && client.process.signalCode === null) {
      client.process.kill()
    }

    let exit = { code: client.process.exitCode, signal: client.process.signalCode }

    try {
      exit = await childExit(client.process)
    } catch {
      // The exact child was already asked to terminate; the outer fixture timeout is the final bound.
    }

    return { ...client, cleanupError, exit }
  }
}

function retentionClient(port) {
  const processHandle = spawn(process.execPath, [retentionClientFixture, String(port), String(RETENTION_PROBE_BYTES)], {
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const errors = []

  processHandle.on('error', (error) => errors.push(Buffer.from(error.stack || error.message)))
  processHandle.stderr.on('data', (chunk) => errors.push(chunk))
  processHandle.stdin.on('error', () => {})

  return { errors, process: processHandle }
}
