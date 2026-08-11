import { RequestPrefetchPlan, createApp, defineHttpHandler, defineWebSocketBehavior } from '@swarmmachina/swm-uws'

const prefetchPlan = new RequestPrefetchPlan({ headers: ['x-test'] })

export const handler = defineHttpHandler((res, req) => {
  req.getUrl()
  req.getHeader('x-test')
  req.prefetch(prefetchPlan).getHeaderValues('x-test')
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

export const bodyHandler = defineHttpHandler((res) => {
  const declaredLength = res.collectBodyWithLength(1024, () => {})

  if (declaredLength !== undefined && declaredLength > 1024) {
    res.discardBody()
  }
})

export const app = createApp().get('/typed', handler).post('/body', bodyHandler).ws('/typed-ws', behavior)
