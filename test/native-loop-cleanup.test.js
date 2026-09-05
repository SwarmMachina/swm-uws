import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))
const fixture = fileURLToPath(new URL('./native/', import.meta.url))

test('environment teardown frees every uSockets allocation after its last loop iteration', { timeout: 120_000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'swm-uws-loop-cleanup-'))

  try {
    copyFileSync(join(fixture, 'loop-cleanup.cpp'), join(directory, 'loop-cleanup.cpp'))
    copyFileSync(join(fixture, 'allocator.h'), join(directory, 'allocator.h'))
    const sources = ['bsd.c', 'context.c', 'loop.c', 'socket.c', 'udp.c', 'eventing/libuv.c']
    const wrappers = sources.map((source, index) => {
      const path = join(directory, `source-${index}.c`)
      const original = join(root, 'vendor/uSockets/src', source).replaceAll('\\', '/')

      writeFileSync(
        path,
        `#include <stdlib.h>\n#include "allocator.h"\n#define malloc swm_test_malloc\n#define calloc swm_test_calloc\n#define realloc swm_test_realloc\n#define free swm_test_free\n#include "${original}"\n`
      )

      return `source-${index}.c`
    })
    const configuration = JSON.parse(readFileSync(join(root, 'build/config.gypi'), 'utf8').replace(/^#.*\r?\n/, ''))
    const gyp = {
      targets: [
        {
          target_name: 'loop_cleanup',
          sources: ['loop-cleanup.cpp', ...wrappers],
          include_dirs: [directory, join(root, 'vendor/uSockets/src')],
          defines: ['LIBUS_USE_LIBUV=1', 'LIBUS_NO_SSL=1'],
          cflags_cc: ['-std=c++20'],
          xcode_settings: { CLANG_CXX_LANGUAGE_STANDARD: 'c++20' },
          conditions: [
            // Instrumentation includes libc before uSockets can enable GNU APIs.
            ['OS=="linux"', { defines: ['_GNU_SOURCE'] }],
            [
              'OS=="win"',
              {
                defines: ['WIN32_LEAN_AND_MEAN', 'NOMINMAX'],
                libraries: ['Ws2_32.lib'],
                msvs_settings: { VCCLCompilerTool: { AdditionalOptions: ['/std:c++20'] } }
              }
            ]
          ]
        }
      ]
    }

    if (process.platform === 'win32') {
      const cachedLibrary = join(configuration.variables.nodedir, configuration.variables.target_arch, 'node.lib')

      // --nodedir assumes a Node source build; downloaded Windows headers keep
      // node.lib under the architecture instead of the build configuration.
      if (existsSync(cachedLibrary)) {
        gyp.variables = { node_lib_file: cachedLibrary.replaceAll('\\', '/') }
      }
    }

    writeFileSync(join(directory, 'binding.gyp'), JSON.stringify(gyp))
    const build = spawnSync(
      process.execPath,
      [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild', `--nodedir=${configuration.variables.nodedir}`],
      { cwd: directory, encoding: 'utf8', timeout: 90_000 }
    )

    assert.ifError(build.error)
    assert.equal(build.status, 0, `Native loop probe build failed:\n${build.stdout}\n${build.stderr}`)
    execFileSync(
      process.execPath,
      [
        '-e',
        `
      const assert = require('node:assert/strict')
      const probe = require(process.argv[1])
      for (let index = 0; index < 16; index++) {
        assert.equal(probe.run(), 0, 'closed native sockets or libuv poll allocations leaked during teardown')
      }
    `,
        join(directory, 'build/Release/loop_cleanup.node')
      ],
      { stdio: 'pipe', timeout: 10_000 }
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
