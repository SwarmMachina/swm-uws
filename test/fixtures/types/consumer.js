// @ts-check

/** @typedef {import('@swarmmachina/swm-uws').HttpRequest} HttpRequest */
/** @typedef {import('@swarmmachina/swm-uws').HttpResponse} HttpResponse */
/** @typedef {import('@swarmmachina/swm-uws').WebSocketBehavior<object>} WebSocketBehavior */

/**
 * @param {HttpRequest} req
 * @param {HttpResponse} res
 * @param {WebSocketBehavior} behavior
 */
export function verifyJsConsumer(req, res, behavior) {
  req.getUrl()
  req.getHeader('x-test')
  req.snapshot()
  res.getRemoteAddress()
  res.getProxiedRemoteAddress()
  res.collectBody(1024, () => {})
  void behavior
}
