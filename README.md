# @swarmmachina/uws-native

Small, controlled Node-API binding for pinned uWebSockets and uSockets sources.
It intentionally exposes only the API required by the v0.1 smoke test.

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
import { createApp, version } from '@swarmmachina/uws-native'

console.log(version())

const app = createApp()

app.get('/', (res) => {
  res.end('ok')
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

app.listen('0.0.0.0', 3000, (ok) => {
  if (!ok) process.exit(1)
})
```

HTTP handlers are synchronous in v0.1. A response wrapper becomes invalid when
its route callback returns. A WebSocket wrapper becomes invalid before its
`close` callback runs.

No other uWebSockets.js API is implemented.

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

The `Windows prebuilds` workflow builds Node.js 22 and 24 separately, runs the
same HTTP/WebSocket smoke test, and uploads:

- the two `win32-x64` prebuilds;
- a combined npm release-candidate tarball containing Linux and Windows files.

Do not publish a package from a non-Windows checkout unless the two Windows
workflow artifacts have first been placed under `prebuilds/win32-x64/`.
The `prepublishOnly` guard verifies that all four ABI files exist and that the
Linux files are ELF while the Windows files are PE binaries.

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
Build @swarmmachina/uws-native for this target first.
```

Vendored source provenance is recorded in `vendor/VERSIONS.md`.
