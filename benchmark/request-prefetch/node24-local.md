# Request prefetch benchmark

Generated: 2026-08-04T19:48:42.287Z

Node: v24.17.0; connections: 100; pipelining: 10; workers: 4; warmup: 500 ms; duration: 1000 ms; ABBA blocks: 5. Target and load generator are separate processes.

| Cell                             | Baseline req/s | Prefetch req/s | RPS delta | Prefetch p95 ms | Prefetch p99 ms | Target ELU | Target RSS MiB |
| -------------------------------- | -------------: | -------------: | --------: | --------------: | --------------: | ---------: | -------------: |
| 20h-2s-present-never-sync        |         857418 |         631043 |    -26.4% |           1.873 |           2.953 |      98.2% |           61.2 |
| 20h-2s-present-materialized-sync |         318055 |         483021 |     51.9% |           2.471 |           3.896 |      98.3% |           64.0 |

Results are medians across all role runs. Treat quick/local runs as suite validation, not a release gate; the release gate requires five ABBA blocks on isolated Node 22 and Node 24 hosts.
