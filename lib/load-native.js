import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

function targetDescription() {
  return `${process.platform}/${process.arch}/node-v${process.versions.modules}`
}

export function resolvePrebuildTarget(platform, arch) {
  if (platform === 'linux' && arch === 'x64') {
    return 'linux-x64-glibc'
  }

  if (platform === 'win32' && arch === 'x64') {
    return 'win32-x64'
  }

  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    return `darwin-${arch}`
  }

  return null
}

export function loadNative() {
  const candidates = []
  const target = resolvePrebuildTarget(process.platform, process.arch)

  if (target) {
    candidates.push(new URL(`../prebuilds/${target}/node-v${process.versions.modules}.node`, import.meta.url))
  }

  candidates.push(new URL('../build/Release/swm_uws.node', import.meta.url))

  for (const candidate of candidates) {
    const path = fileURLToPath(candidate)

    if (existsSync(path)) {
      return require(path)
    }
  }

  throw new Error(
    `No native binary for ${targetDescription()}.\n` + 'Build @swarmmachina/swm-uws for this target first.'
  )
}
