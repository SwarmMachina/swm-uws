import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { SubprocessProbe } from './helpers/subprocess-probe.js'

const MAX_INBOUND_BYTES = 64 * 1024 * 1024
const MAX_ALLOWED_RSS_GROWTH = 32 * 1024 * 1024
const fixture = fileURLToPath(new URL('./fixtures/resource-bounds-case.js', import.meta.url))
const probe = new SubprocessProbe(fixture)

for (const scenario of ['http', 'websocket']) {
  test(`${scenario} declared inbound length does not eagerly allocate its 64 MiB cap`, () => {
    const metrics = runProbe(scenario)

    assert.ok(
      metrics.rssDeltaBytes < MAX_ALLOWED_RSS_GROWTH,
      `${scenario} RSS grew by ${formatMiB(metrics.rssDeltaBytes)} after only a length declaration`
    )
    assert.ok(
      metrics.peakRssDeltaBytes < MAX_ALLOWED_RSS_GROWTH,
      `${scenario} peak RSS grew by ${formatMiB(metrics.peakRssDeltaBytes)} after only a length declaration`
    )
  })
}

test('RSS probe detects a resident allocation near the 64 MiB cap', () => {
  const metrics = runProbe('rss-calibration')

  assert.ok(
    Math.max(metrics.rssDeltaBytes, metrics.peakRssDeltaBytes) > 48 * 1024 * 1024,
    `RSS probe observed only ${formatMiB(
      Math.max(metrics.rssDeltaBytes, metrics.peakRssDeltaBytes)
    )} for a touched 64 MiB allocation`
  )
})

test('large fragmented messages do not retain one RSS peak per live WebSocket', () => {
  const metrics = runProbe('websocket-retention')

  assert.equal(metrics.activeConnections, 4)
  assert.equal(metrics.messageBytes, 16 * 1024 * 1024)
  assert.ok(
    metrics.firstMessage.peakRssDeltaBytes > 12 * 1024 * 1024,
    `first fragmented message raised peak RSS by only ${formatMiB(metrics.firstMessage.peakRssDeltaBytes)}`
  )
  assert.ok(
    metrics.additionalRssBytes < 12 * 1024 * 1024,
    `three additional live WebSockets retained another ${formatMiB(metrics.additionalRssBytes)}`
  )
  assert.ok(
    metrics.additionalPeakRssBytes < 40 * 1024 * 1024,
    `subsequent fragmented messages raised peak RSS by another ${formatMiB(metrics.additionalPeakRssBytes)}`
  )
})

test('fragment buffer clear is deferred until an ending message callback releases its view', () => {
  const result = runProbe('websocket-cancel')

  assert.equal(result.callbackBytes, 16 * 1024 * 1024)
})

test('public HTTP and WebSocket inbound limits are capped at 64 MiB', () => {
  const result = runProbe('caps')

  assert.equal(result.maxInboundBytes, MAX_INBOUND_BYTES)
})

function runProbe(scenario) {
  const result = probe.run(scenario)

  assert.equal(
    result.signal,
    null,
    `${scenario} resource probe terminated by ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  )
  assert.equal(
    result.status,
    0,
    `${scenario} resource probe exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  )

  const lines = result.stdout.trim().split('\n')

  return JSON.parse(lines.at(-1))
}

function formatMiB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
