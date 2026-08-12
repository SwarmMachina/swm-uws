import { createRequire } from 'node:module'

import { startBenchmarkHttpServer } from './lib/benchmark-http-server.js'

const require = createRequire(import.meta.url)
const native = require('../build/Release/swm_uws.node')
const port = Number(process.env.PORT || 30124)

startBenchmarkHttpServer({
  createApp: native.createApp,
  port,
  version: native.version
})
