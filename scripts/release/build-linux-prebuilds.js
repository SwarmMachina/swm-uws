import { spawnSync } from 'node:child_process'

for (const nodeVersion of ['22', '24']) {
  console.log(`Building linux/amd64 prebuild for Node.js ${nodeVersion}`)

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
      'type=local,dest=prebuilds',
      '.'
    ],
    { stdio: 'inherit' }
  )

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
