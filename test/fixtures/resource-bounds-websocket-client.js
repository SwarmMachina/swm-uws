import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createConnection } from 'node:net'
import { createInterface } from 'node:readline'

import { withTimeout } from '../helpers/async.js'

const port = Number(process.argv[2])
const messageBytes = Number(process.argv[3])

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`invalid WebSocket client port: ${process.argv[2]}`)
}

if (!Number.isSafeInteger(messageBytes) || messageBytes < 2 || messageBytes % 2 !== 0) {
  throw new Error(`invalid fragmented message size: ${process.argv[3]}`)
}

const socket = createConnection({ host: '127.0.0.1', port })

await withTimeout(once(socket, 'connect'), 2_000, 'retention probe client did not connect')

const responseHead = readResponseHead(socket)

socket.write(webSocketHandshake())
assert.match((await responseHead).toString('latin1'), /^HTTP\/1\.1 101 /)
process.stdout.write('OPEN\n')

const commands = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })

for await (const command of commands) {
  if (command === 'SEND') {
    await sendFragmentedMessage(socket, messageBytes)
    process.stdout.write('SENT\n')
    continue
  }

  if (command === 'CLOSE') {
    socket.destroy()
    break
  }

  throw new Error(`unknown retention probe client command: ${command}`)
}

commands.close()

async function sendFragmentedMessage(target, totalBytes) {
  const frameBytes = totalBytes / 2

  await sendFrame(target, { fin: false, opCode: 2, payloadBytes: frameBytes })
  await sendFrame(target, { fin: true, opCode: 0, payloadBytes: frameBytes })
}

async function sendFrame(target, { fin, opCode, payloadBytes }) {
  await writeBuffered(target, maskedFrameHeader({ fin, opCode, payloadBytes }))

  const zeroes = Buffer.alloc(64 * 1024)

  let remaining = payloadBytes

  while (remaining > 0) {
    const length = Math.min(remaining, zeroes.length)

    await writeBuffered(target, length === zeroes.length ? zeroes : zeroes.subarray(0, length))
    remaining -= length
  }
}

function maskedFrameHeader({ fin, opCode, payloadBytes }) {
  const header = Buffer.alloc(14)

  header[0] = (fin ? 0x80 : 0) | opCode
  header[1] = 0xff
  header.writeBigUInt64BE(BigInt(payloadBytes), 2)
  // A zero mask is valid and lets the client stream one reusable zero-filled chunk.
  header.fill(0, 10)

  return header
}

async function writeBuffered(target, bytes) {
  if (!target.write(bytes)) {
    await withTimeout(once(target, 'drain'), 2_000, 'retention probe client write stalled')
  }
}

function readResponseHead(target) {
  return withTimeout(
    new Promise((resolve, reject) => {
      const chunks = []

      function cleanup() {
        target.off('close', onClose)
        target.off('data', onData)
        target.off('error', onError)
      }

      function onClose() {
        cleanup()
        reject(new Error('socket closed before the WebSocket handshake response'))
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

      target.once('close', onClose)
      target.on('data', onData)
      target.once('error', onError)
    }),
    2_000,
    'retention probe WebSocket handshake timed out'
  )
}

function webSocketHandshake() {
  return (
    'GET /retention HTTP/1.1\r\n' +
    'Host: localhost\r\n' +
    'Connection: Upgrade\r\n' +
    'Upgrade: websocket\r\n' +
    'Sec-WebSocket-Version: 13\r\n' +
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
    '\r\n'
  )
}
