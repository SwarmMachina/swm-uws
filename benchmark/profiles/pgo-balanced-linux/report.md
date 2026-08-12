# Portable balanced PGO+LTO: raw HTTP response

The `@swarmmachina/swm-uws 0.6.0` candidate is compared with the pinned
`uWebSockets.js 20.69.0` reference on the identical raw GET response path.

| Result            |       swm-uws |  upstream uWS |
| ----------------- | ------------: | ------------: |
| Median throughput | 495,290 req/s | 437,172 req/s |
| Median p95        |      3.635 ms |      4.134 ms |
| Median p97.5      |      3.744 ms |      4.259 ms |
| Median p99        |      3.896 ms |      4.387 ms |

Paired throughput delta: **+12.71%**,
IQR using Tukey hinges **[+11.59%, +13.97%]**.
10 of 10 paired rounds favored swm-uws. There were 0 request errors.

## Protocol

- Linux 6.17.0-40-generic x64, Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz, 28 logical CPUs, 63 GiB RAM
- Node.js 22.22.3, ABI v127
- 10 balanced AB/BA rounds
- 100 connections, pipelining 10
- 2 second warmup, 10 second measurement
- server pinned to CPU 2; 4 client workers pinned to CPUs 3-6
- identical bundled server, `App/get/writeHeader/end` handler, and byte-identical GET

## Runtime

| Median after warmup |   swm-uws | upstream uWS |
| ------------------- | --------: | -----------: |
| ELU                 |    98.29% |       98.27% |
| RSS                 | 59.59 MiB |    60.51 MiB |
| RSS delta           |  0.00 MiB |     0.22 MiB |
| Heap used           |  5.71 MiB |     6.07 MiB |

## Regression guard

**Result: PASS**. Limits: throughput -5%,
tail latency +20% plus 0.25 ms,
RSS +15% plus 5 MiB.

No regressions exceeded the guard limits.

## Hardware counters

The independent stat-only run produced 490,740 req/s
with p99 3.974 ms.

| Counter          | Per request |
| ---------------- | ----------: |
| Cycles           |     5600.65 |
| Instructions     |     9177.51 |
| Branches         |     1878.95 |
| Branch misses    |        7.66 |
| Cache references |       69.89 |
| Cache misses     |       0.131 |

## Build

The release binary was built with Clang 18, balanced PGO, and LTO. Training
covers raw GET c100/p10, POST body collection,
WebSocket depth 1 and depth 16, plus HTTP, WebSocket, and async smoke paths. No
`-march` or `-mtune` is used.

- SHA-256: `23538d5142f3a3a4f8b6ae793bf17b3a4ebe9973f46a60e4c185aaf9465c00d4`
- Size: 1,772,664 bytes
- ELF: generic x86-64, stripped
- Dynamic dependencies: ld-linux-x86-64.so.2, libc.so.6, libm.so.6; C++ runtime is linked statically

Rebuild the native binary and reproduce the comparison with:

```sh
npm run build:native:pgo
SWM_BENCH_REFERENCE=/path/to/uwebsockets.js/ESM_wrapper.mjs \
  npm run bench:compare:pgo:linux -- benchmark/profiles/pgo-balanced-linux
```

The report is generated from `metadata.json`, `runs.json`, and the complete
`features/*.json` suite when feature-path measurements are present. The PGO profile
should be regenerated whenever native wrapper/vendor sources, the Node ABI, the
compiler, or material compiler flags change.
