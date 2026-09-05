/**
 * A text or binary value accepted by the native binding.
 *
 * Strings are encoded as UTF-8. An `ArrayBufferView` contributes only its
 * visible `byteOffset` and `byteLength` range.
 */
export type NativeData = string | ArrayBuffer | SharedArrayBuffer | ArrayBufferView

/** Upstream-compatible alias for {@link NativeData}. */
export type RecognizedString = NativeData

declare const listenSocketBrand: unique symbol
declare const socketBrand: unique symbol
declare const socketContextBrand: unique symbol

/**
 * Opaque native listen token returned by {@link AppInstance.listen}.
 *
 * Pass it only to {@link us_listen_socket_close} or
 * {@link us_socket_local_port}.
 */
export interface ListenSocket {
  readonly [listenSocketBrand]: true
}

/** Upstream-compatible opaque native socket marker. */
export interface Socket {
  readonly [socketBrand]: true
}

/**
 * Opaque socket context supplied to a custom WebSocket upgrade callback.
 *
 * It is valid only during the upgrade operation.
 */
export interface SocketContext {
  readonly [socketContextBrand]: true
}

/** Upstream-compatible alias for {@link ListenSocket}. */
export type us_listen_socket = ListenSocket

/** Upstream-compatible alias for {@link Socket}. */
export type us_socket = Socket

/** Upstream-compatible alias for {@link SocketContext}. */
export type us_socket_context_t = SocketContext

/** Header set captured by a compiled {@link RequestPrefetchPlan}. */
export type RequestHeaderSelection = 'all' | readonly string[]

/**
 * A native-owned immutable response-header block.
 *
 * Construction copies and validates at most 64 name/value pairs and 64 KiB of
 * UTF-8 payload. `Content-Length` and `Transfer-Encoding` remain managed by the
 * binding and are rejected.
 */
export class PreparedHeaderBlock {
  constructor(headerLines: readonly string[])
}

/**
 * Compiles a reusable, immutable request-header selection.
 *
 * Header names are validated, normalized to lowercase, deduplicated, and tied
 * to the current Node environment.
 */
export class RequestPrefetchPlan {
  constructor(options: { headers: RequestHeaderSelection })

  readonly headerNames: readonly string[]
}

/** Owned selected-header data that remains valid after the route callback. */
export interface RequestPrefetchSnapshot {
  /** Returns the first wire value, or `undefined` when the header is absent. */
  getHeader(name: string): string | undefined

  /** Returns every wire value in order, or `undefined` when absent. */
  getHeaderValues(name: string): readonly string[] | undefined

  /** Materializes a null-prototype record; the last wire value wins. */
  getHeaders(): Record<string, string>

  /** Returns `[lowercaseName, value, ...]` in wire order. */
  getHeaderEntries(): readonly string[]
}

/**
 * A stack-backed HTTP request wrapper.
 *
 * The wrapper is valid only during its route or upgrade callback. Values
 * returned by individual getters are owned JavaScript values and may be
 * retained after the callback returns.
 */
export interface HttpRequest {
  /** Returns the lowercase request method. */
  getMethod(): string

  /** Returns the request method with its original casing. */
  getCaseSensitiveMethod(): string

  /** Returns the URL path without the query string. */
  getUrl(): string

  /**
   * Returns a request header value.
   *
   * Header names are case-insensitive. A missing field returns an empty
   * string.
   */
  getHeader(name: NativeData): string

  /** Returns the complete query string without a leading `?`. */
  getQuery(): string

  /** Returns the first value for a query key, or `undefined` when absent. */
  getQuery(key: NativeData): string | undefined

  /** Returns a positional or named route parameter, or `undefined`. */
  getParameter(indexOrName: number | NativeData): string | undefined

  /**
   * Controls whether routing continues after the current route handler.
   *
   * @returns This request wrapper.
   */
  setYield(value: boolean): this

  /**
   * Visits each request header.
   *
   * Iteration stops immediately if `handler` throws.
   */
  forEach(handler: (name: string, value: string) => void): void

