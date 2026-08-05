# Native binding ABBA benchmark

Node v22.22.3; 4 alternating ABBA/BAAB blocks; POST /post; body 256 bytes; connections 100; pipelining 10; warmup 1000 ms; duration 5000 ms; workers 4; server CPU 2.

| Metric           |     Baseline |    Candidate |  Delta |
| ---------------- | -----------: | -----------: | -----: |
| Throughput       | 232518 req/s | 237655 req/s | +2.21% |
| p95              |     6.411 ms |     5.847 ms | -8.81% |
| p99              |     8.106 ms |     7.947 ms | -1.96% |
| Target ELU       |        98.2% |        98.2% | -0.04% |
| Target RSS peak  |     64.6 MiB |     64.6 MiB | -0.00% |
| Target heap peak |      7.0 MiB |      6.9 MiB |      — |

Paired throughput delta across ABBA blocks: **+1.90%**.

Local runs are diagnostic. The release regression gate remains the isolated Linux x86-64 PGO/LTO comparison.
