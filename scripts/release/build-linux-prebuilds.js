import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const evidenceRoot = join(root, 'pgo-evidence')
const prebuildDirectory = join(root, 'prebuilds/linux-x64-glibc')

mkdirSync(evidenceRoot, { recursive: true })
mkdirSync(prebuildDirectory, { recursive: true })

for (const [nodeVersion, abi] of [
  ['22', '127'],
  ['24', '137']
]) {
  const outputDirectory = mkdtempSync(join(evidenceRoot, `node-${nodeVersion}-`))

  console.log(`Building linux/amd64 prebuild for Node.js ${nodeVersion}; evidence: ${outputDirectory}`)

  const result = spawnSync(
    'docker',
    [
      'build',
      '--platform',
      'linux/amd64',
      '--build-arg',
      `NODE_VERSION=${nodeVersion}`,
      '--target',
      'prebuild',
      '--output',
      `type=local,dest=${outputDirectory}`,
      root
    ],
    { stdio: 'inherit' }
  )

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }

  copyFileSync(
    join(outputDirectory, 'linux-x64-glibc', `node-v${abi}.node`),
    join(prebuildDirectory, `node-v${abi}.node`)
  )
}
