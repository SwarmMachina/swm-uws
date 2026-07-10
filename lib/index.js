import { loadNative } from './load-native.js'

const native = loadNative()

export const version = native.version
export const createApp = native.createApp
