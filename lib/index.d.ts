export type NativeData = string | ArrayBuffer | ArrayBufferView

export interface ListenSocket {
  readonly __swmUwsListenSocket: unique symbol
}

export interface SocketContext {
  readonly __swmUwsSocketContext: unique symbol
}

export interface HttpRequest {
  getMethod(): string
  getUrl(): string
  getHeader(name: string): string
  getQuery(): string
  getQuery(key: string): string | undefined
  getParameter(index: number): string | undefined
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
  end(body?: NativeData): this
  endBatch(status: string, headerLines: string[], body?: NativeData): this
  writeStatus(status: string): this
  writeHeader(name: string, value: string): this
  cork(handler: () => void): this
  beginWrite(): this
  write(chunk: NativeData): boolean
  tryEnd(chunk: NativeData, totalSize: number): [ok: boolean, done: boolean]
  onWritable(handler: (offset: number) => boolean): this
  getWriteOffset(): number
  getRemoteAddressAsText(): ArrayBuffer
  upgrade<UserData>(userData: UserData, key: string, protocol: string, extensions: string, context: SocketContext): void
  onData(handler: (chunk: ArrayBuffer, isLast: boolean) => void): this
  collectBody(maxSize: number, handler: (body: ArrayBuffer | null) => void): this
  pause(): void
  resume(): void
  onAborted(handler: () => void): this
}

export interface WebSocket<UserData = unknown> {
  send(message: NativeData, isBinary?: boolean, compress?: boolean): number
  end(code?: number, reason?: string): this
  close(): this
  getBufferedAmount(): number
  getUserData(): UserData
  subscribe(topic: string): boolean
  unsubscribe(topic: string): boolean
}

export interface WebSocketBehavior<UserData = unknown> {
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
  drain?: (ws: WebSocket<UserData>) => void
  subscription?: (ws: WebSocket<UserData>, topic: ArrayBuffer, newCount: number, oldCount: number) => void
  close?: (ws: WebSocket<UserData>, code: number, reason: ArrayBuffer) => void
}

export type HttpHandler = (res: HttpResponse, req: HttpRequest) => void

export interface AppInstance {
  get(path: string, handler: HttpHandler): this
  post(path: string, handler: HttpHandler): this
  put(path: string, handler: HttpHandler): this
  patch(path: string, handler: HttpHandler): this
  del(path: string, handler: HttpHandler): this
  options(path: string, handler: HttpHandler): this
  head(path: string, handler: HttpHandler): this
  any(path: string, handler: HttpHandler): this
  ws<UserData = unknown>(path: string, behavior: WebSocketBehavior<UserData>): this
  publish(topic: string, message: NativeData, isBinary?: boolean): boolean
  numSubscribers(topic: string): number
  listen(port: number, callback: (socket: ListenSocket | false) => void): this
  listen(host: string, port: number, callback: (socket: ListenSocket | false) => void): this
  close(): this
}

export function App(): AppInstance
export function createApp(): AppInstance
export function us_listen_socket_close(socket: ListenSocket): void
export function version(): string
export function capabilities(): {
  beginWrite: true
  collectBody: true
  requestSnapshot: true
  responseBatch: true
  requestPause: true
}
