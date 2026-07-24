import { performance } from 'node:perf_hooks'

import { BoundedLatencyRecorder } from '@swarmmachina/benchkit/measurement'

const connections = Number(process.env.CONNECTIONS || 50)
const depth = Number(process.env.DEPTH || 1)
const durationMs = Number(process.env.DURATION_MS || 10_000)
const payload = new Uint8Array(Number(process.env.PAYLOAD_BYTES || 256))
const port = Number(process.env.PORT || 30123)
const sockets = []
const latencies = new BoundedLatencyRecorder()

let messages = 0
let maxLatencyMs = 0
let opened = 0
let closed = 0
let resolveOpened

const allOpened = new Promise((resolve) => {
  resolveOpened = resolve
})

let resolveClosed

const allClosed = new Promise((resolve) => {
  resolveClosed = resolve
})

for (let index = 0; index < connections; index++) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const state = { socket, pending: [] }

  sockets.push(state)

  socket.addEventListener('open', () => {
    opened++

    if (opened === connections) {
      resolveOpened()
    }
  })

  socket.addEventListener('message', () => {
    const now = performance.now()
    const sentAt = state.pending.shift()

    if (sentAt !== undefined) {
      const latencyMs = now - sentAt

      latencies.record(latencyMs)
      maxLatencyMs = Math.max(maxLatencyMs, latencyMs)
    }

    messages++

    if (now < deadline) {
      state.pending.push(now)
      socket.send(payload)
    } else {
      socket.close(1000, 'done')
    }
  })

  socket.addEventListener('close', () => {
    closed++

    if (closed === connections) {
      resolveClosed()
    }
  })

  socket.addEventListener('error', (error) => {
    throw error
  })
}

await allOpened
const started = performance.now()
const deadline = started + durationMs

for (const state of sockets) {
  for (let index = 0; index < depth; index++) {
    state.pending.push(started)
    state.socket.send(payload)
  }
}

const stopTimer = setTimeout(() => {
  for (const { socket } of sockets) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(1000, 'timeout')
    }
  }
}, durationMs + 1_000)

await allClosed
clearTimeout(stopTimer)

const elapsedSeconds = (performance.now() - started) / 1_000
const latency = latencies.summary()

console.log(
  JSON.stringify({
    connections,
    depth,
    durationMs,
    payloadBytes: payload.byteLength,
    messages,
    messagesPerSecond: messages / elapsedSeconds,
    latencyMs: {
      p50: latency.p50Ms,
      p95: latency.p95Ms,
      p99: latency.p99Ms,
      max: maxLatencyMs,
      accuracy: latency.accuracy
    }
  })
)
