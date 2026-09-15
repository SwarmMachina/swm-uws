import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { FEATURE_PERFORMANCE_PATH_NAMES } from '../benchmark/lib/feature-performance-guard.js'
import { WS_PERFORMANCE_PARAMETERS } from '../benchmark/lib/ws-performance-evidence.js'
import { qualifyIndependentBuilds } from '../benchmark/pgo/qualify-independent-builds.js'

const CONSISTENT_FILES = [
  'source-files.sha256',
  'training-get.json',
  'training-post.json',
  'training-ws-closed.json',
  'training-ws-depth16.json'
]

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function passingWs(candidateSha256) {
  const runs = []

  for (const depth of [1, 16]) {
    for (let block = 1; block <= 6; block += 1) {
      for (const [position, role] of [
        [1, 'baseline'],
        [2, 'candidate'],
        [3, 'candidate'],
        [4, 'baseline']
      ]) {
        runs.push({
          depth,
          block,
          position,
          role,
          requestsPerSecond: 100_000,
          load: {
            errors: { total: 0 },
            latencyMs: { dropped: 0, outOfRange: 0, nonFinite: 0 },
            transport: { rateDropped: 0, backpressureEvents: 0 },
            loadGenerator: { parentEluPct: 10, maxWorkerEluPct: 80, saturated: false }
          }
        })
      }
    }
  }

  return {
    status: 'pass',
    node: 'v24.19.0',
    targetNode: { node: 'v24.19.0', abi: '137' },
    candidateSha256,
    parameters: WS_PERFORMANCE_PARAMETERS,
    guards: [1, 16].map((depth) => ({
      depth,
      status: 'pass',
      comparison: { medianPairedDeltaPct: -4 }
    })),
    runs
  }
}

async function writeManifest(directory) {
  const names = ['candidate.node', ...CONSISTENT_FILES]
  const lines = []

  for (const name of names) {
    lines.push(`${sha256(await readFile(join(directory, name)))}  ${name}`)
  }

  await writeFile(join(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`)
}

test('independent-build qualification records pass and cross-build inconsistency', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'swm-uws-pgo-qualification-'))
  const resultsDirectory = join(root, 'results')
  const evidenceDirectory = join(root, 'evidence')

  context.after(() => rm(root, { recursive: true, force: true }))

  for (let build = 1; build <= 2; build += 1) {
    const result = join(resultsDirectory, `build-${build}`)
    const evidence = join(evidenceDirectory, String(build), 'pgo-evidence')
    const candidate = `candidate-${build}`
    const candidateSha256 = sha256(candidate)

    await mkdir(result, { recursive: true })
    await mkdir(evidence, { recursive: true })
    await writeFile(join(result, 'command-exit-code'), '0\n')
    await writeFile(join(result, 'metadata.json'), JSON.stringify({ guard: { status: 'pass' } }))
    await writeFile(
      join(result, 'summary.json'),
      JSON.stringify({
        featurePaths: FEATURE_PERFORMANCE_PATH_NAMES.map((name) => ({ name, guard: { status: 'pass' } }))
      })
    )
    await writeFile(join(result, 'ws.json'), JSON.stringify(passingWs(candidateSha256)))
    await writeFile(join(evidence, 'candidate.node'), candidate)

    for (const name of CONSISTENT_FILES) {
      await writeFile(join(evidence, name), `${name}\n`)
    }

    await writeManifest(evidence)
  }

  const passing = await qualifyIndependentBuilds({ resultsDirectory, evidenceDirectory, nodeMajor: 24, abi: 137 })

  assert.equal(passing.status, 'pass')
  assert.equal(passing.builds.length, 2)
  assert.deepEqual(passing.consistencyFailures, [])

  const checker = fileURLToPath(new URL('../benchmark/pgo/qualify-independent-builds.js', import.meta.url))
  const output = join(root, 'qualification.json')
  const command = spawnSync(process.execPath, [checker, resultsDirectory, evidenceDirectory, '24', '137', output], {
    encoding: 'utf8'
  })

  assert.equal(command.status, 0, command.stderr)
  assert.equal(JSON.parse(await readFile(output, 'utf8')).status, 'pass')

  const changedEvidence = join(evidenceDirectory, '2', 'pgo-evidence')

  await writeFile(join(changedEvidence, 'training-get.json'), 'different\n')
  await writeManifest(changedEvidence)

  const failing = await qualifyIndependentBuilds({ resultsDirectory, evidenceDirectory, nodeMajor: 24, abi: 137 })

  assert.equal(failing.status, 'fail')
  assert.deepEqual(failing.consistencyFailures, ['training-get.json differs across builds'])
})
