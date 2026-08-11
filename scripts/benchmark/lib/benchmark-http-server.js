import { performance } from 'node:perf_hooks'

export function startBenchmarkHttpServer({ createApp, version, port, enableWebSocketEcho = false }) {
  const app = createApp()

  let startedElu
  let startedMemory

  app.get('/', (res) => {
    res.end('ok')
  })

  app.get('/metrics', (res) => {
    const memory = process.memoryUsage()
    const elu = performance.eventLoopUtilization(startedElu)

    res.writeHeader('content-type', 'application/json').end(
      JSON.stringify({
        version: version(),
        elu,
        memory,
        memoryDelta: Object.fromEntries(Object.entries(memory).map(([key, value]) => [key, value - startedMemory[key]]))
      })
    )
  })

  app.get('/reset', (res) => {
    startedElu = performance.eventLoopUtilization()
    startedMemory = process.memoryUsage()
    res.end('reset')
  })

  app.get('/shutdown', (res) => {
    res.end('bye')
    setImmediate(() => app.close())
  })

  if (enableWebSocketEcho) {
    app.ws('/ws', {
      message(ws, message, isBinary) {
        ws.send(message, isBinary)
      }
    })
  }

  app.listen('127.0.0.1', port, (ok) => {
    if (!ok) {
      throw new Error(`listen failed on 127.0.0.1:${port}`)
    }

    startedElu = performance.eventLoopUtilization()
    startedMemory = process.memoryUsage()
    console.log(JSON.stringify({ ready: true, port, version: version(), memory: startedMemory }))
  })
}
