const binding = require('./commonjs-binding.cjs')
const { BodyAllocationProbe } = require('./body-allocation-probe.cjs')

// Exercise the real benchmark adapter with pooling enabled on every Node.js major.
Buffer.poolSize = 64 * 1024

function App(...options) {
  // Select the real native App implementation, adding only allocation observation.
  const app = binding.App(...options)
  const post = app.post

  app.post = function (path, handler) {
    return post.call(this, path, (res, req) => {
      const probe = new BodyAllocationProbe(Number(req.getHeader('content-length')))
      const onData = res.onDataV2

      res.onDataV2 = function (callback) {
        return onData.call(this, (chunk, remaining) => probe.run(callback, chunk, remaining))
      }

      handler(res, req)
    })
  }

  return app
}

module.exports = { ...binding, App }
