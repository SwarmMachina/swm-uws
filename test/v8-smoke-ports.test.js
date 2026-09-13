import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { SubprocessProbe } from './helpers/subprocess-probe.js'

const fixture = fileURLToPath(new URL('./fixtures/smoke-port-collision.js', import.meta.url))
const probe = new SubprocessProbe(fixture)

for (const scenario of ['v8-http-smoke', 'v8-ws-smoke']) {
  test(`${scenario} succeeds when its former PID-derived port is occupied`, () => {
    const result = probe.run(scenario)

    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  })
}
