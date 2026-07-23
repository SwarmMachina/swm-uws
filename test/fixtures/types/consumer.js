import { createApp, defineHttpHandler, defineWebSocketBehavior } from '@swarmmachina/swm-uws'

export const handler = defineHttpHandler((res, req) => {
  req.getUrl()
  req.getHeader('x-test')
  req.snapshot()
  res.getRemoteAddress()
  res.getProxiedRemoteAddress()
  res.collectBody(1024, () => {})
})

export const behavior = defineWebSocketBehavior({
  message(ws, message, isBinary) {
    ws.send(message, isBinary)
    ws.getBufferedAmount()
  }
})

export const app = createApp().get('/typed', handler).ws('/typed-ws', behavior)
