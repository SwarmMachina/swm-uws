class BodyAllocationProbe {
  #size
  #body

  constructor(size) {
    this.#size = size
  }

  run(handler, chunk, remaining) {
    const allocate = Buffer.allocUnsafe
    const allocateStandalone = Buffer.allocUnsafeSlow
    const capture = (original) => (size) => {
      const body = original(size)

      if (size === this.#size) {
        this.#body = body
      }

      return body
    }

    Buffer.allocUnsafe = capture(allocate)
    Buffer.allocUnsafeSlow = capture(allocateStandalone)

    try {
      handler(chunk, remaining)
    } finally {
      Buffer.allocUnsafe = allocate
      Buffer.allocUnsafeSlow = allocateStandalone
    }

    if (Number(remaining) !== 0) {
      return
    }

    const body = this.#body
    const report = {
      type: 'body-ownership',
      bodyBytes: body?.byteLength,
      backingBytes: body?.buffer.byteLength,
      byteOffset: body?.byteOffset,
      transferable: false,
      payloadMatches: false
    }

    if (body) {
      try {
        const backing = body.buffer
        const transferred = structuredClone(backing, { transfer: [backing] })

        report.transferable = backing.byteLength === 0
        report.payloadMatches =
          transferred.byteLength === this.#size && Buffer.from(transferred).every((value) => value === 0xa5)
      } catch (error) {
        report.transferError = error.name
      }
    }

    process.send?.(report)
  }
}

module.exports = { BodyAllocationProbe }
