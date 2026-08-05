# Native binding ABBA benchmark

Node v22.22.3; 4 alternating ABBA/BAAB blocks; GET /batch; body 0 bytes; connections 100; pipelining 10; warmup 1000 ms; duration 5000 ms; workers 4; server CPU 2.

| Metric           |     Baseline |    Candidate |  Delta |
| ---------------- | -----------: | -----------: | -----: |
| Throughput       | 362652 req/s | 362084 req/s | -0.16% |
| p95              |     4.941 ms |     4.941 ms | +0.00% |
| p99              |     5.296 ms |     5.296 ms | +0.00% |
| Target ELU       |        98.1% |        98.1% | +0.06% |
| Target RSS peak  |     60.5 MiB |     60.5 MiB | +0.04% |
| Target heap peak |      6.9 MiB |      6.9 MiB |      — |

Paired throughput delta across ABBA blocks: **+0.20%**.

Local runs are diagnostic. The release regression gate remains the isolated Linux x86-64 PGO/LTO comparison.
