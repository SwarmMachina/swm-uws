# Portable balanced PGO+LTO: raw HTTP response

The `@swarmmachina/swm-uws 0.4.0` development candidate is faster than the pinned
`uWebSockets.js 20.69.0` reference on the identical raw GET response path.

| Result            |       swm-uws |  upstream uWS |
| ----------------- | ------------: | ------------: |
| Median throughput | 493,458 req/s | 430,937 req/s |
| Median p95        |      3.679 ms |      4.203 ms |
| Median p97.5      |      3.798 ms |      4.363 ms |
| Median p99        |      3.999 ms |      4.498 ms |

Paired throughput delta: **+15.20%**,
IQR using Tukey hinges **[+13.69%, +15.97%]**.
All 6 paired rounds were positive. There were 0 request errors.

## Protocol

- Linux 6.17 x86-64, Intel Xeon E5-2680 v4, 28 logical CPUs, 62 GiB RAM
- Node.js 22.22.3, ABI v127
- 6 balanced AB/BA rounds
- 100 connections, pipelining 10
- 2 second warmup, 5 second measurement
- server pinned to CPU 2; 4 client workers pinned to CPUs 3-6
- identical bundled server, `App/get/writeHeader/end` handler, and byte-identical GET

## Hardware counters

An independent stat-only run produced 493,038 req/s
with p99 4.015 ms.

| Counter          | Per request |
| ---------------- | ----------: |
| Cycles           |     5511.03 |
| Instructions     |     8774.87 |
| Branches         |     1761.11 |
| Branch misses    |        8.48 |
| Cache references |       68.99 |
| Cache misses     |       0.051 |

## Build

The release binary was built with Clang 18, balanced PGO, and LTO. Training
covers raw GET c100/p10, POST body collection,
WebSocket depth 1 and depth 16, plus HTTP, WebSocket, and async smoke paths. No
`-march` or `-mtune` is used.

- SHA-256: `38a003e4670c2e57e9524345e1b0eedd95aa20e0b67346e1856dcae91eaf7ae9`
- Size: 1,677,912 bytes
- ELF: generic x86-64, stripped
- Dynamic dependencies: libc, libm, dynamic loader; C++ runtime is linked statically

Rebuild the native binary and regenerate this report with:

```sh
npm run build:native:pgo
npm run bench:report
```

The report is generated from `metadata.json` and `runs.json`. The PGO profile
should be regenerated whenever native wrapper/vendor sources, the Node ABI, the
compiler, or material compiler flags change.
