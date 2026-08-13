import assert from 'node:assert/strict'
import { win32 } from 'node:path'
import test from 'node:test'

import { getNpmInvocation } from '../scripts/release/npm-cli.js'

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
