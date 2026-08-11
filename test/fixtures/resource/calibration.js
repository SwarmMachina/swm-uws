import assert from 'node:assert/strict'

import { MAX_INBOUND_BYTES } from './constants.js'
import { rssDelta, rssSnapshot } from './common.js'

export async function probeRssCalibration() {
  const baseline = await rssSnapshot()
  const residentAllocation = Buffer.allocUnsafe(MAX_INBOUND_BYTES)

  // Touch every possible OS page so the calibration represents resident,
  // rather than merely reserved, virtual memory on every supported platform.
  for (let offset = 0; offset < residentAllocation.length; offset += 4 * 1024) {
    residentAllocation[offset] = offset & 0xff
  }

  residentAllocation[residentAllocation.length - 1] = 1

  const afterAllocation = await rssSnapshot()

  assert.equal(residentAllocation[residentAllocation.length - 1], 1)

  return rssDelta(baseline, afterAllocation)
}
