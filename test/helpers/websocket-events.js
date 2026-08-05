export function nextWebSocketMessage(socket, message = 'WebSocket message failed') {
  return nextWebSocketEvent(socket, 'message', message).then((event) => event.data)
}

export function nextWebSocketOpen(socket, message = 'WebSocket open failed') {
  return nextWebSocketEvent(socket, 'open', message)
}

export function nextWebSocketClose(socket) {
  return new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }))
}

export function nextWebSocketEvent(socket, name, errorMessage) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener(name, onEvent)
      socket.removeEventListener('error', onError)
    }
    const onEvent = (event) => {
      cleanup()
      resolve(event)
    }
    const onError = () => {
      cleanup()
      reject(new Error(errorMessage || `WebSocket ${name} failed`))
    }

    socket.addEventListener(name, onEvent, { once: true })
    socket.addEventListener('error', onError, { once: true })
  })
}
