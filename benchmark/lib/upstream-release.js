export function pinnedUpstreamCommit(versions, expectedTag) {
  const rows = versions.split('\n').filter((line) => /^\|\s*uWebSockets\.js release tag\s*\|/.test(line))
  const match = /\|\s*`(v\d+\.\d+\.\d+)`\s*\/\s*`([0-9a-f]{40})`\s*\|\s*$/.exec(rows[0] || '')

  if (rows.length !== 1 || !match || match[1] !== expectedTag) {
    throw new Error(`Vendor release metadata does not match ${expectedTag}`)
  }

  return match[2]
}
