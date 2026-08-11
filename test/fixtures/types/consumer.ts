import uWS, {
  App,
  DISABLED,
  LIBUS_LISTEN_EXCLUSIVE_PORT,
  RequestPrefetchPlan,
  capabilities,
  createApp,
  defineHttpHandler,
  defineWebSocketBehavior,
  us_listen_socket_close,
  us_socket_local_port,
  version
} from '@swarmmachina/swm-uws'
import type {
  AppInstance,
  AppOptions,
  Capabilities,
  HttpHandler,
  HttpRequest,
  HttpTransportOptions,
  HttpTransportStats,
  HttpResponse,
  ListenHandler,
  ListenOptions,
  ListenSocket,
  NativeData,
  RequestHeaderSelection,
  RequestPrefetchSnapshot,
  RecognizedString,
  Socket,
  SocketContext,
  TemplatedApp,
  WebSocket,
  WebSocketBehavior,
  us_listen_socket,
  us_socket,
  us_socket_context_t
} from '@swarmmachina/swm-uws'

type PublicTypes = [
  NativeData,
  RecognizedString,
  ListenSocket,
  Socket,
  SocketContext,
  us_listen_socket,
  us_socket,
  us_socket_context_t,
  HttpRequest,
  HttpTransportOptions,
  HttpTransportStats,
  RequestHeaderSelection,
  RequestPrefetchSnapshot,
  HttpResponse,
  WebSocket<object>,
  WebSocketBehavior<object>,
  HttpHandler,
  ListenHandler,
  AppOptions,
  ListenOptions,
  AppInstance,
  TemplatedApp,
  Capabilities
]

const app: AppInstance = createApp()
const prefetchPlan = new RequestPrefetchPlan({ headers: ['authorization'] })
const handler = defineHttpHandler((res, req) => res.end(req.getUrl()))
const bodyLengthHandler = defineHttpHandler((res) => res.collectBodyWithLength(1024, () => {}))
const bodyDiscardHandler = defineHttpHandler((res) => {
  const result: void = res.discardBody()

  return result
})
const behavior = defineWebSocketBehavior({
  message(ws, message, isBinary) {
    ws.send(message, isBinary)
  }
})

void app
void handler
void bodyLengthHandler
void bodyDiscardHandler
void behavior
void prefetchPlan
void uWS
void App
void version
void capabilities
void us_listen_socket_close
void us_socket_local_port
void LIBUS_LISTEN_EXCLUSIVE_PORT
void DISABLED

declare const types: PublicTypes
void types
