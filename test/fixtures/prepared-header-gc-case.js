import { setImmediate as turn } from 'node:timers/promises'

import { PreparedHeaderBlock } from '../../lib/index.js'

if (typeof global.gc !== 'function') {
  throw new Error('prepared-header lifecycle probe requires --expose-gc')
}

function allocateBlocks() {
  const references = []

  for (let index = 0; index < 512; index++) {
    const value = `${index}:${'x'.repeat(64 * 1024 - 16)}`

    references.push(new WeakRef(new PreparedHeaderBlock(['x-test', value])))
  }

  return references
}

const references = allocateBlocks()

for (let attempt = 0; attempt < 4; attempt++) {
  await turn()
  global.gc()
  global.gc()
}

console.log(
  JSON.stringify({
    alive: references.filter((reference) => reference.deref() !== undefined).length,
    rssBytes: process.memoryUsage().rss
  })
)
