// @ts-check

const uWS = require('@swarmmachina/swm-uws')
const app = uWS.App()

app.get('/', (res, req) => {
  req.getUrl()
  res.getRemoteAddress()
  res.end('ok')
})

uWS.createApp()
uWS.version()
