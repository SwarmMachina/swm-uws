import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'

const port = Number(process.argv[2])
const framing = process.argv[3]
const body = Buffer.alloc(Number(process.argv[4]))

for (let i = 0; i < body.length; i++) {
  body[i] = (i * 31) % 251
}

const digest = createHash('sha256').update(body).digest('hex')

if (framing === 'fixed-fin') {
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port })

    let response = ''

    socket.setEncoding('utf8')
    socket.setTimeout(10_000, () => socket.destroy(new Error('half-closed upload timed out')))
    socket.on('error', reject)
    socket.on('data', (chunk) => {
      response += chunk
    })
    socket.on('end', () => {
      try {
        assert.match(response, /^HTTP\/1\.1 200 /)
        assert.ok(response.endsWith(digest))
        resolve()
      } catch (error) {
        reject(error)
      }
    })
    socket.on('connect', () => {
      socket.write(
        `POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`
      )
      socket.end(body)
    })
  })
} else {
  await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/upload',
        method: 'POST',
        headers: framing === 'fixed' ? { 'content-length': body.length } : { 'transfer-encoding': 'chunked' }
      },
      (response) => {
        let text = ''

        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          text += chunk
        })
        response.on('error', reject)
        response.on('end', () => {
          try {
            assert.equal(response.statusCode, 200)
            assert.equal(text, digest)
            resolve()
          } catch (error) {
            reject(error)
          }
        })
      }
    )

    request.on('error', reject)
    request.setTimeout(10_000, () => request.destroy(new Error('upload timed out')))
    request.end(body)
  })
}
