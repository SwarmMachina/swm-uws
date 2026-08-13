import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = '@swarmmachina/swm-uws'
const MANIFEST_VERSION = 1
const root = fileURLToPath(new URL('../..', import.meta.url))

export const expectedPrebuilds = Object.freeze([
  artifact('prebuilds/linux-x64-glibc/node-v127.node', 'ELF', 'linux', 'x64', '22', '127', [0x7f, 0x45, 0x4c, 0x46]),
  artifact('prebuilds/linux-x64-glibc/node-v137.node', 'ELF', 'linux', 'x64', '24', '137', [0x7f, 0x45, 0x4c, 0x46]),
  artifact('prebuilds/win32-x64/node-v127.node', 'PE', 'win32', 'x64', '22', '127', [0x4d, 0x5a]),
  artifact('prebuilds/win32-x64/node-v137.node', 'PE', 'win32', 'x64', '24', '137', [0x4d, 0x5a]),
  artifact('prebuilds/darwin-arm64/node-v127.node', 'Mach-O', 'darwin', 'arm64', '22', '127', [0xcf, 0xfa, 0xed, 0xfe]),
  artifact('prebuilds/darwin-arm64/node-v137.node', 'Mach-O', 'darwin', 'arm64', '24', '137', [0xcf, 0xfa, 0xed, 0xfe]),
  artifact('prebuilds/darwin-x64/node-v127.node', 'Mach-O', 'darwin', 'x64', '22', '127', [0xcf, 0xfa, 0xed, 0xfe]),
  artifact('prebuilds/darwin-x64/node-v137.node', 'Mach-O', 'darwin', 'x64', '24', '137', [0xcf, 0xfa, 0xed, 0xfe])
])

export function verifyReleasePrebuilds(releaseRoot, { requireManifest = true } = {}) {
  const errors = []
  const artifacts = []
  const packageJson = readPackageJson(releaseRoot)

  for (const expected of expectedPrebuilds) {
    let bytes

    try {
      bytes = readFileSync(join(releaseRoot, expected.path))
    } catch {
      errors.push(`Missing release prebuild: ${expected.path}`)
      continue
    }

    if (!hasMagic(bytes, expected.magic)) {
      errors.push(`Invalid ${expected.format} prebuild: ${expected.path}`)
      continue
    }

    artifacts.push({
      path: expected.path,
      bytes: bytes.length,
      sha256: digest(bytes),
      format: expected.format
    })
  }

  const manifestPath = join(releaseRoot, 'prebuilds/manifest.json')

  let manifest

  try {
    manifest = parseJson(readFileSync(manifestPath, 'utf8'), 'prebuilds/manifest.json')
  } catch (error) {
    if (requireManifest) {
      errors.push(
        error.message.startsWith('Invalid JSON') ? error.message : 'Missing release manifest: prebuilds/manifest.json'
      )
    }
  }

  if (manifest) {
    errors.push(...validateReleaseManifest(manifest, artifacts, packageJson))
  }

  try {
    const checksums = readFileSync(join(releaseRoot, 'prebuilds/SHA256SUMS'), 'utf8')

    if (checksums !== renderChecksums(artifacts)) {
      errors.push('Invalid prebuilds/SHA256SUMS')
    }
  } catch {
    errors.push('Missing release checksums: prebuilds/SHA256SUMS')
  }

  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }

  return { artifacts, manifest }
}

export function createBuildManifest({ releaseRoot, environment }) {
  const relativePath = requireValue(environment.SWM_RELEASE_ARTIFACT, 'SWM_RELEASE_ARTIFACT')
  const expected = expectedPrebuilds.find((candidate) => candidate.path === relativePath)

  if (!expected) {
    throw new Error(`Unexpected release artifact path: ${relativePath}`)
  }

  const bytes = readFileSync(join(releaseRoot, expected.path))

  if (!hasMagic(bytes, expected.magic)) {
    throw new Error(`Invalid ${expected.format} prebuild: ${expected.path}`)
  }

  const packageJson = readPackageJson(releaseRoot)
  const source = sourceIdentity(environment)
  const workflow = workflowIdentity(environment)
  const manifest = {
    schemaVersion: MANIFEST_VERSION,
    kind: 'swm-uws-prebuild',
    package: {
      name: packageJson.name,
      version: packageJson.version
    },
    source,
    workflow,
    artifact: {
      path: expected.path,
      bytes: bytes.length,
      sha256: digest(bytes),
      format: expected.format
    },
    toolchain: {
      platform: expected.platform,
      arch: expected.arch,
      nodeMajor: expected.nodeMajor,
      nodeAbi: expected.nodeAbi,
      nodeVersion: environment.SWM_RELEASE_NODE_VERSION || process.version,
      npmVersion: environment.SWM_RELEASE_NPM_VERSION || npmVersion(),
      builder: requireValue(environment.SWM_RELEASE_BUILDER, 'SWM_RELEASE_BUILDER'),
      compiler: requireValue(environment.SWM_RELEASE_COMPILER, 'SWM_RELEASE_COMPILER'),
      profile: requireValue(environment.SWM_RELEASE_PROFILE, 'SWM_RELEASE_PROFILE')
    }
  }

  validateBuildManifest(manifest, expected, { source, workflow, packageJson })
  writeJson(join(releaseRoot, buildManifestPath(expected.path)), manifest)

  return manifest
}

