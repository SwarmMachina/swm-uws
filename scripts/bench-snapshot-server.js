import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

import { V8HeapAllocationSampler } from '@swarmmachina/benchkit/profiling'

const bindingPath = process.env.SWM_SNAPSHOT_BENCH_BINDING || new URL('../lib/index.js', import.meta.url).href
const metricsPath = process.env.SWM_SNAPSHOT_BENCH_METRICS
const port = Number(process.env.SWM_SNAPSHOT_BENCH_PORT || 3000)

if (!metricsPath) {
  throw new Error('SWM_SNAPSHOT_BENCH_METRICS is required')
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
const app = createApp()

await allocationSampler.start()

let eluStart = performance.eventLoopUtilization()
let memoryStart = process.memoryUsage()
let heapUsedPeakBytes = memoryStart.heapUsed
let listenSocket
let snapshotRequests = 0
let checksum = 0
let stopping = false

const heapSampler = setInterval(() => {
  heapUsedPeakBytes = Math.max(heapUsedPeakBytes, process.memoryUsage().heapUsed)
}, 50)

heapSampler.unref()

app.get('/snapshot', (res, req) => {
  const snapshot = req.snapshot()

  snapshotRequests++
  res.onAborted(() => {})
  setImmediate(() => {
    const headers = snapshot.headers
    const variant = headers['x-variant']
    const dynamic = headers[`x-dynamic-${variant}`]

    checksum ^= headers.host.length + headers['x-common-a'].length + headers['x-common-b'].length + dynamic.length
    res.end('ok')
  })
})

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
  global.gc?.()
  await allocationSampler.start()

  memoryStart = process.memoryUsage()
  heapUsedPeakBytes = memoryStart.heapUsed
  snapshotRequests = 0
  checksum = 0
  eluStart = performance.eventLoopUtilization()
}

async function stop() {
  if (stopping) {
    return
  }

  stopping = true
  clearInterval(heapSampler)

  const elu = performance.eventLoopUtilization(eluStart)
  const memory = process.memoryUsage()
  const allocationProfile = await allocationSampler.stop()

  fs.writeFileSync(
    metricsPath,
    `${JSON.stringify(
      {
        snapshotRequests,
        checksum,
        eluPct: elu.utilization * 100,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapUsedPeakBytes,
        heapUsedDeltaBytes: memory.heapUsed - memoryStart.heapUsed,
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
