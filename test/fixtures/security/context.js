import { createConnection } from 'node:net'

import { createApp, us_listen_socket_close, us_socket_local_port } from '../../../lib/index.js'
import { rawHttpExchange } from '../../helpers/raw-http.js'

export class SecurityFixtureContext {
  #app = createApp()
  #listenSocket

  get app() {
    return this.#app
  }

  get listenSocket() {
    return this.#listenSocket
  }

  captureUncaught(message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`uncaught exception was not observed: ${message}`))
      }, 5_000)
      const onUncaught = (error) => {
        cleanup()

        if (error.message !== message) {
          reject(error)

          return
        }

        resolve(error)
      }
      const cleanup = () => {
        clearTimeout(timer)
        process.off('uncaughtException', onUncaught)
      }

      process.once('uncaughtException', onUncaught)
    })
  }

  event(target, name) {
    return new Promise((resolve, reject) => {
      target.addEventListener(name, resolve, { once: true })

      if (name !== 'close') {
        target.addEventListener('error', () => reject(new Error(`WebSocket ${name} failed`)), { once: true })
      }
    })
  }

  async listen() {
    return new Promise((resolve, reject) => {
      this.#app.listen('127.0.0.1', 0, (socket) => {
        if (!socket) {
          reject(new Error('listen failed'))

          return
        }

        this.#listenSocket = socket
        resolve(us_socket_local_port(socket))
      })
    })
  }

  async rawRequest(port, chunks) {
    const response = await rawHttpExchange({ host: '127.0.0.1', port }, chunks, {
      resolveOn: 'close',
      yieldBetweenChunks: true,
      timeoutMessage: 'raw request'
    })

    return response.toString()
  }

  async assertNextRequestWorks(port) {
    const response = await this.rawRequest(port, ['GET /ok HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'])

    if (!/^HTTP\/1\.1 200/m.test(response) || !/ok$/.test(response)) {
      throw new Error(`expected a healthy follow-up request, got:\n${response}`)
    }
  }

  createSocket(port, onConnect) {
    const socket = createConnection({ host: '127.0.0.1', port }, onConnect)

    socket.on('error', () => {})

    return socket
  }

  closeApp() {
    this.#app.close()
    this.#listenSocket = undefined
  }

  close() {
    if (this.#listenSocket) {
      us_listen_socket_close(this.#listenSocket)
    }

    this.#app.close()
  }
}
