import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

import { createApp } from '../../../lib/index.js'
import { withTimeout } from '../../helpers/async.js'
import { NativeAppServer } from '../../helpers/native-app-server.js'
import { MAX_INBOUND_BYTES } from './constants.js'
import { connectedSocket, rssDelta, rssSnapshot } from './common.js'

export async function probeHttpAllocation() {
  const app = createApp()
  const requestArmed = Promise.withResolvers()

  app.post('/upload', (res) => {
    res.onAborted(() => {})
    res.collectBody(MAX_INBOUND_BYTES, () => {
      throw new Error('incomplete HTTP body unexpectedly completed')
    })
    requestArmed.resolve()
  })

  const server = await NativeAppServer.listen(app)
  const socket = await connectedSocket(server.port)

  try {
    const baseline = await rssSnapshot()

    socket.write(`POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${MAX_INBOUND_BYTES}\r\n\r\n`)
    await withTimeout(requestArmed.promise, 2_000, 'HTTP collector was not armed')

    const afterDeclaration = await rssSnapshot()

    return rssDelta(baseline, afterDeclaration)
  } finally {
    socket.destroy()
    await delay(10)
    server.close()
  }
}

export async function probePublicCaps() {
  const app = createApp()
  const bodyCapsChecked = Promise.withResolvers()

  assert.throws(
    () => app.ws('/too-large', { maxPayloadLength: MAX_INBOUND_BYTES + 1 }),
    /maxPayloadLength must be an integer between 1 and 67108864/
  )
  assert.doesNotThrow(() => app.ws('/at-limit', { maxPayloadLength: MAX_INBOUND_BYTES }))

  app.post('/body-cap', (res) => {
    res.onAborted(() => {})
    assert.throws(() => res.collectBody(MAX_INBOUND_BYTES + 1, () => {}), /integer between 0 and 64 MiB/)
    assert.throws(() => res.collectBodyWithLength(MAX_INBOUND_BYTES + 1, () => {}), /integer between 0 and 64 MiB/)
    assert.doesNotThrow(() => res.collectBody(MAX_INBOUND_BYTES, () => {}))
    bodyCapsChecked.resolve()
  })

  const server = await NativeAppServer.listen(app)
  const socket = await connectedSocket(server.port)

  try {
    socket.write(`POST /body-cap HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${MAX_INBOUND_BYTES}\r\n\r\n`)
    await withTimeout(bodyCapsChecked.promise, 2_000, 'HTTP body cap checks did not run')

    return { maxInboundBytes: MAX_INBOUND_BYTES }
  } finally {
    socket.destroy()
    await delay(10)
    server.close()
  }
}
