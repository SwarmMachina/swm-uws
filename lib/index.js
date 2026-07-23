import { loadNative } from './load-native.js'

const native = loadNative()

/**
 * Preserve contextual typing for a separately declared HTTP handler.
 * @template Handler
 * @param {Handler} handler
 * @returns {Handler}
 */
export function defineHttpHandler(handler) {
  return handler
}

/**
 * Preserve contextual typing for a separately declared WebSocket behavior.
 * @template {object} Behavior
 * @param {Behavior} behavior
 * @returns {Behavior}
 */
export function defineWebSocketBehavior(behavior) {
  return behavior
}

export default native
export const version = native.version
export const capabilities = native.capabilities
export const createApp = native.createApp
export const App = native.App
export const us_listen_socket_close = native.us_listen_socket_close
export const us_socket_local_port = native.us_socket_local_port
export const LIBUS_LISTEN_EXCLUSIVE_PORT = native.LIBUS_LISTEN_EXCLUSIVE_PORT
export const DISABLED = native.DISABLED
