export function benchmarkBlockSchedule(blocks, { baseline, candidate }) {
  if (!Number.isSafeInteger(blocks) || blocks <= 0) {
    throw new RangeError('blocks must be a positive safe integer')
  }

  const entries = []

  for (let block = 1; block <= blocks; block++) {
    const ordered =
      block % 2 === 1
        ? [
            ['baseline', baseline],
            ['candidate', candidate],
            ['candidate', candidate],
            ['baseline', baseline]
          ]
        : [
            ['candidate', candidate],
            ['baseline', baseline],
            ['baseline', baseline],
            ['candidate', candidate]
          ]

    for (const [index, [role, value]] of ordered.entries()) {
      entries.push({ block, position: index + 1, role, value })
    }
  }

  return entries
}
