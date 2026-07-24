import os from 'node:os'

import { runHttp1Load } from '@swarmmachina/benchkit/load/http1'
import { parseArgs } from '@swarmmachina/benchkit/orchestration'

const options = parseArgs(
  process.argv,
  {
    host: '127.0.0.1',
    method: 'GET',
    path: '/base',
    bodySize: 0,
    port: 3000,
    connections: 100,
    pipelining: 10,
    duration: 5,
    workers: Math.min(4, os.availableParallelism())
  },
  {
    '--host': (out, value) => {
      out.host = requiredValue('--host', value)
    },
    '--method': (out, value) => {
      out.method = requiredValue('--method', value).toUpperCase()
    },
    '--path': (out, value) => {
      out.path = requiredValue('--path', value)
    },
    '--bodySize': (out, value) => {
      out.bodySize = numberValue('--bodySize', value)
    },
    '--port': (out, value) => {
      out.port = numberValue('--port', value)
    },
    '--connections': (out, value) => {
      out.connections = numberValue('--connections', value)
    },
    '--pipelining': (out, value) => {
      out.pipelining = numberValue('--pipelining', value)
    },
    '--duration': (out, value) => {
      out.duration = numberValue('--duration', value)
    },
    '--workers': (out, value) => {
      out.workers = numberValue('--workers', value)
    }
  },
  { strict: true, offset: 2 }
)

validateOptions(options)

const result = await runHttp1Load({
  url: new URL(options.path, `http://${options.host}:${options.port}`),
  method: options.method,
  body: options.method === 'POST' || options.bodySize ? Buffer.alloc(options.bodySize, 0x61) : undefined,
  connections: options.connections,
  pipelining: options.pipelining,
  durationMs: options.duration * 1_000,
  workers: options.workers
})
const summary = {
  connections: result.parameters.connections,
  method: result.parameters.method,
  path: new URL(result.parameters.url).pathname,
  bodySize: options.bodySize,
  pipelining: result.parameters.pipelining,
  duration: options.duration,
  workers: result.parameters.workers,
  requests: {
    total: result.requests.completed,
    average: result.requests.averagePerSecond
  },
  latency: {
    p95: result.latencyMs.p95Ms,
    p97_5: result.latencyMs.p97_5Ms,
    p99: result.latencyMs.p99Ms
  },
  errors: result.errors.total,
  benchkit: result
}

process.stdout.write(`${JSON.stringify(summary)}\n`)

function requiredValue(name, value) {
  if (!value) {
    throw new Error(`${name} requires a value`)
  }

  return value
}

function numberValue(name, value) {
  const number = Number(requiredValue(name, value))

  if (!Number.isFinite(number)) {
    throw new Error(`${name} must be a finite number`)
  }

  return number
}

function validateOptions(value) {
  if (value.method !== 'GET' && value.method !== 'POST') {
    throw new Error('--method must be GET or POST')
  }

  for (const key of ['port', 'connections', 'pipelining', 'duration', 'workers']) {
    if (!Number.isFinite(value[key]) || value[key] <= 0) {
      throw new Error(`--${key} must be a positive number`)
    }
  }

  if (!Number.isInteger(value.bodySize) || value.bodySize < 0) {
    throw new Error('--bodySize must be a non-negative integer')
  }

  value.workers = Math.min(Math.floor(value.workers), Math.floor(value.connections))
}
