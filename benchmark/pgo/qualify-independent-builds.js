import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { FEATURE_PERFORMANCE_PATH_NAMES } from '../lib/feature-performance-guard.js'
import { wsPerformanceEvidenceFailures } from '../lib/ws-performance-evidence.js'

const BUILD_COUNT = 2
const CONSISTENT_EVIDENCE_FILES = [
  'source-files.sha256',
  'training-get.json',
  'training-post.json',
  'training-ws-closed.json',
  'training-ws-depth16.json'
]

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function evidenceFailures(directory) {
  const failures = []
  const manifest = await readFile(resolve(directory, 'SHA256SUMS'), 'utf8')

  for (const line of manifest.trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line)

    if (!match) {
      failures.push(`invalid SHA256SUMS line: ${line}`)
      continue
    }

    const path = resolve(directory, match[2])
    const pathRelativeToEvidence = relative(directory, path)

    if (
      isAbsolute(pathRelativeToEvidence) ||
      pathRelativeToEvidence === '..' ||
      pathRelativeToEvidence.startsWith(`..${sep}`)
    ) {
      failures.push(`SHA256SUMS path escapes evidence directory: ${match[2]}`)
      continue
    }

    if ((await sha256(path)) !== match[1]) {
      failures.push(`SHA-256 mismatch: ${match[2]}`)
    }
  }

  return failures
}

async function qualifyBuild({ build, resultsDirectory, evidenceDirectory, expectedNodeMajor, expectedAbi }) {
  const resultDirectory = resolve(resultsDirectory, `build-${build}`)
  const buildEvidenceDirectory = resolve(evidenceDirectory, String(build), 'pgo-evidence')
  const failures = []

  try {
    const commandExitCode = (await readFile(resolve(resultDirectory, 'command-exit-code'), 'utf8')).trim()

    if (commandExitCode !== '0') {
      failures.push(`benchmark command exited with ${commandExitCode}`)
    }

    const [metadata, summary, ws, candidateSha256] = await Promise.all([
      readJson(resolve(resultDirectory, 'metadata.json')),
      readJson(resolve(resultDirectory, 'summary.json')),
      readJson(resolve(resultDirectory, 'ws.json')),
      sha256(resolve(buildEvidenceDirectory, 'candidate.node'))
    ])

    failures.push(...(await evidenceFailures(buildEvidenceDirectory)))

    if (metadata.guard?.status !== 'pass') {
      failures.push('HTTP guard did not pass')
    }

    const featurePaths = Array.isArray(summary.featurePaths) ? summary.featurePaths : []
    const featureNames = featurePaths.map((path) => path.name).sort()
    const expectedFeatureNames = [...FEATURE_PERFORMANCE_PATH_NAMES].sort()

    if (JSON.stringify(featureNames) !== JSON.stringify(expectedFeatureNames)) {
      failures.push('feature path set is incomplete')
    }

    if (featurePaths.some((path) => path.guard?.status !== 'pass')) {
      failures.push('feature guard did not pass')
    }

    failures.push(...wsPerformanceEvidenceFailures(ws).map((failure) => `WS ${failure}`))

    if (ws.candidateSha256 !== candidateSha256) {
      failures.push('WS candidate identity does not match evidence')
    }

    if (ws.targetNode?.abi !== expectedAbi) {
      failures.push(`WS target ABI must equal ${expectedAbi}`)
    }

    if (typeof ws.targetNode?.node !== 'string' || !ws.targetNode.node.startsWith(`v${expectedNodeMajor}.`)) {
      failures.push(`WS target must be Node ${expectedNodeMajor}`)
    }

    return {
      build,
      candidateSha256,
      httpStatus: metadata.guard?.status || 'missing',
      featureStatuses: Object.fromEntries(featurePaths.map((path) => [path.name, path.guard?.status || 'missing'])),
      wsGuards: ws.guards?.map((guard) => ({
        depth: guard.depth,
        status: guard.status,
        medianPairedDeltaPct: guard.comparison?.medianPairedDeltaPct
      })),
      failures,
      status: failures.length ? 'fail' : 'pass'
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))

    return { build, failures, status: 'fail' }
  }
}

export async function qualifyIndependentBuilds({ resultsDirectory, evidenceDirectory, nodeMajor, abi }) {
  const builds = []

  for (let build = 1; build <= BUILD_COUNT; build += 1) {
    builds.push(
      await qualifyBuild({
        build,
        resultsDirectory,
        evidenceDirectory,
        expectedNodeMajor: String(nodeMajor),
        expectedAbi: String(abi)
      })
    )
  }

  const consistencyFailures = []

  for (const name of CONSISTENT_EVIDENCE_FILES) {
    try {
      const contents = await Promise.all(
        Array.from({ length: BUILD_COUNT }, (_, index) =>
          readFile(resolve(evidenceDirectory, String(index + 1), 'pgo-evidence', name), 'utf8')
        )
      )

      if (contents.some((content) => content !== contents[0])) {
        consistencyFailures.push(`${name} differs across builds`)
      }
    } catch (error) {
      consistencyFailures.push(
        `${name} could not be compared: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  return {
    schemaVersion: 1,
    nodeMajor: String(nodeMajor),
    abi: String(abi),
    expectedBuilds: BUILD_COUNT,
    builds,
    consistencyFailures,
    status: builds.every((build) => build.status === 'pass') && consistencyFailures.length === 0 ? 'pass' : 'fail'
  }
}

const mainPath = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href

if (mainPath === import.meta.url) {
  if (process.argv.length !== 7) {
    throw new Error(
      `usage: ${basename(fileURLToPath(import.meta.url))} <results-dir> <evidence-dir> <node-major> <abi> <output>`
    )
  }

  const [, , resultsDirectory, evidenceDirectory, nodeMajor, abi, output] = process.argv
  const qualification = await qualifyIndependentBuilds({ resultsDirectory, evidenceDirectory, nodeMajor, abi })

  await writeFile(resolve(output), `${JSON.stringify(qualification, null, 2)}\n`)
  console.log(`independent-build qualification: ${qualification.status}`)

  if (qualification.status !== 'pass') {
    process.exitCode = 1
  }
}