  /**
   * Copies only the headers selected by a reusable native plan.
   *
   * No method, URL, query, parameter, or remote-address data is copied.
   */
  prefetch(plan: RequestPrefetchPlan): RequestPrefetchSnapshot
}

/**
 * A native HTTP response wrapper.
 *
 * Calling `end`, a completing `tryEnd`, `close`, or `upgrade` invalidates the
 * wrapper. An aborted response is already invalid inside its `onAborted`
 * callback.
 *
 * A response may outlive its route callback only after registering `onData`,
 * `onDataV2`, `onWritable`, `collectBody`, or `onAborted`.
 */
export interface HttpResponse {
  /**
   * Ends the response.
   *
   * `Content-Length` or chunked framing is selected automatically.
   *
   * @param body Optional UTF-8 or binary response body.
   * @param closeConnection Close the HTTP connection after flushing.
   * @returns This response wrapper, now invalid for further writes.
   */
  end(body?: NativeData, closeConnection?: boolean): this

  /**
   * Ends the response without sending a body.
   *
   * @param reportedContentLength Value reported in `Content-Length`.
   * @param closeConnection Close the HTTP connection after flushing.
   * @returns This response wrapper, now invalid for further writes.
   */
  endWithoutBody(reportedContentLength?: number, closeConnection?: boolean): this

  /**
   * Force-closes the connection.
   *
   * @returns This response wrapper, now invalid.
   */
  close(): this

  /**
   * Writes status, headers, and body in one corked operation.
   *
   * Header entries are a flat name/value array. `Content-Length` and
   * `Transfer-Encoding` are managed by the binding and are rejected here.
   *
   * @example
   * ```js
   * res.endBatch(
   *   '200 OK',
   *   ['content-type', 'application/json'],
   *   '{"ok":true}'
   * )
   * ```
   */
  endBatch(status: string, headerLines: string[], body?: NativeData): this

  /** Writes status, a reusable native header block, and body in one corked operation. */
  endPrepared(status: string, headers: PreparedHeaderBlock, body?: NativeData): this

  /**
   * Sets the HTTP status line.
   *
   * @example
   * ```js
   * res.writeStatus('404 Not Found')
   * ```
   */
  writeStatus(status: NativeData): this

  /**
   * Appends one response header.
   *
   * `Content-Length` and `Transfer-Encoding` are managed automatically and
   * throw when passed explicitly.
   */
  writeHeader(name: NativeData, value: NativeData): this

  /**
   * Corks writes performed by `handler` into one native I/O operation.
   *
   * The original exception is rethrown and the response is invalidated if
   * `handler` throws.
   */
  cork(handler: () => void): this

  /**
   * Flushes response headers and enters chunked transfer mode.
   *
   * Follow with {@link write}, {@link tryEnd}, or {@link end}.
   */
  beginWrite(): this

  /**
   * Writes one response chunk.
   *
   * @returns `true` when the write completed without backpressure.
   */
  write(chunk: NativeData): boolean

  /**
   * Writes a response chunk when the total body size is known.
   *
   * Every call for one response must use the same `totalSize`; a chunk may not
   * exceed the remaining declared bytes. An empty chunk does not complete a
   * response while declared bytes remain.
   *
   * @returns `[writeSucceeded, responseCompleted]`.
   */
  tryEnd(chunk: NativeData, totalSize: number): [ok: boolean, done: boolean]

  /**
   * Registers the response backpressure callback.
   *
   * Return `true` when the attempted continuation succeeded, or `false` when
   * it did not. A thrown exception is not converted into either result.
   */
  onWritable(handler: (offset: number) => boolean): this

  /** Returns the number of response body bytes accepted by the transport. */
  getWriteOffset(): number

  /** Returns the peer IP address in binary IPv4 or IPv6 form. */
  getRemoteAddress(): ArrayBuffer

  /** Returns the peer IP address encoded as textual bytes. */
  getRemoteAddressAsText(): ArrayBuffer

