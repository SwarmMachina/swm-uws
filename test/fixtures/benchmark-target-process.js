process.on('message', (message) => {
  if (message?.type === 'metrics:start') {
    process.send?.({ type: 'metrics:started', id: message.id })
  } else if (message?.type === 'metrics:stop') {
    process.send?.({ type: 'metrics:result', id: message.id, metrics: { sample: message.id } })
  } else if (message?.type === 'shutdown') {
    process.disconnect()
  }
})

process.send?.({ type: 'ready', port: 12_345, node: process.version })
