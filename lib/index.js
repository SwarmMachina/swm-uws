import { loadNative } from './load-native.js'

const native = loadNative()

export const version = native.version
export const capabilities = native.capabilities
export const createApp = native.createApp
export const App = native.App
export const us_listen_socket_close = native.us_listen_socket_close
