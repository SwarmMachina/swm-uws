import { createConnection } from 'node:net'
import { setImmediate as yieldToLoop, setTimeout as delay } from 'node:timers/promises'

export function rawHttpExchange(
  connection,
  chunks,
  {
    prefix,
    acceptResetAfterData = false,
    delayMs = 0,
    yieldBetweenChunks = false,
    resolveOn = 'end',
    timeoutMs = 5_000,
    timeoutMessage = 'raw HTTP exchange'
  } = {}
) {
  if (resolveOn !== 'end' && resolveOn !== 'close') {
    throw new TypeError("resolveOn must be either 'end' or 'close'")
  }

  if (typeof acceptResetAfterData !== 'boolean') {
    throw new TypeError('acceptResetAfterData must be a boolean')
  }

  return new Promise((resolve, reject) => {
    const socket = createConnection(connection)
    const response = []

    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`${timeoutMessage} timed out`)))
    socket.on('data', (chunk) => response.push(chunk))
    socket.once(resolveOn, () => resolve(Buffer.concat(response)))
    socket.once('error', (error) => {
      if (acceptResetAfterData && error.code === 'ECONNRESET' && response.length > 0) {
        resolve(Buffer.concat(response))

        return
      }

      reject(error)
    })
    socket.once('connect', () => {
      void writeChunks(socket, chunks, { prefix, delayMs, yieldBetweenChunks }).catch((error) => {
        socket.destroy(error)
      })
    })
  })
}

export function proxyProtocolV2Ipv4Header({
  sourceAddress,
  destinationAddress = [127, 0, 0, 1],
  sourcePort,
  destinationPort
}) {
  assertIpv4Address('sourceAddress', sourceAddress)
  assertIpv4Address('destinationAddress', destinationAddress)
  assertPort('sourcePort', sourcePort)
  assertPort('destinationPort', destinationPort)

  const header = Buffer.alloc(28)

  Buffer.from('\r\n\r\n\0\r\nQUIT\n', 'binary').copy(header)
  header[12] = 0x21
  header[13] = 0x11
  header.writeUInt16BE(12, 14)
  Buffer.from([...sourceAddress, ...destinationAddress]).copy(header, 16)
  header.writeUInt16BE(sourcePort, 24)
  header.writeUInt16BE(destinationPort, 26)

  return header
}

async function writeChunks(socket, chunks, { prefix, delayMs, yieldBetweenChunks }) {
  if (prefix) {
    socket.write(prefix)
  }

  for (const chunk of chunks) {
    if (socket.destroyed) {
      break
    }

    socket.write(chunk)

    if (delayMs > 0) {
      await delay(delayMs)
    } else if (yieldBetweenChunks) {
      await yieldToLoop()
    }
  }
}

function assertIpv4Address(name, address) {
  if (
    !Array.isArray(address) ||
    address.length !== 4 ||
    address.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    throw new TypeError(`${name} must contain four IPv4 bytes`)
  }
}

function assertPort(name, port) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError(`${name} must be an integer between 0 and 65535`)
  }
}
