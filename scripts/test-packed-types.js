import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const temp = mkdtempSync(join(tmpdir(), 'swm-uws-packed-types-'))

/**
 * Verifies the completion and hover path used by TypeScript-backed editors,
 * including VS Code. The source deliberately has no JSDoc or `@ts-check`.
 * @param {string} consumer
 * @param {object} compilerOptions
 */
function assertJavaScriptIdeTypes(consumer, compilerOptions) {
  const file = join(consumer, 'ide-consumer.js')
  const source = [
    "import uWS, { defineHttpHandler, defineWebSocketBehavior } from '@swarmmachina/swm-uws'",
    '',
    'const app = uWS.App()',
    "app.get('/', (res, req) => req.getH)",
    '',
    'defineHttpHandler((res, req) => res.getProx)',
    '',
    'defineWebSocketBehavior({',
    '  message(ws, message, isBinary) {',
    '    ws.getB',
    '  }',
    '})',
    ''
  ].join('\n')

  writeFileSync(file, source)

  const host = {
    getScriptFileNames: () => [file],
    getScriptVersion: () => '0',
    getScriptSnapshot: (path) => {
      const text = ts.sys.readFile(path)

      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => consumer,
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath
  }
  const service = ts.createLanguageService(host)

  for (const [prefix, expected] of [
    ['getH', 'getHeader'],
    ['getProx', 'getProxiedRemoteAddress'],
    ['getB', 'getBufferedAmount']
  ]) {
    const position = source.indexOf(prefix) + prefix.length
    const completions = service.getCompletionsAtPosition(file, position, {})
    const names = new Set(completions?.entries.map((entry) => entry.name))

    assert.ok(names.has(expected), `JavaScript IDE completion is missing ${expected}`)
  }

  const headerDetails = service.getCompletionEntryDetails(
    file,
    source.indexOf('getH') + 'getH'.length,
    'getHeader',
    {},
    undefined,
    {},
    undefined
  )

  assert.match(ts.displayPartsToString(headerDetails?.documentation), /Returns a request header value/)
}

try {
  const artifacts = join(temp, 'artifacts')
  const consumer = join(temp, 'consumer')

  mkdirSync(artifacts)
  mkdirSync(consumer)

  const [packed] = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', artifacts], {
      cwd: root,
      encoding: 'utf8'
    })
  )
  const tarball = join(artifacts, basename(packed.filename))

  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify(
      { private: true, type: 'module', dependencies: { '@swarmmachina/swm-uws': `file:${tarball}` } },
      null,
      2
    )
  )
  cpSync(join(root, 'test/fixtures/types'), join(consumer, 'fixtures'), { recursive: true })
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: consumer,
    stdio: 'inherit'
  })

  const shared = {
    strict: true,
    noEmit: true,
    allowJs: true,
    checkJs: true,
    types: ['node'],
    typeRoots: [join(root, 'node_modules/@types')]
  }

  assertJavaScriptIdeTypes(consumer, {
    ...shared,
    checkJs: false,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext
  })

  for (const mode of [
    { name: 'nodenext', module: 'NodeNext', moduleResolution: 'NodeNext' },
    { name: 'bundler', module: 'ESNext', moduleResolution: 'Bundler' }
  ]) {
    const config = join(consumer, `tsconfig.${mode.name}.json`)

    writeFileSync(
      config,
      JSON.stringify(
        {
          compilerOptions: { ...shared, module: mode.module, moduleResolution: mode.moduleResolution },
          include: ['fixtures/*']
        },
        null,
        2
      )
    )
    execFileSync(join(root, 'node_modules/.bin/tsc'), ['--project', config, '--pretty', 'false'], {
      cwd: consumer,
      stdio: 'inherit'
    })

    const options = ts.convertCompilerOptionsFromJson(
      { ...shared, module: mode.module, moduleResolution: mode.moduleResolution },
      consumer
    ).options
    const resolved = ts.resolveModuleName(
      '@swarmmachina/swm-uws',
      join(consumer, 'fixtures/consumer.ts'),
      options,
      ts.sys
    ).resolvedModule

    assert.ok(resolved, `${mode.name}: package did not resolve`)
    assert.equal(
      resolved.resolvedFileName,
      join(realpathSync(consumer), 'node_modules/@swarmmachina/swm-uws/lib/index.d.ts')
    )
  }

  console.log('packed swm-uws consumer types: NodeNext + Bundler + JS + CommonJS + Language Service IntelliSense ok')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
