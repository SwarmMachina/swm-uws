import os from 'node:os'

import { runWebSocketLoad } from '@swarmmachina/benchkit/load/websocket'

const connections = positiveIntegerEnvironment('CONNECTIONS', 50)
const maxInFlight = positiveIntegerEnvironment('DEPTH', 1)
const durationMs = positiveIntegerEnvironment('DURATION_MS', 10_000)
const warmupMs = nonNegativeIntegerEnvironment('WARMUP_MS', 0)
const payloadBytes = nonNegativeIntegerEnvironment('PAYLOAD_BYTES', 256)
const port = positiveIntegerEnvironment('PORT', 30_123)
const workers = Math.min(positiveIntegerEnvironment('WORKERS', 4), connections, os.availableParallelism())
const result = await runWebSocketLoad({
  name: 'swm-uws echo',
  url: `ws://127.0.0.1:${port}/ws`,
  message: new Uint8Array(payloadBytes),
  connections,
  maxInFlight,
  workers,
  durationMs,
  warmupMs
})
const summary = {
  connections,
  depth: maxInFlight,
  durationMs,
  warmupMs,
  workers,
  payloadBytes,
  messages: result.messages.received,
  sentMessages: result.messages.sent,
  messagesPerSecond: result.messages.averagePerSecond,
  latencyMs: {
    p50: result.latencyMs.p50Ms,
    p95: result.latencyMs.p95Ms,
    p97_5: result.latencyMs.p97_5Ms,
    p99: result.latencyMs.p99Ms,
    accuracy: result.latencyMs.accuracy
  },
  loadGenerator: {
    cpuCorePct: result.loadGenerator.cpuCorePct,
    parentEluPct: result.loadGenerator.parentEluPct,
    maxWorkerEluPct: result.loadGenerator.maxWorkerEluPct,
    rssPeakBytes: result.loadGenerator.processMemory.rss.peakBytes,
    heapUsedPeakBytes: result.loadGenerator.processMemory.heapUsed.peakBytes
  },
  transport: result.transport,
  errors: result.errors
}

process.stdout.write(`${JSON.stringify(summary)}\n`)

if (result.errors.total !== 0) {
  throw new Error(`WebSocket load reported ${result.errors.total} errors`)
}

function positiveIntegerEnvironment(name, fallback) {
  const value = integerEnvironment(name, fallback)

  if (value <= 0) {
    throw new RangeError(`${name} must be a positive integer`)
  }

  return value
}

function nonNegativeIntegerEnvironment(name, fallback) {
  const value = integerEnvironment(name, fallback)

  if (value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`)
  }

  return value
}

function integerEnvironment(name, fallback) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name])

  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be an integer`)
  }

  return value
}
