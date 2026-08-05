import { us_listen_socket_close, us_socket_local_port } from '../../lib/index.js'

export class NativeAppServer {
  #app
  #closed = false
  #listenSocket
  #port

  constructor(app, listenSocket, port) {
    this.#app = app
    this.#listenSocket = listenSocket
    this.#port = port
  }

  static listen(app, { host = '127.0.0.1', port = 0 } = {}) {
    return new Promise((resolve, reject) => {
      app.listen(host, port, (socket) => {
        if (!socket) {
          reject(new Error(`listen failed on ${host}:${port}`))

          return
        }

        resolve(new NativeAppServer(app, socket, us_socket_local_port(socket)))
      })
    })
  }

  get port() {
    return this.#port
  }

  close() {
    if (this.#closed) {
      return
    }

    this.#closed = true
    us_listen_socket_close(this.#listenSocket)
    this.#listenSocket = undefined
    this.#app.close()
  }
}