export function assembleReleaseManifest({ releaseRoot, environment }) {
  const packageJson = readPackageJson(releaseRoot)
  const source = sourceIdentity(environment)
  const workflow = workflowIdentity(environment)
  const buildManifests = []

  for (const expected of expectedPrebuilds) {
    const manifest = readJson(join(releaseRoot, buildManifestPath(expected.path)), buildManifestPath(expected.path))

    validateBuildManifest(manifest, expected, { source, workflow, packageJson })

    const bytes = readFileSync(join(releaseRoot, expected.path))

    if (!hasMagic(bytes, expected.magic)) {
      throw new Error(`Invalid ${expected.format} prebuild: ${expected.path}`)
    }

    if (manifest.artifact.sha256 !== digest(bytes) || manifest.artifact.bytes !== bytes.length) {
      throw new Error(`Prebuild digest mismatch: ${expected.path}`)
    }

    buildManifests.push(manifest)
  }

  const manifest = {
    schemaVersion: MANIFEST_VERSION,
    kind: 'swm-uws-release-prebuilds',
    package: {
      name: packageJson.name,
      version: packageJson.version
    },
    source,
    workflow,
    artifacts: buildManifests.map(({ artifact: builtArtifact, toolchain }) => ({
      ...builtArtifact,
      toolchain
    }))
  }

  writeJson(join(releaseRoot, 'prebuilds/manifest.json'), manifest)
  writeFileSync(join(releaseRoot, 'prebuilds/SHA256SUMS'), renderChecksums(manifest.artifacts))
  verifyReleasePrebuilds(releaseRoot)

  return manifest
}

export function createCandidateManifest({ releaseRoot, environment }) {
  const source = sourceIdentity(environment)
  const workflow = workflowIdentity(environment)
  const tarballPath = findTarball(releaseRoot)
  const tarball = readFileSync(tarballPath)
  const packedPackage = readPackedJson(tarballPath, 'package/package.json')
  const prebuildManifest = readPackedJson(tarballPath, 'package/prebuilds/manifest.json')
  const packageJson = readPackageJson(releaseRoot)

  assertPackageIdentity(packedPackage, packageJson)
  assertReleasePackageIdentity(prebuildManifest.package, packageJson)
  assertSourceIdentity(prebuildManifest.source, source)
  assertWorkflowIdentity(prebuildManifest.workflow, workflow)
  verifyPackedArtifacts(tarballPath, prebuildManifest)

  const manifest = {
    schemaVersion: MANIFEST_VERSION,
    kind: 'swm-uws-release-candidate',
    package: {
      name: packageJson.name,
      version: packageJson.version
    },
    source,
    workflow,
    tarball: {
      file: basename(tarballPath),
      bytes: tarball.length,
      sha256: digest(tarball)
    },
    prebuildManifest: {
      path: 'package/prebuilds/manifest.json',
      sha256: digest(Buffer.from(`${JSON.stringify(prebuildManifest, null, 2)}\n`))
    }
  }
  const dist = join(releaseRoot, 'dist')

  writeJson(join(dist, 'release-manifest.json'), manifest)
  writeFileSync(join(dist, 'SHA256SUMS'), `${manifest.tarball.sha256}  ${manifest.tarball.file}\n`)

  return manifest
}

