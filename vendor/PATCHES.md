# Vendored patches

## `beginWrite()` first-chunk framing

The uWebSockets revision `fe7c01a477b688a7743f754fee33bdd78d52ad91`
flushes the HTTP header terminator in `beginWrite()` but the next `write()` or
`end()` still emits the normal leading chunk separator. That produces an empty
line before the first chunk size and violates HTTP/1.1 chunk framing.

The local `HTTP_CHUNKED_READY` state bit records that `beginWrite()` already
emitted the separator. The first subsequent chunk or terminal zero chunk
consumes the bit and omits the duplicate CRLF.

The patch is kept as a standalone diff under `vendor/patches/` and is reapplied
after every upstream refresh.

## Per-App HTTP transport policy

`uwebsockets-http-transport-policy.patch` moves HTTP header limits and timeout
policy from process-wide/static behavior into immutable data owned by each
`App`. It adds bounded header-count parsing, phase-specific timeout handling,
minimum request-body throughput enforcement, and per-App transport counters.

The binding validates and constructs the policy synchronously. The vendored
layer remains responsible for applying it at parser/socket lifecycle boundaries,
including HTTP-to-WebSocket upgrades.

Timeout-wheel seconds and the body-rate reset threshold are precomputed once
when an `App` is constructed. Transport policy and counters live after router
state in `HttpContextData`, keeping cold observability data out of the dispatch
layout.

The patch assumes `uwebsockets-begin-write-framing.patch` has already been
applied; patch files are sorted by name by `scripts/update-vendor.js`, which
preserves that order.

## Request framing validation

`uwebsockets-request-framing.patch` rejects duplicate `Content-Length` and
`Transfer-Encoding` fields, rejects requests containing both fields, accepts
only a single case-insensitive `chunked` transfer-coding token, and validates
`Content-Length` before the route handler runs. Parser errors return one `400`
and close the connection before any pipelined bytes can be dispatched.
