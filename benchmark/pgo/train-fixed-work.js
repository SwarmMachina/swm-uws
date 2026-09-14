import http from 'node:http'

const [protocol, portText, countText, connectionsText, depthText = '1'] = process.argv.slice(2)
const [port, count, connections, depth] = [portText, countText, connectionsText, depthText].map(Number)

if (
  !['GET', 'POST', 'WS'].includes(protocol) ||
  ![port, count, connections, depth].every((v) => Number.isSafeInteger(v) && v > 0) ||
  count < connections
) {
  throw new Error('usage: train-fixed-work.js GET|POST|WS port count connections depth')
}

const deadline = setTimeout(() => {
  throw new Error('TRAINING_INCOMPLETE: deadline exceeded')
}, 300_000)

let completed = 0

const agent = new http.Agent({ keepAlive: true, maxSockets: connections })

try {
  await Promise.all(
    Array.from({ length: connections }, async (_, index) => {
      const budget = Math.floor(count / connections) + (index < count % connections ? 1 : 0)

      if (protocol === 'WS') {
        await new Promise((resolve, reject) => {
          const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)

          let sent = 0
          let received = 0

          const fill = () => {
            while (sent < budget && sent - received < depth) {
              socket.send(new Uint8Array(256))
              sent++
            }
          }

          socket.onopen = fill
          socket.onerror = () => reject(new Error('WS training failed'))
          socket.onmessage = (event) => {
            if (event.data.size !== 256) {
              return reject(new Error('invalid echo'))
            }

            received++
            completed++

            if (received === budget) {
              socket.close()
            } else {
              fill()
            }
          }
          socket.onclose = () => (received === budget ? resolve() : reject(new Error('incomplete WS training')))
        })
      } else {
        for (let operation = 0; operation < budget; operation++) {
          await new Promise((resolve, reject) => {
            const request = http.request(
              {
                hostname: '127.0.0.1',
                port,
                path: protocol === 'POST' ? '/post' : '/base',
                method: protocol,
                agent,
                headers: protocol === 'POST' ? { 'content-length': 256 } : {}
              },
              (response) => {
                response.resume()
                response.on('error', reject)
                response.on('end', () =>
                  response.statusCode === 200 ? resolve() : reject(new Error('training HTTP status'))
                )
              }
            )

            request.on('error', reject)
            request.end(protocol === 'POST' ? Buffer.alloc(256, 0x61) : undefined)
          })
          completed++
        }
      }
    })
  )

  if (completed !== count) {
    throw new Error('TRAINING_INCOMPLETE')
  }

  console.log(
    JSON.stringify({
      protocol,
      requested: count,
      completed,
      connections,
      depth,
      payloadBytes: protocol === 'GET' ? 0 : 256
    })
  )
} finally {
  clearTimeout(deadline)
  agent.destroy()
}
