# Native binding ABBA benchmark

Node v22.22.3; 4 alternating ABBA/BAAB blocks; GET /stream-begin; body 0 bytes; connections 100; pipelining 10; warmup 1000 ms; duration 5000 ms; workers 4; server CPU 2.

| Metric           |     Baseline |    Candidate |  Delta |
| ---------------- | -----------: | -----------: | -----: |
| Throughput       | 328938 req/s | 332761 req/s | +1.16% |
| p95              |     5.455 ms |     5.348 ms | -1.96% |
| p99              |     5.847 ms |     5.789 ms | -0.99% |
| Target ELU       |        98.0% |        98.0% | +0.03% |
| Target RSS peak  |     60.6 MiB |     60.8 MiB | +0.23% |
| Target heap peak |      7.0 MiB |      7.0 MiB |      — |

Paired throughput delta across ABBA blocks: **+1.43%**.

Local runs are diagnostic. The release regression gate remains the isolated Linux x86-64 PGO/LTO comparison.
