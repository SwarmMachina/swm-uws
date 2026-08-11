# @swarmmachina/swm-uws

[![CI](https://github.com/SwarmMachina/swm-uws/actions/workflows/quality.yml/badge.svg)](https://github.com/SwarmMachina/swm-uws/actions/workflows/quality.yml)
[![License: MPL 2.0](https://img.shields.io/badge/License-MPL%202.0-brightgreen.svg)](https://opensource.org/licenses/MPL-2.0)
[![Node.js](https://img.shields.io/badge/node-22%20%7C%2024-brightgreen.svg)](https://nodejs.org/)
[![runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-brightgreen.svg)](#runtime-requirements)
[![stability](https://img.shields.io/badge/stability-experimental-orange.svg)](#stability)

Non-TLS HTTP and WebSocket V8 binding compatible with the standard
uWebSockets.js `App()` API. Used by `swm-core`.

The binding tracks uWebSockets.js `20.69.0`. See the
[vendored revisions](https://github.com/SwarmMachina/swm-uws/blob/master/vendor/VERSIONS.md),
[local patches](https://github.com/SwarmMachina/swm-uws/blob/master/vendor/PATCHES.md),
and [TypeScript API](lib/index.d.ts).

## Features

- Drop-in non-TLS compatibility with the standard uWebSockets.js `App()` API.
- Native HTTP and WebSocket transport for Node.js 22 and 24.
- TypeScript declarations with typed standalone callback helpers.
- Zero-copy streaming and bounded native body collection.
- Per-App native HTTP limits, phase-specific timeouts, and transport counters.
- Generated responses omit the upstream fingerprint from headers and automatic parser errors.
- Compiled selective request-header prefetch with owned lazy snapshots.
- Batched responses and explicit capability detection.
- Platform-specific prebuilds with no runtime dependencies.

## Installation

```bash
npm install @swarmmachina/swm-uws
```

### Runtime requirements

| Runtime | Support    |
| ------- | ---------- |
| Node.js | 22, 24     |
| Linux   | x64, glibc |
| Windows | x64        |
| macOS   | arm64, x64 |

- No runtime npm dependencies; the package ships platform-specific native prebuilds.

Not supported:

- TLS / `SSLApp`.
- `H3App`.
- permessage-deflate and non-zero compression constants.
- SNI.
- Alpine/musl.
- Windows ARM64.
- Upstream worker descriptors, declarative responses, KV and timer helpers.

Terminate TLS before traffic reaches the application.

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

## Contracts

### HTTP transport policy

Configure parser limits and lifecycle timeouts independently for each `App`:

```js
const native = uWS.capabilities()

if (!native.httpTransportConfig || !native.requestPrefetch) {
  throw new Error('required native fast paths are unavailable')
}

const app = uWS.App({
  http: {
    maxHeaderSize: 16 * 1024,
    maxHeaderCount: 100,
    headersTimeoutMs: 10_000,
    keepAliveTimeoutMs: 5_000,
    bodyIdleTimeoutMs: 10_000,
    minBodyRateBytesPerSec: 16 * 1024,
    responseWriteTimeoutMs: 10_000,
    trustedProxy: { header: 'x-forwarded-for', hops: 1 }
  }
})
```

Values are positive finite safe integers without coercion; `0` is rejected and
`null` is accepted only as `minBodyRateBytesPerSec: null` to disable the body
rate check. Unknown `http` fields throw synchronously during `App()`.
`UWS_HTTP_MAX_HEADERS_SIZE` remains a deprecated fallback when
`maxHeaderSize` is omitted. Explicit timeouts use the coarse four-second
uSockets wheel, never expire before the configured deadline, and are limited
to `956_000` ms so the wheel cannot wrap to a much shorter timeout.

`trustedProxy` is an explicit listener trust boundary for ordinary nginx-style
HTTP proxying. It is disabled by default. Enable it only when clients cannot
reach the listener without passing through proxies that overwrite or sanitize
the selected header. `x-forwarded-for` selects `hops` entries from the right
(`1` is the rightmost value); `x-real-ip` accepts exactly one address and only
`hops: 1`. Invalid or duplicate trusted headers receive `400`. Configuring a
trusted HTTP header disables binary PROXY v2 parsing for that `App`. The
compatibility methods
`getProxiedRemoteAddress()` and `getProxiedRemoteAddressAsText()` expose the
selected address; `getProxiedRemotePort()` returns `0` because these HTTP
headers do not authenticate a source port. When `trustedProxy` is omitted, the
listener preserves legacy binary PROXY v2 behavior, including its source
address and port accessors. Use that legacy mode only on a listener unreachable
except through a trusted PROXY-protocol peer.

For a single nginx hop, bind the native listener to loopback or a private
network, overwrite the address header at nginx, and trust only that header:

```nginx
location / {
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For "";
    proxy_pass http://127.0.0.1:3000;
}
```

```js
const app = uWS.App({
  http: { trustedProxy: { header: 'x-real-ip' } }
})
```

For a fixed proxy chain, use `x-forwarded-for` with the exact number of
trusted hops. Do not enable either mode on a listener that clients can reach
directly; an HTTP header is trustworthy only because the ingress proxy
replaces or sanitizes it.

Header limit failures return `431` before HTTP or WebSocket handlers run.
Read inexpensive per-App counters when exporting metrics:

```js
const stats = app.getHttpTransportStats()
console.log(stats.headerTooLarge, stats.bodyRateViolations, stats.activeConnections)
```

### Request lifetime

Request wrappers expire when the route or upgrade callback returns. Copy the
individual values needed by asynchronous work while the callback is active:

```js
app.get('/users/:id', (res, req) => {
  const parameter = req.getParameter(0)
  const userAgent = req.getHeader('user-agent')
  let aborted = false

  res.onAborted(() => {
    aborted = true
  })

  setImmediate(() => {
    if (aborted) return
    console.log(parameter, userAgent)
    res.end('ok')
  })
})
```

Values returned by `req.getMethod()`, `getUrl()`, `getQuery()`, `getHeader()` and
`getParameter()` are owned JavaScript values and may outlive the native request
wrapper.

For async consumers that need selected headers with duplicate/missing/empty
semantics, compile a native plan once and prefetch only those fields:

```js
const plan = new uWS.RequestPrefetchPlan({
  headers: ['authorization', 'traceparent']
})

app.get('/*', (res, req) => {
  const headers = req.prefetch(plan)
  res.onAborted(() => {})
  setImmediate(() => {
    const authorization = headers.getHeader('authorization')
    const traceparents = headers.getHeaderValues('traceparent')
    res.end(JSON.stringify({ authorization, traceparents }))
  })
})
```

Plans normalize and deduplicate names once. Snapshots remain valid after the
request callback, preserve duplicate wire order, distinguish missing
(`undefined`) from empty (`''`), and copy no unselected headers. Use
`getHeaders()` for a null-prototype last-value-wins record or
`getHeaderEntries()` for all retained pairs in wire order. `headers: []`
captures nothing; `headers: 'all'` captures every occurrence.

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
maxSize: integer bytes, 0..64 MiB, per request
native body memory grows with bytes actually received, not declared Content-Length
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
//   httpTransportConfig: true,
//   requestPrefetch: true,
//   responseBatch: true,
//   requestPause: true
// }
```

The six flags describe binding extensions; consumers should negotiate them
instead of assuming that every compatible binding implements the extension:

| Capability            | Short use                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beginWrite`          | `res.beginWrite()` selects explicit streaming before `write()`.                                                                                   |
| `collectBody`         | `res.collectBody(maxBytes, callback)` retains one complete body.                                                                                  |
| `httpTransportConfig` | `App({ http: { maxHeaderCount: 64 } })` applies per-App parser policy.                                                                            |
| `requestPrefetch`     | `req.prefetch(new RequestPrefetchPlan({ headers: ['authorization'] }))` retains selected headers.                                                 |
| `responseBatch`       | `res.endBatch(status, preparedHeaderLines, body)` combines a prepared response; consumers should keep it opt-in until their own perf gate passes. |
| `requestPause`        | `res.pause()` / `res.resume()` controls incoming request-body delivery.                                                                           |

## Development

```sh
npm ci
npm run build:native
npm run check
npm run check:cpp
npm test
npm run test:v8-http
npm run test:v8-ws
npm run test:types
npm run test:package
npm run deps:check:vendor
```

`check:cpp` requires LLVM 18+ (`clang-format` and `clang-tidy`), prefers the
versioned LLVM 18 toolchain (including Homebrew's keg-only `llvm@18`), and checks
only first-party `src/` files. Use `npm run fix:cpp` to apply the shared C++ format.

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
# GET-only training
SWM_PGO_PROFILE=synthetic npm run build:native:pgo
```

Release CI runs PGO on native x86-64 hosts. The current working tree measured
`+12.71%` paired raw-GET throughput over pinned upstream uWebSockets.js
20.69.0 on isolated Node 22 Linux; all 10 paired rounds favored swm-uws, with
lower p95, p99, and RSS. See the generated
[`Linux PGO report`](https://github.com/SwarmMachina/swm-uws/blob/master/benchmark/profiles/pgo-balanced-linux/report.md)
and the broader
[`Linux refactor qualification`](benchmark/profiles/refactor-linux/report.md).

## Profiling

```sh
npm run profile:http-raw:linux -- /tmp/http-raw-swm

# Optional
FLAMEGRAPH_DIR=/path/to/FlameGraph
SWM_PROFILE_FREQUENCY=199
SWM_PROFILE_CALL_GRAPH=fp # or dwarf
SWM_PROFILE_SKIP_PERF=1

npm run bench:report
npm run bench:report:check
```

Defaults: concurrency 100, pipelining 10, 2-second warmup, 5-second measurement.
Release CI also runs an independent `perf stat` measurement for cycles,
instructions, branches, and cache events. Its dedicated Linux runner requires
`kernel.perf_event_paranoid=1` or an equivalent scoped `CAP_PERFMON` policy.

Selective request prefetch (separate target/load processes, balanced ABBA/BAAB blocks):

```sh
npm run bench:prefetch -- --quick
```

Node 22/24 reports are under
[`benchmark/request-prefetch`](benchmark/request-prefetch/). With 20 incoming
headers and two selected fields, materialized native prefetch measured `+15.4%`
over `req.forEach()` plus JS filtering. Creating a snapshot that is never used
measured `-37.9%` to `-40.6%`, so prefetch should remain opt-in per route.

Native before/after comparison with throughput, p95/p99, target ELU and memory:

```sh
npm run bench:native:abba -- \
  --baseline /path/to/before.node \
  --candidate build/Release/swm_uws.node \
  --blocks 6 \
  --connections 100 \
  --pipelining 10 \
  --warmupMs 2000 \
  --durationMs 10000 \
  --workers 4 \
  --serverCpu 2
```

## Updating upstream

```sh
npm run deps:update:vendor -- v20.69.0
npm run deps:check:vendor
```

## Stability

The package is currently experimental. Public APIs and runtime behavior may
change before a stable release; changes should be documented and covered by
tests.

## Contributing

Run `npm run release:gate` before opening a pull request. Changes to vendored
upstream code must retain the applicable licenses and be documented in
[vendor/PATCHES.md](vendor/PATCHES.md).

## License

[MPL-2.0](LICENSE) for first-party code.

Vendored licenses and notices:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Copyright Contributors to SwarmMachina.
