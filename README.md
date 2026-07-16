# @swarmmachina/swm-uws

Raw V8 binding for the HTTP and WebSocket APIs used by `swm-core`. Sources are
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
import { App, us_listen_socket_close } from '@swarmmachina/swm-uws'

const app = App()

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
  us_listen_socket_close(listenSocket)
  app.close()
})
```

The complete surface is declared in [`lib/index.d.ts`](lib/index.d.ts).

## Lifetime and ownership

- Request wrappers are valid only inside route and upgrade callbacks. Use
  `req.snapshot(paramCount)` before asynchronous work.
- Responses remain valid after a route callback only when `onData`,
  `onWritable`, `collectBody`, or `onAborted` is registered.
- `onData` chunks are zero-copy `ArrayBuffer`s detached after the callback.
  Copy a chunk if it must be retained.
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

The portable balanced build measured +15.20% paired median raw GET throughput
over the pinned upstream binary. See the
[`Linux PGO report`](https://github.com/SwarmMachina/swm-uws/blob/master/benchmark/profiles/pgo-balanced-linux/report.md).

In a source checkout, regenerate and verify the report with
`npm run bench:report` and `npm run bench:report:check`.

## Updating upstream

```sh
npm run deps:update:vendor -- v20.69.0
npm run deps:check:vendor
```
