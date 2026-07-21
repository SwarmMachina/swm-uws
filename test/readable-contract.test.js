import assert from 'node:assert/strict'
import { createConnection, createServer } from 'node:net'
import test from 'node:test'

import { createApp, us_socket_local_port } from '../lib/index.js'

const READABLE_SURFACE = {
  HttpRequest: [
    'forEach',
    'getCaseSensitiveMethod',
    'getHeader',
    'getMethod',
    'getParameter',
    'getQuery',
    'getUrl',
    'snapshot'
  ],
  HttpResponse: [
    'collectBody',
    'getProxiedRemoteAddress',
    'getProxiedRemoteAddressAsText',
    'getProxiedRemotePort',
    'getRemoteAddress',
    'getRemoteAddressAsText',
    'getRemotePort',
    'getWriteOffset',
    'onData',
    'onDataV2'
  ],
  WebSocket: [
    'getBufferedAmount',
    'getRemoteAddress',
    'getRemoteAddressAsText',
    'getRemotePort',
    'getTopics',
    'getUserData',
    'isSubscribed'
  ]
}
const explicitReaders = new Set(['collectBody', 'forEach', 'onData', 'onDataV2', 'snapshot'])

function prototypeReaders(value) {
  return Object.getOwnPropertyNames(Object.getPrototypeOf(value))
    .filter((name) => name.startsWith('get') || name.startsWith('is') || explicitReaders.has(name))
    .sort()
}

function arrayBuffer(bytes) {
  assert.ok(bytes instanceof ArrayBuffer)

  return bytes
}

function rawRequest(port, chunks, proxyHeader) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const response = []

    socket.setTimeout(5_000, () => socket.destroy(new Error('raw request timed out')))
    socket.on('connect', async () => {
      if (proxyHeader) {
        socket.write(proxyHeader)
      }

      for (const chunk of chunks) {
        socket.write(chunk)
        await new Promise((resolve) => setImmediate(resolve))
      }
    })
    socket.on('data', (chunk) => response.push(chunk))
    socket.on('end', () => resolve(Buffer.concat(response).toString()))
    socket.on('error', reject)
  })
}

function proxyV2Header(port, sourcePort = 41_234) {
  const header = Buffer.alloc(28)

  Buffer.from('\r\n\r\n\0\r\nQUIT\n', 'binary').copy(header)
  header[12] = 0x21
  header[13] = 0x11
  header.writeUInt16BE(12, 14)
  Buffer.from([203, 0, 113, 10, 127, 0, 0, 1]).copy(header, 16)
  header.writeUInt16BE(sourcePort, 24)
  header.writeUInt16BE(port, 26)

  return header
}

function nextEvent(target, name) {
  return new Promise((resolve, reject) => {
    target.addEventListener(name, resolve, { once: true })
    target.addEventListener('error', () => reject(new Error(`WebSocket ${name} failed`)), { once: true })
  })
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()

    server.listen(0, '127.0.0.1', () => {
      const address = server.address()

      server.close((error) => {
        if (error) {
          return reject(error)
        }

        resolve(address.port)
      })
    })
    server.on('error', reject)
  })
}

