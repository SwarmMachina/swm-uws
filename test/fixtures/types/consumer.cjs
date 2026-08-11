const uWS = require('@swarmmachina/swm-uws')
const app = uWS.App()

app.get('/', (res, req) => {
  req.getUrl()
  res.getRemoteAddress()
  res.end('ok')
})
app.post('/body', (res) => {
  const declaredLength = res.collectBodyWithLength(1024, () => {})

  if (declaredLength !== undefined && declaredLength > 1024) {
    res.discardBody()
  }
})

uWS.defineHttpHandler((res, req) => res.end(req.getUrl()))
uWS.defineWebSocketBehavior({
  message(ws, message, isBinary) {
    ws.send(message, isBinary)
  }
})
uWS.createApp()
uWS.version()