  /** Returns the peer TCP port in host representation. */
  getRemotePort(): number

  /** Returns the trusted HTTP proxy IP, or the upstream peer IP when the configured header is absent. */
  getProxiedRemoteAddress(): ArrayBuffer

  /** Returns the trusted HTTP proxy IP as text, or the upstream peer IP when the configured header is absent. */
  getProxiedRemoteAddressAsText(): ArrayBuffer

  /** Returns `0` for a trusted HTTP address header, or the upstream peer port when the header is absent. */
  getProxiedRemotePort(): number

  /**
   * Upgrades this HTTP response to a WebSocket.
   *
   * Own string and symbol descriptors from `userData` are copied to the
   * WebSocket wrapper. Inherited properties are skipped, accessors are not
   * invoked, and binding-owned methods cannot be shadowed.
   */
  upgrade<UserData>(
    userData: UserData,
    key: NativeData,
    protocol: NativeData,
    extensions: NativeData,
    context: SocketContext
  ): void

  /**
   * Registers a zero-copy request body callback.
   *
   * `chunk` is detached after `handler` returns. Copy it synchronously before
   * retaining it.
   */
  onData(handler: (chunk: ArrayBuffer, isLast: boolean) => void): this

  /**
   * Registers the V2 zero-copy request body callback.
   *
   * `chunk` is detached after `handler` returns.
   * `maxRemainingBodyLength === 0n` marks the final chunk.
   */
  onDataV2(handler: (chunk: ArrayBuffer, maxRemainingBodyLength: bigint) => void): this

  /**
   * Collects this request body into an owned `ArrayBuffer`.
   *
   * `maxSize` is an integer byte limit for this request only, not a process
   * memory budget. Parallel requests allocate independently. A limit breach
   * releases accumulated bytes before invoking the handler with `null`.
   *
   * @param maxSize Integer byte limit from `0` through `64 MiB`.
   * @param handler Receives the complete body, or `null` after a limit breach.
   */
  collectBody(maxSize: number, handler: (body: ArrayBuffer | null) => void): this

  /**
   * Framework collector variant that also exposes the numeric request-body
   * length already known by the native HTTP parser.
   *
   * Returns the explicit `Content-Length`, including zero, before body bytes
   * are consumed. Returns `undefined` for chunked framing or when the header is
   * absent. The synchronous metadata lets a framework reserve aggregate body
   * capacity before the native collector can grow. Body delivery reuses the
   * same owned `ArrayBuffer` and `null` limit-failure semantics as
   * {@link collectBody}.
   */
  collectBodyWithLength(maxSize: number, handler: (body: ArrayBuffer | null) => void): number | undefined

  /** Releases collected bytes and stops body callbacks while the transport drains remaining bytes. */
  discardBody(): void

  /**
   * Pauses further socket reads. Data already in the current parser buffer may
   * still be delivered. Call resume() when the consumer is ready for more data.
   */
  pause(): void

  /** Resumes delivery of request body data. */
  resume(): void

  /**
   * Registers the response abort callback.
   *
   * The response wrapper is already invalid when `handler` runs.
   */
  onAborted(handler: () => void): this
}

/**
 * A WebSocket wrapper valid from `open` until `close`.
 *
 * Message, ping, pong, subscription, and close `ArrayBuffer` values are
 * transport-owned and detached after their callback returns.
 */
export interface WebSocket<UserData = unknown> {
  /**
   * Sends one text or binary message.
   *
   * @returns `0` for backpressure, `1` for success, or `2` when dropped.
   */
  send(message: NativeData, isBinary?: boolean, compress?: boolean): number

  /** Sends the first fragment of a fragmented message. */
  sendFirstFragment(message: NativeData, isBinary?: boolean, compress?: boolean): number

  /** Sends an intermediate fragment. */
  sendFragment(message: NativeData, compress?: boolean): number

  /** Sends the final fragment. */
  sendLastFragment(message: NativeData, compress?: boolean): number

