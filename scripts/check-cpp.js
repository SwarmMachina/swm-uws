import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const fix = process.argv.slice(2).includes('--fix')
const format = resolveTool('clang-format', process.env.CLANG_FORMAT)
const tidy = resolveTool('clang-tidy', process.env.CLANG_TIDY)
const files = sourceFiles(path.resolve(root, 'src'))
const translationUnits = files.filter((file) => file.endsWith('.cpp'))
const packageMetadata = JSON.parse(readFileSync(path.resolve(root, 'package.json'), 'utf8'))

run(format, fix ? ['-i', ...files] : ['--dry-run', '--Werror', ...files])

const nodeDirectory = configuredNodeDirectory()
const compilerArguments = [
  '-x',
  'c++',
  '-std=c++20',
  '-fno-exceptions',
  '-fno-rtti',
  '-DNODE_GYP_MODULE_NAME=swm_uws',
  '-DUSING_UV_SHARED=1',
  '-DUSING_V8_SHARED=1',
  '-DV8_DEPRECATION_WARNINGS=1',
  '-D_FILE_OFFSET_BITS=64',
  '-D_LARGEFILE_SOURCE',
  '-DLIBUS_USE_LIBUV=1',
  '-DLIBUS_NO_SSL=1',
  '-DUWS_WITH_PROXY=1',
  '-DUWS_NO_ZLIB=1',
  `-DSWM_UWS_VERSION="${packageMetadata.version}"`,
  `-DSWM_UWS_UPSTREAM_VERSION="${packageMetadata.upstream.uWebSocketsJs}"`,
  '-DBUILDING_NODE_EXTENSION',
  ...systemIncludeArguments(nodeDirectory),
  '-isystem',
  path.resolve(root, 'vendor/uWebSockets/src'),
  '-isystem',
  path.resolve(root, 'vendor/uSockets/src')
]

for (const source of translationUnits) {
  run(tidy, ['--quiet', source, '--', ...compilerArguments])
}

process.stdout.write(
  `C++ ${fix ? 'format and ' : ''}quality gate passed: ${files.length} files, ` +
    `${translationUnits.length} translation units\n`
)

function configuredNodeDirectory() {
  const configuration = path.resolve(root, 'build/config.gypi')

  if (!existsSync(configuration)) {
    const nodeGyp = path.resolve(root, 'node_modules/.bin', process.platform === 'win32' ? 'node-gyp.cmd' : 'node-gyp')

    if (!existsSync(nodeGyp)) {
      throw new Error('node-gyp is required; run npm ci first')
    }

    run(nodeGyp, ['configure'])
  }

  const text = readFileSync(configuration, 'utf8').replace(/^#.*\r?\n/, '')
  const nodeDirectory = JSON.parse(text).variables?.nodedir

  if (!nodeDirectory) {
    throw new Error('build/config.gypi does not contain variables.nodedir')
  }

  return nodeDirectory
}

function systemIncludeArguments(nodeDirectory) {
  const directories = [
    'include/node',
    'src',
    'deps/openssl/config',
    'deps/openssl/openssl/include',
    'deps/uv/include',
    'deps/zlib',
    'deps/v8/include'
  ]

  return directories.flatMap((directory) => ['-isystem', path.resolve(nodeDirectory, directory)])
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const target = path.resolve(directory, entry.name)

      return entry.isDirectory() ? sourceFiles(target) : [target]
    })
    .filter((file) => file.endsWith('.cpp') || file.endsWith('.h'))
    .sort()
}

function resolveTool(name, configured) {
  const candidates = [
    configured,
    `${name}-18`,
    `/opt/homebrew/opt/llvm@18/bin/${name}`,
    name,
    `/opt/homebrew/opt/llvm/bin/${name}`,
    `/usr/local/opt/llvm/bin/${name}`
  ].filter(Boolean)

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' })

    if (result.status === 0) {
      return candidate
    }
  }

  throw new Error(
    `${name} was not found; install LLVM 18+ or set ${name === 'clang-format' ? 'CLANG_FORMAT' : 'CLANG_TIDY'}`
  )
}

function run(command, arguments_) {
  try {
    execFileSync(command, arguments_, { cwd: root, stdio: 'inherit' })
  } catch (error) {
    if (error.status !== undefined) {
      throw new Error(`${path.basename(command)} exited with status ${error.status}`, { cause: error })
    }

    throw error
  }
}
