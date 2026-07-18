import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import uWS, * as binding from '../lib/index.js'

const require = createRequire(import.meta.url)
const required = require('../lib/index.js')
const expectedKeys = [
  'App',
  'DISABLED',
  'LIBUS_LISTEN_EXCLUSIVE_PORT',
  'capabilities',
  'createApp',
  'us_listen_socket_close',
  'us_socket_local_port',
  'version'
]

test('default export mirrors the supported upstream-style binding surface', () => {
  assert.deepEqual(Object.keys(uWS).sort(), expectedKeys)
  assert.equal(binding.default, uWS)

  for (const key of expectedKeys) {
    assert.equal(uWS[key], binding[key])
  }
})

test('CommonJS consumers retain named access and receive the ESM default', () => {
  assert.equal(required.default, uWS)

  for (const key of expectedKeys) {
    assert.equal(required[key], binding[key])
  }
})
