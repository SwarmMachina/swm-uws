import assert from 'node:assert/strict'
import test from 'node:test'

import { createApp } from '../lib/index.js'
import { NativeAppServer } from './helpers/native-app-server.js'
import { rawHttpExchange } from './helpers/raw-http.js'

const chunkedRequestHead = Buffer.from(
  'POST /chunked HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n',
  'latin1'
)
const pipelinedRequest = Buffer.from('GET /next HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n', 'latin1')

test(
  'strict chunked framing accepts RFC 9112 extensions and trailers across every byte boundary',
  { timeout: 30_000 },
  async () => {
    const requests = []

    let nextHandled = 0

    const app = createApp()

    app.post('/chunked', (res) => {
      const request = { body: [], completed: false }

      requests.push(request)
      res.onData((chunk, isLast) => {
        request.body.push(Buffer.from(new Uint8Array(chunk)))

        if (isLast) {
          request.completed = true
          res.end(Buffer.concat(request.body))
        }
      })
      res.onAborted(() => {})
    })
    app.get('/next', (res) => {
      nextHandled++
      res.end('next')
    })

    const server = await NativeAppServer.listen(app)

    try {
      const framing = Buffer.concat([
        Buffer.from('4; foo = "quoted\\\\value";flag\r\nWiki\r\n', 'latin1'),
        Buffer.from('5;token=value\r\npedia\r\n', 'latin1'),
        Buffer.from('0;done="yes"\r\nX-Checksum: ok\t \r\nX-Empty:\r\n\r\n', 'latin1')
      ])

      for (let split = 1; split < framing.length; split++) {
        const response = await rawExchange(
          server.port,
          [framing.subarray(0, split), framing.subarray(split), pipelinedRequest],
          { prefix: chunkedRequestHead, yieldBetweenChunks: true }
        )

        assert.equal(countOccurrences(response, Buffer.from('HTTP/1.1 200 OK\r\n')), 2, `split ${split}`)
        assert.equal(requests.at(-1).completed, true, `split ${split}`)
        assert.equal(Buffer.concat(requests.at(-1).body).toString('latin1'), 'Wikipedia', `split ${split}`)
      }

      const oneByteRequest = Buffer.concat([chunkedRequestHead, framing, pipelinedRequest])
      const oneByteResponse = await rawExchange(
        server.port,
        Array.from(oneByteRequest, (_byte, index) => oneByteRequest.subarray(index, index + 1)),
        { yieldBetweenChunks: true }
      )

      assert.equal(countOccurrences(oneByteResponse, Buffer.from('HTTP/1.1 200 OK\r\n')), 2)
      assert.equal(requests.at(-1).completed, true)
      assert.equal(Buffer.concat(requests.at(-1).body).toString('latin1'), 'Wikipedia')
      assert.equal(nextHandled, framing.length)
    } finally {
      server.close()
    }
  }
)

