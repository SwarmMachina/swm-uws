import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { PreparedHeaderBlock, capabilities, createApp } from '../lib/index.js'
import { NativeAppServer } from './helpers/native-app-server.js'
import { rawHttpExchange } from './helpers/raw-http.js'
import { SubprocessProbe } from './helpers/subprocess-probe.js'

const gcFixture = fileURLToPath(new URL('./fixtures/prepared-header-gc-case.js', import.meta.url))

test('PreparedHeaderBlock validates, bounds, freezes, and copies its input', () => {
  assert.equal(capabilities().preparedHeaders, true)
  assert.throws(() => PreparedHeaderBlock([]), /new PreparedHeaderBlock/)
  assert.throws(() => new PreparedHeaderBlock({}), /flat string array/)
  assert.throws(() => new PreparedHeaderBlock(['x-test']), /name\/value pairs/)
  assert.throws(() => new PreparedHeaderBlock(['bad name', 'value']), /invalid header/)
  assert.throws(() => new PreparedHeaderBlock(['x-test', 'bad\r\nvalue']), /invalid header/)
  assert.throws(() => new PreparedHeaderBlock(['content-length', '4']), /cannot contain/)
  assert.throws(
    () => new PreparedHeaderBlock(Array.from({ length: 130 }, (_, index) => String(index))),
    /at most 64 header pairs/
  )
  assert.throws(() => new PreparedHeaderBlock(['x', 'a'.repeat(64 * 1024)]), /exceeds 64 KiB/)
  assert.throws(() => new PreparedHeaderBlock(['x', 'é'.repeat(32 * 1024)]), /exceeds 64 KiB/)
  assert.throws(() => new PreparedHeaderBlock(['x', '😀'.repeat(40_000)]), /exceeds 64 KiB/)

  const maximum = new PreparedHeaderBlock(['x', 'a'.repeat(64 * 1024 - 1)])
  const multibyteMaximum = new PreparedHeaderBlock(['x', 'é'.repeat(32 * 1024 - 1)])
  const source = ['x-copy', 'before']
  const copied = new PreparedHeaderBlock(source)

  source[1] = 'after'
  assert.equal(Object.isFrozen(maximum), true)
  assert.equal(Object.isFrozen(multibyteMaximum), true)
  assert.equal(Object.isFrozen(copied), true)
})

test('endPrepared preserves wire data and response lifecycle', { timeout: 15_000 }, async () => {
  const source = ['x-copy', 'before', 'set-cookie', 'a=1; Path=/', 'set-cookie', 'b=2; Path=/']
  const block = new PreparedHeaderBlock(source)
  const app = createApp()

  source[1] = 'after'
  app.get('/prepared', (res) => {
    assert.equal(res.endPrepared('201 Created', block, 'prepared'), res)
    assert.throws(() => res.endPrepared('200 OK', block, 'late'), /no longer valid/)
  })
  app.get('/validation', (res) => {
    assert.throws(() => res.endPrepared('invalid', block, 'bad'), /valid status/)
    assert.throws(() => res.endPrepared('200 OK', {}, 'bad'), /PreparedHeaderBlock/)
    assert.throws(() => res.endPrepared('200 OK', block, Symbol('bad')), /string or buffer/)
    res.endPrepared('200 OK', block, Buffer.from('valid'))
  })

  const server = await NativeAppServer.listen(app)

  try {
    const prepared = (
      await rawHttpExchange({ host: '127.0.0.1', port: server.port }, [
        'GET /prepared HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      ])
    ).toString()
    const validation = await fetch(`http://127.0.0.1:${server.port}/validation`, {
      signal: AbortSignal.timeout(5_000)
    })

    assert.match(prepared, /^HTTP\/1\.1 201 Created/m)
    assert.match(prepared, /^x-copy: before$/im)
    assert.equal((prepared.match(/^set-cookie:/gim) ?? []).length, 2)
    assert.match(prepared, /\r\n\r\nprepared$/)
    assert.equal(validation.status, 200)
    assert.equal(validation.headers.get('x-copy'), 'before')
    assert.equal(await validation.text(), 'valid')
  } finally {
    server.close()
  }
})

test('PreparedHeaderBlock does not retain native payloads after wrapper collection', () => {
  const result = new SubprocessProbe(gcFixture).run('collect')

  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout.trim()).alive, 0)
})
