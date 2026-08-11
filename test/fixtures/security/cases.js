import { requestCases } from './request.js'
import { responseCases } from './response.js'
import { socketCases } from './socket.js'
import { webSocketCases } from './websocket.js'

export const securityCases = {
  ...responseCases,
  ...requestCases,
  ...webSocketCases,
  ...socketCases
}