test(
  'malformed chunked framing returns one 400, closes, and never dispatches a pipeline',
  { timeout: 30_000 },
  async () => {
    const requests = []

    let nextHandled = 0

    const app = createApp()

    app.post('/chunked', (res) => {
      const request = { body: [], completed: false }

      requests.push(request)
      res.onData((chunk, isLast) => {
        request.body.push(Buffer.from(new Uint8Array(chunk)))

        if (isLast) {
          request.completed = true
          res.end('unexpected completion')
        }
      })
      res.onAborted(() => {})
    })
    app.get('/next', (res) => {
      nextHandled++
      res.end('smuggled')
    })

    const server = await NativeAppServer.listen(app)

    try {
      const malformedCases = [
        ['empty chunk size', Buffer.from('\r\n', 'latin1'), ''],
        ['non-hex chunk size', Buffer.from('g\r\n', 'latin1'), ''],
        ['punctuation in chunk size', Buffer.from(':\r\n', 'latin1'), ''],
        ['bare LF after chunk size', Buffer.from('1\na\r\n0\r\n\r\n', 'latin1'), ''],
        ['non-LF after chunk-size CR', Buffer.from('1\rXa\r\n0\r\n\r\n', 'latin1'), ''],
        ['bare LF after chunk data', Buffer.from('1\r\na\n0\r\n\r\n', 'latin1'), 'a'],
        ['non-LF after chunk-data CR', Buffer.from('1\r\na\rX0\r\n\r\n', 'latin1'), 'a'],
        ['empty extension name', Buffer.from('1;\r\na\r\n0\r\n\r\n', 'latin1'), ''],
        ['invalid extension name', Buffer.from('1;bad/name\r\na\r\n0\r\n\r\n', 'latin1'), ''],
        ['missing extension value', Buffer.from('1;name=\r\na\r\n0\r\n\r\n', 'latin1'), ''],
        ['unterminated quoted extension', Buffer.from('1;name="open\r\na\r\n0\r\n\r\n', 'latin1'), ''],
        ['invalid quoted pair', Buffer.from('1;name="bad\\\r\na\r\n0\r\n\r\n', 'latin1'), ''],
        ['overflowing chunk size', Buffer.from('1000000000000000\r\n', 'latin1'), ''],
        ['trailer without colon', Buffer.from('0\r\nBad-Trailer\r\n\r\n', 'latin1'), ''],
        ['folded trailer line', Buffer.from('0\r\n Folded: value\r\n\r\n', 'latin1'), ''],
        ['bare LF in trailer', Buffer.from('0\r\nX-Test: value\n\r\n', 'latin1'), ''],
        [
          'NUL in trailer',
          Buffer.concat([Buffer.from('0\r\nX-Test: a', 'latin1'), Buffer.from([0]), Buffer.from('b\r\n\r\n')]),
          ''
        ],
        ['bare LF after last chunk', Buffer.from('0\r\n\n', 'latin1'), '']
      ]

      for (let byte = 0; byte <= 0xff; byte++) {
        if (!isAsciiHexByte(byte)) {
          malformedCases.push([
            `non-hex size byte 0x${byte.toString(16).padStart(2, '0')}`,
            Buffer.from([byte, 0x0d, 0x0a]),
            ''
          ])
        }
      }

      for (const [name, framing, expectedBody] of malformedCases) {
        const request = Buffer.concat([chunkedRequestHead, framing, pipelinedRequest])
        const response = await rawExchange(server.port, [request], {
          acceptResetAfterData: true,
          resolveOn: 'close'
        })
        const handled = requests.at(-1)

        assert.match(response.toString('latin1'), /^HTTP\/1\.1 400 Bad Request\r\n/, name)
        assert.equal(countOccurrences(response, Buffer.from('HTTP/1.1 ')), 1, name)
        assert.equal(handled.completed, false, name)
        assert.equal(Buffer.concat(handled.body).toString('latin1'), expectedBody, name)
        assert.equal(nextHandled, 0, name)
      }

      for (const [name, framing, expectedBody] of [
        ['fragmented chunk-data CRLF', Buffer.from('1\r\na\rX', 'latin1'), 'a'],
        ['fragmented quoted extension', Buffer.from('1;name="open\r', 'latin1'), ''],
        ['fragmented trailer line', Buffer.from('0\r\nX-Test: value\n', 'latin1'), '']
      ]) {
        for (let split = 1; split < framing.length; split++) {
          const response = await rawExchange(
            server.port,
            [framing.subarray(0, split), framing.subarray(split), pipelinedRequest],
            {
              acceptResetAfterData: true,
              prefix: chunkedRequestHead,
              resolveOn: 'close',
              yieldBetweenChunks: true
            }
          )
          const handled = requests.at(-1)
          const label = `${name}, split ${split}`

          assert.match(response.toString('latin1'), /^HTTP\/1\.1 400 Bad Request\r\n/, label)
          assert.equal(countOccurrences(response, Buffer.from('HTTP/1.1 ')), 1, label)
          assert.equal(handled.completed, false, label)
          assert.equal(Buffer.concat(handled.body).toString('latin1'), expectedBody, label)
          assert.equal(nextHandled, 0, label)
        }
      }
    } finally {
      server.close()
    }
  }
)

function rawExchange(port, chunks, options) {
  return rawHttpExchange({ host: '127.0.0.1', port }, chunks, options)
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

function isAsciiHexByte(byte) {
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66)
}
