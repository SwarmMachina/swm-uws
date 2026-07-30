import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

import { ProcessMemorySampler } from '@swarmmachina/benchkit/measurement'
import { V8HeapAllocationSampler } from '@swarmmachina/benchkit/profiling'

const bindingPath = process.env.SWM_SNAPSHOT_BENCH_BINDING || new URL('../lib/index.js', import.meta.url).href
const metricsPath = process.env.SWM_SNAPSHOT_BENCH_METRICS
const port = Number(process.env.SWM_SNAPSHOT_BENCH_PORT || 3000)
const mode = process.env.SWM_SNAPSHOT_BENCH_MODE || 'snapshot'

if (!metricsPath) {
  throw new Error('SWM_SNAPSHOT_BENCH_METRICS is required')
}

if (mode !== 'snapshot' && mode !== 'forEach') {
  throw new Error(`unsupported snapshot benchmark mode: ${mode}`)
}

const binding = await loadBinding(bindingPath)
const api = binding.default || binding
const createApp = api.App || api.createApp

if (typeof createApp !== 'function') {
  throw new TypeError(`${bindingPath} does not export App or createApp`)
}

const allocationSampler = new V8HeapAllocationSampler({
  samplingIntervalBytes: 32 * 1024,
  includeCollectedObjects: true
})
const memorySampler = new ProcessMemorySampler()
const app = createApp()

await allocationSampler.start()
memorySampler.start()

let eluStart = performance.eventLoopUtilization()
let listenSocket
let snapshotRequests = 0
let checksum = 0
let stopping = false

app.get('/snapshot', mode === 'snapshot' ? snapshotRequest : forEachRequest)

function snapshotRequest(res, req) {
  completeRequest(res, req.snapshot())
}

function forEachRequest(res, req) {
  const headers = Object.create(null)

  req.forEach((name, value) => {
    headers[name] = value
  })
  completeRequest(res, {
    method: req.getMethod(),
    url: req.getUrl(),
    query: req.getQuery(),
    headers,
    params: []
  })
}

function completeRequest(res, snapshot) {
  snapshotRequests++
  res.end('ok')
  setImmediate(() => {
    const headers = snapshot.headers
    const variant = headers['x-variant']
    const dynamic = headers[`x-dynamic-${variant}`]

    checksum ^= headers.host.length + headers['x-common-a'].length + headers['x-common-b'].length + dynamic.length
  })
}

app.get('/__reset', (res) => {
  res.onAborted(() => {})
  void resetMetrics().then(
    () => res.end('reset'),
    (error) => {
      console.error(error)
      res.writeStatus('500 Internal Server Error').end('reset failed')
    }
  )
})

async function resetMetrics() {
  await allocationSampler.stop()
  memorySampler.stop()
  global.gc?.()
  await allocationSampler.start()
  memorySampler.start()

  snapshotRequests = 0
  checksum = 0
  eluStart = performance.eventLoopUtilization()
}

async function stop() {
  if (stopping) {
    return
  }

  stopping = true

  const elu = performance.eventLoopUtilization(eluStart)
  const memory = memorySampler.stop()
  const allocationProfile = await allocationSampler.stop()

  if (!memory) {
    throw new Error('process memory sampler was not running')
  }

  fs.writeFileSync(
    metricsPath,
    `${JSON.stringify(
      {
        snapshotRequests,
        mode,
        checksum,
        eluPct: elu.utilization * 100,
        rssBytes: memory.rss.endBytes,
        rssPeakBytes: memory.rss.peakBytes,
        heapUsedBytes: memory.heapUsed.endBytes,
        heapUsedPeakBytes: memory.heapUsed.peakBytes,
        heapUsedDeltaBytes: memory.heapUsed.deltaBytes,
        sampledAllocationBytes: allocationProfile.sampledAllocationBytes,
        sampledAllocationBytesPerRequest:
          snapshotRequests === 0 ? 0 : allocationProfile.sampledAllocationBytes / snapshotRequests
      },
      null,
      2
    )}\n`
  )

  if (listenSocket && api.us_listen_socket_close) {
    api.us_listen_socket_close(listenSocket)
  }

  app.close?.()
  await allocationSampler.dispose()
  process.exit(0)
}

async function loadBinding(modulePath) {
  const resolved = modulePath.startsWith('file:') ? modulePath : path.resolve(modulePath)

  if (String(resolved).endsWith('.node')) {
    return createRequire(import.meta.url)(resolved)
  }

  return import(typeof resolved === 'string' && !resolved.startsWith('file:') ? pathToFileURL(resolved).href : resolved)
}

process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())

app.listen('127.0.0.1', port, (socket) => {
  if (!socket) {
    throw new Error(`listen failed on 127.0.0.1:${port}`)
  }

  listenSocket = socket
  process.stdout.write(`ready http://127.0.0.1:${port}/snapshot\n`)
})
