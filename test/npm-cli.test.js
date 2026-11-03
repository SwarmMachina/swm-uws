import assert from 'node:assert/strict'
import { win32 } from 'node:path'
import test from 'node:test'

import { getNpmInvocation, parseNpmPackOutput } from '../scripts/release/npm-cli.js'

test('npm invocation reuses the active npm CLI without a command shell', () => {
  assert.deepEqual(
    getNpmInvocation(['pack'], {
      environment: { npm_execpath: '/opt/npm/bin/npm-cli.js' },
      nodePath: '/opt/node/bin/node',
      platform: 'linux'
    }),
    {
      executable: '/opt/node/bin/node',
      args: ['/opt/npm/bin/npm-cli.js', 'pack']
    }
  )
})

test('npm invocation resolves the bundled Windows CLI without cmd.exe', () => {
  const nodePath = 'C:\\node\\node.exe'

  assert.deepEqual(
    getNpmInvocation(['--version'], {
      environment: {},
      nodePath,
      platform: 'win32'
    }),
    {
      executable: nodePath,
      args: [win32.join('C:\\node', 'node_modules/npm/bin/npm-cli.js'), '--version']
    }
  )
})

test('npm invocation preserves the executable PATH lookup on Unix', () => {
  assert.deepEqual(
    getNpmInvocation(['install'], {
      environment: {},
      nodePath: '/opt/node/bin/node',
      platform: 'darwin'
    }),
    {
      executable: 'npm',
      args: ['install']
    }
  )
})

test('npm pack metadata supports npm 11 arrays and npm 12 package maps', () => {
  const packed = { filename: 'package.tgz', files: [{ path: 'lib/index.js' }] }

  assert.deepEqual(parseNpmPackOutput(JSON.stringify([packed])), packed)
  assert.deepEqual(parseNpmPackOutput(JSON.stringify({ '@swarmmachina/swm-uws': packed })), packed)
})

test('npm pack metadata rejects ambiguous or malformed package results', () => {
  const packed = { filename: 'package.tgz', files: [] }

  for (const result of [[], {}, [packed, packed], { first: packed, second: packed }, { error: 'failure' }]) {
    assert.throws(() => parseNpmPackOutput(JSON.stringify(result)), /exactly one package/)
  }
})
