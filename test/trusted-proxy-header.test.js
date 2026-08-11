import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from '../lib/index.js'
import { NativeAppServer } from './helpers/native-app-server.js'
import { proxyProtocolV2Ipv4Header, rawHttpExchange } from './helpers/raw-http.js'

function request(port, headers = '', options = {}) {
  return rawHttpExchange(
    { host: '127.0.0.1', port },
    [`GET /ip HTTP/1.1\r\nHost: localhost\r\n${headers}Connection: close\r\n\r\n`],
    { timeoutMessage: 'trusted proxy request', ...options }
  ).then((response) => response.toString())
}

function body(response) {
  return response.slice(response.indexOf('\r\n\r\n') + 4)
}

async function withAddressServer(http, run, formatResponse = (_res, address) => address || 'none') {
  const app = createApp({ http })

  let routeCalls = 0

  app.get('/ip', (res) => {
    routeCalls++
    const address = Buffer.from(res.getProxiedRemoteAddressAsText()).toString()

    res.end(formatResponse(res, address))
  })

  const server = await NativeAppServer.listen(app)

  try {
    await run(server.port, () => routeCalls)
  } finally {
    server.close()
  }
}

test('omitting trustedProxy preserves legacy PROXY v2 addresses and ports', async () => {
  await withAddressServer(undefined, async (port, routeCalls) => {
    const spoofed = await request(port, 'X-Forwarded-For: 203.0.113.40\r\n')

    assert.match(spoofed, /^HTTP\/1\.1 200 /)
    assert.equal(body(spoofed), 'none:0')
    assert.equal(routeCalls(), 1)

    const binaryHeader = proxyProtocolV2Ipv4Header({
      sourceAddress: [203, 0, 113, 41],
      sourcePort: 41_234,
      destinationPort: port
    })
    const binaryProxy = (
      await rawHttpExchange(
        { host: '127.0.0.1', port },
        [
          Buffer.concat([binaryHeader, Buffer.from('GET /ip HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')])
        ],
        {
          timeoutMessage: 'binary PROXY preamble request',
          acceptResetAfterData: true
        }
      )
    ).toString()

    assert.match(binaryProxy, /^HTTP\/1\.1 200 /)
    assert.equal(body(binaryProxy), '203.0.113.41:41234')
    assert.equal(routeCalls(), 2)
  }, (res, address) => `${address || 'none'}:${res.getProxiedRemotePort()}`)
})

test('trusted x-forwarded-for selects an explicit hop from the right', async () => {
  await withAddressServer({ trustedProxy: { header: 'x-forwarded-for', hops: 1 } }, async (port) => {
    const response = await request(port, 'X-Forwarded-For: attacker.invalid, 198.51.100.9, 203.0.113.42\r\n')

    assert.equal(body(response), '203.0.113.42')
  })

  await withAddressServer({ trustedProxy: { header: 'x-forwarded-for', hops: 2 } }, async (port) => {
    const response = await request(port, 'X-Forwarded-For: attacker.invalid, 198.51.100.9, 203.0.113.42\r\n')

    assert.equal(body(response), '198.51.100.9')
  })
})

test('trusted x-real-ip accepts strict IPv4 and IPv6 address literals', async () => {
  await withAddressServer({ trustedProxy: { header: 'x-real-ip' } }, async (port) => {
    assert.equal(body(await request(port, 'X-Real-IP: 203.0.113.43\r\n')), '203.0.113.43')
    assert.equal(body(await request(port, 'X-Real-IP: 2001:db8::5\r\n')), '2001:0db8:0000:0000:0000:0000:0000:0005')

    const binaryHeader = proxyProtocolV2Ipv4Header({
      sourceAddress: [203, 0, 113, 41],
      sourcePort: 41_234,
      destinationPort: port
    })
    const binaryProxy = (
      await rawHttpExchange(
        { host: '127.0.0.1', port },
        [Buffer.concat([binaryHeader, Buffer.from('GET /ip HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')])],
        { timeoutMessage: 'binary PROXY preamble in trusted-header mode', acceptResetAfterData: true }
      )
    ).toString()

    assert.doesNotMatch(binaryProxy, /^HTTP\/1\.1 200 /)
  })
})

test('malformed, ambiguous, or undersized trusted header chains fail closed', async () => {
  await withAddressServer({ trustedProxy: { header: 'x-forwarded-for', hops: 2 } }, async (port, routeCalls) => {
    for (const headers of [
      'X-Forwarded-For: 203.0.113.44\r\n',
      'X-Forwarded-For: 198.51.100.1, invalid\r\n',
      'X-Forwarded-For: 198.51.100.1, 203.0.113.44\r\nX-Forwarded-For: 203.0.113.45\r\n'
    ]) {
      const response = await request(port, headers, { acceptResetAfterData: true })

      assert.match(response, /^HTTP\/1\.1 400 /)
    }

    assert.equal(routeCalls(), 0)
  })
})
