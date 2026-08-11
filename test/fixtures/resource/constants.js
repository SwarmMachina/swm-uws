import { fileURLToPath } from 'node:url'

export const MAX_INBOUND_BYTES = 64 * 1024 * 1024
export const RETENTION_PROBE_BYTES = 16 * 1024 * 1024
export const retentionClientFixture = fileURLToPath(new URL('../resource-bounds-websocket-client.js', import.meta.url))
