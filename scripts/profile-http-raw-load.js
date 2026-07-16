import net from 'node:net'
import os from 'node:os'
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'

const HEADER_END = Buffer.from('\r\n\r\n')

function percentile(values, fraction) {
  if (!values.length) return 0
  const sorted = values.sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

function parseArgs(argv) {
  const options = {
    host: '127.0.0.1',
    method: 'GET',
    path: '/base',
    bodySize: 0,
    port: 3000,
    connections: 100,
    pipelining: 10,
    duration: 5,
    workers: Math.min(4, os.availableParallelism())
  }

  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!value || !name.startsWith('--')) throw new Error(`invalid argument: ${name}`)
    const key = name.slice(2)
    if (!(key in options)) throw new Error(`unknown option: ${name}`)
    options[key] = key === 'host' || key === 'path' || key === 'method' ? value : Number(value)
  }

  for (const key of ['port', 'connections', 'pipelining', 'duration', 'workers']) {
    if (!Number.isFinite(options[key]) || options[key] <= 0) {
      throw new Error(`--${key} must be a positive number`)
    }
  }

  if (!Number.isInteger(options.bodySize) || options.bodySize < 0) {
    throw new Error('--bodySize must be a non-negative integer')
  }
  options.method = options.method.toUpperCase()
  if (options.method !== 'GET' && options.method !== 'POST') {
    throw new Error('--method must be GET or POST')
  }

  options.workers = Math.min(Math.floor(options.workers), Math.floor(options.connections))
  return options
}

function runWorker() {
  const { host, method, path, bodySize, port, connections, pipelining, duration } = workerData
  const body = Buffer.alloc(bodySize, 0x61)
  const contentLength = method === 'POST' || body.length ? `Content-Length: ${body.length}\r\n` : ''
  const request = Buffer.concat([
    Buffer.from(
      `${method} ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: keep-alive\r\n${contentLength}\r\n`
    ),
    body
  ])
  const requestBatches = Array.from({ length: pipelining + 1 }, (_, count) =>
    count === 0 ? Buffer.alloc(0) : Buffer.concat(Array(count).fill(request))
  )
  const states = new Set()
  const latencies = []
  let connected = 0
  let startupFailed = false
  let requests = 0
  let errors = 0
  let running = false
  let stopAt = 0

  function writeRequests(state, count) {
    const now = performance.now()
    for (let index = 0; index < count; index++) state.pending.push(now)
    state.socket.write(requestBatches[count] || Buffer.concat(Array(count).fill(request)))
  }

  function recordResponses(state, count) {
    const now = performance.now()
    for (let index = 0; index < count; index++) {
      const sentAt = state.pending.shift()
      if (running && sentAt !== undefined && now <= stopAt) {
        requests++
        latencies.push(now - sentAt)
      }
    }
    if (running && now <= stopAt) writeRequests(state, count)
  }

  function parseResponses(state) {
    if (!state.responseLength) {
      const headerEnd = state.buffer.indexOf(HEADER_END)
      if (headerEnd === -1) return
      const headers = state.buffer.subarray(0, headerEnd).toString('latin1')
      const match = /\r\ncontent-length:\s*(\d+)/i.exec(headers)
      if (!match) throw new Error('response has no content-length')
      state.responseLength = headerEnd + HEADER_END.length + Number(match[1])
    }

    const complete = Math.floor(state.buffer.length / state.responseLength)
    if (!complete) return
    state.buffer = state.buffer.subarray(complete * state.responseLength)
    recordResponses(state, complete)
  }

  for (let index = 0; index < connections; index++) {
    const socket = net.createConnection({ host, port, noDelay: true })
    const state = { socket, buffer: Buffer.alloc(0), pending: [], responseLength: 0 }
    states.add(state)
    socket.setTimeout(5_000, () => socket.destroy(new Error('connection timed out')))

    socket.on('connect', () => {
      socket.setTimeout(0)
      connected++
      if (connected === connections) parentPort.postMessage({ type: 'ready' })
    })
    socket.on('data', (chunk) => {
      state.buffer = state.buffer.length ? Buffer.concat([state.buffer, chunk]) : chunk
      parseResponses(state)
    })
    socket.on('error', (error) => {
      errors++
      if (!running && !startupFailed) {
        startupFailed = true
        parentPort.postMessage({ type: 'error', message: error.message })
      }
    })
  }

  parentPort.on('message', (message) => {
    if (message !== 'start') return
    running = true
    stopAt = performance.now() + duration * 1000
    for (const state of states) writeRequests(state, pipelining)

    setTimeout(() => {
      running = false
      for (const state of states) state.socket.destroy()
      parentPort.postMessage({ type: 'result', requests, errors, latencies })
    }, duration * 1000)
  })
}

async function runMain() {
  const options = parseArgs(process.argv.slice(2))
  const workerCount = options.workers
  const baseConnections = Math.floor(options.connections / workerCount)
  const extraConnections = options.connections % workerCount
  const workers = []

  for (let index = 0; index < workerCount; index++) {
    workers.push(
      new Worker(new URL(import.meta.url), {
        workerData: {
          ...options,
          connections: baseConnections + (index < extraConnections ? 1 : 0)
        }
      })
    )
  }

  await Promise.all(
    workers.map(
      (worker) =>
        new Promise((resolve, reject) => {
          worker.once('error', reject)
          worker.on('message', (message) => {
            if (message.type === 'ready') resolve()
            if (message.type === 'error') reject(new Error(`load worker failed: ${message.message}`))
          })
        })
    )
  )

  const resultsPromise = Promise.all(
    workers.map(
      (worker) =>
        new Promise((resolve, reject) => {
          worker.once('error', reject)
          worker.on('message', (message) => {
            if (message.type === 'result') resolve(message)
          })
        })
    )
  )
  for (const worker of workers) worker.postMessage('start')
  const results = await resultsPromise
  const latencies = results.flatMap((result) => result.latencies)
  const requests = results.reduce((sum, result) => sum + result.requests, 0)
  const errors = results.reduce((sum, result) => sum + result.errors, 0)
  const summary = {
    connections: options.connections,
    method: options.method,
    path: options.path,
    bodySize: options.bodySize,
    pipelining: options.pipelining,
    duration: options.duration,
    workers: workerCount,
    requests: {
      total: requests,
      average: requests / options.duration
    },
    latency: {
      p95: percentile(latencies, 0.95),
      p97_5: percentile(latencies, 0.975),
      p99: percentile(latencies, 0.99)
    },
    errors
  }

  process.stdout.write(`${JSON.stringify(summary)}\n`)
  await Promise.all(workers.map((worker) => worker.terminate()))
}

if (isMainThread) {
  await runMain()
} else {
  runWorker()
}