  /** Sends a ping control frame and returns native send status. */
  ping(message?: NativeData): number

  /** Publishes to every socket subscribed to `topic`. */
  publish(topic: NativeData, message: NativeData, isBinary?: boolean, compress?: boolean): boolean

  /** Corks sends performed by `handler`. */
  cork(handler: () => void): this

  /** Sends a WebSocket close frame. */
  end(code?: number, reason?: NativeData): void

  /** Force-closes the socket without a close frame. */
  close(): void

  /** Returns currently buffered outbound bytes. */
  getBufferedAmount(): number

  /** Returns the peer IP address in binary form. */
  getRemoteAddress(): ArrayBuffer

  /** Returns the peer IP address encoded as textual bytes. */
  getRemoteAddressAsText(): ArrayBuffer

  /** Returns the peer TCP port. */
  getRemotePort(): number

  /**
   * Returns this WebSocket wrapper typed with the upgrade user-data shape.
   *
   * The upgrade data's own descriptors are copied onto the wrapper.
   */
  getUserData(): UserData

  /** Subscribes this socket to `topic`. */
  subscribe(topic: NativeData): boolean

  /** Removes this socket's subscription to `topic`. */
  unsubscribe(topic: NativeData): boolean

  /** Tests whether this socket subscribes to `topic`. */
  isSubscribed(topic: NativeData): boolean

  /** Returns this socket's current topic subscriptions. */
  getTopics(): string[]
}

/** WebSocket route options and event callbacks. */
export interface WebSocketBehavior<UserData = unknown> {
  /**
   * Compression setting.
   *
   * Only {@link DISABLED} is supported by this non-compression build.
   */
  compression?: typeof DISABLED

  /** Maximum accepted message payload in bytes, from `1` through `64 MiB`. */
  maxPayloadLength?: number

  /** Idle timeout in seconds; `0` disables it, otherwise use `8` through `960`. */
  idleTimeout?: number

  /** Maximum queued outbound bytes for each socket. */
  maxBackpressure?: number

  /** Maximum socket lifetime in minutes, from `0` through `240`. */
  maxLifetime?: number

  /** Close the socket when a send exceeds {@link maxBackpressure}. */
  closeOnBackpressureLimit?: boolean

  /** Reset the idle timeout after a successful send. */
  resetIdleTimeoutOnSend?: boolean

  /** Let the transport send idle-timeout pings automatically. */
  sendPingsAutomatically?: boolean

  /** Performs a custom HTTP-to-WebSocket upgrade. */
  upgrade?: (res: HttpResponse, req: HttpRequest, context: SocketContext) => void

  /** Runs after the WebSocket opens. */
  open?: (ws: WebSocket<UserData>) => void

  /** Receives a complete text or binary message. */
  message?: (ws: WebSocket<UserData>, message: ArrayBuffer, isBinary: boolean) => void

  /** Reports an outbound message dropped at the backpressure limit. */
  dropped?: (ws: WebSocket<UserData>, message: ArrayBuffer, isBinary: boolean) => void

  /** Runs when buffered output drains. */
  drain?: (ws: WebSocket<UserData>) => void

  /** Receives a ping payload. */
  ping?: (ws: WebSocket<UserData>, message: ArrayBuffer) => void

  /** Receives a pong payload. */
  pong?: (ws: WebSocket<UserData>, message: ArrayBuffer) => void

  /** Reports a topic subscription-count change. */
  subscription?: (ws: WebSocket<UserData>, topic: ArrayBuffer, newCount: number, oldCount: number) => void

  /**
   * Runs during socket cleanup.
   *
   * The WebSocket wrapper is already invalid when this callback runs.
   */
  close?: (ws: WebSocket<UserData>, code: number, reason: ArrayBuffer) => void
}

/** An HTTP route callback. */
export type HttpHandler = (res: HttpResponse, req: HttpRequest) => void

