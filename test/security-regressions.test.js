import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const fixture = fileURLToPath(new URL('./fixtures/security-regression-case.js', import.meta.url))

for (const scenario of [
  'response-cork',
  'framing-exception',
  'response-writable',
  'request-data',
  'collect-body',
  'response-aborted',
  'websocket-message',
  'websocket-close',
  'socket-cork',
  'upgrade',
  'listen',
  'ws-options',
  'socket-user-data',
  'socket-user-data-descriptor-error'
]) {
  test(`security regression: ${scenario}`, { timeout: 15_000 }, () => {
    const result = spawnSync(process.execPath, [fixture, scenario], {
      encoding: 'utf8',
      timeout: 12_000
    })

    assert.equal(
      result.signal,
      null,
      `${scenario} terminated by ${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    )
    assert.equal(
      result.status,
      0,
      `${scenario} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    )
    assert.match(result.stdout, new RegExp(`security case ok: ${scenario}`))
    assert.doesNotMatch(result.stderr, /FATAL ERROR|Check failed|Assertion failed|SIGABRT/)
  })
}
