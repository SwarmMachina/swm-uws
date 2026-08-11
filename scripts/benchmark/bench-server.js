import { createApp, version } from '../../lib/index.js'
import { startBenchmarkHttpServer } from './lib/benchmark-http-server.js'

const port = Number(process.env.PORT || 30123)

startBenchmarkHttpServer({
  createApp,
  enableWebSocketEcho: true,
  port,
  version
})
