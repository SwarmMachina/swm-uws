import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

import { ProcessMemorySampler } from '@swarmmachina/benchkit/measurement'

const modulePath = process.env.SWM_PROFILE_BINDING || new URL('../../lib/index.js', import.meta.url).href
const metricsPath = process.env.SWM_PROFILE_METRICS
const port = Number(process.env.SWM_PROFILE_PORT || 3000)

if (!metricsPath) {
  throw new Error('SWM_PROFILE_METRICS is required')
}

const binding = modulePath.endsWith('.node')
  ? createRequire(import.meta.url)(path.resolve(modulePath))
  : await import(modulePath.startsWith('file:') ? modulePath : pathToFileURL(path.resolve(modulePath)).href)
const api = binding.default || binding
const createApp = api.App || api.createApp

if (typeof createApp !== 'function') {
  throw new TypeError(`${modulePath} does not export App or createApp`)
}

const app = createApp()
const memorySampler = new ProcessMemorySampler()

let eluStart = performance.eventLoopUtilization()
let listenSocket = null
let stopping = false

memorySampler.start()

app.get('/base', (res) => {
  res.writeHeader('content-type', 'application/json').end('{"ok":true}')
})

app.get('/batch', (res) => {
  res.endBatch('200 OK', ['content-type', 'application/json'], '{"ok":true}')
})

app.get('/stream-begin', (res) => {
  res.cork(() => {
    res.writeStatus('200 OK')
    res.writeHeader('content-type', 'application/json')
    res.beginWrite()
  })
  res.end('{"ok":true}')
})

app.post('/post', (res) => {
  res.collectBody(1024 * 1024, (body) => {
    if (body === null) {
      res.writeStatus('413 Payload Too Large').end('too large')

      return
    }

    res.writeHeader('content-type', 'application/json').end('{"ok":true}')
  })
})

app.ws('/ws', {
  maxPayloadLength: 1024 * 1024,
  message(ws, message, isBinary) {
    ws.send(message, isBinary)
  }
})

app.get('/__swm_profile_reset', (res) => {
  memorySampler.stop()
  memorySampler.start()
  eluStart = performance.eventLoopUtilization()
  res.end('reset')
})

function stop() {
  if (stopping) {
    return
  }

  stopping = true

  const memory = memorySampler.stop()
  const elu = performance.eventLoopUtilization(eluStart)

  if (!memory) {
    throw new Error('process memory sampler was not running')
  }

  fs.writeFileSync(
    metricsPath,
    `${JSON.stringify(
      {
        eluPct: elu.utilization * 100,
        rssBytes: memory.rss.endBytes,
        rssPeakBytes: memory.rss.peakBytes,
        heapUsedBytes: memory.heapUsed.endBytes,
        heapUsedPeakBytes: memory.heapUsed.peakBytes,
        externalBytes: memory.external.endBytes,
        externalPeakBytes: memory.external.peakBytes,
        rssDeltaBytes: memory.rss.deltaBytes,
        heapUsedDeltaBytes: memory.heapUsed.deltaBytes,
        externalDeltaBytes: memory.external.deltaBytes
      },
      null,
      2
    )}\n`
  )

  if (listenSocket && api.us_listen_socket_close) {
    api.us_listen_socket_close(listenSocket)
    listenSocket = null
  }

  app.close?.()
  process.exit(0)
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)

app.listen('127.0.0.1', port, (socket) => {
  if (!socket) {
    throw new Error(`listen failed on 127.0.0.1:${port}`)
  }

  listenSocket = socket
  const listeningPort = api.us_socket_local_port?.(socket) || port

  process.send?.({ type: 'ready', port: listeningPort })
  process.stdout.write(`ready http://127.0.0.1:${listeningPort}/base\n`)
})
