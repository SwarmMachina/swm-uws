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

## Request framing validation and metadata

`uwebsockets-request-framing.patch` rejects duplicate `Content-Length` and
`Transfer-Encoding` fields, rejects requests containing both fields, accepts
only a single case-insensitive `chunked` transfer-coding token, and validates
`Content-Length` as a non-empty decimal value no larger than JavaScript's
largest exactly representable integer before the route handler runs. Parser
errors return one `400` and close the connection before any pipelined bytes can
be dispatched.

The same pre-handler framing step records whether the request had an explicit
`Content-Length`, including zero. The native binding uses that metadata for
`collectBodyWithLength()` without performing another header lookup.

## HTTP/WebSocket security hardening

`uwebsockets-security-hardening.patch` is applied after the transport-policy
and request-framing patches. It contains the security changes that intentionally
diverge from the pinned upstream revision:

- replace the permissive chunk decoder with a byte-split-safe state machine
  that validates hexadecimal sizes, chunk extensions, data CRLF, trailers, and
  the terminal CRLF before accepting a request;
- require a complete RFC 6455 default WebSocket handshake, a canonical
  16-byte nonce in `Sec-WebSocket-Key`, version 13, and masked client frames;
- add an explicit trusted `X-Forwarded-For` or `X-Real-IP` mode with a
  configured hop count; duplicate, malformed, and non-IP values fail closed.
  When its selected HTTP header is absent, the proxied-address accessors fall
  back to the upstream peer address and port. The mode disables the legacy
  binary PROXY v2 parser only for the configured `App`, preserving the
  historical PROXY v2 address and port contract when no trusted HTTP header is
  set;
- cap explicit HTTP timeouts to the representable uSockets timeout wheel,
  handle a disabled WebSocket idle timeout without unsigned underflow, and
  preserve the forced-close deadline while shutdown backpressure drains;
- avoid reserving an entire declared fragmented-message payload up front and
  release unusually large retained fragment buffers after delivery or shutdown
  without invalidating views held by an active callback; and
- replace the default branded 404 body with a minimal generic response.

The patch is generated as the exact diff from the committed vendored tree to
the hardened tree. Replaying it on a clean `HEAD` copy must reproduce every
file byte-for-byte, including the added `src/ForwardedAddress.h`.
