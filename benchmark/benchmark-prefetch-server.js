import { performance } from 'node:perf_hooks'

import { Metrics } from '@swarmmachina/benchkit/measurement'

import { RequestPrefetchPlan, createApp, us_listen_socket_close, us_socket_local_port } from '../lib/index.js'

const selectedCounts = [0, 1, 2, 4, 8]
const selectedNames = Array.from({ length: 8 }, (_, index) => `x-selected-${index}`)
const plans = new Map(
  selectedCounts.map((count) => [count, new RequestPrefetchPlan({ headers: selectedNames.slice(0, count) })])
)
const app = createApp({ http: { maxHeaderSize: 16 * 1024, maxHeaderCount: 100 } })
const metrics = new Metrics()

let listenSocket
let sink = 0

app.get('/baseline-sync', (res) => res.end('ok'))
app.get('/baseline-async', (res) => {
  res.onAborted(() => {})
  setImmediate(() => res.end('ok'))
})

for (const count of selectedCounts.filter(Boolean)) {
  app.get(`/get-${count}-sync`, (res, req) => {
    for (let index = 0; index < count; index++) {
      sink += req.getHeader(selectedNames[index]).length
    }

    res.end('ok')
  })
}

app.get('/foreach-filter-sync', (res, req) => {
  req.forEach((name, value) => {
    if (name.startsWith('x-selected-')) {
      sink += value.length
    }
  })
  res.end('ok')
})
app.get('/foreach-full-sync', (res, req) => {
  req.forEach((name, value) => {
    sink += name.length + value.length
  })
  res.end('ok')
})
app.get('/foreach-filter-async', (res, req) => {
  const selected = []

  req.forEach((name, value) => {
    if (name.startsWith('x-selected-')) {
      selected.push(name, value)
    }
  })
  res.onAborted(() => {})
  setImmediate(() => {
    sink += selected.length
    res.end('ok')
  })
})

for (const count of selectedCounts) {
  const plan = plans.get(count)

  app.get(`/prefetch-${count}-never-sync`, (res, req) => {
    req.prefetch(plan)
    res.end('ok')
  })
  app.get(`/prefetch-${count}-materialized-sync`, (res, req) => {
    sink += Object.keys(req.prefetch(plan).getHeaders()).length
    res.end('ok')
  })
  app.get(`/prefetch-${count}-never-async`, (res, req) => {
    const snapshot = req.prefetch(plan)

    res.onAborted(() => {})
    setImmediate(() => {
      sink += snapshot === null ? 1 : 0
      res.end('ok')
    })
  })
  app.get(`/prefetch-${count}-materialized-async`, (res, req) => {
    const snapshot = req.prefetch(plan)

    res.onAborted(() => {})
    setImmediate(() => {
      sink += Object.keys(snapshot.getHeaders()).length
      res.end('ok')
    })
  })
}

process.on('message', (message) => {
  if (message?.type === 'metrics:start') {
    metrics.start({ sampleMs: 100 })
    process.send?.({ type: 'metrics:started', id: message.id })
  } else if (message?.type === 'metrics:stop') {
    process.send?.({ type: 'metrics:result', id: message.id, metrics: metrics.stop(), sink })
  } else if (message?.type === 'shutdown') {
    shutdown()
  }
})

app.listen('127.0.0.1', 0, (socket) => {
  if (!socket) {
    throw new Error('benchmark target failed to listen')
  }

  listenSocket = socket
  process.send?.({
    type: 'ready',
    port: us_socket_local_port(socket),
    node: process.version,
    pid: process.pid,
    startedAt: performance.timeOrigin
  })
})

function shutdown() {
  if (listenSocket) {
    us_listen_socket_close(listenSocket)
    listenSocket = undefined
  }

  app.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
