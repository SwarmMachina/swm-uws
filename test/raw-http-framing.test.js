import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import test from 'node:test'

import { createApp, us_listen_socket_close, us_socket_local_port } from '../lib/index.js'

test('raw HTTP framing remains unambiguous across fast paths and pipelining', { timeout: 15_000 }, async () => {
  const app = createApp()

  let listenSocket

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
  app.get('/collect-validation', (res) => {
    for (const value of [undefined, null, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2 ** 53, '4', new Number(4)]) {
      assert.throws(() => res.collectBody(value, () => {}), /expects a size|integer between/)
    }

    assert.throws(() => res.collectBody(1024 ** 3 + 1, () => {}), /integer between/)
    res.collectBody(1024 ** 3, (body) => {
      assert.equal(body.byteLength, 0)
      res.end('valid')
    })
  })
  try {
    const port = await new Promise((resolve, reject) => {
      app.listen('127.0.0.1', 0, (socket) => {
        if (!socket) {
          return reject(new Error('listen failed'))
        }

        listenSocket = socket
        resolve(us_socket_local_port(socket))
      })
    })

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
    if (listenSocket) {
      us_listen_socket_close(listenSocket)
    }

    app.close()
  }
})

function requestAndParse(port, chunks, expectedCount) {
  return rawExchange(port, chunks).then((wire) => {
    const parsed = parseResponses(wire)

    assert.equal(parsed.incomplete, false, wire.toString('latin1'))
    assert.equal(parsed.responses.length, expectedCount, wire.toString('latin1'))
    assert.equal(parsed.consumed, wire.length, wire.toString('latin1'))

    return parsed.responses
  })
}

function rawExchange(port, chunks) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const response = []

    socket.setTimeout(5_000, () => socket.destroy(new Error('raw exchange timed out')))
    socket.on('connect', () => {
      for (const chunk of chunks) {
        socket.write(chunk)
      }
    })
    socket.on('data', (chunk) => response.push(chunk))
    socket.on('end', () => resolve(Buffer.concat(response)))
    socket.on('error', reject)
  })
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
