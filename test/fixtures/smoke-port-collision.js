import assert from 'node:assert/strict'
import { once } from 'node:events'
import { Server } from 'node:net'

const scenario = process.argv[2]

assert.ok(['v8-http-smoke', 'v8-ws-smoke'].includes(scenario))

const reserved = new Server((socket) => socket.destroy())

try {
  reserved.listen({ port: 40_000 + (process.pid % 10_000), ipv6Only: false })

  try {
    await once(reserved, 'listening')
  } catch (error) {
    // An existing listener already supplies the collision this fixture needs.
    if (error.code !== 'EADDRINUSE') {
      throw error
    }
  }

  await import(new URL(`../${scenario}.js`, import.meta.url))
} finally {
  if (reserved.listening) {
    await new Promise((resolve) => reserved.close(resolve))
  }
}
