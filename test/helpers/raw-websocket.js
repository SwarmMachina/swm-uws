import { withTimeout } from './async.js'

export const DEFAULT_WEBSOCKET_KEY = 'dGhlIHNhbXBsZSBub25jZQ=='

export function readResponseHead(
  socket,
  {
    closeMessage = 'socket closed before the WebSocket handshake response',
    timeoutMessage = 'WebSocket handshake response timed out',
    timeoutMs = 2_000
  } = {}
) {
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
        reject(new Error(closeMessage))
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
    timeoutMs,
    timeoutMessage
  )
}

export function webSocketHandshakeRequest({ path = '/ws' } = {}) {
  return (
    `GET ${path} HTTP/1.1\r\n` +
    'Host: localhost\r\n' +
    'Connection: Upgrade\r\n' +
    'Upgrade: websocket\r\n' +
    'Sec-WebSocket-Version: 13\r\n' +
    `Sec-WebSocket-Key: ${DEFAULT_WEBSOCKET_KEY}\r\n` +
    '\r\n'
  )
}