/**
 * Preserves contextual typing for a separately declared HTTP route callback.
 *
 * The function returns `handler` unchanged. It performs no wrapping,
 * validation, or allocation.
 *
 * @example
 * ```js
 * import { defineHttpHandler } from '@swarmmachina/swm-uws'
 *
 * const handler = defineHttpHandler((res, req) => {
 *   res.end(req.getUrl())
 * })
 * ```
 */
export function defineHttpHandler<const Handler extends HttpHandler>(handler: Handler): Handler

/**
 * Preserves contextual typing for a separately declared WebSocket behavior.
 *
 * The function returns `behavior` unchanged. Inline objects passed directly to
 * `app.ws()` are already contextually typed and do not require this helper.
 *
 * @example
 * ```js
 * import { defineWebSocketBehavior } from '@swarmmachina/swm-uws'
 *
 * const behavior = defineWebSocketBehavior({
 *   message(ws, message, isBinary) {
 *     ws.send(message, isBinary)
 *   }
 * })
 * ```
 */
export function defineWebSocketBehavior<
  UserData = unknown,
  const Behavior extends WebSocketBehavior<UserData> = WebSocketBehavior<UserData>
>(behavior: Behavior): Behavior

/** Explicit trust boundary for an HTTP listener reached only through known reverse proxies. */
export interface TrustedProxyOptions {
  /** Header written or sanitized by the trusted proxy. */
  header: 'x-forwarded-for' | 'x-real-ip'

  /** Address selected from the right of `X-Forwarded-For`; `1` is the rightmost entry. */
  hops?: number
}

/** Per-application HTTP parser and lifecycle policy. */
export interface HttpTransportOptions {
  /** Maximum bytes in the request line and all request header fields, up to `64 MiB`. */
  maxHeaderSize?: number

  /** Maximum number of request header fields, excluding parser sentinel slots. */
  maxHeaderCount?: number

  /** Maximum time allowed to receive a complete request head, up to `956000` ms. */
  headersTimeoutMs?: number

  /** Maximum wait for the next request on an idle HTTP keep-alive socket, up to `956000` ms. */
  keepAliveTimeoutMs?: number

  /** Idle timeout while receiving a request body, up to `956000` ms. */
  bodyIdleTimeoutMs?: number

  /** Minimum sustained body receive rate; `null` disables rate enforcement. */
  minBodyRateBytesPerSec?: number | null

  /** Timeout while a response remains blocked by outbound backpressure, up to `956000` ms. */
  responseWriteTimeoutMs?: number

  /**
   * Trusts one forwarded-address header for this listener.
   *
   * Leave unset on public listeners. The nearest proxy must overwrite or
   * sanitize the configured header before forwarding the request.
   */
  trustedProxy?: TrustedProxyOptions
}

/** Application construction options. Unknown top-level fields are ignored. */
export interface AppOptions {
  http?: HttpTransportOptions
  [key: string]: unknown
}

/** Snapshot of inexpensive per-application HTTP transport counters. */
export interface HttpTransportStats {
  activeConnections: number
  headerTooLarge: number
  headerCountExceeded: number
  headerTimeouts: number
  bodyTimeouts: number
  bodyRateViolations: number
  responseWriteTimeouts: number
}

/** Listen flags accepted by {@link AppInstance.listen}. */
export type ListenOptions = 0 | typeof LIBUS_LISTEN_EXCLUSIVE_PORT

/** Callback invoked after a listen attempt. */
export type ListenHandler = (socket: ListenSocket | false) => void

/** A non-TLS HTTP and WebSocket application. */
export interface AppInstance {
  /** Registers a GET route. */
  get(path: NativeData, handler: HttpHandler): this

  /** Registers a POST route. */
  post(path: NativeData, handler: HttpHandler): this

  /** Registers a PUT route. */
  put(path: NativeData, handler: HttpHandler): this

  /** Registers a PATCH route. */
  patch(path: NativeData, handler: HttpHandler): this

  /** Registers a DELETE route. */
  del(path: NativeData, handler: HttpHandler): this

