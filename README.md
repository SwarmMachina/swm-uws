# @swarmmachina/swm-uws

Non-TLS HTTP and WebSocket V8 binding compatible with the standard
uWebSockets.js `App()` API. Used by `swm-core`.

- uWebSockets.js: `20.69.0`
- [vendored revisions](https://github.com/SwarmMachina/swm-uws/blob/master/vendor/VERSIONS.md)
- [local patches](https://github.com/SwarmMachina/swm-uws/blob/master/vendor/PATCHES.md)
- [TypeScript API](lib/index.d.ts)

## Install

```sh
npm install @swarmmachina/swm-uws
```

## Example

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

Named imports are available:

```js
import { App, us_listen_socket_close } from '@swarmmachina/swm-uws'
```

Inline callbacks are typed by the IDE automatically. Use the identity helpers
when declaring them separately:

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

## Drop-in alias

Keep existing `uwebsockets.js` imports:

```sh
npm install uwebsockets.js@npm:@swarmmachina/swm-uws
```

```js
import uWS from 'uwebsockets.js'
// const uWS = require('uwebsockets.js')
```

Use an explicit package import when the application also needs unsupported
upstream features.

## Support

| Runtime | Support    |
| ------- | ---------- |
| Node.js | 22, 24     |
| Linux   | x64, glibc |
| Windows | x64        |
| macOS   | arm64, x64 |

Not supported:

- TLS / `SSLApp`
- `H3App`
- permessage-deflate and non-zero compression constants
- SNI
- Alpine/musl
- Windows ARM64
- upstream worker descriptors, declarative responses, KV and timer helpers

Terminate TLS before traffic reaches the application.

## Contracts

### Request lifetime

Request wrappers expire when the route or upgrade callback returns. Snapshot
data needed by asynchronous work:

```js
app.get('/users/:id', (res, req) => {
  const request = req.snapshot(1)
  let aborted = false

  res.onAborted(() => {
    aborted = true
  })

  setImmediate(() => {
    if (aborted) return
    console.log(request.params[0], request.headers['user-agent'])
    res.end('ok')
  })
})
```

`request.headers` has a null prototype:

```js
Object.hasOwn(request.headers, 'authorization')
request.headers.authorization
```

### Streaming data

`onData` and `onDataV2` receive zero-copy `ArrayBuffer`s. They are detached
after the callback:

```js
res.onData((chunk, isLast) => {
  const owned = Buffer.from(new Uint8Array(chunk))
  // keep `owned`, not `chunk`
})
```

Responses stay alive after a route callback only after registering `onData`,
`onDataV2`, `onWritable`, `collectBody`, or `onAborted`.

### Body collection

```js
const maxBodyBytes = 16 * 1024 * 1024

res.collectBody(maxBodyBytes, (body) => {
  if (body === null) {
    res.writeStatus('413 Payload Too Large')
    return res.end('request body too large', true)
  }

  res.end(Buffer.from(body))
})
```

```text
maxSize: integer bytes, 0..1 GiB, per request
native body memory ≈ concurrent collections × maxSize + overhead
```

Use application-level admission control for a global memory limit.

### Response framing

`Content-Length` and `Transfer-Encoding` are set by response methods:

```js
res.end('ok') // Content-Length: 2

res.beginWrite()
res.write('one')
res.end('two') // chunked
```

Manual framing headers are rejected:

```js
res.writeHeader('content-length', '2') // throws
res.writeHeader('transfer-encoding', 'chunked') // throws
res.endBatch('200 OK', ['content-length', '2'], 'ok') // throws
```

### Callback failures

If a callback throws, Node.js receives the original exception. The binding
stops the current request or socket sequence and invalidates the affected
wrapper.

Valid `onWritable` results remain distinct:

```js
const body = Buffer.from(largePayload)

res.onWritable((offset) => {
  const [ok, done] = res.tryEnd(body.subarray(offset), body.length)
  return ok || done
})
```

### WebSocket user data

For user data passed to `upgrade()`:

- own string and symbol descriptors are copied once;
- inherited properties are skipped;
- accessors are copied without invocation;
- binding methods such as `send` cannot be shadowed.

### Capabilities

```js
uWS.capabilities()
// {
//   beginWrite: true,
//   collectBody: true,
//   requestSnapshot: true,
//   responseBatch: true,
//   requestPause: true
// }
```

## Development

```sh
npm ci
npm run build:native
npm run check
npm test
npm run test:v8-http
npm run test:v8-snapshot-shapes
npm run test:v8-ws
npm run test:types
npm run test:package
npm run deps:check:vendor
```

```sh
# Full prepublish validation
npm run release:gate
```

## Linux release build

Portable generic x86-64 Clang 18 PGO+LTO:

```sh
# Requires clang-18, libclang-rt-18-dev and llvm-profdata-18
npm run build:native:pgo

# Build Node ABI 127 and 137 prebuilds with Docker
npm run build:prebuilds
```

```sh
# Optional training controls (defaults: variants=24, pipelining=1, duration=4s)
SWM_PGO_SNAPSHOT_VARIANTS=24 \
SWM_PGO_SNAPSHOT_PIPELINING=1 \
SWM_PGO_SNAPSHOT_DURATION=4 \
npm run build:native:pgo

# GET-only training
SWM_PGO_PROFILE=synthetic npm run build:native:pgo
```

Release CI runs PGO on native x86-64 hosts. The current portable balanced build
measured +13.95% paired median raw GET throughput over the pinned upstream
binary. See the
[`Linux PGO report`](https://github.com/SwarmMachina/swm-uws/blob/master/benchmark/profiles/pgo-balanced-linux/report.md).

## Profiling

```sh
npm run profile:http-raw:linux -- /tmp/http-raw-swm

# Optional
FLAMEGRAPH_DIR=/path/to/FlameGraph
SWM_PROFILE_SKIP_PERF=1

npm run bench:report
npm run bench:report:check
```

Defaults: concurrency 100, pipelining 10, 2-second warmup, 5-second measurement.

## Updating upstream

```sh
npm run deps:update:vendor -- v20.69.0
npm run deps:check:vendor
```

## License

[MPL-2.0](LICENSE) for first-party code.

Vendored licenses and notices:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Copyright Contributors to SwarmMachina.
