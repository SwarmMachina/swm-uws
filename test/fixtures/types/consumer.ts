import uWS, {
  App,
  DISABLED,
  LIBUS_LISTEN_EXCLUSIVE_PORT,
  capabilities,
  createApp,
  us_listen_socket_close,
  us_socket_local_port,
  version
} from '@swarmmachina/swm-uws'
import type {
  AppInstance,
  AppOptions,
  HttpHandler,
  HttpRequest,
  HttpResponse,
  ListenOptions,
  ListenSocket,
  NativeData,
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
  HttpResponse,
  WebSocket<object>,
  WebSocketBehavior<object>,
  HttpHandler,
  AppOptions,
  ListenOptions,
  AppInstance,
  TemplatedApp
]

const app: AppInstance = createApp()

void app
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
