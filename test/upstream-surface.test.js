import assert from 'node:assert/strict'
import test from 'node:test'

import * as localBinding from '../lib/index.js'
import { bindingSurfaceDelta, captureBindingSurface } from './helpers/capture-binding-surface.js'
import { allowedSurfaceDelta, upstreamSurface } from './upstream-surface-contract.js'

test('non-TLS runtime surface matches pinned upstream except explicit exclusions', async () => {
  const localSurface = await captureBindingSurface(localBinding)

  assert.deepEqual(bindingSurfaceDelta(upstreamSurface, localSurface), allowedSurfaceDelta)
})
