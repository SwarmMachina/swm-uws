# Changelog

## 0.6.0 — 2026-08-05

### Added

- Per-`App` HTTP header limits, lifecycle timeouts, minimum body-rate enforcement,
  and inexpensive transport counters.
- Compiled `RequestPrefetchPlan` and owned selective-header snapshots.
- C++ formatting and static-analysis gates based on LLVM 18.

### Changed

- Split the native binding into focused application, request, response,
  WebSocket, environment, and state translation units.
- Replaced the eager `HttpRequest.snapshot()` extension and
  `requestSnapshot` capability with selective `HttpRequest.prefetch()` and
  `requestPrefetch`.
- Balanced PGO training and Linux AB/BA performance qualification now cover
  raw HTTP, body collection, WebSocket traffic, and request prefetch.

### Performance

- The portable Clang 18 PGO+LTO build measured 12.71% higher paired raw-GET
  throughput than pinned uWebSockets.js 20.69.0 on the isolated Linux release
  host, with lower p95, p99, and RSS.
- Materialized selective prefetch measured 15.4% faster than JavaScript header
  filtering. Unused prefetch remains intentionally opt-in because its copy cost
  is measurable.
