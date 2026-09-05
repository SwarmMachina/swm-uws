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

The patch is generated as the exact diff for this hardening layer. Replaying
all patches on a clean `HEAD` copy must reproduce every vendored file
byte-for-byte, including the added `src/ForwardedAddress.h`.

## Canonical WebSocket payload-length framing

`uwebsockets-websocket-length-framing.patch` rejects extended payload-length
encodings when the value fits in the shorter RFC 6455 form, and rejects 64-bit
lengths with the reserved high bit set. This removes differential frame
boundaries between strict intermediaries and the server parser.

## Re-entrant WebSocket topic-tree callbacks

`uwebsockets-topic-tree-reentrancy.patch` makes pub/sub traversal fail closed
when a synchronous `dropped` callback closes a socket, closes the `App`, or
otherwise changes topic membership. A monotonic topology version prevents an
invalidated `unordered_set` or drainage-list iterator from being advanced. A
separate message-palette version stops an outer drain when a nested drain clears
the shared message storage, and `WebSocket::send()` stops when its pre-send
drain was interrupted. A normal backpressure stop remains local to one
subscriber, so the loop-level drain still reports drops for every stalled
subscriber in the batch.

The normal publish path adds only constant-time version checks and does not
allocate. The copied payload used by the binding's exceptional `dropped` path
keeps JavaScript-visible bytes valid across re-entrant publishes and closure.

## Wire-callback lifecycle hardening

`uwebsockets-wire-callback-lifecycle.patch` commits HTTP parser state before
calling body handlers and stops parsing immediately when a callback replaces or
closes the socket. This prevents chunked and fixed-length parser state from
being touched after a re-entrant close. Connection filters and writable handlers
also stop before dereferencing socket-owned state after callback-driven closure,
and `HttpResponse::cork()` checks the current corked allocation rather than the
possibly-reallocated pre-upgrade response before releasing the loop cork.

For WebSockets, subscription removal is snapshotted only on the close path and
the topic tree is unlinked before user callbacks run. Close notification and
per-socket user-data destruction are tracked independently so re-entrant
`end()`, `close()`, and `App::close()` paths perform each exactly once. The
HTTP-to-WebSocket handoff releases the loop cork through the closed-socket fast
path when `open` synchronously closes the newly upgraded socket, then stops
before reading the destroyed WebSocket extension. The protocol parser rejects the forbidden
one-byte close payload and stops
after an automatic pong triggers a re-entrant close or graceful shutdown through
backpressure. A fragmented-message view is released before that graceful-stop
path returns, so a callback-driven `end()` cannot retain the large assembly
buffer until socket teardown. A second close-time cleanup prevents callbacks
from leaving a new dangling topic subscription even when an embedding exposes a
closed native socket.

The HTTP path adds only constant-time state updates and no allocation. Normal
WebSocket message and publish paths are unchanged; close-time snapshot cost is
linear in that socket's subscription count.

## Stop receiving when an HTTP body callback pauses the socket

`usockets-read-pause.patch` rechecks the socket's current readable interest before
handling a readable event and before repeating a full-buffer `recv`. Previously,
`HttpResponse::pause()` changed polling interest but the active receive loop
continued delivering 512 KiB buffers until the socket was drained. A slow upload
consumer could consequently retain almost the entire request in its JS queue.

A callback can still receive data already present in the current parser buffer
(for example, multiple HTTP chunks in one receive). Pausing prevents the next
receive; resuming restores normal polling and preserves the full-buffer drain
behavior while reads remain enabled. No payload copy or allocation is added.

The vendor updater applies `usockets-*` patches to `vendor/uSockets`; the existing
`uwebsockets-*` patches continue to target `vendor/uWebSockets`.

## HTTP callback ownership and completion

`uwebsockets-z-lifecycle-ownership.patch` keeps an executing body handler alive
outside the HTTP socket extension. An upgrade can destroy that extension; the
parser checks for the replacement socket before reading the old response again.
A generation counter preserves re-entrant handler replacement when a partial
body callback returns. Final body drainage restores the keep-alive or response
write deadline even when the response was completed before the request body.
The writable path also returns immediately after closing a drained socket.

An empty `tryEnd` chunk no longer marks a response complete when declared body
bytes remain. The separate `endWithoutBody` behavior is preserved.

## Closed sockets at loop teardown

`usockets-z-loop-cleanup.patch` frees the loop's deferred closed-socket list
before releasing loop data. Node environment cleanup can close sockets after
the last uSockets post iteration, so relying on another iteration leaked socket
allocations and their libuv polling handles. libuv still owns the final close
callbacks and releases the poll handles in its normal teardown phase.
