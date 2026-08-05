# Request prefetch benchmark

Generated: 2026-08-04T22:33:29.965Z

Node: v22.22.3; connections: 100; pipelining: 10; workers: 4; warmup: 1000 ms; duration: 5000 ms; balanced ABBA/BAAB blocks: 4; server CPU: 2. Target and load generator are separate processes.

| Cell                             | Baseline req/s | Prefetch req/s | RPS delta | Prefetch p95 ms | Prefetch p99 ms | Target ELU | Target RSS MiB |
| -------------------------------- | -------------: | -------------: | --------: | --------------: | --------------: | ---------: | -------------: |
| 20h-2s-present-never-sync        |         368077 |         218793 |    -40.6% |           5.905 |           8.602 |      98.4% |           67.2 |
| 20h-2s-present-materialized-sync |         134199 |         154882 |     15.4% |           6.918 |          12.782 |      98.4% |           73.7 |

Results are medians across all role runs. Treat quick/local runs as suite validation, not a release gate; the release gate requires an even number of balanced ABBA/BAAB blocks on isolated Node 22 and Node 24 hosts.
