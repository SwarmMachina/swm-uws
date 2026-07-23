const uWS = require('@swarmmachina/swm-uws')
const app = uWS.App()

app.get('/', (res, req) => {
  req.getUrl()
  res.getRemoteAddress()
  res.end('ok')
})

uWS.defineHttpHandler((res, req) => res.end(req.getUrl()))
uWS.defineWebSocketBehavior({
  message(ws, message, isBinary) {
    ws.send(message, isBinary)
  }
})
uWS.createApp()
uWS.version()
