import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = join(root, 'build', 'Release', 'swm_uws.node')
const targetDirectories = new Map([
  ['linux/x64', 'linux-x64-glibc'],
  ['win32/x64', 'win32-x64']
])
const targetDirectory = targetDirectories.get(`${process.platform}/${process.arch}`)

if (!targetDirectory) {
  console.log(`Skipping prebuild copy on unsupported target ${process.platform}/${process.arch}`)
  process.exit(0)
}

const destination = join(
  root,
  'prebuilds',
  targetDirectory,
  `node-v${process.versions.modules}.node`
)

mkdirSync(dirname(destination), { recursive: true })
copyFileSync(source, destination)
console.log(`Copied native binary to ${destination}`)
