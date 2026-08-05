# Request prefetch benchmark

Generated: 2026-08-04T22:37:04.882Z

Node: v24.17.0; connections: 100; pipelining: 10; workers: 4; warmup: 1000 ms; duration: 5000 ms; balanced ABBA/BAAB blocks: 4; server CPU: 2. Target and load generator are separate processes.

| Cell                             | Baseline req/s | Prefetch req/s | RPS delta | Prefetch p95 ms | Prefetch p99 ms | Target ELU | Target RSS MiB |
| -------------------------------- | -------------: | -------------: | --------: | --------------: | --------------: | ---------: | -------------: |
| 20h-2s-present-never-sync        |         336589 |         208900 |    -37.9% |           5.789 |           9.129 |      98.5% |           67.1 |
| 20h-2s-present-materialized-sync |         131598 |         151822 |     15.4% |           6.987 |          12.782 |      98.5% |           74.5 |

Results are medians across all role runs. Treat quick/local runs as suite validation, not a release gate; the release gate requires an even number of balanced ABBA/BAAB blocks on isolated Node 22 and Node 24 hosts.
