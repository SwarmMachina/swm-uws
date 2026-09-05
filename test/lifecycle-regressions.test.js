import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { SubprocessProbe } from './helpers/subprocess-probe.js'

const fixture = fileURLToPath(new URL('./fixtures/lifecycle-regression-case.js', import.meta.url))
const probe = new SubprocessProbe(fixture, { timeoutMs: 30_000 })

for (const scenario of [
  'yield-sync',
  'yield-promoted',
  'upgrade-yield',
  'upgrade-on-data',
  'upgrade-on-data-v2',
  'upgrade-collect',
  'upgrade-collect-length',
  ...['on-data', 'on-data-v2', 'collect', 'collect-length'].flatMap((handler) =>
    ['fixed', 'chunked'].map((framing) => `upgrade-${handler}-${framing}`)
  ),
  'filter-closed-response',
  'early-response-timeout',
  'overflow-response-timeout',
  'handler-collection',
  'ws-handler-lifetime',
  'ws-handler-registration-failure',
  'collector-discard',
  'collector-overflow',
  'prefetch-accounting',
  'try-end-empty'
]) {
  test(`lifecycle regression: ${scenario}`, { timeout: 35_000 }, () => {
    const result = probe.run(scenario)

    assert.equal(result.signal, null, `${scenario}: ${result.signal}\n${result.stdout}\n${result.stderr}`)
    assert.equal(result.status, 0, `${scenario}: exit ${result.status}\n${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /lifecycle case ok/)
  })
}