export function verifyCandidateManifest({ releaseRoot, environment }) {
  const source = sourceIdentity(environment)
  const workflow = workflowIdentity(environment)
  const rootPackageJson = readPackageJson(releaseRoot)
  const manifest = readJson(join(releaseRoot, 'dist/release-manifest.json'), 'dist/release-manifest.json')

  if (
    manifest.schemaVersion !== MANIFEST_VERSION ||
    manifest.kind !== 'swm-uws-release-candidate' ||
    manifest.prebuildManifest?.path !== 'package/prebuilds/manifest.json'
  ) {
    throw new Error('Invalid release candidate manifest schema')
  }

  assertReleasePackageIdentity(manifest.package, rootPackageJson)
  assertSourceIdentity(manifest.source, source)
  assertWorkflowIdentity(manifest.workflow, workflow)
  assertCandidateTarball(manifest, releaseRoot)

  const tarballPath = join(releaseRoot, 'dist', manifest.tarball.file)
  const tarball = readFileSync(tarballPath)

  if (manifest.tarball.sha256 !== digest(tarball) || manifest.tarball.bytes !== tarball.length) {
    throw new Error(`Release candidate digest mismatch: ${manifest.tarball.file}`)
  }

  const checksums = readFileSync(join(releaseRoot, 'dist/SHA256SUMS'), 'utf8')
  const expectedChecksums = `${manifest.tarball.sha256}  ${manifest.tarball.file}\n`

  if (checksums !== expectedChecksums) {
    throw new Error('Invalid dist/SHA256SUMS')
  }

  const packedPackageJson = readPackedJson(tarballPath, 'package/package.json')
  const prebuildManifestText = readPackedText(tarballPath, 'package/prebuilds/manifest.json')
  const prebuildManifest = parseJson(prebuildManifestText, 'package/prebuilds/manifest.json')

  assertPackageIdentity(packedPackageJson, rootPackageJson)
  assertReleasePackageIdentity(prebuildManifest.package, rootPackageJson)
  assertSourceIdentity(prebuildManifest.source, source)
  assertWorkflowIdentity(prebuildManifest.workflow, workflow)
  verifyPackedArtifacts(tarballPath, prebuildManifest)

  if (manifest.prebuildManifest.sha256 !== digest(Buffer.from(prebuildManifestText))) {
    throw new Error('Packed prebuild manifest digest mismatch')
  }

  return manifest
}

function artifact(path, format, platform, arch, nodeMajor, nodeAbi, magic) {
  return Object.freeze({ path, format, platform, arch, nodeMajor, nodeAbi, magic: Buffer.from(magic) })
}

function sourceIdentity(environment) {
  const repository = requireValue(environment.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY')
  const commit = requireValue(environment.GITHUB_SHA, 'GITHUB_SHA')
  const ref = requireValue(environment.GITHUB_REF, 'GITHUB_REF')

  if (repository !== 'SwarmMachina/swm-uws') {
    throw new Error(`Unexpected source repository: ${repository}`)
  }

  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('GITHUB_SHA must be a full lowercase commit SHA')
  }

  return { repository, commit, ref }
}

