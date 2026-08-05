# Linux refactor qualification

Generated on 2026-08-05 on Ubuntu 24.04, Linux 6.17, Intel Xeon E5-2680 v4
(14 cores / 28 threads), 63 GiB RAM. The server was pinned to CPU 2; four load
workers were pinned to CPUs 3-6. Sibling threads 16-20 were not used.

## Before/after raw GET

Both sides were built with Clang 18 as generic x86-64 Release LTO binaries.
Each result contains six alternating ABBA/BAAB blocks, 100 connections,
pipelining 10, a 2-second warmup, and a 10-second measurement.

| Runtime      | Baseline req/s | Candidate req/s | Paired delta | Candidate p95 | Candidate p99 | RSS delta |
| ------------ | -------------: | --------------: | -----------: | ------------: | ------------: | --------: |
| Node 22.22.3 |        425,547 |         436,012 |       +1.82% |      4.134 ms |      4.387 ms |    +0.39% |
| Node 24.17.0 |        426,519 |         431,212 |       +0.53% |      4.176 ms |      4.431 ms |    +0.23% |

## Balanced perf stat medians

Four measurements per role were collected in ABBA/BAAB order, separately from
the timing runs.

| Runtime      | Throughput delta | Cycles/request | Instructions/request | Branch misses/request | p99 delta |
| ------------ | ---------------: | -------------: | -------------------: | --------------------: | --------: |
| Node 22.22.3 |           +1.39% |         -1.32% |               +0.99% |                -1.08% |    -1.94% |
| Node 24.17.0 |           -0.73% |         +1.00% |               +1.09% |                -0.47% |    +2.02% |

Cache events were below one miss per request and varied too much to support a
cache-level conclusion. Node 24 is neutral within the observed approximately
1% throughput/cycle noise; Node 22 is slightly positive.

## Feature paths

Node 22 Release LTO, four alternating ABBA/BAAB blocks per path, 100
connections, pipelining 10, a 1-second warmup, and a 5-second measurement.

| Path                         | Paired throughput delta | p95 delta | p99 delta |
| ---------------------------- | ----------------------: | --------: | --------: |
| `collectBody`, POST 256 B    |                  +1.90% |    -8.81% |    -1.96% |
| `responseBatch` / `endBatch` |                  +0.20% |     0.00% |     0.00% |
| `beginWrite`                 |                  +1.43% |    -1.96% |    -0.99% |

## Selective request prefetch

Four balanced blocks, 20 incoming headers and two selected headers:

| Runtime                  | Consumer                         | Baseline req/s | Prefetch req/s |  Delta |
| ------------------------ | -------------------------------- | -------------: | -------------: | -----: |
| Node 22.22.3 PGO+LTO     | Snapshot unused                  |        368,077 |        218,793 | -40.6% |
| Node 22.22.3 PGO+LTO     | Materialized vs `forEach` filter |        134,199 |        154,882 | +15.4% |
| Node 24.17.0 Release LTO | Snapshot unused                  |        336,589 |        208,900 | -37.9% |
| Node 24.17.0 Release LTO | Materialized vs `forEach` filter |        131,598 |        151,822 | +15.4% |

Selective prefetch is valuable when retained headers are consumed. Enabling it
for a route that never consumes the snapshot adds substantial unnecessary copy
work, so it must remain opt-in.

## PGO+LTO versus pinned upstream

Node 22.22.3, ten balanced AB/BA rounds, 100 connections, pipelining 10,
2-second warmup, and 10-second measurement:

| Result     |       swm-uws |  upstream uWS |
| ---------- | ------------: | ------------: |
| Throughput | 495,290 req/s | 437,172 req/s |
| p95        |      3.635 ms |      4.134 ms |
| p99        |      3.896 ms |      4.387 ms |
| RSS        |     59.59 MiB |     60.51 MiB |

Paired throughput delta was **+12.71%**, IQR **[+11.59%, +13.97%]**;
all 10 paired rounds favored swm-uws and produced zero request errors.

## Profiles

- [Baseline Node 22 frame-pointer flamegraph](flamegraph-baseline-node22.svg)
- [Candidate Node 22 frame-pointer flamegraph](flamegraph-candidate-node22.svg)

Both profiles have the same dominant stacks: V8 UTF-8 conversion, socket
write, HTTP parsing/context dispatch, header lookup, and response completion.
The refactor introduced no new dominant hot stack.

## Reproduction

```sh
taskset -c 3-6 npm run bench:native:abba -- \
  --baseline /path/to/before.node \
  --candidate /path/to/after.node \
  --blocks 6 \
  --connections 100 \
  --pipelining 10 \
  --warmupMs 2000 \
  --durationMs 10000 \
  --workers 4 \
  --serverCpu 2
```

```sh
SWM_BENCH_RUNS=10 \
SWM_BENCH_CONNECTIONS=100 \
SWM_BENCH_PIPELINING=10 \
SWM_BENCH_WARMUP=2 \
SWM_BENCH_DURATION=10 \
SWM_BENCH_SKIP_PERF=0 \
SWM_BENCH_REFERENCE=/path/to/uwebsockets.js/ESM_wrapper.mjs \
npm run bench:compare:pgo:linux -- benchmark/profiles/pgo-balanced-linux
```

## Verdict

The refactor is accepted for performance: no measured path regressed outside
run-to-run noise, tail latency is neutral or better, and PGO+LTO remains ahead
of the pinned upstream reference. Selective prefetch remains an explicit
route-level trade-off rather than a universal fast path.
