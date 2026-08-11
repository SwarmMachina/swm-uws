import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  assembleReleaseManifest,
  createBuildManifest,
  createCandidateManifest,
  expectedPrebuilds,
  verifyCandidateManifest,
  verifyReleasePrebuilds
} from '../scripts/release-artifacts.js'

const environment = {
  GITHUB_REPOSITORY: 'SwarmMachina/swm-uws',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_REF: 'refs/tags/v0.6.3',
  GITHUB_RUN_ID: '123456',
  GITHUB_RUN_ATTEMPT: '1',
  GITHUB_WORKFLOW_REF: 'SwarmMachina/swm-uws/.github/workflows/windows-prebuilds.yml@refs/tags/v0.6.3',
  SWM_RELEASE_BUILDER: 'test-builder@sha256:fixture',
  SWM_RELEASE_COMPILER: 'test-compiler 1.0',
  SWM_RELEASE_PROFILE: 'release',
  SWM_RELEASE_NODE_VERSION: 'v24.0.0',
  SWM_RELEASE_NPM_VERSION: '11.0.0'
}

test('release manifest binds every prebuild to its digest, source, run, and toolchain', () => {
  withReleaseFixture((releaseRoot) => {
    const manifest = assembleReleaseManifest({ releaseRoot, environment })
    const verified = verifyReleasePrebuilds(releaseRoot)

    assert.equal(manifest.artifacts.length, expectedPrebuilds.length)
    assert.equal(verified.manifest.source.commit, environment.GITHUB_SHA)
    assert.ok(manifest.artifacts.every((artifact) => artifact.toolchain.builder === environment.SWM_RELEASE_BUILDER))

    const checksums = readFileSync(join(releaseRoot, 'prebuilds/SHA256SUMS'), 'utf8')

    assert.equal(checksums.trim().split('\n').length, expectedPrebuilds.length)

    const tampered = expectedPrebuilds[0]
    const path = join(releaseRoot, tampered.path)

    writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('tampered')]))
    assert.throws(() => verifyReleasePrebuilds(releaseRoot), /Manifest digest or format mismatch/)
  })
})

test('assembly rejects a prebuild manifest from another workflow run', () => {
  withReleaseFixture((releaseRoot) => {
    const path = join(releaseRoot, `${expectedPrebuilds[0].path}.build.json`)
    const manifest = JSON.parse(readFileSync(path, 'utf8'))

    manifest.workflow.runId = 'different-run'
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)

    assert.throws(() => assembleReleaseManifest({ releaseRoot, environment }), /Release workflow runId mismatch/)
  })
})

test('candidate verification rejects a tarball changed after package assembly', () => {
  withReleaseFixture((releaseRoot) => {
    assembleReleaseManifest({ releaseRoot, environment })
    mkdirSync(join(releaseRoot, 'dist'))
    execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', 'dist'], {
      cwd: releaseRoot,
      env: {
        ...process.env,
        npm_config_cache: join(releaseRoot, '.npm-cache')
      },
      stdio: 'pipe'
    })

    const manifest = createCandidateManifest({ releaseRoot, environment })

    assert.equal(verifyCandidateManifest({ releaseRoot, environment }).tarball.sha256, manifest.tarball.sha256)

    const tarball = join(releaseRoot, 'dist', manifest.tarball.file)

    writeFileSync(tarball, Buffer.concat([readFileSync(tarball), Buffer.from('tampered')]))
    assert.throws(() => verifyCandidateManifest({ releaseRoot, environment }), /Release candidate digest mismatch/)
  })
})

function withReleaseFixture(run) {
  const releaseRoot = mkdtempSync(join(tmpdir(), 'swm-uws-release-artifacts-'))

  try {
    writeFileSync(
      join(releaseRoot, 'package.json'),
      `${JSON.stringify({
        name: '@swarmmachina/swm-uws',
        version: '0.6.3',
        files: ['prebuilds/'],
        repository: {
          type: 'git',
          url: 'git+https://github.com/SwarmMachina/swm-uws.git'
        },
        publishConfig: {
          access: 'public',
          registry: 'https://registry.npmjs.org/',
          provenance: true
        }
      })}\n`
    )

    for (const [index, artifact] of expectedPrebuilds.entries()) {
      const path = join(releaseRoot, artifact.path)

      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, Buffer.concat([artifact.magic, Buffer.from(`fixture-${index}`)]))
      createBuildManifest({
        releaseRoot,
        environment: {
          ...environment,
          SWM_RELEASE_ARTIFACT: artifact.path
        }
      })
    }

    run(releaseRoot)
  } finally {
    rmSync(releaseRoot, { recursive: true, force: true })
  }
}
