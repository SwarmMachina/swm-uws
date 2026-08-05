import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import test from 'node:test'

import { benchmarkBlockSchedule } from '../scripts/lib/benchmark-block-schedule.js'
import { BenchmarkTargetProcess } from '../scripts/lib/benchmark-target-process.js'
import {
  cpuIndexOption,
  expandEqualsArguments,
  nonNegativeIntegerOption,
  positiveIntegerOption,
  requiredOption
} from '../scripts/lib/option-values.js'
import { waitFor, withTimeout } from './helpers/async.js'
import { proxyProtocolV2Ipv4Header, rawHttpExchange } from './helpers/raw-http.js'
import { nextWebSocketClose, nextWebSocketMessage, nextWebSocketOpen } from './helpers/websocket-events.js'

test('benchmark schedule alternates complete ABBA and BAAB blocks', () => {
  const schedule = benchmarkBlockSchedule(2, { baseline: 'A', candidate: 'B' })

  assert.deepEqual(
    schedule.map(({ block, position, role, value }) => [block, position, role, value]),
    [
      [1, 1, 'baseline', 'A'],
      [1, 2, 'candidate', 'B'],
      [1, 3, 'candidate', 'B'],
      [1, 4, 'baseline', 'A'],
      [2, 1, 'candidate', 'B'],
      [2, 2, 'baseline', 'A'],
      [2, 3, 'baseline', 'A'],
      [2, 4, 'candidate', 'B']
    ]
  )
  assert.throws(() => benchmarkBlockSchedule(0, { baseline: 'A', candidate: 'B' }), /positive safe integer/)
})

test('benchmark option values accept both CLI forms and reject unsafe numbers', () => {
  assert.deepEqual(expandEqualsArguments(['--blocks=4', '--output=a=b.json', '--quick']), [
    '--blocks',
    '4',
    '--output',
    'a=b.json',
    '--quick'
  ])
  assert.equal(requiredOption('--output', 'report.json'), 'report.json')
  assert.equal(positiveIntegerOption('--blocks', '4'), 4)
  assert.equal(nonNegativeIntegerOption('--bodySize', '0'), 0)
  assert.equal(cpuIndexOption('--serverCpu', '-1'), -1)
  assert.throws(() => requiredOption('--output', ''), /requires a value/)
  assert.throws(() => positiveIntegerOption('--blocks', '0'), /positive safe integer/)
  assert.throws(() => nonNegativeIntegerOption('--bodySize', '-1'), /non-negative safe integer/)
  assert.throws(() => cpuIndexOption('--serverCpu', '-2'), /-1 or a non-negative safe integer/)
})

test('benchmark target owns IPC measurement and bounded shutdown', async () => {
  const target = await startFixtureTarget()

  assert.equal(target.ready.port, 12_345)
  assert.equal(target.ready.node, process.version)
  assert.deepEqual(await target.measure(async () => 'result'), {
    value: 'result',
    metrics: { sample: 1 }
  })
  await assert.rejects(
    target.measure(async () => Promise.reject(new Error('run failed'))),
    /run failed/
  )
  assert.deepEqual(await target.measure(async () => 'after-error'), {
    value: 'after-error',
    metrics: { sample: 3 }
  })

  await target.stop({ shutdownMessage: { type: 'shutdown' } })
  await target.stop({ shutdownMessage: { type: 'shutdown' } })
  await assert.rejects(
    target.measure(async () => 'late'),
    /cannot handle metrics:start/
  )
})

test('raw HTTP exchange supports end and close completion without changing wire bytes', async () => {
  const server = createServer((socket) => {
    const request = []

    socket.on('data', (chunk) => {
      request.push(chunk)

      if (chunk.includes(0x0a)) {
        socket.end(Buffer.concat(request))
      }
    })
  })
  const address = await listen(server)

  try {
    const chunks = [Buffer.from('one'), Buffer.from('two\n')]
    const response = await rawHttpExchange(address, chunks, { yieldBetweenChunks: true })

    assert.equal(response.toString(), 'onetwo\n')

    const closeResponse = await rawHttpExchange(address, ['close\n'], { resolveOn: 'close' })

    assert.equal(closeResponse.toString(), 'close\n')
    assert.throws(() => rawHttpExchange(address, [], { resolveOn: 'invalid' }), /either 'end' or 'close'/)
    assert.throws(() => rawHttpExchange(address, [], { acceptResetAfterData: 'yes' }), /must be a boolean/)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

test(
  'raw HTTP exchange can accept a reset after observed response data',
  {
    skip: process.platform === 'win32' && 'Windows may discard unread TCP payload when the peer sends an immediate RST'
  },
  async () => {
    const server = createServer((socket) => {
      socket.once('data', () => socket.write('reset-response', () => socket.resetAndDestroy()))
    })
    const address = await listen(server)

    try {
      const response = await rawHttpExchange(address, ['reset\n'], { acceptResetAfterData: true })

      assert.equal(response.toString(), 'reset-response')
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  }
)

test('PROXY v2 IPv4 builder validates and serializes addresses and ports', () => {
  const header = proxyProtocolV2Ipv4Header({
    sourceAddress: [203, 0, 113, 7],
    destinationAddress: [127, 0, 0, 1],
    sourcePort: 45_678,
    destinationPort: 8_080
  })

  assert.equal(header.length, 28)
  assert.equal(header.subarray(0, 12).toString('binary'), '\r\n\r\n\0\r\nQUIT\n')
  assert.deepEqual([...header.subarray(16, 24)], [203, 0, 113, 7, 127, 0, 0, 1])
  assert.equal(header.readUInt16BE(24), 45_678)
  assert.equal(header.readUInt16BE(26), 8_080)
  assert.throws(
    () => proxyProtocolV2Ipv4Header({ sourceAddress: [127, 0, 0], sourcePort: 1, destinationPort: 2 }),
    /four IPv4 bytes/
  )
})

test('async and WebSocket helpers settle on their documented event', async () => {
  let ready = false

  setImmediate(() => {
    ready = true
  })
  await waitFor(() => ready, 1_000, { intervalMs: 1, description: 'ready flag' })
  await assert.rejects(withTimeout(new Promise(() => {}), 1, 'deadline'), /deadline/)

  const socket = new EventTarget()
  const message = nextWebSocketMessage(socket)

  socket.dispatchEvent(new MessageEvent('message', { data: 'payload' }))
  assert.equal(await message, 'payload')

  const open = nextWebSocketOpen(socket)

  socket.dispatchEvent(new Event('open'))
  assert.equal((await open).type, 'open')

  const close = nextWebSocketClose(socket)

  socket.dispatchEvent(new Event('close'))
  assert.equal((await close).type, 'close')
})

function startFixtureTarget() {
  return BenchmarkTargetProcess.start({
    command: process.execPath,
    arguments_: ['test/fixtures/benchmark-target-process.js'],
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'ignore', 'inherit', 'ipc']
  })
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()

      assert.notEqual(address, null)
      assert.equal(typeof address, 'object')
      resolve({ host: '127.0.0.1', port: address.port })
    })
  })
}
