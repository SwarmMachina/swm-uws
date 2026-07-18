export type NativeData = string | ArrayBuffer | SharedArrayBuffer | ArrayBufferView

export interface ListenSocket {
  readonly __swmUwsListenSocket: unique symbol
}

export interface Socket {
  readonly __swmUwsSocket: unique symbol
}

export interface SocketContext {
  readonly __swmUwsSocketContext: unique symbol
}

export type RecognizedString = NativeData
export type us_listen_socket = ListenSocket
export type us_socket = Socket
export type us_socket_context_t = SocketContext

export interface HttpRequest {
  getMethod(): string
  getCaseSensitiveMethod(): string
  getUrl(): string
  getHeader(name: NativeData): string
  getQuery(): string
  getQuery(key: NativeData): string | undefined
  getParameter(indexOrName: number | NativeData): string | undefined
  setYield(value: boolean): this
  forEach(handler: (name: string, value: string) => void): void
  snapshot(paramCount?: number): {
    method: string
    url: string
    query: string
    headers: Record<string, string>
    params: Array<string | undefined>
  }
}

export interface HttpResponse {
  end(body?: NativeData, closeConnection?: boolean): this
  endWithoutBody(reportedContentLength?: number, closeConnection?: boolean): this
  close(): this
  endBatch(status: string, headerLines: string[], body?: NativeData): this
  writeStatus(status: NativeData): this
  writeHeader(name: NativeData, value: NativeData): this
  cork(handler: () => void): this
  beginWrite(): this
  write(chunk: NativeData): boolean
  tryEnd(chunk: NativeData, totalSize: number): [ok: boolean, done: boolean]
  onWritable(handler: (offset: number) => boolean): this
  getWriteOffset(): number
  getRemoteAddress(): ArrayBuffer
  getRemoteAddressAsText(): ArrayBuffer
  getRemotePort(): number
  getProxiedRemoteAddress(): ArrayBuffer
  getProxiedRemoteAddressAsText(): ArrayBuffer
  getProxiedRemotePort(): number
  upgrade<UserData>(
    userData: UserData,
    key: NativeData,
    protocol: NativeData,
    extensions: NativeData,
    context: SocketContext
  ): void
  onData(handler: (chunk: ArrayBuffer, isLast: boolean) => void): this
  onDataV2(handler: (chunk: ArrayBuffer, maxRemainingBodyLength: bigint) => void): this
  collectBody(maxSize: number, handler: (body: ArrayBuffer | null) => void): this
  pause(): void
  resume(): void
  onAborted(handler: () => void): this
}

export interface WebSocket<UserData = unknown> {
  send(message: NativeData, isBinary?: boolean, compress?: boolean): number
  sendFirstFragment(message: NativeData, isBinary?: boolean, compress?: boolean): number
  sendFragment(message: NativeData, compress?: boolean): number
  sendLastFragment(message: NativeData, compress?: boolean): number
  ping(message?: NativeData): number
  publish(topic: NativeData, message: NativeData, isBinary?: boolean, compress?: boolean): boolean
  cork(handler: () => void): this
  end(code?: number, reason?: NativeData): void
  close(): void
  getBufferedAmount(): number
  getRemoteAddress(): ArrayBuffer
  getRemoteAddressAsText(): ArrayBuffer
  getRemotePort(): number
  getUserData(): UserData
  subscribe(topic: NativeData): boolean
  unsubscribe(topic: NativeData): boolean
  isSubscribed(topic: NativeData): boolean
  getTopics(): string[]
}

export interface WebSocketBehavior<UserData = unknown> {
  compression?: typeof DISABLED
  maxPayloadLength?: number
  idleTimeout?: number
  maxBackpressure?: number
  maxLifetime?: number
  closeOnBackpressureLimit?: boolean
  resetIdleTimeoutOnSend?: boolean
  sendPingsAutomatically?: boolean
  upgrade?: (res: HttpResponse, req: HttpRequest, context: SocketContext) => void
  open?: (ws: WebSocket<UserData>) => void
  message?: (ws: WebSocket<UserData>, message: ArrayBuffer, isBinary: boolean) => void
  dropped?: (ws: WebSocket<UserData>, message: ArrayBuffer, isBinary: boolean) => void
  drain?: (ws: WebSocket<UserData>) => void
  ping?: (ws: WebSocket<UserData>, message: ArrayBuffer) => void
  pong?: (ws: WebSocket<UserData>, message: ArrayBuffer) => void
  subscription?: (ws: WebSocket<UserData>, topic: ArrayBuffer, newCount: number, oldCount: number) => void
  close?: (ws: WebSocket<UserData>, code: number, reason: ArrayBuffer) => void
}

export type HttpHandler = (res: HttpResponse, req: HttpRequest) => void

export interface AppOptions {
  [key: string]: unknown
}

export enum ListenOptions {
  LIBUS_LISTEN_DEFAULT = 0,
  LIBUS_LISTEN_EXCLUSIVE_PORT = 1
}

export interface AppInstance {
  get(path: NativeData, handler: HttpHandler): this
  post(path: NativeData, handler: HttpHandler): this
  put(path: NativeData, handler: HttpHandler): this
  patch(path: NativeData, handler: HttpHandler): this
  del(path: NativeData, handler: HttpHandler): this
  options(path: NativeData, handler: HttpHandler): this
  head(path: NativeData, handler: HttpHandler): this
  connect(path: NativeData, handler: HttpHandler): this
  trace(path: NativeData, handler: HttpHandler): this
  any(path: NativeData, handler: HttpHandler): this
  ws<UserData = unknown>(path: NativeData, behavior: WebSocketBehavior<UserData>): this
  publish(topic: NativeData, message: NativeData, isBinary?: boolean, compress?: boolean): boolean
  numSubscribers(topic: NativeData): number
  listen(port: number, callback: (socket: ListenSocket | false) => void): this
  listen(port: number, options: ListenOptions, callback: (socket: ListenSocket | false) => void): this
  listen(host: NativeData, port: number, callback: (socket: ListenSocket | false) => void): this
  listen(host: NativeData, port: number, options: ListenOptions, callback: (socket: ListenSocket | false) => void): this
  listen_unix(callback: (socket: ListenSocket | false) => void, path: NativeData): this
  listen_unix(options: ListenOptions, callback: (socket: ListenSocket | false) => void, path: NativeData): this
  filter(handler: (res: HttpResponse, count: number) => void): this
  close(): this
}

export type TemplatedApp = AppInstance

export function App(options?: AppOptions): AppInstance
export function createApp(options?: AppOptions): AppInstance
export function us_listen_socket_close(socket: ListenSocket): void
export function us_socket_local_port(socket: Socket | ListenSocket): number
export const LIBUS_LISTEN_EXCLUSIVE_PORT: 1
export const DISABLED: 0
export function version(): string
export function capabilities(): {
  beginWrite: true
  collectBody: true
  requestSnapshot: true
  responseBatch: true
  requestPause: true
}

declare const api: {
  readonly version: typeof version
  readonly capabilities: typeof capabilities
  readonly createApp: typeof createApp
  readonly App: typeof App
  readonly us_listen_socket_close: typeof us_listen_socket_close
  readonly us_socket_local_port: typeof us_socket_local_port
  readonly LIBUS_LISTEN_EXCLUSIVE_PORT: typeof LIBUS_LISTEN_EXCLUSIVE_PORT
  readonly DISABLED: typeof DISABLED
}

export default api
