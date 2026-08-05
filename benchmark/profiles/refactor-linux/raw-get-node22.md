# Native binding ABBA benchmark

Node v22.22.3; 6 alternating ABBA/BAAB blocks; connections 100; pipelining 10; warmup 2000 ms; duration 10000 ms; workers 4; server CPU 2.

| Metric           |     Baseline |    Candidate |  Delta |
| ---------------- | -----------: | -----------: | -----: |
| Throughput       | 425547 req/s | 436012 req/s | +2.46% |
| p95              |     4.217 ms |     4.134 ms | -1.96% |
| p99              |     4.475 ms |     4.387 ms | -1.96% |
| Target ELU       |        98.9% |        99.0% | +0.02% |
| Target RSS peak  |     60.0 MiB |     60.3 MiB | +0.39% |
| Target heap peak |      6.9 MiB |      6.9 MiB |      — |

Paired throughput delta across ABBA blocks: **+1.82%**.

Local runs are diagnostic. The release regression gate remains the isolated Linux x86-64 PGO/LTO comparison.