function workflowIdentity(environment) {
  return {
    runId: requireValue(environment.GITHUB_RUN_ID, 'GITHUB_RUN_ID'),
    runAttempt: requireValue(environment.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT'),
    workflow: requireValue(environment.GITHUB_WORKFLOW_REF, 'GITHUB_WORKFLOW_REF')
  }
}

function validateBuildManifest(manifest, expected, identity) {
  if (manifest.schemaVersion !== MANIFEST_VERSION || manifest.kind !== 'swm-uws-prebuild') {
    throw new Error(`Invalid build manifest schema: ${expected.path}`)
  }

  assertSourceIdentity(manifest.source, identity.source)
  assertWorkflowIdentity(manifest.workflow, identity.workflow)
  assertReleasePackageIdentity(manifest.package, identity.packageJson)

  for (const [key, value] of Object.entries({
    path: expected.path,
    format: expected.format
  })) {
    if (manifest.artifact?.[key] !== value) {
      throw new Error(`Invalid ${key} in build manifest: ${expected.path}`)
    }
  }

  for (const [key, value] of Object.entries({
    platform: expected.platform,
    arch: expected.arch,
    nodeMajor: expected.nodeMajor,
    nodeAbi: expected.nodeAbi
  })) {
    if (manifest.toolchain?.[key] !== value) {
      throw new Error(`Invalid toolchain ${key} in build manifest: ${expected.path}`)
    }
  }

  for (const key of ['nodeVersion', 'npmVersion', 'builder', 'compiler', 'profile']) {
    requireValue(manifest.toolchain?.[key], `toolchain.${key}`)
  }
}

function validateReleaseManifest(manifest, actualArtifacts, packageJson) {
  const errors = []

  if (manifest.schemaVersion !== MANIFEST_VERSION || manifest.kind !== 'swm-uws-release-prebuilds') {
    return ['Invalid release manifest schema: prebuilds/manifest.json']
  }

  if (
    manifest.package?.name !== PACKAGE_NAME ||
    manifest.package?.name !== packageJson.name ||
    manifest.package?.version !== packageJson.version
  ) {
    errors.push('Invalid package identity in prebuilds/manifest.json')
  }

  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== expectedPrebuilds.length) {
    errors.push(`Expected ${expectedPrebuilds.length} artifacts in prebuilds/manifest.json`)

    return errors
  }

  for (const expected of expectedPrebuilds) {
    const declaredEntries = manifest.artifacts.filter((candidate) => candidate.path === expected.path)
    const declared = declaredEntries[0]
    const actual = actualArtifacts.find((candidate) => candidate.path === expected.path)

    if (declaredEntries.length !== 1 || !actual) {
      errors.push(`Missing manifest entry: ${expected.path}`)
      continue
    }

    if (declared.sha256 !== actual.sha256 || declared.bytes !== actual.bytes || declared.format !== expected.format) {
      errors.push(`Manifest digest or format mismatch: ${expected.path}`)
    }

    for (const [key, value] of Object.entries({
      platform: expected.platform,
      arch: expected.arch,
      nodeMajor: expected.nodeMajor,
      nodeAbi: expected.nodeAbi
    })) {
      if (declared.toolchain?.[key] !== value) {
        errors.push(`Invalid manifest toolchain ${key}: ${expected.path}`)
      }
    }

    for (const key of ['nodeVersion', 'npmVersion', 'builder', 'compiler', 'profile']) {
      if (typeof declared.toolchain?.[key] !== 'string' || declared.toolchain[key].trim() === '') {
        errors.push(`Missing manifest toolchain ${key}: ${expected.path}`)
      }
    }
  }

  return errors
}

function verifyPackedArtifacts(tarballPath, manifest) {
  if (manifest.schemaVersion !== MANIFEST_VERSION || manifest.kind !== 'swm-uws-release-prebuilds') {
    throw new Error('Invalid packed prebuild manifest schema')
  }

  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== expectedPrebuilds.length) {
    throw new Error('Packed prebuild manifest has an invalid artifact count')
  }

  for (const expected of expectedPrebuilds) {
    const declaredEntries = manifest.artifacts.filter((candidate) => candidate.path === expected.path)
    const declared = declaredEntries[0]

    if (declaredEntries.length !== 1) {
      throw new Error(`Packed prebuild manifest is missing ${expected.path}`)
    }

    const bytes = readPackedEntry(tarballPath, `package/${expected.path}`)

    if (!hasMagic(bytes, expected.magic)) {
      throw new Error(`Invalid packed ${expected.format} prebuild: ${expected.path}`)
    }

    if (declared.sha256 !== digest(bytes) || declared.bytes !== bytes.length) {
      throw new Error(`Packed prebuild digest mismatch: ${expected.path}`)
    }

    for (const [key, value] of Object.entries({
      platform: expected.platform,
      arch: expected.arch,
      nodeMajor: expected.nodeMajor,
      nodeAbi: expected.nodeAbi
    })) {
      if (declared.toolchain?.[key] !== value) {
        throw new Error(`Invalid packed prebuild toolchain ${key}: ${expected.path}`)
      }
    }

    for (const key of ['nodeVersion', 'npmVersion', 'builder', 'compiler', 'profile']) {
      requireValue(declared.toolchain?.[key], `packed prebuild toolchain ${key}: ${expected.path}`)
    }
  }

  const checksums = readPackedText(tarballPath, 'package/prebuilds/SHA256SUMS')

  if (checksums !== renderChecksums(manifest.artifacts)) {
    throw new Error('Invalid packed prebuilds/SHA256SUMS')
  }
}

function assertSourceIdentity(actual, expected) {
  for (const key of ['repository', 'commit', 'ref']) {
    if (actual?.[key] !== expected[key]) {
      throw new Error(`Release source ${key} mismatch`)
    }
  }
}

function assertWorkflowIdentity(actual, expected) {
  // A rerun of failed jobs reuses artifacts from successful jobs in an earlier
  // attempt of the same workflow run. Bind artifacts to the immutable run id
  // and workflow identity while retaining runAttempt as audit evidence.
  for (const key of ['runId', 'workflow']) {
    if (actual?.[key] !== expected[key]) {
      throw new Error(`Release workflow ${key} mismatch`)
    }
  }
}

