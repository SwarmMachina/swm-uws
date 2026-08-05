# Native binding ABBA benchmark

Node v24.17.0; 6 alternating ABBA/BAAB blocks; connections 100; pipelining 10; warmup 2000 ms; duration 10000 ms; workers 4; server CPU 2.

| Metric           |     Baseline |    Candidate |  Delta |
| ---------------- | -----------: | -----------: | -----: |
| Throughput       | 426519 req/s | 431212 req/s | +1.10% |
| p95              |     4.217 ms |     4.176 ms | -0.98% |
| p99              |     4.475 ms |     4.431 ms | -0.98% |
| Target ELU       |        99.0% |        99.0% | +0.06% |
| Target RSS peak  |     60.8 MiB |     61.0 MiB | +0.23% |
| Target heap peak |      7.3 MiB |      7.3 MiB |      — |

Paired throughput delta across ABBA blocks: **+0.53%**.

Local runs are diagnostic. The release regression gate remains the isolated Linux x86-64 PGO/LTO comparison.
