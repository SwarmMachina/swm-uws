import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const modulePath = process.env.SWM_PROFILE_BINDING || new URL('../lib/index.js', import.meta.url).href
const metricsPath = process.env.SWM_PROFILE_METRICS
const port = Number(process.env.SWM_PROFILE_PORT || 3000)

if (!metricsPath) {
  throw new Error('SWM_PROFILE_METRICS is required')
}

const binding = await import(modulePath.startsWith('file:') ? modulePath : pathToFileURL(path.resolve(modulePath)).href)
const api = binding.default || binding
const createApp = api.App || api.createApp

if (typeof createApp !== 'function') {
  throw new TypeError(`${modulePath} does not export App or createApp`)
}

const app = createApp()
const eluStart = performance.eventLoopUtilization()
let listenSocket = null
let stopping = false

app.get('/base', (res) => {
  res.writeHeader('content-type', 'application/json').end('{"ok":true}')
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

function stop() {
  if (stopping) return
  stopping = true

  const memory = process.memoryUsage()
  const elu = performance.eventLoopUtilization(eluStart)
  fs.writeFileSync(
    metricsPath,
    `${JSON.stringify(
      {
        eluPct: elu.utilization * 100,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external
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
  if (!socket) throw new Error(`listen failed on 127.0.0.1:${port}`)
  listenSocket = socket
  process.stdout.write(`ready http://127.0.0.1:${port}/base\n`)
})
