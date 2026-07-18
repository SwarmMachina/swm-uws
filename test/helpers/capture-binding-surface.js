import assert from 'node:assert/strict'

function prototypeMethods(value) {
  return Object.getOwnPropertyNames(Object.getPrototypeOf(value))
    .filter((name) => name !== 'constructor')
    .sort()
}

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timeout = setTimeout(() => {
      socket.close()
      reject(new Error(`WebSocket surface probe timed out: ${url}`))
    }, 5_000)

    socket.addEventListener(
      'close',
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true }
    )
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timeout)
        reject(new Error(`WebSocket surface probe failed: ${url}`))
      },
      { once: true }
    )
  })
}

export async function captureBindingSurface(bindingModule) {
  const binding = bindingModule.default ?? bindingModule
  const app = binding.App()
  const surface = {
    module: Object.keys(binding).sort(),
    app: prototypeMethods(app),
    request: undefined,
    response: undefined,
    websocket: undefined
  }

  app.get('/__swm_surface_http', (res, req) => {
    surface.request = prototypeMethods(req)
    surface.response = prototypeMethods(res)
    res.end('ok')
  })

  app.ws('/__swm_surface_ws', {
    open(ws) {
      surface.websocket = prototypeMethods(ws)
      ws.end(1000, 'surface captured')
    }
  })

  let port

  await new Promise((resolve, reject) => {
    app.listen('127.0.0.1', 0, (socket) => {
      if (!socket) {
        reject(new Error('Binding surface probe failed to listen'))

        return
      }

      port = binding.us_socket_local_port(socket)
      resolve()
    })
  })

  try {
    const response = await fetch(`http://127.0.0.1:${port}/__swm_surface_http`, {
      signal: AbortSignal.timeout(5_000)
    })

    assert.equal(await response.text(), 'ok')
    await openWebSocket(`ws://127.0.0.1:${port}/__swm_surface_ws`)

    assert.ok(surface.request, 'HttpRequest surface was not captured')
    assert.ok(surface.response, 'HttpResponse surface was not captured')
    assert.ok(surface.websocket, 'WebSocket surface was not captured')

    return surface
  } finally {
    app.close()
  }
}

export function bindingSurfaceDelta(reference, candidate) {
  return Object.fromEntries(
    Object.keys(reference).map((scope) => {
      const referenceNames = new Set(reference[scope])
      const candidateNames = new Set(candidate[scope])

      return [
        scope,
        {
          missing: reference[scope].filter((name) => !candidateNames.has(name)),
          extra: candidate[scope].filter((name) => !referenceNames.has(name))
        }
      ]
    })
  )
}
