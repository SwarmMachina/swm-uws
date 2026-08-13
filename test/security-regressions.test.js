import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const fixture = fileURLToPath(new URL('./fixtures/security-regression-case.js', import.meta.url))

for (const scenario of [
  'response-cork',
  'response-cork-reentrant-app-close',
  'framing-exception',
  'response-writable',
  'response-writable-reentrant-app-close',
  'response-try-end-backpressure-lifecycle',
  'response-end-batch-reentrant-close',
  'response-end-batch-limit',
  'response-route-cleanup-reentrant-filter',
  'response-terminal-reentrant-filter',
  'response-data-reentrant-close',
  'response-data-reentrant-app-close',
  'response-data-terminal-close-connection',
  'response-collect-reentrant-close',
  'response-collect-reentrant-app-close',
  'response-detached-buffer',
  'request-data',
  'collect-body',
  'response-aborted',
  'request-after-response-end',
  'request-for-each-reentrant-app-close',
  'request-for-each-reentrant-response-close',
  'request-chunked-data-reentrant-app-close',
  'filter-reentrant-registration',
  'filter-nested-close-registration',
  'route-reentrant-registration',
  'array-prototype-output-boundaries',
  'app-closed-lifecycle',
  'websocket-open-route-registration',
  'websocket-get-topics-array-prototype',
  'websocket-callback-buffer-transfer-guard',
  'websocket-fragmented-payload-reentrant-close',
  'websocket-fragmented-payload-reentrant-app-close',
  'websocket-auto-pong-dropped-reentrant-app-close',
  'websocket-auto-pong-dropped-reentrant-end',
  'websocket-subscription-close-throw',
  'websocket-subscription-close-reentrancy',
  'websocket-end-subscription-lifecycle',
  'websocket-end-dropped-reentrant-app-close',
  'websocket-end-dropped-throw',
  'websocket-dropped-reentrant-close',
  'websocket-buffered-publish-dropped-reentrant-app-close',
  'websocket-open-close-then-throw',
  'websocket-message',
  'websocket-close',
  'socket-cork',
  'socket-cork-reentrant-app-close',
  'upgrade',
  'upgrade-async-context',
  'upgrade-reentrant-boundaries',
  'response-cork-upgrade-reentrant-app-close',
  'listen',
  'ws-options',
  'socket-user-data',
  'socket-user-data-descriptor-error',
  'socket-user-data-reentrant-close',
  'socket-user-data-prototype-has-reentrant-close',
  'receiver-guards',
  'external-token-guards'
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
