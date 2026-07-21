import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const temp = mkdtempSync(join(tmpdir(), 'swm-uws-package-'))

try {
  const [packed] = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], {
      cwd: root,
      encoding: 'utf8'
    })
  )
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const files = new Set(packed.files.map((entry) => entry.path))
  const metadata = [pkg.main, pkg.types, ...Object.values(pkg.exports['.'])].map((path) => path.replace(/^\.\//, ''))

  for (const path of ['package.json', 'lib/index.js', 'lib/index.d.ts', 'lib/load-native.js', ...metadata]) {
    assert.ok(files.has(path), `tarball is missing ${path}`)
  }

  assert.ok(
    [...files].some((path) => path.startsWith('prebuilds/')),
    'tarball is missing prebuilds'
  )
  console.log('swm-uws package metadata and tarball contents: ok')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
