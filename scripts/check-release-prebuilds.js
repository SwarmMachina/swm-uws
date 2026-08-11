import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyReleasePrebuilds } from './release-artifacts.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const releaseRoot = process.argv[2] ? resolve(process.argv[2]) : root

try {
  const { artifacts, manifest } = verifyReleasePrebuilds(releaseRoot)

  for (const artifact of artifacts) {
    console.log(`Release prebuild ok: ${artifact.path} (${artifact.sha256})`)
  }

  console.log(`Release manifest ok: ${manifest.source.commit}`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
