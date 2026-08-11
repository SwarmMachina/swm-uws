import assert from 'node:assert/strict'

import { probeRssCalibration } from './resource/calibration.js'
import { probeHttpAllocation, probePublicCaps } from './resource/http.js'
import { probeWebSocketAllocation, probeWebSocketCancellation, probeWebSocketRetention } from './resource/websocket.js'

const scenario = process.argv[2]
const cases = {
  caps: probePublicCaps,
  http: probeHttpAllocation,
  'rss-calibration': probeRssCalibration,
  websocket: probeWebSocketAllocation,
  'websocket-cancel': probeWebSocketCancellation,
  'websocket-retention': probeWebSocketRetention
}

if (typeof global.gc !== 'function') {
  throw new Error('resource-bound probes require --expose-gc')
}

assert.equal(typeof cases[scenario], 'function', `unknown resource-bound scenario: ${scenario}`)
const result = await cases[scenario]()

process.stdout.write(`${JSON.stringify({ scenario, ...result })}\n`)
