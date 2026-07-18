import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const expected = [
  {
    path: 'prebuilds/linux-x64-glibc/node-v127.node',
    magic: Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    format: 'ELF'
  },
  {
    path: 'prebuilds/linux-x64-glibc/node-v137.node',
    magic: Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    format: 'ELF'
  },
  {
    path: 'prebuilds/win32-x64/node-v127.node',
    magic: Buffer.from([0x4d, 0x5a]),
    format: 'PE'
  },
  {
    path: 'prebuilds/win32-x64/node-v137.node',
    magic: Buffer.from([0x4d, 0x5a]),
    format: 'PE'
  },
  {
    path: 'prebuilds/darwin-arm64/node-v127.node',
    magic: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
    format: 'Mach-O'
  },
  {
    path: 'prebuilds/darwin-arm64/node-v137.node',
    magic: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
    format: 'Mach-O'
  },
  {
    path: 'prebuilds/darwin-x64/node-v127.node',
    magic: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
    format: 'Mach-O'
  },
  {
    path: 'prebuilds/darwin-x64/node-v137.node',
    magic: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
    format: 'Mach-O'
  }
]

let failed = false

for (const artifact of expected) {
  const path = join(root, artifact.path)

  let bytes

  try {
    bytes = readFileSync(path)
  } catch {
    console.error(`Missing release prebuild: ${artifact.path}`)
    failed = true
    continue
  }

  if (bytes.length <= artifact.magic.length || !bytes.subarray(0, artifact.magic.length).equals(artifact.magic)) {
    console.error(`Invalid ${artifact.format} prebuild: ${artifact.path}`)
    failed = true
    continue
  }

  console.log(`Release prebuild ok: ${artifact.path}`)
}

if (failed) {
  process.exit(1)
}
