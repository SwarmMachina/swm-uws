import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const manifest = readFileSync(resolve(root, 'vendor/FILES.sha256'), 'utf8').trim().split('\n')
const declaredFiles = new Set()

for (const line of manifest) {
  const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line)

  if (!match) {
    throw new Error(`Invalid vendor manifest line: ${line}`)
  }

  if (declaredFiles.has(match[2])) {
    throw new Error(`Duplicate vendor manifest entry: ${match[2]}`)
  }

  declaredFiles.add(match[2])

  const actual = createHash('sha256')
    .update(readFileSync(resolve(root, match[2])))
    .digest('hex')

  if (actual !== match[1]) {
    throw new Error(`Vendored source drift: ${match[2]}`)
  }
}

const actualFiles = [...walk(resolve(root, 'vendor/uWebSockets')), ...walk(resolve(root, 'vendor/uSockets'))].map(
  (file) => relative(root, file)
)

for (const file of actualFiles) {
  if (!declaredFiles.has(file)) {
    throw new Error(`Untracked vendored source: ${file}`)
  }
}

if (actualFiles.length !== declaredFiles.size) {
  throw new Error('Vendor manifest contains missing files')
}

console.log(`Verified ${manifest.length} vendored files`)

function walk(directory) {
  const files = []

  for (const entry of readdirSync(directory).sort()) {
    const path = resolve(directory, entry)

    if (statSync(path).isDirectory()) {
      files.push(...walk(path))
    } else {
      files.push(path)
    }
  }

  return files
}
