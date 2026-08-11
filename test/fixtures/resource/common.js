import { once } from 'node:events'
import { createConnection } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

import { withTimeout } from '../../helpers/async.js'

export async function connectedSocket(port) {
  const socket = createConnection({ host: '127.0.0.1', port })

  socket.on('error', () => {})
  await withTimeout(once(socket, 'connect'), 2_000, 'probe socket did not connect')

  return socket
}

export function maskedFrameHeader(payloadLength) {
  const header = Buffer.alloc(14)

  header[0] = 0x82
  header[1] = 0xff
  header.writeBigUInt64BE(BigInt(payloadLength), 2)
  header.set([0x12, 0x34, 0x56, 0x78], 10)

  return header
}

export function write(socket, bytes) {
  return withTimeout(
    new Promise((resolve, reject) => {
      socket.write(bytes, (error) => {
        if (error) {
          reject(error)

          return
        }

        resolve()
      })
    }),
    2_000,
    'probe socket write timed out'
  )
}

export async function rssSnapshot() {
  global.gc()
  await delay(50)
  global.gc()

  const samples = []

  for (let sample = 0; sample < 5; sample++) {
    samples.push(process.memoryUsage().rss)
    await delay(20)
  }

  samples.sort((left, right) => left - right)

  return {
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
    rssBytes: samples[Math.floor(samples.length / 2)]
  }
}

export function rssDelta(baseline, afterDeclaration) {
  return {
    afterDeclaration,
    baseline,
    peakRssDeltaBytes: Math.max(0, afterDeclaration.peakRssBytes - baseline.peakRssBytes),
    rssDeltaBytes: Math.max(0, afterDeclaration.rssBytes - baseline.rssBytes)
  }
}
