# Request prefetch benchmark

Generated: 2026-08-04T19:50:22.338Z

Node: v22.18.0; connections: 100; pipelining: 10; workers: 4; warmup: 500 ms; duration: 1000 ms; ABBA blocks: 5. Target and load generator are separate processes.

| Cell                             | Baseline req/s | Prefetch req/s | RPS delta | Prefetch p95 ms | Prefetch p99 ms | Target ELU | Target RSS MiB |
| -------------------------------- | -------------: | -------------: | --------: | --------------: | --------------: | ---------: | -------------: |
| 20h-2s-present-never-sync        |         883015 |         621153 |    -29.7% |           1.987 |           3.042 |      97.9% |           55.6 |
| 20h-2s-present-materialized-sync |         364475 |         493656 |     35.4% |           2.422 |           3.744 |      97.9% |           57.0 |

Results are medians across all role runs. Treat quick/local runs as suite validation, not a release gate; the release gate requires five ABBA blocks on isolated Node 22 and Node 24 hosts.
