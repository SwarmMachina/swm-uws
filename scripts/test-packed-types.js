import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const temp = mkdtempSync(join(tmpdir(), 'swm-uws-packed-types-'))

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

  console.log('packed swm-uws consumer types: NodeNext + Bundler + JS/JSDoc + CommonJS ok')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
