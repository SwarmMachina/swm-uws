# @swarmmachina/swm-uws

Raw V8 binding compatible with the ordinary non-TLS HTTP and WebSocket surface
of uWebSockets.js. It is also the native binding used by `swm-core`. Sources are
pinned to uWebSockets.js 20.69.0 and vendored in this repository.

## Runtime

- Node.js 22 and 24
- Linux x64 with glibc
- Windows x64
- macOS arm64 and x64

Alpine/musl and Windows ARM64 are not supported. TLS and permessage-deflate are
disabled; terminate TLS before the application.

## Usage

```sh
npm install @swarmmachina/swm-uws
```

```js
import uWS from '@swarmmachina/swm-uws'

const app = uWS.App()

app.get('/', (res) => {
  res.writeHeader('content-type', 'application/json').end('{"ok":true}')
})

app.ws('/ws', {
  message(ws, message, isBinary) {
    ws.send(message, isBinary)
  }
})

let listenSocket
app.listen(3000, (socket) => {
  if (!socket) process.exit(1)
  listenSocket = socket
})

process.on('SIGTERM', () => {
  uWS.us_listen_socket_close(listenSocket)
  app.close()
})
```

For an explicit switch, change only the module specifier:

```js
import uWS from 'uwebsockets.js'
// import uWS from '@swarmmachina/swm-uws'
```

To keep application source unchanged, install this package under the original
dependency name with an npm alias:

```sh
npm install uwebsockets.js@npm:@swarmmachina/swm-uws
```

Existing default-import and CommonJS code then continues to resolve
`uwebsockets.js`:

```js
import uWS from 'uwebsockets.js'
// or: const uWS = require('uwebsockets.js')
```

Named imports remain available when preferred:

```js
import { App, us_listen_socket_close } from '@swarmmachina/swm-uws'
```

The complete surface is declared in [`lib/index.d.ts`](lib/index.d.ts).

The compatibility target is the plain `App()` HTTP/WebSocket API: routing,
listen options and Unix sockets, request/response streaming and lifetime,
remote and PROXY protocol addresses, pub/sub, corking, ping, and fragmented
WebSocket sends. `SSLApp`/TLS, `H3App`, permessage-deflate and its non-zero
compression constants, SNI methods, worker app descriptors, declarative
responses, and upstream experimental KV/timer helpers are not implemented.
Applications using those features require an explicit migration rather than a
package alias.

## Lifetime and ownership

- Request wrappers are valid only inside route and upgrade callbacks. Use
  `req.snapshot(paramCount)` before asynchronous work.
- Responses remain valid after a route callback only when `onData`,
  `onWritable`, `collectBody`, or `onAborted` is registered.
- `onData` and `onDataV2` chunks are zero-copy `ArrayBuffer`s detached after
  the callback. Copy a chunk if it must be retained.
- `collectBody(maxSize, callback)` returns an owned `ArrayBuffer`, or `null`
  when the limit is exceeded.
- Response and WebSocket wrappers are invalid inside their `onAborted` and
  `close` callbacks respectively.
- `app.close()` is idempotent and closes active HTTP and WebSocket contexts.

`capabilities()` reports optional fast paths such as `endBatch`, `beginWrite`,
and `collectBody`.

## Development

```sh
npm ci
npm run build:native
npm test
npm run test:v8-http
npm run test:v8-ws
```

Vendored source revisions and hashes are recorded in the source repository at
[`vendor/VERSIONS.md`](https://github.com/SwarmMachina/swm-uws/blob/master/vendor/VERSIONS.md).

## Linux release build

Release prebuilds use portable generic x86-64 Clang 18 PGO+LTO without
`-march` or `-mtune`:

```sh
npm run build:native:pgo
```

Required tools: `clang-18`, `libclang-rt-18-dev`, and `llvm-profdata-18`.
The default balanced profile trains raw GET, POST body collection, and
WebSocket depths 1 and 16. Use `SWM_PGO_PROFILE=synthetic` for GET-only
training.

Build both Linux Node ABI prebuilds with Docker:

```sh
npm run build:prebuilds
```

Release CI runs PGO only on native x86-64 hosts and builds ABI 127 and 137
separately.

## Profiling

The bundled Linux profiler records throughput, latency, ELU, memory, hardware
counters, and native stacks:

```sh
npm run profile:http-raw:linux -- /tmp/http-raw-swm
```

Defaults: c100, p10, 2-second warmup, 5-second measurement. Set
`FLAMEGRAPH_DIR` to generate `flamegraph.svg`, or
`SWM_PROFILE_SKIP_PERF=1` when hardware counters are unavailable.

The v0.4.1 portable balanced build measured +13.95% paired median raw GET
throughput over the pinned upstream binary. Re-run the Linux benchmark before
releasing changes to the native parser or build flags. See the
[`Linux PGO report`](https://github.com/SwarmMachina/swm-uws/blob/master/benchmark/profiles/pgo-balanced-linux/report.md).

In a source checkout, regenerate and verify the report with
`npm run bench:report` and `npm run bench:report:check`.

## Updating upstream

```sh
npm run deps:update:vendor -- v20.69.0
npm run deps:check:vendor
```