function assertPackageIdentity(actual, expected) {
  if (actual.name !== PACKAGE_NAME || actual.name !== expected.name || actual.version !== expected.version) {
    throw new Error('Packed package identity does not match package.json')
  }

  if (actual.repository?.url !== 'git+https://github.com/SwarmMachina/swm-uws.git') {
    throw new Error('Packed package repository metadata is missing or invalid')
  }

  if (
    actual.publishConfig?.access !== 'public' ||
    actual.publishConfig?.registry !== 'https://registry.npmjs.org/' ||
    actual.publishConfig?.provenance !== true
  ) {
    throw new Error('Packed package publishConfig is missing or invalid')
  }
}

function assertReleasePackageIdentity(actual, expected) {
  if (actual?.name !== PACKAGE_NAME || actual.name !== expected.name || actual.version !== expected.version) {
    throw new Error('Release prebuild package identity does not match package.json')
  }
}

function findTarball(releaseRoot) {
  const dist = join(releaseRoot, 'dist')
  const tarballs = readdirSync(dist).filter((entry) => entry.endsWith('.tgz'))

  if (tarballs.length !== 1) {
    throw new Error(`Expected exactly one release tarball in dist, found ${tarballs.length}`)
  }

  return join(dist, tarballs[0])
}

function assertCandidateTarball(manifest, releaseRoot) {
  const file = manifest.tarball?.file

  if (typeof file !== 'string' || basename(file) !== file || !file.endsWith('.tgz')) {
    throw new Error('Invalid release candidate tarball path')
  }

  const tarballs = readdirSync(join(releaseRoot, 'dist')).filter((entry) => entry.endsWith('.tgz'))

  if (tarballs.length !== 1 || tarballs[0] !== file) {
    throw new Error('Release candidate manifest does not identify the only tarball in dist')
  }
}

function readPackedJson(tarballPath, entry) {
  return parseJson(readPackedText(tarballPath, entry), entry)
}

function readPackedText(tarballPath, entry) {
  return readPackedEntry(tarballPath, entry).toString('utf8')
}

function readPackedEntry(tarballPath, entry) {
  try {
    return execFileSync('tar', ['-xOf', tarballPath, entry], {
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024
    })
  } catch {
    throw new Error(`Missing or unreadable packed entry: ${entry}`)
  }
}

function readPackageJson(releaseRoot) {
  const packageJson = readJson(join(releaseRoot, 'package.json'), 'package.json')

  if (packageJson.name !== PACKAGE_NAME) {
    throw new Error(`Unexpected package name: ${packageJson.name}`)
  }

  return packageJson
}

function readJson(path, label) {
  return parseJson(readFileSync(path, 'utf8'), label)
}

function parseJson(value, label) {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`Invalid JSON: ${label}`)
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function renderChecksums(artifacts) {
  return artifacts.map(({ sha256, path }) => `${sha256}  ${path}`).join('\n') + '\n'
}

function buildManifestPath(artifactPath) {
  return `${artifactPath}.build.json`
}

function hasMagic(bytes, magic) {
  return bytes.length > magic.length && bytes.subarray(0, magic.length).equals(magic)
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function npmVersion() {
  return execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim()
}

function requireValue(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`)
  }

  return value
}

function runCli(command) {
  if (command === 'create-prebuild') {
    const manifest = createBuildManifest({ releaseRoot: root, environment: process.env })

    console.log(`Recorded ${manifest.artifact.path}: ${manifest.artifact.sha256}`)

    return
  }

  if (command === 'assemble') {
    const manifest = assembleReleaseManifest({ releaseRoot: root, environment: process.env })

    console.log(`Assembled ${manifest.artifacts.length} verified prebuilds for ${manifest.source.commit}`)

    return
  }

  if (command === 'create-candidate') {
    const manifest = createCandidateManifest({ releaseRoot: root, environment: process.env })

    console.log(`Recorded ${manifest.tarball.file}: ${manifest.tarball.sha256}`)

    return
  }

  if (command === 'verify-candidate') {
    const manifest = verifyCandidateManifest({ releaseRoot: root, environment: process.env })

    console.log(`Verified ${manifest.tarball.file}: ${manifest.tarball.sha256}`)

    return
  }

  throw new Error(
    'Usage: node scripts/release/release-artifacts.js <create-prebuild|assemble|create-candidate|verify-candidate>'
  )
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv[2])
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