  /** Registers an OPTIONS route. */
  options(path: NativeData, handler: HttpHandler): this

  /** Registers a HEAD route. */
  head(path: NativeData, handler: HttpHandler): this

  /** Registers a CONNECT route. */
  connect(path: NativeData, handler: HttpHandler): this

  /** Registers a TRACE route. */
  trace(path: NativeData, handler: HttpHandler): this

  /** Registers a route for any supported HTTP method. */
  any(path: NativeData, handler: HttpHandler): this

  /** Registers a WebSocket route. */
  ws<UserData = unknown>(path: NativeData, behavior: WebSocketBehavior<UserData>): this

  /** Publishes to all WebSockets subscribed to `topic`. */
  publish(topic: NativeData, message: NativeData, isBinary?: boolean, compress?: boolean): boolean

  /** Returns the current subscriber count for `topic`. */
  numSubscribers(topic: NativeData): number

  /** Listens on all interfaces. */
  listen(port: number, callback: ListenHandler): this

  /** Listens on all interfaces with native listen flags. */
  listen(port: number, options: ListenOptions, callback: ListenHandler): this

  /** Listens on `host`. */
  listen(host: NativeData, port: number, callback: ListenHandler): this

  /** Listens on `host` with native listen flags. */
  listen(host: NativeData, port: number, options: ListenOptions, callback: ListenHandler): this

  /** Listens on a Unix-domain socket. */
  listen_unix(callback: ListenHandler, path: NativeData): this

  /** Listens on a Unix-domain socket with native listen flags. */
  listen_unix(options: ListenOptions, callback: ListenHandler, path: NativeData): this

  /**
   * Registers a callback for HTTP connection-count changes.
   * During a negative-count (disconnect) callback, only remote-address and
   * remote-port accessors are available on `res`; other methods throw.
   */
  filter(handler: (res: HttpResponse, count: number) => void): this

  /** Returns a snapshot of this application's native HTTP transport counters. */
  getHttpTransportStats(): HttpTransportStats

  /** Idempotently closes listeners and connections; releases contexts and handlers after active callbacks return. */
  close(): this
}

/** Upstream-compatible alias for {@link AppInstance}. */
export type TemplatedApp = AppInstance

/** Creates a non-TLS application. */
export function App(options?: AppOptions): AppInstance

/** Alias of {@link App}. */
export function createApp(options?: AppOptions): AppInstance

/** Closes a native listen token. */
export function us_listen_socket_close(socket: ListenSocket): void

/** Returns the local port associated with a live native listen token. */
export function us_socket_local_port(socket: ListenSocket): number

/** Native exclusive-port listen flag. */
export const LIBUS_LISTEN_EXCLUSIVE_PORT: 1

/** The only supported WebSocket compression setting. */
export const DISABLED: 0

/** Returns the binding and pinned upstream version string. */
export function version(): string

/** Compile-time and runtime feature flags for binding extensions. */
export interface Capabilities {
  readonly beginWrite: true
  readonly collectBody: true
  readonly collectBodyLength: true
  readonly httpTransportConfig: true
  readonly preparedHeaders: true
  readonly requestPrefetch: true
  readonly responseBatch: true
  readonly requestPause: true
}

/** Returns the extensions implemented by this binding. */
export function capabilities(): Capabilities

declare const api: {
  readonly version: typeof version
  readonly capabilities: typeof capabilities
  readonly createApp: typeof createApp
  readonly App: typeof App
  readonly PreparedHeaderBlock: typeof PreparedHeaderBlock
  readonly RequestPrefetchPlan: typeof RequestPrefetchPlan
  readonly us_listen_socket_close: typeof us_listen_socket_close
  readonly us_socket_local_port: typeof us_socket_local_port
  readonly LIBUS_LISTEN_EXCLUSIVE_PORT: typeof LIBUS_LISTEN_EXCLUSIVE_PORT
  readonly DISABLED: typeof DISABLED
}

export default api
