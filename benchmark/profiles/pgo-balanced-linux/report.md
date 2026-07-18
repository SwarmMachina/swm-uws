# Portable balanced PGO+LTO: raw HTTP response

The `@swarmmachina/swm-uws 0.4.1` candidate is compared with the pinned
`uWebSockets.js 20.69.0` reference on the identical raw GET response path.

| Result            |       swm-uws |  upstream uWS |
| ----------------- | ------------: | ------------: |
| Median throughput | 493,350 req/s | 430,870 req/s |
| Median p95        |      3.668 ms |      4.178 ms |
| Median p97.5      |      3.802 ms |      4.372 ms |
| Median p99        |      3.994 ms |      4.504 ms |

Paired throughput delta: **+13.95%**,
IQR using Tukey hinges **[+13.80%, +18.05%]**.
6 of 6 paired rounds favored swm-uws. There were 0 request errors.

## Protocol

- Linux 6.17.0-40-generic x64, Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz, 28 logical CPUs, 63 GiB RAM
- Node.js 22.22.3, ABI v127
- 6 balanced AB/BA rounds
- 100 connections, pipelining 10
- 2 second warmup, 5 second measurement
- server pinned to CPU 2; 4 client workers pinned to CPUs 3-6
- identical bundled server, `App/get/writeHeader/end` handler, and byte-identical GET

## Runtime

| Median after warmup |   swm-uws | upstream uWS |
| ------------------- | --------: | -----------: |
| ELU                 |    85.42% |       84.01% |
| RSS                 | 55.03 MiB |    56.02 MiB |
| RSS delta           |  0.00 MiB |     0.00 MiB |
| Heap used           |  4.75 MiB |     5.07 MiB |

## Regression guard

**Result: PASS**. Limits: throughput -5%,
tail latency +20% plus 0.25 ms,
RSS +15% plus 5 MiB.

No regressions exceeded the guard limits.

## Hardware counters

The independent stat-only run produced 460,576 req/s
with p99 4.244 ms.

| Counter          | Per request |
| ---------------- | ----------: |
| Cycles           |     5934.97 |
| Instructions     |     8851.71 |
| Branches         |     1784.66 |
| Branch misses    |        8.61 |
| Cache references |       79.61 |
| Cache misses     |       0.056 |

## Build

The release binary was built with Clang 18, balanced PGO, and LTO. Training
covers raw GET c100/p10, POST body collection,
WebSocket depth 1 and depth 16, plus HTTP, WebSocket, and async smoke paths. No
`-march` or `-mtune` is used.

- SHA-256: `e346d56347d867af73ca459588959998f9f3b8b9f69c3be274a71735340f9840`
- Size: 1,702,552 bytes
- ELF: generic x86-64, stripped
- Dynamic dependencies: ld-linux-x86-64.so.2, libc.so.6, libm.so.6; C++ runtime is linked statically

Rebuild the native binary and reproduce the comparison with:

```sh
npm run build:native:pgo
SWM_BENCH_REFERENCE=/path/to/uwebsockets.js/ESM_wrapper.mjs \
  npm run bench:compare:pgo:linux -- benchmark/profiles/pgo-balanced-linux
```

The report is generated from `metadata.json` and `runs.json`. The PGO profile
should be regenerated whenever native wrapper/vendor sources, the Node ABI, the
compiler, or material compiler flags change.
