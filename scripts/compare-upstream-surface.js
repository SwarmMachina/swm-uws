import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { bindingSurfaceDelta } from '../test/helpers/capture-binding-surface.js'
import { allowedSurfaceDelta, upstreamSurface } from '../test/upstream-surface-contract.js'

function captureSurface(bindingName) {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./capture-binding-surface.js', import.meta.url))],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, SWM_UWS_CAPTURE_BINDING: bindingName }
    }
  )

  if (result.status !== 0) {
    throw new Error(`Failed to capture ${bindingName} surface\n${result.stdout}${result.stderr}`)
  }

  const line = result.stdout.split(/\r?\n/).find((value) => value.startsWith('SWM_UWS_SURFACE:'))

  if (!line) {
    throw new Error(`Surface output marker missing for ${bindingName}`)
  }

  return JSON.parse(line.slice('SWM_UWS_SURFACE:'.length))
}

const referenceName = process.env.SWM_UWS_REFERENCE || 'uwebsockets.js'
const referenceSurface = captureSurface(referenceName)

assert.deepEqual(
  referenceSurface,
  upstreamSurface,
  'Installed uwebsockets.js surface does not match the pinned v20.69.0 contract'
)

const localSurface = captureSurface(fileURLToPath(new URL('../lib/index.js', import.meta.url)))

assert.deepEqual(
  bindingSurfaceDelta(referenceSurface, localSurface),
  allowedSurfaceDelta,
  'Local binding surface differs from the explicit compatibility allowlist'
)

console.log(`upstream surface comparison ok: ${referenceName}`)
