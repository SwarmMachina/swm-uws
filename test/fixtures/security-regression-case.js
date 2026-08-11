import assert from 'node:assert/strict'

import { securityCases } from './security/cases.js'
import { SecurityFixtureContext } from './security/context.js'

const scenario = process.argv[2]
const timeout = setTimeout(() => {
  throw new Error(`security case timed out: ${scenario}`)
}, 10_000)
const fixture = new SecurityFixtureContext()

try {
  assert.equal(typeof securityCases[scenario], 'function', `unknown security case: ${scenario}`)
  await securityCases[scenario](fixture)
  console.log(`security case ok: ${scenario}`)
} finally {
  clearTimeout(timeout)
  fixture.close()
}