test('native readable surface has a functional network contract', { timeout: 15_000 }, async () => {
  const app = createApp()
  const covered = new Set()
  const prototypes = {}
  const bodyResults = new Map()
  const callbackErrors = []

  let subscriptionSeen = false
  let closeSeen

  function cover(scope, method) {
    covered.add(`${scope}.${method}`)
  }

  app.any('/contract/:name', (res, req) => {
    prototypes.HttpRequest = prototypeReaders(req)
    prototypes.HttpResponse = prototypeReaders(res)

    cover('HttpRequest', 'getMethod')
    assert.equal(typeof req.getMethod(), 'string')
    assert.equal(req.getMethod(), 'post')
    cover('HttpRequest', 'getCaseSensitiveMethod')
    assert.equal(req.getCaseSensitiveMethod(), 'POST')
    cover('HttpRequest', 'getUrl')
    assert.equal(req.getUrl(), '/contract/alice')
    cover('HttpRequest', 'getHeader')
    assert.equal(req.getHeader('x-contract'), 'Value')
    assert.equal(req.getHeader('x-absent'), '')
    cover('HttpRequest', 'getQuery')
    assert.equal(req.getQuery(), 'one=1&empty=&encoded=a%20b')
    assert.equal(req.getQuery('one'), '1')
    assert.equal(req.getQuery('empty'), '')
    assert.equal(req.getQuery('absent'), undefined)
    cover('HttpRequest', 'getParameter')
    assert.equal(req.getParameter(0), 'alice')
    assert.equal(req.getParameter('name'), 'alice')

    const headers = Object.create(null)

    cover('HttpRequest', 'forEach')
    req.forEach((name, value) => {
      assert.equal(typeof name, 'string')
      assert.equal(typeof value, 'string')
      headers[name] = value
    })
    assert.equal(headers['x-contract'], 'Value')

    cover('HttpRequest', 'snapshot')
    const snapshot = req.snapshot(1)

    assert.deepEqual(
      { method: snapshot.method, url: snapshot.url, query: snapshot.query, params: snapshot.params },
      { method: 'post', url: '/contract/alice', query: 'one=1&empty=&encoded=a%20b', params: ['alice'] }
    )
    assert.equal(Object.getPrototypeOf(snapshot.headers), null)
    assert.equal(snapshot.headers['x-contract'], 'Value')

    cover('HttpResponse', 'getRemoteAddress')
    assert.ok([4, 16].includes(arrayBuffer(res.getRemoteAddress()).byteLength))
    cover('HttpResponse', 'getRemoteAddressAsText')
    assert.ok(arrayBuffer(res.getRemoteAddressAsText()).byteLength > 0)
    cover('HttpResponse', 'getRemotePort')
    assert.ok(res.getRemotePort() > 0)
    cover('HttpResponse', 'getProxiedRemoteAddress')
    assert.equal(arrayBuffer(res.getProxiedRemoteAddress()).byteLength, 0)
    cover('HttpResponse', 'getProxiedRemoteAddressAsText')
    assert.equal(arrayBuffer(res.getProxiedRemoteAddressAsText()).byteLength, 0)
    cover('HttpResponse', 'getProxiedRemotePort')
    assert.equal(res.getProxiedRemotePort(), 0)
    cover('HttpResponse', 'getWriteOffset')
    assert.equal(res.getWriteOffset(), 0)

    res.onData((chunk, isLast) => {
      cover('HttpResponse', 'onData')
      assert.ok(chunk instanceof ArrayBuffer)
      assert.equal(typeof isLast, 'boolean')
      const previous = bodyResults.get('onData') || Buffer.alloc(0)
      const copy = Buffer.from(new Uint8Array(chunk))

      bodyResults.set('onData', Buffer.concat([previous, copy]))

      if (isLast) {
        res.end('contract')
      }
    })
  })

  app.post('/data-v2', (res) => {
    const chunks = []

    res.onDataV2((chunk, remaining) => {
      cover('HttpResponse', 'onDataV2')
      assert.ok(chunk instanceof ArrayBuffer)
      assert.equal(typeof remaining, 'bigint')
      chunks.push(Buffer.from(new Uint8Array(chunk)))

      if (remaining === 0n) {
        bodyResults.set('onDataV2', Buffer.concat(chunks))
        res.end('v2')
      }
    })
  })

  app.post('/collect', (res) => {
    res.collectBody(64, (body) => {
      cover('HttpResponse', 'collectBody')
      assert.ok(body instanceof ArrayBuffer)
      bodyResults.set('collect', Buffer.from(body))
      res.end('collect')
    })
  })

  app.post('/collect-overflow', (res) => {
    res.collectBody(4, (body) => {
      cover('HttpResponse', 'collectBody')
      assert.equal(body, null)
      res.end('overflow')
    })
  })

  app.get('/proxy', (res) => {
    assert.deepEqual([...new Uint8Array(res.getProxiedRemoteAddress())], [203, 0, 113, 10])
    assert.equal(Buffer.from(res.getProxiedRemoteAddressAsText()).toString(), '203.0.113.10')
    assert.equal(res.getProxiedRemotePort(), 41_234)
    assert.ok([4, 16].includes(res.getRemoteAddress().byteLength))
    res.end('proxy')
  })

  app.ws('/ws', {
    open(ws) {
      try {
        prototypes.WebSocket = prototypeReaders(ws)
        cover('WebSocket', 'getUserData')
        assert.equal(ws.getUserData(), ws)
        cover('WebSocket', 'getBufferedAmount')
        assert.equal(ws.getBufferedAmount(), 0)
        cover('WebSocket', 'getRemoteAddress')
        assert.ok([4, 16].includes(arrayBuffer(ws.getRemoteAddress()).byteLength))
        cover('WebSocket', 'getRemoteAddressAsText')
        assert.ok(arrayBuffer(ws.getRemoteAddressAsText()).byteLength > 0)
        cover('WebSocket', 'getRemotePort')
        assert.ok(ws.getRemotePort() > 0)
        cover('WebSocket', 'isSubscribed')
        assert.equal(ws.isSubscribed('contract'), false)
        cover('WebSocket', 'getTopics')
        assert.deepEqual(ws.getTopics(), [])
        assert.equal(ws.subscribe('contract'), true)
        assert.equal(ws.isSubscribed('contract'), true)
        assert.deepEqual([...ws.getTopics()].sort(), ['contract'])
        assert.equal(ws.unsubscribe('contract'), true)
        assert.equal(ws.isSubscribed('contract'), false)
        assert.deepEqual(ws.getTopics(), [])
        ws.send('ready')
      } catch (error) {
        callbackErrors.push(error)
      }
    },
    message(ws, message, isBinary) {
      try {
        assert.ok(message instanceof ArrayBuffer)
        assert.equal(typeof isBinary, 'boolean')
        ws.end(1000, 'done')
      } catch (error) {
        callbackErrors.push(error)
      }
    },
    subscription(ws, topic, newCount, oldCount) {
      try {
        assert.ok(topic instanceof ArrayBuffer)
        assert.equal(Buffer.from(topic).toString(), 'contract')
        assert.equal(typeof newCount, 'number')
        assert.equal(typeof oldCount, 'number')
        assert.equal(ws.getUserData(), ws)
        subscriptionSeen = true
      } catch (error) {
        callbackErrors.push(error)
      }
    },
    close(_ws, code, reason) {
      try {
        assert.equal(typeof code, 'number')
        assert.ok(reason instanceof ArrayBuffer)
        closeSeen = { code, reason: Buffer.from(reason).toString() }
      } catch (error) {
        callbackErrors.push(error)
      }
    }
  })

  const port = await getFreePort()

  await new Promise((resolve, reject) => {
    app.listen('127.0.0.1', port, (socket) => {
      if (!socket) {
        return reject(new Error('listen failed'))
      }

      assert.equal(us_socket_local_port(socket), port)
      resolve()
    })
  })

  try {
    const body = 'split-body'
    const contractResponse = await rawRequest(port, [
      `POST /contract/alice?one=1&empty=&encoded=a%20b HTTP/1.1\r\nHost: localhost\r\nX-Contract: Value\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
      'split-',
      'body'
    ])

    assert.match(contractResponse, /contract$/)
    assert.equal(bodyResults.get('onData').toString(), body)

    for (const [path, payload, expected] of [
      ['/data-v2', 'fragmented-v2', 'v2'],
      ['/collect', '', 'collect'],
      ['/collect-overflow', 'too-large', 'overflow']
    ]) {
      const response = await rawRequest(port, [
        `POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`,
        payload
      ])

      assert.match(response, new RegExp(`${expected}$`))
    }

    assert.equal(bodyResults.get('onDataV2').toString(), 'fragmented-v2')
    assert.equal(bodyResults.get('collect').byteLength, 0)

    const proxyResponse = await rawRequest(
      port,
      ['GET /proxy HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'],
      proxyV2Header(port)
    )

    assert.match(proxyResponse, /proxy$/)

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const message = await nextEvent(ws, 'message')

    assert.equal(message.data, 'ready')
    ws.send('close')
    await nextEvent(ws, 'close')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(subscriptionSeen, true)
    assert.deepEqual(closeSeen, { code: 1000, reason: 'done' })
    assert.deepEqual(callbackErrors, [])

    for (const [scope, methods] of Object.entries(READABLE_SURFACE)) {
      assert.deepEqual(prototypes[scope], [...methods].sort(), `${scope} readable prototype changed`)
    }

    assert.deepEqual(
      [...covered].sort(),
      Object.entries(READABLE_SURFACE)
        .flatMap(([scope, methods]) => methods.map((method) => `${scope}.${method}`))
        .sort(),
      'every manifest entry must execute a functional assertion'
    )
  } finally {
    app.close()
  }
})
