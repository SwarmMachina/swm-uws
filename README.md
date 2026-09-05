# @swarmmachina/swm-uws

[![CI](https://github.com/SwarmMachina/swm-uws/actions/workflows/quality.yml/badge.svg)](https://github.com/SwarmMachina/swm-uws/actions/workflows/quality.yml)
[![License: MPL 2.0](https://img.shields.io/badge/License-MPL%202.0-brightgreen.svg)](https://opensource.org/licenses/MPL-2.0)
[![Node.js](https://img.shields.io/badge/node-22%20%7C%2024-brightgreen.svg)](https://nodejs.org/)
[![runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-brightgreen.svg)](#runtime-requirements)
[![stability](https://img.shields.io/badge/stability-experimental-orange.svg)](#stability)

A high-performance non-TLS HTTP and WebSocket binding compatible with the
standard uWebSockets.js `App()` API. Used by
[`@swarmmachina/swm-core`](https://www.npmjs.com/package/@swarmmachina/swm-core).

The binding tracks uWebSockets.js `20.69.0`. See the
[vendored revisions](https://github.com/SwarmMachina/swm-uws/blob/master/vendor/VERSIONS.md),
[local patches](https://github.com/SwarmMachina/swm-uws/blob/master/vendor/PATCHES.md),
and [TypeScript API](lib/index.d.ts).

## Features

- **uWebSockets.js compatibility** - Non-TLS `App()` API for existing applications.
- **Native HTTP + WebSocket transport** - Both protocols on Node.js 22 and 24.
- **TypeScript declarations** - Typed APIs and helpers for standalone callbacks.
- **Request-body control** - Zero-copy streaming, bounded collection, pause and resume.
- **HTTP transport policy** - Per-`App` parser limits, timeouts, trusted proxy support, and counters.
- **Optimized extensions** - Header prefetch, batched responses, and capability detection.
- **Zero runtime dependencies** - Platform-specific native prebuilds are included.

## Installation

```bash
pnpm add @swarmmachina/swm-uws
```

### Runtime requirements

The binding ships platform-specific native prebuilds:

- **Node.js 22 or 24** - Other majors are rejected by the package engine constraint.
- **Linux x64 with glibc** - Use a `bookworm`/`slim` image rather than Alpine/musl.
- **Windows x64** and **macOS arm64/x64** are supported.
- **Linux ARM64, Windows ARM64 and musl are not supported.**
- **TLS, `SSLApp`, `H3App`, and WebSocket compression are disabled.** Terminate TLS
  before the application.

## Quick Start

### Basic HTTP and WebSocket Server

```js
import uWS from '@swarmmachina/swm-uws'

const app = uWS.App()

app.get('/', (res) => {
  res.writeHeader('content-type', 'application/json')
  res.end('{"ok":true}')
})

app.ws('/ws', {
  message(ws, message, isBinary) {
    ws.send(message, isBinary)
  }
})

let listenSocket

app.listen(3000, (socket) => {
  if (!socket) throw new Error('listen failed')
  listenSocket = socket
  console.log('listening on http://127.0.0.1:3000')
})

process.on('SIGTERM', () => {
  if (listenSocket) uWS.us_listen_socket_close(listenSocket)
  app.close()
})
```

Named imports are also available:

```js
import { App, us_listen_socket_close } from '@swarmmachina/swm-uws'
```

### Standalone callback types

Inline route and WebSocket callbacks are inferred automatically. Wrap a
separately declared callback with an identity helper to retain its contextual
type:

```js
import { defineHttpHandler, defineWebSocketBehavior } from '@swarmmachina/swm-uws'

const handler = defineHttpHandler((res, req) => {
  res.end(req.getUrl())
})

const behavior = defineWebSocketBehavior({
  message(ws, message, isBinary) {
    ws.send(message, isBinary)
  }
})
```

## Drop-in compatibility

Keep existing `uwebsockets.js` imports with an npm alias:

```sh
pnpm add uwebsockets.js@npm:@swarmmachina/swm-uws
```

```js
import uWS from 'uwebsockets.js'
// const uWS = require('uwebsockets.js')
```

Use the explicit `@swarmmachina/swm-uws` import when the application also
depends on unsupported upstream features.

## API Documentation

The [TypeScript declarations](lib/index.d.ts) are the complete API reference.
The sections below cover the binding-specific contracts.

### `App(options)`

`App()` creates a non-TLS application. Route methods (`get`, `post`, `put`,
`patch`, `del`, `options`, `head`, `connect`, `trace`, and `any`) return the
same application instance. `app.close()` idempotently closes its listeners and
connections. Native contexts and registered handlers are released after active
callbacks return. Transport counters remain readable on the closed instance.

In `app.filter()` callbacks with a negative `count`, the connection is
already closing. Only remote-address and remote-port accessors are available on
`res`; response mutation and callback registration throw.

Configure HTTP parser and lifecycle limits per application:

```js
const app = uWS.App({
  http: {
    maxHeaderSize: 16 * 1024,
    maxHeaderCount: 100,
    headersTimeoutMs: 10_000,
    keepAliveTimeoutMs: 5_000,
    bodyIdleTimeoutMs: 10_000,
    minBodyRateBytesPerSec: 16 * 1024,
    responseWriteTimeoutMs: 10_000
  }
})
```

Header-limit failures return `431` before an HTTP or WebSocket handler runs.
`maxHeaderSize` is capped at `64 MiB` so configuration cannot bypass the
binding's native inbound-memory ceiling.
Read inexpensive per-application counters with `app.getHttpTransportStats()`:

```js
const stats = app.getHttpTransportStats()
console.log(stats.headerTooLarge, stats.bodyRateViolations, stats.activeConnections)
```

### Trusted proxies

`trustedProxy` is disabled by default. Enable it only for a listener that is
unreachable except through proxies that overwrite or sanitize the selected
header:

```js
const app = uWS.App({
  http: { trustedProxy: { header: 'x-real-ip' } }
})
```

Use `x-forwarded-for` with an exact `hops` count for a fixed proxy chain. The
selected address is available through `getProxiedRemoteAddress()` and
`getProxiedRemoteAddressAsText()`; `getProxiedRemotePort()` is `0` for a
selected header. If the configured header is absent, these methods fall back to
the upstream peer address and port.

### Requests and responses

`HttpRequest` is valid only while its route or upgrade callback is running.
Values returned by individual getters are owned JavaScript values and may be
retained after the callback returns.

| Request API                                    | Description                                     |
| ---------------------------------------------- | ----------------------------------------------- |
| `getMethod()`, `getUrl()`, `getQuery()`        | Request method, path, and query string.         |
| `getHeader(name)`, `getParameter(indexOrName)` | Header and route parameter lookup.              |
| `forEach(handler)`                             | Visits request headers.                         |
| `prefetch(plan)`                               | Copies selected headers into an owned snapshot. |

`HttpResponse` is invalid after `end`, a completing `tryEnd`, `close`, or
`upgrade`. The binding owns `Content-Length` and `Transfer-Encoding`; setting
either header manually throws.

```js
app.get('/stream', (res) => {
  res.beginWrite()
  res.write('one')
  res.end('two')
})
```

Register `onWritable` before continuing a response after backpressure. A
response may outlive a route callback only after registering `onData`,
`onDataV2`, `onWritable`, `collectBody`, `collectBodyWithLength`, `discardBody`,
or `onAborted`.

### Request bodies

`onData` and `onDataV2` receive zero-copy `ArrayBuffer` chunks. Copy a chunk
synchronously before retaining it.

Use `collectBody` to receive one owned `ArrayBuffer` with a per-request limit:

```js
const maxBodyBytes = 16 * 1024 * 1024

app.post('/echo', (res) => {
  res.collectBody(maxBodyBytes, (body) => {
    if (body === null) {
      res.writeStatus('413 Payload Too Large').end()
      return
    }

    res.end(Buffer.from(body))
  })
})
```

`maxSize` is an integer between `0` and `64 MiB` and bounds one request only.
Use application-level admission control for a process-wide memory budget.
`collectBodyWithLength` additionally returns the explicit `Content-Length`
before body delivery; it returns `undefined` for chunked or absent lengths.
Exceeding the limit releases accumulated bytes before delivering `null`.
`res.discardBody()` releases collected bytes immediately and suppresses further
body callbacks while the transport drains the rest of the request.

### Selected request headers

Compile a selection once when asynchronous work needs request headers after
the route callback has returned:

```js
const plan = new uWS.RequestPrefetchPlan({
  headers: ['authorization', 'traceparent']
})

app.get('/*', (res, req) => {
  const headers = req.prefetch(plan)
  res.onAborted(() => {})

  setImmediate(() => {
    res.end(headers.getHeader('authorization') ?? '')
  })
})
```

Snapshots preserve duplicate wire order. `getHeaderValues()` returns all
values, `getHeaders()` returns a null-prototype last-value-wins record, and
`getHeaderEntries()` returns all retained pairs in wire order.

### WebSockets

`app.ws(path, behavior)` accepts the standard uWebSockets.js lifecycle
callbacks: `upgrade`, `open`, `message`, `dropped`, `drain`, `ping`, `pong`,
`subscription`, and `close`. WebSocket message and control-frame buffers are
transport-owned; copy them before retaining them.

Adding an `upgrade` callback makes the application responsible for validating
the complete WebSocket handshake before it calls `res.upgrade()`.

The non-TLS binding supports `DISABLED` (`0`) as its only compression option.
Use `maxPayloadLength`, `idleTimeout`, `maxBackpressure`,
`closeOnBackpressureLimit`, and `maxLifetime` to set per-route limits.

### Binding extensions

Check optional binding extensions before depending on them across compatible
uWebSockets.js implementations:

```js
const native = uWS.capabilities()

if (!native.httpTransportConfig || !native.requestPrefetch) {
  throw new Error('required native extensions are unavailable')
}
```

| Capability            | API                                                               |
| --------------------- | ----------------------------------------------------------------- |
| `beginWrite`          | `res.beginWrite()` selects explicit streaming.                    |
| `collectBody`         | `res.collectBody(maxBytes, callback)` retains one complete body.  |
| `collectBodyLength`   | `res.collectBodyWithLength()` exposes the declared body length.   |
| `httpTransportConfig` | `App({ http })` applies parser and lifecycle policy.              |
| `preparedHeaders`     | `PreparedHeaderBlock` owns a reusable validated response block.   |
| `requestPrefetch`     | `req.prefetch(plan)` copies selected headers.                     |
| `responseBatch`       | `res.endBatch(status, headers, body)` writes a prepared response. |
| `requestPause`        | `res.pause()` and `res.resume()` control body delivery.           |

`res.pause()` stops further socket reads; callbacks can still consume data
already present in the current parser buffer. Call `res.resume()` when the
consumer is ready. Version 0.7.3 fixes continued full-buffer reads after pause;
code that pauses without resuming can no longer rely on those unintended reads.

## Examples

Each example below is a separate server fragment. Start its application with
the `listen()` call from Quick Start.

### JSON route with parameters

Use named route parameters and `cork()` to prepare a small JSON response in
one native write:

```js
import uWS from '@swarmmachina/swm-uws'

const app = uWS.App()

app.get('/users/:id', (res, req) => {
  const body = JSON.stringify({
    id: req.getParameter('id'),
    verbose: req.getQuery('verbose') === 'true'
  })

  res.cork(() => {
    res.writeStatus('200 OK')
    res.writeHeader('content-type', 'application/json')
    res.end(body)
  })
})
```

### Streaming an upload

`onData` delivers transport-owned chunks. Consume or copy each chunk before
the callback returns:

```js
import { createHash } from 'node:crypto'
import uWS from '@swarmmachina/swm-uws'

const app = uWS.App()

app.post('/upload', (res) => {
  const hash = createHash('sha256')
  let aborted = false

  res.onAborted(() => {
    aborted = true
  })

  res.onData((chunk, isLast) => {
    hash.update(new Uint8Array(chunk))

    if (isLast && !aborted) {
      res.writeHeader('content-type', 'application/json')
      res.end(JSON.stringify({ sha256: hash.digest('hex') }))
    }
  })
})
```

### Download with backpressure

When the socket is full, resume a known-length response from the offset passed
to `onWritable`:

```js
import { readFile } from 'node:fs/promises'
import uWS from '@swarmmachina/swm-uws'

const app = uWS.App()
const body = await readFile(new URL('./report.csv', import.meta.url))

app.get('/report.csv', (res) => {
  let aborted = false

  res.onAborted(() => {
    aborted = true
  })

  const write = (offset) => {
    if (aborted) return true

    const [ok, done] = res.tryEnd(body.subarray(offset), body.length)
    return ok || done
  }

  res.writeHeader('content-type', 'text/csv')
  res.onWritable(write)
  write(0)
})
```

### Prepared batch response

Use `endBatch()` when status and headers are already available as flat
name/value pairs:

```js
import uWS from '@swarmmachina/swm-uws'

const app = uWS.App()

const jsonHeaders = ['content-type', 'application/json', 'cache-control', 'no-store']

app.get('/health', (res) => {
  res.endBatch('200 OK', jsonHeaders, '{"ok":true}')
})
```

`Content-Length` and `Transfer-Encoding` remain managed by the binding and
must not be included in `jsonHeaders`.

When the same complete header set is reused across responses, compile it once
into native-owned bytes and use `endPrepared()`:

```js
const preparedJsonHeaders = new uWS.PreparedHeaderBlock(jsonHeaders)

app.get('/ready', (res) => {
  res.endPrepared('200 OK', preparedJsonHeaders, '{"ready":true}')
})
```

The constructor copies and validates at most 64 pairs and 64 KiB of UTF-8
payload. Keep dynamic request IDs and per-response cookies on `writeHeader()`;
they do not belong in a reusable prepared block.

### WebSocket topics

Subscribe each connection to a chat topic and broadcast text messages to it:

```js
import uWS from '@swarmmachina/swm-uws'

const app = uWS.App()

app.ws('/chat', {
  maxPayloadLength: 1024 * 1024,
  idleTimeout: 60,

  open(ws) {
    ws.subscribe('chat')
    ws.send(JSON.stringify({ type: 'welcome' }))
  },

  message(_ws, message, isBinary) {
    if (!isBinary) app.publish('chat', message, false)
  }
})
```

## Testing

```bash
npm test
```

## Stability

The package is currently experimental. Public APIs and runtime behavior may
change before a stable release; changes should be documented and covered by
tests.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

Licensed under the MPL-2.0 License.

Copyright Contributors to SwarmMachina.

See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
