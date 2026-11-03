import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { pinnedUpstreamCommit } from '../benchmark/lib/upstream-release.js'

const commit = '9ec36de7709996c58dce03d63796216c90a17136'
const row = `| uWebSockets.js release tag | https://github.com/uNetworking/uWebSockets.js | \`v20.71.0\` / \`${commit}\` |`

test('performance metadata reads the current vendored upstream release', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
  const versions = readFileSync(new URL('../vendor/VERSIONS.md', import.meta.url), 'utf8')

  assert.equal(pinnedUpstreamCommit(versions, packageJson.upstream.uWebSocketsJs), commit)
  assert.equal(pinnedUpstreamCommit(row.replaceAll('v20.71.0', 'v20.72.0'), 'v20.72.0'), commit)
})

test('performance metadata rejects stale, ambiguous, or malformed vendor revisions', () => {
  for (const versions of [row.replace('v20.71.0', 'v20.69.0'), `${row}\n${row}`, row.replace(commit, 'invalid'), '']) {
    assert.throws(() => pinnedUpstreamCommit(versions, 'v20.71.0'), /does not match/)
  }
})
