import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import test from 'node:test'

import { createApp } from '../lib/index.js'
import { NativeAppServer } from './helpers/native-app-server.js'
import { rawHttpExchange } from './helpers/raw-http.js'

test('raw HTTP framing remains unambiguous across fast paths and pipelining', { timeout: 15_000 }, async () => {
  const app = createApp()

  let discardedBodyCallbacks = 0
  let discardedDeclaredLength

  app.get('/multi', (res) => {
    res.beginWrite()
    res.write('alpha')
    res.write('\r\n0\r\n\r\n')
    res.end('omega')
  })
  app.get('/begin-try', (res) => {
    res.beginWrite()
    assert.deepEqual(res.tryEnd('chunk', 5), [true, true])
  })
  app.get('/batch', (res) => {
    res.endBatch('201 Created', ['x-batch', 'yes'], 'batch')
  })
  app.get('/empty', (res) => res.end())
  app.get('/exact', (res) => {
    assert.deepEqual(res.tryEnd('exact', 5), [true, true])
  })
  app.get('/larger', (res) => {
    assert.throws(() => res.tryEnd('oversized', 4), /exceeds or conflicts/)
    res.end('rejected')
  })
  app.get('/conflict', (res) => {
    assert.throws(() => res.writeHeader('Content-Length', '4'), /manages Content-Length/)
    assert.throws(() => res.writeHeader('Transfer-Encoding', 'chunked'), /manages Content-Length/)
    assert.throws(() => res.endBatch('200 OK', ['content-length', '4'], 'body'), /manages Content-Length/)
    res.end('safe')
  })
  app.get('/one', (res) => res.end('one'))
  app.get('/two', (res) => res.end('two'))
  app.get('/partial', (res) => {
    res.onWritable(() => false)
    assert.deepEqual(res.tryEnd('short', 10), [true, false])
  })
  app.post('/collect-zero', (res) => {
    res.collectBody(0, (body) => {
      assert.equal(body.byteLength, 0)
      res.end('zero')
    })
  })
  app.post('/collect-exact', (res) => {
    res.collectBody(4, (body) => res.end(Buffer.from(body).toString()))
  })
  app.post('/collect-over', (res) => {
    res.collectBody(4, (body) => {
      assert.equal(body, null)
      res.end('limited')
    })
  })
  app.post('/collect-length', (res) => {
    const declaredLength = res.collectBodyWithLength(4, (body) => {
      res.end(`${declaredLength}:${body === null ? 'limited' : Buffer.from(body).toString()}`)
    })
  })
  app.post('/collect-discard', (res) => {
    let callbackCount = 0

    const declaredLength = res.collectBodyWithLength(4, () => callbackCount++)
    const discardResult = res.discardBody()

    assert.equal(discardResult, undefined)
    res.end(`${declaredLength}:${callbackCount}:${String(discardResult)}`)
  })
  app.post('/collect-discard-drain', (res) => {
    discardedDeclaredLength = res.collectBodyWithLength(64, () => discardedBodyCallbacks++)

    assert.ok(discardedDeclaredLength > 4)
    assert.equal(res.discardBody(), undefined)
    res.writeStatus('413 Payload Too Large').end('discarded')
  })
  app.get('/collect-validation', (res) => {
    const invalidSizes = [undefined, null, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2 ** 53, '4', new Number(4)]

    for (const value of invalidSizes) {
      assert.throws(() => res.collectBody(value, () => {}), /expects a size|integer between/)
      assert.throws(() => res.collectBodyWithLength(value, () => {}), /expects a size|integer between/)
    }

    assert.throws(() => res.collectBody(1024 ** 3 + 1, () => {}), /integer between/)
    assert.throws(() => res.collectBodyWithLength(1024 ** 3 + 1, () => {}), /integer between/)
    assert.throws(() => res.discardBody(1), /does not accept arguments/)
    res.collectBody(1024 ** 3, (body) => {
      assert.equal(body.byteLength, 0)
      res.end('valid')
    })
  })
  const server = await NativeAppServer.listen(app)

  try {
    const { port } = server

    for (const [path, status, body, framing] of [
      ['/multi', 200, 'alpha\r\n0\r\n\r\nomega', 'chunked'],
      ['/begin-try', 200, 'chunk', 'chunked'],
      ['/batch', 201, 'batch', 'content-length'],
      ['/empty', 200, '', 'content-length'],
      ['/exact', 200, 'exact', 'content-length'],
      ['/larger', 200, 'rejected', 'content-length'],
      ['/conflict', 200, 'safe', 'content-length']
    ]) {
      const responses = await requestAndParse(
        port,
        [`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`],
        1
      )

      assert.equal(responses[0].status, status)
      assert.equal(responses[0].headers.has('uwebsockets'), false)
      assert.equal(responses[0].body.toString(), body)
      assert.equal(responses[0].framing, framing)
    }

    const pipelined = await requestAndParse(
      port,
      [
        'GET /one HTTP/1.1\r\nHost: localhost\r\n\r\n' +
          'GET /two HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      ],
      2
    )

    assert.deepEqual(
      pipelined.map(({ status, body }) => [status, body.toString()]),
      [
        [200, 'one'],
        [200, 'two']
      ]
    )

    const partial = await rawExchange(port, [
      'GET /partial HTTP/1.1\r\nHost: localhost\r\n\r\n' +
        'GET /two HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    ])
    const parsedPartial = parseResponses(partial)

    assert.equal(parsedPartial.responses.length, 0)

    if (partial.length > 0) {
      assert.equal(parsedPartial.incomplete, true)
    }

    assert.ok(countOccurrences(partial, Buffer.from('HTTP/1.1 ')) <= 1)

    for (const [path, body, expected] of [
      ['/collect-zero', '', 'zero'],
      ['/collect-exact', 'four', 'four'],
      ['/collect-over', 'excess', 'limited']
    ]) {
      const responses = await requestAndParse(
        port,
        [
          `POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`
        ],
        1
      )

      assert.equal(responses[0].body.toString(), expected)
    }

    for (const [request, expected] of [
      [
        'POST /collect-length HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\nConnection: close\r\n\r\nfour',
        '4:four'
      ],
      [
        'POST /collect-length HTTP/1.1\r\nHost: localhost\r\nContent-Length: 6\r\nConnection: close\r\n\r\nexcess',
        '6:limited'
      ],
      [
        'POST /collect-length HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: ChUnKeD\r\nConnection: close\r\n\r\n4\r\nfour\r\n0\r\n\r\n',
        'undefined:four'
      ],
      ['POST /collect-length HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n', '0:'],
      ['POST /collect-length HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n', 'undefined:']
    ]) {
      const responses = await requestAndParse(port, [request], 1)

      assert.equal(responses[0].body.toString(), expected)
    }

    const discarded = await requestAndParse(
      port,
      ['POST /collect-discard HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\nConnection: close\r\n\r\nfour'],
      1
    )

    assert.equal(discarded[0].body.toString(), '4:0:undefined')

    const fragmented = await requestAndParse(
      port,
      [
        'POST /collect-length HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\nConnection: close\r\n\r\n',
        'f',
        'ou',
        'r'
      ],
      1,
      { yieldBetweenChunks: true }
    )

    assert.equal(fragmented[0].body.toString(), '4:four')

    const validBodyPipeline = await requestAndParse(
      port,
      [
        'POST /collect-length HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\n\r\nfour' +
          'GET /one HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      ],
      2
    )

    assert.deepEqual(
      validBodyPipeline.map(({ status, body }) => [status, body.toString()]),
      [
        [200, '4:four'],
        [200, 'one']
      ]
    )

    const discardedBodyPipeline = await requestAndParse(
      port,
      [
        'POST /collect-discard-drain HTTP/1.1\r\nHost: localhost\r\nContent-Length: 9\r\n\r\n',
        'over',
        'limit',
        'GET /one HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
      ],
      2,
      { yieldBetweenChunks: true }
    )

    assert.deepEqual(
      discardedBodyPipeline.map(({ status, body }) => [status, body.toString()]),
      [
        [413, 'discarded'],
        [200, 'one']
      ]
    )
    assert.equal(discardedDeclaredLength, 9)
    assert.equal(discardedBodyCallbacks, 0)

    const maximum = await requestAndParse(
      port,
      ['GET /collect-validation HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'],
      1
    )

    assert.equal(maximum[0].body.toString(), 'valid')

    const concurrent = await Promise.all([
      requestAndParse(
        port,
        ['POST /collect-exact HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\nConnection: close\r\n\r\nleft'],
        1
      ),
      requestAndParse(
        port,
        ['POST /collect-exact HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\nConnection: close\r\n\r\nrght'],
        1
      )
    ])

    assert.deepEqual(
      concurrent.map(([response]) => response.body.toString()),
      ['left', 'rght']
    )

    const next = await requestAndParse(port, ['GET /one HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'], 1)

    assert.equal(next[0].body.toString(), 'one')
  } finally {
    server.close()
  }
})

test(
  'length-aware collection aborts a truncated declared body without materializing it',
  { timeout: 5_000 },
  async () => {
    const app = createApp()
    const aborted = Promise.withResolvers()

    let declaredLength
    let callbackCount = 0

    app.post('/truncated', (res) => {
      declaredLength = res.collectBodyWithLength(64, () => callbackCount++)
      res.onAborted(() => aborted.resolve())
    })
    const server = await NativeAppServer.listen(app)

    try {
      const socket = createConnection({ host: '127.0.0.1', port: server.port })

      socket.on('error', () => {})
      await new Promise((resolve) => socket.once('connect', resolve))
      socket.write('POST /truncated HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\nshort')
      await new Promise((resolve) => setImmediate(resolve))
      socket.destroy()
      await aborted.promise

      assert.equal(declaredLength, 10)
      assert.equal(callbackCount, 0)
    } finally {
      server.close()
    }
  }
)

test('length-aware collection does not materialize an aborted chunked body', { timeout: 5_000 }, async () => {
  const app = createApp()
  const aborted = Promise.withResolvers()

  let declaredLength = null
  let callbackCount = 0

  app.post('/aborted', (res) => {
    declaredLength = res.collectBodyWithLength(64, () => callbackCount++)
    res.onAborted(() => aborted.resolve())
  })
  const server = await NativeAppServer.listen(app)

  try {
    const socket = createConnection({ host: '127.0.0.1', port: server.port })

    socket.on('error', () => {})
    await new Promise((resolve) => socket.once('connect', resolve))
    socket.write('POST /aborted HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nab')
    await new Promise((resolve) => setImmediate(resolve))
    socket.destroy()
    await aborted.promise

    assert.equal(declaredLength, undefined)
    assert.equal(callbackCount, 0)
  } finally {
    server.close()
  }
})

test('ambiguous request framing is rejected before any route handler runs', { timeout: 15_000 }, async () => {
  const app = createApp()

  let victimHandled = 0
  let smuggledHandled = 0

  app.post('/victim', (res) => {
    victimHandled++
    res.end('victim')
  })
  app.get('/smuggled', (res) => {
    smuggledHandled++
    res.end('smuggled')
  })
  const server = await NativeAppServer.listen(app)

  try {
    const smuggled = 'GET /smuggled HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'
    const invalidRequests = [
      [
        'conflicting Content-Length fields',
        'POST /victim HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\nContent-Length: 0\r\n\r\nfour' + smuggled
      ],
      [
        'identical Content-Length fields',
        'POST /victim HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n' + smuggled
      ],
      [
        'empty duplicate Content-Length fields',
        'POST /victim HTTP/1.1\r\nHost: localhost\r\nContent-Length:\r\nContent-Length:\r\n\r\n' + smuggled
      ],
      [
        'duplicate Transfer-Encoding fields',
        'POST /victim HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n' +
          smuggled
      ],
      [
        'empty duplicate Transfer-Encoding fields',
        'POST /victim HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding:\r\nTransfer-Encoding:\r\n\r\n' + smuggled
      ],
      [
        'identity Transfer-Encoding',
        'POST /victim HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: identity\r\n\r\n0\r\n\r\n' + smuggled
      ],
      [
        'gzip Transfer-Encoding',
        'POST /victim HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: gzip\r\n\r\n0\r\n\r\n' + smuggled
      ],
      [
        'gzip then chunked Transfer-Encoding',
        'POST /victim HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n' + smuggled
      ],
      [
        'repeated chunked transfer coding',
        'POST /victim HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked, chunked\r\n\r\n0\r\n\r\n' + smuggled
      ],
      ['empty Transfer-Encoding', 'POST /victim HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding:\r\n\r\n' + smuggled],
      ['empty Content-Length', 'POST /victim HTTP/1.1\r\nHost: localhost\r\nContent-Length:\r\n\r\n' + smuggled],
      [
        'signed positive Content-Length',
        'POST /victim HTTP/1.1\r\nHost: localhost\r\nContent-Length: +4\r\n\r\nfour' + smuggled
      ],
      ['negative Content-Length', 'POST /victim HTTP/1.1\r\nHost: localhost\r\nContent-Length: -1\r\n\r\n' + smuggled],
      [
        'suffixed Content-Length',
        'POST /victim HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4x\r\n\r\nfour' + smuggled
      ],
      [
        'comma-separated Content-Length',
        'POST /victim HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4, 4\r\n\r\nfour' + smuggled
      ],
      [
        'overflowing Content-Length',
        'POST /victim HTTP/1.1\r\nHost: localhost\r\nContent-Length: 9999999999999999999\r\n\r\n' + smuggled
      ],
      [
        'Content-Length above the largest safe JavaScript integer',
        'POST /victim HTTP/1.1\r\nHost: localhost\r\nContent-Length: 9007199254740992\r\n\r\n' + smuggled
      ],
      [
        'Content-Length plus Transfer-Encoding',
        'POST /victim HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n' +
          smuggled
      ]
    ]

    for (const [name, request] of invalidRequests) {
      const response = (await rawExchange(server.port, [request], { resolveOn: 'close' })).toString('latin1')

      assert.match(response, /^HTTP\/1\.1 400 Bad Request\r\n/, name)
      assert.equal(countOccurrences(Buffer.from(response, 'latin1'), Buffer.from('HTTP/1.1 ')), 1, name)
      assert.equal(victimHandled, 0, `${name}: victim handler ran`)
      assert.equal(smuggledHandled, 0, `${name}: smuggled handler ran`)
    }

    const valid = await requestAndParse(
      server.port,
      [
        'POST /victim HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding:\t ChUnKeD \t\r\nConnection: close\r\n\r\n0\r\n\r\n'
      ],
      1
    )

    assert.equal(valid[0].status, 200)
    assert.equal(valid[0].body.toString(), 'victim')
    assert.equal(victimHandled, 1)
    assert.equal(smuggledHandled, 0)
  } finally {
    server.close()
  }
})

test('server fingerprint is suppressed in headers and automatic parser errors', async () => {
  const app = createApp({ http: { maxHeaderSize: 96 } })
  const server = await NativeAppServer.listen(app)

  try {
    for (const [request, status] of [
      ['GET / HTTP/1.1\r\nHost localhost\r\nConnection: close\r\n\r\n', 400],
      [`GET / HTTP/1.1\r\nHost: localhost\r\nX-Long: ${'a'.repeat(96)}\r\nConnection: close\r\n\r\n`, 431],
      ['GET / HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n', 505]
    ]) {
      const response = (await rawExchange(server.port, [request])).toString('latin1')
      const [head, body] = response.split('\r\n\r\n')

      assert.match(head, new RegExp(`^HTTP/1\\.1 ${status} `))
      assert.doesNotMatch(head, /^uWebSockets:/im)
      assert.equal(body, '')
    }
  } finally {
    server.close()
  }
})

function requestAndParse(port, chunks, expectedCount, options) {
  return rawExchange(port, chunks, options).then((wire) => {
    const parsed = parseResponses(wire)

    assert.equal(parsed.incomplete, false, wire.toString('latin1'))
    assert.equal(parsed.responses.length, expectedCount, wire.toString('latin1'))
    assert.equal(parsed.consumed, wire.length, wire.toString('latin1'))

    return parsed.responses
  })
}

function rawExchange(port, chunks, options) {
  return rawHttpExchange({ host: '127.0.0.1', port }, chunks, options)
}

function parseResponses(wire) {
  const responses = []

  let offset = 0

  while (offset < wire.length) {
    const headerEnd = wire.indexOf('\r\n\r\n', offset, 'latin1')

    if (headerEnd === -1) {
      return { responses, consumed: offset, incomplete: true }
    }

    const lines = wire.subarray(offset, headerEnd).toString('latin1').split('\r\n')
    const statusMatch = /^HTTP\/1\.1 ([1-9][0-9]{2})(?: |$)/.exec(lines.shift())

    assert.ok(statusMatch, `invalid status line at ${offset}`)

    const headers = new Map()

    for (const line of lines) {
      const separator = line.indexOf(':')

      assert.ok(separator > 0, `invalid header: ${line}`)
      const name = line.slice(0, separator).toLowerCase()

      assert.equal(headers.has(name), false, `duplicate header: ${name}`)
      headers.set(name, line.slice(separator + 1).trim())
    }

    const hasLength = headers.has('content-length')
    const chunked = headers.get('transfer-encoding')?.toLowerCase() === 'chunked'

    assert.equal(hasLength && chunked, false, 'ambiguous Content-Length plus Transfer-Encoding')

    let cursor = headerEnd + 4
    let body
    let framing

    if (chunked) {
      framing = 'chunked'
      const chunks = []

      while (true) {
        const sizeEnd = wire.indexOf('\r\n', cursor, 'latin1')

        if (sizeEnd === -1) {
          return { responses, consumed: offset, incomplete: true }
        }

        const sizeText = wire.subarray(cursor, sizeEnd).toString('ascii')

        assert.match(sizeText, /^[0-9a-f]+$/i)
        const size = Number.parseInt(sizeText, 16)

        cursor = sizeEnd + 2

        if (wire.length < cursor + size + 2) {
          return { responses, consumed: offset, incomplete: true }
        }

        chunks.push(wire.subarray(cursor, cursor + size))
        cursor += size
        assert.equal(wire.subarray(cursor, cursor + 2).toString('latin1'), '\r\n')
        cursor += 2

        if (size === 0) {
          break
        }
      }

      body = Buffer.concat(chunks.slice(0, -1))
    } else if (hasLength) {
      framing = 'content-length'
      const length = Number(headers.get('content-length'))

      assert.ok(Number.isSafeInteger(length) && length >= 0)

      if (wire.length < cursor + length) {
        return { responses, consumed: offset, incomplete: true }
      }

      body = wire.subarray(cursor, cursor + length)
      cursor += length
    } else {
      throw new Error('response has no unambiguous framing')
    }

    responses.push({ status: Number(statusMatch[1]), headers, body, framing })
    offset = cursor
  }

  return { responses, consumed: offset, incomplete: false }
}

function countOccurrences(haystack, needle) {
  let count = 0
  let offset = 0

  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    count++
    offset += needle.length
  }

  return count
}
