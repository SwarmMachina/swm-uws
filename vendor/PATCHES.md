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
