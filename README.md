# @swarmmachina/swm-uws

High-performance raw V8 binding for pinned uWebSockets and uSockets sources.
Its public surface is intentionally aligned with the HTTP and WebSocket APIs
used by `swm-core`.

## Supported runtime

- Node.js 22 and 24
- Linux x64 with glibc:
  - Debian Bookworm-based Node.js images
  - `node:22-bookworm-slim` and `node:24-bookworm-slim`
- Windows x64:
  - native prebuilds produced on the `windows-2022` GitHub Actions runner
  - no Visual Studio, Python, or node-gyp required at runtime

TLS and permessage-deflate are disabled. Terminate TLS at an ingress or reverse
proxy.

Alpine Linux is not supported in v0.1.

Alpine uses musl libc, while the first prebuild target is glibc. A separate
`linux-x64-musl` binary and CI job will be required later. Use
`node:22-bookworm-slim` or `node:24-bookworm-slim` for now.

Windows ARM64 is not supported in v0.1.

## API

```js
import { App, us_listen_socket_close, version } from '@swarmmachina/swm-uws'

console.log(version())

const app = App()

app.get('/', (res, req) => {
  console.log(req.getMethod(), req.getUrl(), req.getHeader('user-agent'))

  res.writeStatus('200 OK').writeHeader('content-type', 'application/json').end('{"ok":true}')
})

app.ws('/ws', {
  open(ws) {
    ws.send('open')
  },
  message(ws, message, isBinary) {
    ws.send(message, isBinary)
  },
  close(ws, code, reason) {
    // The socket is already invalid here.
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

HTTP route handlers run synchronously. A response remains valid after its route
callback only when `onData` or `onAborted` has been registered; otherwise an
unfinished response is closed. A WebSocket wrapper becomes invalid before its
`close` callback runs.

WebSockets support `send`, `close`, `end`, `getBufferedAmount`, `getUserData`,
`subscribe`, and `unsubscribe`. Apps support `publish` and `numSubscribers`.
Close reasons are limited to 123 UTF-8 bytes and invalid or reserved close
codes are rejected.

`app.ws(path, behavior)` accepts `maxPayloadLength` (default 16 KiB),
`idleTimeout` (default 120 seconds; either 0 or 8–960), `maxBackpressure`,
`maxLifetime`, `closeOnBackpressureLimit`, `resetIdleTimeoutOnSend`, and
`sendPingsAutomatically`. Supported callbacks are `upgrade`, `open`, `message`,
`drain`, `subscription`, and `close`.

HTTP responses support `writeStatus`, `writeHeader`, `cork`, `write`, `tryEnd`,
`onWritable`, `getWriteOffset`, `getRemoteAddressAsText`, `upgrade`, and `end`.
Status and header values containing control characters are rejected.

Request bodies are exposed as zero-copy external `ArrayBuffer` chunks with
`res.onData((chunk, isLast) => {})`. Each chunk is valid only during its callback
and is detached immediately afterwards. Copy it inside the callback if it must
be retained, for example `Buffer.from(new Uint8Array(chunk))`. The binding does
not aggregate chunks; the application remains responsible for enforcing its
total body-size limit. An aborted response is invalid before its `onAborted`
handler runs.

HTTP requests support `getMethod`, `getUrl`, `getHeader`, `getQuery`,
`getParameter`, and `forEach`. Request wrappers are valid only while their route
or upgrade callback is running. Returned strings are safe to retain.

Routes can be registered with `get`, `post`, `put`, `patch`, `del`, `options`,
`head`, and `any`. Every registration method returns the app for chaining.

`app.close()` is idempotent and closes the HTTP and WebSocket contexts,
including active WebSockets. Use `us_listen_socket_close(socket)` first when
only accepting new connections must stop while active work drains. A closed app
cannot listen again.

`createApp()` remains an alias of `App()` for compatibility. APIs outside the
documented `swm-core` surface are not implemented.

## Development build

Install the C/C++ toolchain and run:

```bash
npm ci
npm run build:native
npm test
```

On Linux x64, `build:native` copies the binary to:

```text
prebuilds/linux-x64-glibc/node-v${process.versions.modules}.node
```

On other development platforms the loader uses
`build/Release/swm_uws.node`. Package installation itself uses an explicit
no-op install script and never compiles native code.

To rebuild both supported Linux prebuilds with Docker:

```bash
npm run build:prebuilds
```

The script always targets `linux/amd64`, including on ARM64 development hosts.

## Performance baseline

Build the native module, start the instrumented server, and warm it before each
measurement:

```bash
npm run build:native
npm run bench:server
```

HTTP baseline parameters are 50 connections, 10 seconds, and pipelining 1:

```bash
curl -sS http://127.0.0.1:30123/reset
npm exec --yes autocannon -- -c 50 -d 10 -p 1 -j http://127.0.0.1:30123/
curl -sS http://127.0.0.1:30123/metrics
```

The WebSocket echo baseline uses 50 connections, 256-byte messages, 10 seconds,
and one in-flight message per connection:

```bash
curl -sS http://127.0.0.1:30123/reset
CONNECTIONS=50 DURATION_MS=10000 PAYLOAD_BYTES=256 npm run bench:ws
curl -sS http://127.0.0.1:30123/metrics
```

Benchmark numbers are machine-specific. Compare changes on the same idle host
using identical parameters and report throughput, p95/p99, ELU, and memory.

## Windows build

Windows builds are native MSVC/node-gyp builds; they are not cross-compiled
from Linux or macOS. A development machine needs:

- 64-bit Windows
- Visual Studio 2022 Build Tools with the Desktop development with C++ workload
- Python 3
- Node.js 22 or 24

Run in PowerShell or a Visual Studio developer shell:

```powershell
npm ci
npm run build:native
npm test
```

The resulting file is copied to:

```text
prebuilds/win32-x64/node-v${process.versions.modules}.node
```

The `Prebuilds` workflow builds Node.js 22 and 24 separately on native Linux
and Windows x64 runners, runs the same HTTP/WebSocket smoke test, and uploads:

- the two `linux-x64-glibc` and two `win32-x64` prebuilds;
- a combined npm release-candidate tarball containing Linux and Windows files.

The workflow installs the packed release candidate and smoke-tests it on both
operating systems with Node.js 22 and 24. The `prepublishOnly` guard verifies
that all four ABI files exist and that the Linux files are ELF while the
Windows files are PE binaries.

## Docker smoke

```bash
docker build --platform linux/amd64 --build-arg NODE_VERSION=24 -t swm-uws-node24 .
docker run --rm -p 3000:3000 swm-uws-node24
curl http://127.0.0.1:3000/
```

Use `NODE_VERSION=22` for the Node.js 22 runtime matrix entry. The runtime stage
contains no Python, compiler, make, or node-gyp installation.

## Native loader failures

If a matching binary and local development build are both absent, import fails
at startup with the detected platform, architecture, and Node module ABI:

```text
No native binary for linux/x64/node-vXXX.
Build @swarmmachina/swm-uws for this target first.
```

Vendored source provenance is recorded in `vendor/VERSIONS.md`.
