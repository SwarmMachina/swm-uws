import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const tag = process.argv[2]

if (!/^v20\.\d+\.0$/.test(tag || '')) {
  throw new Error('Usage: node scripts/update-vendor.js v20.x.0')
}

const temp = mkdtempSync(join(tmpdir(), 'swm-uws-vendor-'))

try {
  const jsRepo = join(temp, 'uWebSockets.js')

  checkout('https://github.com/uNetworking/uWebSockets.js.git', `refs/tags/${tag}`, jsRepo)
  const releaseCommit = output('git', ['rev-parse', 'HEAD'], jsRepo)
  const sourceCommit = readFileSync(join(jsRepo, 'source_commit'), 'utf8').trim()

  run('git', ['fetch', '--depth=1', 'origin', sourceCommit], jsRepo)
  run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], jsRepo)
  const uWebSocketsCommit = gitlink(jsRepo, 'uWebSockets')
  const uWebSocketsRepo = join(temp, 'uWebSockets')

  checkout('https://github.com/uNetworking/uWebSockets.git', uWebSocketsCommit, uWebSocketsRepo)
  const uSocketsCommit = gitlink(uWebSocketsRepo, 'uSockets')
  const uSocketsRepo = join(temp, 'uSockets')

  checkout('https://github.com/uNetworking/uSockets.git', uSocketsCommit, uSocketsRepo)

  syncComponent(uWebSocketsRepo, join(root, 'vendor/uWebSockets'), [
    'GNUmakefile',
    'LICENSE',
    'Makefile',
    'README.md',
    'src'
  ])
  syncComponent(uSocketsRepo, join(root, 'vendor/uSockets'), ['LICENSE', 'Makefile', 'README.md', 'src'])

  for (const patch of readdirSync(join(root, 'vendor/patches')).sort()) {
    run('git', ['apply', '--directory=vendor/uWebSockets', join('vendor/patches', patch)], root)
  }

  const packagePath = join(root, 'package.json')
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))

  packageJson.upstream = { uWebSocketsJs: tag }
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)

  writeFileSync(
    join(root, 'vendor/VERSIONS.md'),
    renderVersions({ tag, releaseCommit, sourceCommit, uWebSocketsCommit, uSocketsCommit })
  )
  writeManifest()

  console.log(
    `Updated ${tag}: source=${sourceCommit.slice(0, 12)} uWebSockets=${uWebSocketsCommit.slice(0, 12)} uSockets=${uSocketsCommit.slice(0, 12)}`
  )
} finally {
  rmSync(temp, { recursive: true, force: true })
}

function checkout(repository, revision, directory) {
  run('git', ['init', '--quiet', directory], root)
  run('git', ['remote', 'add', 'origin', repository], directory)
  run('git', ['fetch', '--depth=1', 'origin', revision], directory)
  run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], directory)
}

function gitlink(directory, path) {
  const fields = output('git', ['ls-tree', 'HEAD', path], directory).split(/\s+/)

  if (fields[1] !== 'commit' || !/^[a-f0-9]{40}$/.test(fields[2] || '')) {
    throw new Error(`Missing gitlink ${path} in ${directory}`)
  }

  return fields[2]
}

function syncComponent(source, target, entries) {
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })

  for (const entry of entries) {
    const destination = join(target, entry)

    cpSync(join(source, entry), destination, { recursive: true })
  }
}

function writeManifest() {
  const files = [...walk(join(root, 'vendor/uWebSockets')), ...walk(join(root, 'vendor/uSockets'))].sort()
  const lines = files.map((file) => {
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex')

    return `${hash}  ${relative(root, file)}`
  })

  writeFileSync(join(root, 'vendor/FILES.sha256'), `${lines.join('\n')}\n`)
}

function walk(directory) {
  const files = []

  for (const entry of readdirSync(directory).sort()) {
    const path = join(directory, entry)

    if (statSync(path).isDirectory()) {
      files.push(...walk(path))
    } else {
      files.push(path)
    }
  }

  return files
}

function renderVersions({ tag, releaseCommit, sourceCommit, uWebSocketsCommit, uSocketsCommit }) {
  return `# Vendored upstream revisions

The files under \`vendor/\` are copied sources, not git submodules.

| Component | Upstream | Revision |
| --- | --- | --- |
| uWebSockets.js release tag | https://github.com/uNetworking/uWebSockets.js | \`${tag}\` / \`${releaseCommit}\` |
| uWebSockets.js source commit | https://github.com/uNetworking/uWebSockets.js | \`${sourceCommit}\` |
| uWebSockets | https://github.com/uNetworking/uWebSockets | \`${uWebSocketsCommit}\` |
| uSockets | https://github.com/uNetworking/uSockets | \`${uSocketsCommit}\` |

The release tag contains prebuilt binaries. Its \`source_commit\` file points to
the uWebSockets.js source commit above, whose gitlinks pin the uWebSockets and
uSockets revisions copied here.

Local deviations are documented in [PATCHES.md](./PATCHES.md) and reapplied by
the vendor updater.
`
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' })
}

function output(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim()
}
