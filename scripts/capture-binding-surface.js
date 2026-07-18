import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

import { captureBindingSurface } from '../test/helpers/capture-binding-surface.js'

function bindingSpecifier(value) {
  if (isAbsolute(value) || value.startsWith('.')) {
    return pathToFileURL(value).href
  }
  return value
}

const bindingName = process.env.SWM_UWS_CAPTURE_BINDING
if (!bindingName) throw new Error('SWM_UWS_CAPTURE_BINDING is required')

const binding = await import(bindingSpecifier(bindingName))
const surface = await captureBindingSurface(binding)
console.log(`SWM_UWS_SURFACE:${JSON.stringify(surface)}`)
