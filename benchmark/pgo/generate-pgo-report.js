import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { pairedComparison } from '@swarmmachina/benchkit/statistics'
import { format } from 'prettier'

let directory = new URL('../profiles/pgo-balanced-linux/', import.meta.url)
let check = false

const expectedFeatureArtifacts = [
  'collect-body-with-length-256.json',
  'collect-body-with-length-4096.json',
  'end-batch.json',
  'request-prefetch.json',
  'discard-body.json'
]
const arguments_ = process.argv.slice(2)

for (let index = 0; index < arguments_.length; index++) {
  const argument = arguments_[index]

  if (argument === '--check') {
    check = true
    continue
  }

  if (argument === '--directory' && arguments_[index + 1]) {
    directory = pathToFileURL(`${resolve(arguments_[++index])}/`)
    continue
  }

  throw new Error(`unknown argument: ${argument}`)
}

const metadata = await readJson('metadata.json')
const runs = await readJson('runs.json')
const featurePaths = await readFeaturePaths()

validateInputs(metadata, runs)

const throughputComparison = pairedComparison(runs.map((run) => ({ candidate: run.swmRps, reference: run.uwsRps })))
const summary = {
  environment: metadata.environment,
  build: metadata.build,
  parameters: metadata.parameters,
  results: {
    swmRequestsPerSecondMedian: throughputComparison.medianCandidate,
    uwsRequestsPerSecondMedian: throughputComparison.medianReference,
    pairedDeltaMedianPct: throughputComparison.medianPairedDeltaPct,
    pairedDeltaIqrPct: [throughputComparison.iqr.q1, throughputComparison.iqr.q3],
    positivePairedRounds: throughputComparison.winningPairs,
    swmLatencyMsMedian: metadata.measurements.swmLatencyMsMedian,
    uwsLatencyMsMedian: metadata.measurements.uwsLatencyMsMedian,
    errors: metadata.measurements.errors
  },
  runtime: {
    swmMedian: metadata.measurements.swmRuntimeMedian,
    uwsMedian: metadata.measurements.uwsRuntimeMedian
  },
  guard: metadata.guard,
  hardwareStat: metadata.hardwareStat,
  ...(featurePaths.length ? { featurePaths } : {})
}
const summaryText = await format(JSON.stringify(summary), { parser: 'json' })
const reportText = await format(renderReport(summary), { parser: 'markdown' })
const outputs = [
  ['summary.json', summaryText],
  ['report.md', reportText]
]

if (check) {
  const stale = []

  for (const [name, expected] of outputs) {
    const actual = await readFile(new URL(name, directory), 'utf8').catch(() => null)

    if (actual !== expected) {
      stale.push(name)
    }
  }

  if (stale.length) {
    throw new Error(`generated benchmark files are stale: ${stale.join(', ')}; run npm run bench:report`)
  }

  process.stdout.write('benchmark report is up to date\n')
} else {
  await Promise.all(outputs.map(([name, contents]) => writeFile(new URL(name, directory), contents)))
  process.stdout.write('generated benchmark summary and report\n')
}

async function readJson(name) {
  return JSON.parse(await readFile(new URL(name, directory), 'utf8'))
}

async function readFeaturePaths() {
  const featureDirectory = new URL('features/', directory)

  let names

  try {
    names = await readdir(featureDirectory)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return []
    }

    throw error
  }

  const jsonNames = names.filter((name) => name.endsWith('.json')).sort()
  const missing = expectedFeatureArtifacts.filter((name) => !jsonNames.includes(name))
  const unexpected = jsonNames.filter((name) => !expectedFeatureArtifacts.includes(name))

  if (missing.length || unexpected.length) {
    throw new Error(
      `feature benchmark artifacts are incomplete: missing=${missing.join(',') || 'none'} unexpected=${unexpected.join(',') || 'none'}`
    )
  }

  const artifacts = await Promise.all(
    jsonNames.map(async (name) => ({
      name,
      value: JSON.parse(await readFile(new URL(name, featureDirectory), 'utf8'))
    }))
  )

  return artifacts.map(({ name, value }) => summarizeFeaturePath(name, value)).sort(compareFeaturePaths)
}

function summarizeFeaturePath(name, artifact) {
  const { parameters, medians, results } = artifact
  const feature = parameters?.feature || featureFromName(name)

  if (!parameters || !medians || !Array.isArray(results)) {
    throw new Error(`feature benchmark ${name} has an invalid schema`)
  }

  if (!feature) {
    throw new Error(`feature benchmark ${name} does not declare a supported feature`)
  }

  if (!Number.isSafeInteger(parameters.blocks) || parameters.blocks < 2 || parameters.blocks % 2 !== 0) {
    throw new Error(`feature benchmark ${name} must use an even block count of at least 2`)
  }

  if (results.length !== parameters.blocks * 4) {
    throw new Error(`feature benchmark ${name} has ${results.length} results, expected ${parameters.blocks * 4}`)
  }

  const baselineRuns = results.filter((result) => result.role === 'baseline')
  const candidateRuns = results.filter((result) => result.role === 'candidate')

  if (baselineRuns.length !== parameters.blocks * 2 || candidateRuns.length !== parameters.blocks * 2) {
    throw new Error(`feature benchmark ${name} does not contain balanced baseline and candidate runs`)
  }

  for (const [metricName, value] of Object.entries({
    upstreamRequestsPerSecond: medians.upstreamManual?.requestsPerSecond,
    swmRequestsPerSecond: medians.swmHelper?.requestsPerSecond,
    pairedThroughputDeltaPct: medians.pairedThroughputDeltaPct,
    pairedThroughputIqrQ1Pct: medians.pairedThroughputIqrPct?.[0],
    pairedThroughputIqrQ3Pct: medians.pairedThroughputIqrPct?.[1],
    p95DeltaPct: medians.deltaPct?.p95Ms,
    p99DeltaPct: medians.deltaPct?.p99Ms,
    eluDeltaPct: medians.deltaPct?.eluPct,
    rssDeltaPct: medians.deltaPct?.rssPeakMiB
  })) {
    if (!Number.isFinite(value)) {
      throw new Error(`feature benchmark ${name} has invalid ${metricName}`)
    }
  }

  return {
    name: name.replace(/\.json$/, ''),
    feature,
    label: featureLabel({ ...parameters, feature }),
    upstreamPath: upstreamPath(feature),
    parameters: {
      bodySize: parameters.bodySize,
      blocks: parameters.blocks,
      connections: parameters.connections,
      pipelining: parameters.pipelining,
      warmupMs: parameters.warmupMs,
      durationMs: parameters.durationMs,
      workers: parameters.workers,
      serverCpu: parameters.serverCpu
    },
    upstream: medians.upstreamManual,
    swm: medians.swmHelper,
    pairedThroughputDeltaPct: medians.pairedThroughputDeltaPct,
    pairedThroughputIqrPct: medians.pairedThroughputIqrPct,
    winningPairs: medians.winningPairs,
    deltaPct: medians.deltaPct
  }
}

function featureFromName(name) {
  if (name.startsWith('collect-body-with-length-')) {
    return 'collect-length'
  }

  if (name === 'end-batch.json') {
    return 'end-batch'
  }

  if (name === 'request-prefetch.json') {
    return 'prefetch'
  }

  if (name === 'discard-body.json') {
    return 'discard-body'
  }

  return null
}

function compareFeaturePaths(left, right) {
  const order = {
    'collect-body-with-length-256': 1,
    'collect-body-with-length-4096': 2,
    'end-batch': 3,
    'request-prefetch': 4,
    'discard-body': 5
  }

  return (
    (order[left.name] ?? Number.MAX_SAFE_INTEGER) - (order[right.name] ?? Number.MAX_SAFE_INTEGER) ||
    left.name.localeCompare(right.name)
  )
}

function featureLabel(parameters) {
  if (parameters.feature === 'collect-length') {
    return `collectBodyWithLength, POST ${parameters.bodySize} B`
  }

  if (parameters.feature === 'end-batch') {
    return 'endBatch, 6 headers + 11 B body'
  }

  if (parameters.feature === 'discard-body') {
    return `discardBody, POST ${parameters.bodySize} B`
  }

  if (parameters.feature === 'prefetch') {
    return 'RequestPrefetchPlan, 2 of 20 headers'
  }

  return parameters.feature
}

function upstreamPath(feature) {
  const paths = {
    'collect-length': 'onDataV2 + allocate/copy body',
    'end-batch': 'cork + status/header writes + end',
    'discard-body': 'onDataV2 callback drain',
    prefetch: 'retain two getHeader values'
  }

  return paths[feature] || 'manual upstream path'
}

function validateInputs(inputMetadata, inputRuns) {
  if (!Array.isArray(inputRuns) || inputRuns.length < 2) {
    throw new Error('runs.json must contain at least two paired runs')
  }

  if (inputMetadata.parameters?.runs !== inputRuns.length) {
    throw new Error('metadata run count does not match runs.json')
  }

  if (!inputMetadata.measurements || !inputMetadata.hardwareStat) {
    throw new Error('metadata must include measurements and hardwareStat')
  }

  const orders = new Map()

  for (const [index, run] of inputRuns.entries()) {
    if (run.round !== index + 1) {
      throw new Error(`run ${index + 1} has an invalid round number`)
    }

    if (run.order !== 'swm/uws' && run.order !== 'uws/swm') {
      throw new Error(`run ${run.round} has an invalid order`)
    }

    for (const key of ['swmRps', 'uwsRps']) {
      if (!Number.isFinite(run[key]) || run[key] <= 0) {
        throw new Error(`run ${run.round} has an invalid ${key}`)
      }
    }

    orders.set(run.order, (orders.get(run.order) || 0) + 1)
  }

  if (Math.abs((orders.get('swm/uws') || 0) - (orders.get('uws/swm') || 0)) > 1) {
    throw new Error('paired run order is not balanced')
  }
}

function renderReport(value) {
  const {
    environment,
    build,
    parameters,
    results,
    runtime: runtimeResults,
    guard,
    hardwareStat,
    featurePaths = []
  } = value
  const integerFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
  const formatInteger = (number) => integerFormatter.format(number)
  const fixed = (number, digits) => number.toFixed(digits)
  const signed = (number, digits) => `${number >= 0 ? '+' : ''}${fixed(number, digits)}`
  const latency = (side, percentile) => fixed(results[`${side}LatencyMsMedian`][percentile], 3)
  const runtime = (side, metric, suffix = '') =>
    `${fixed(runtimeResults[`${side}Median`][metric], metric === 'eluPct' ? 2 : 1)}${suffix}`
  const mib = (bytes) => `${fixed(bytes / 1024 / 1024, 2)} MiB`
  const counter = (number, digits) => (number === null ? 'unavailable' : fixed(number, digits))
  const runtimeSection = runtimeResults.swmMedian
    ? `## Runtime

| Median after warmup | swm-uws | upstream uWS |
| --- | ---: | ---: |
| ELU | ${runtime('swm', 'eluPct', '%')} | ${runtime('uws', 'eluPct', '%')} |
| RSS | ${mib(runtimeResults.swmMedian.rssBytes)} | ${mib(runtimeResults.uwsMedian.rssBytes)} |
| RSS delta | ${mib(runtimeResults.swmMedian.rssDeltaBytes)} | ${mib(runtimeResults.uwsMedian.rssDeltaBytes)} |
| Heap used | ${mib(runtimeResults.swmMedian.heapUsedBytes)} | ${mib(runtimeResults.uwsMedian.heapUsedBytes)} |

`
    : ''
  const guardSection = guard
    ? `## Regression guard

**Result: ${guard.status === 'pass' ? 'PASS' : 'FAIL'}**. Limits: throughput -${guard.thresholds.maxThroughputRegressionPct}%,
tail latency +${guard.thresholds.maxLatencyRegressionPct}% plus ${guard.thresholds.latencySlackMs} ms,
RSS +${guard.thresholds.maxRssRegressionPct}% plus ${guard.thresholds.rssSlackMiB} MiB.

${guard.failures.length ? guard.failures.map((failure) => `- ${failure}`).join('\n') : 'No regressions exceeded the guard limits.'}

`
    : ''
  const featureSection = featurePaths.length
    ? `## Binding extension paths versus upstream

Each path uses ${featurePaths[0].parameters.blocks} balanced ABBA/BAAB blocks. RPS and percentile deltas compare the swm-uws helper with the listed pinned-upstream equivalent.

| Feature path | Upstream path | Protocol | Upstream RPS | swm RPS | Paired RPS delta | p95 delta | p99 delta | ELU delta | RSS delta |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${featurePaths
  .map((path) => {
    const protocol = `c${path.parameters.connections}/p${path.parameters.pipelining}; ${path.parameters.warmupMs} ms + ${path.parameters.durationMs} ms`

    return `| ${path.label} | ${path.upstreamPath} | ${protocol} | ${formatInteger(path.upstream.requestsPerSecond)} | ${formatInteger(path.swm.requestsPerSecond)} | ${signed(path.pairedThroughputDeltaPct, 2)}% (${path.winningPairs}/${path.parameters.blocks}) | ${signed(path.deltaPct.p95Ms, 2)}% | ${signed(path.deltaPct.p99Ms, 2)}% | ${signed(path.deltaPct.eluPct, 2)}% | ${signed(path.deltaPct.rssPeakMiB, 2)}% |`
  })
  .join('\n')}

The \`prefetch\` and \`discardBody\` paths use pipelining 1 because their comparison retains the response past the route callback. Higher pipelining would close an upstream response before the delayed callback and measure an invalid lifecycle rather than the feature path.

`
    : ''

  return `# Portable balanced PGO+LTO: raw HTTP response

The \`${environment.package}\` candidate is compared with the pinned
\`${environment.upstream}\` reference on the identical raw GET response path.

| Result | swm-uws | upstream uWS |
| --- | ---: | ---: |
| Median throughput | ${formatInteger(results.swmRequestsPerSecondMedian)} req/s | ${formatInteger(results.uwsRequestsPerSecondMedian)} req/s |
| Median p95 | ${latency('swm', 'p95')} ms | ${latency('uws', 'p95')} ms |
| Median p97.5 | ${latency('swm', 'p97_5')} ms | ${latency('uws', 'p97_5')} ms |
| Median p99 | ${latency('swm', 'p99')} ms | ${latency('uws', 'p99')} ms |

Paired throughput delta: **${signed(results.pairedDeltaMedianPct, 2)}%**,
IQR using Tukey hinges **[${signed(results.pairedDeltaIqrPct[0], 2)}%, ${signed(results.pairedDeltaIqrPct[1], 2)}%]**.
${results.positivePairedRounds} of ${parameters.runs} paired rounds favored swm-uws. There were ${results.errors} request errors.

## Protocol

- ${environment.os}, ${environment.cpu}, ${environment.logicalCpus} logical CPUs, ${environment.ramGiB} GiB RAM
- Node.js ${environment.node}, ABI v${environment.abi}
- ${parameters.runs} ${parameters.order} rounds
- ${parameters.connections} connections, pipelining ${parameters.pipelining}
- ${parameters.warmupSeconds} second warmup, ${parameters.durationSeconds} second measurement
- server pinned to CPU ${parameters.serverCpu}; ${parameters.clientWorkers} client workers pinned to CPUs ${parameters.clientCpus}
- identical bundled server, \`App/get/writeHeader/end\` handler, and byte-identical GET

${runtimeSection}${featureSection}${guardSection}## Hardware counters

The ${hardwareStat.source || 'independent stat-only run'} produced ${formatInteger(hardwareStat.requestsPerSecond)} req/s
with p99 ${fixed(hardwareStat.latencyMs.p99, 3)} ms.

| Counter | Per request |
| --- | ---: |
| Cycles | ${counter(hardwareStat.perRequest.cycles, 2)} |
| Instructions | ${counter(hardwareStat.perRequest.instructions, 2)} |
| Branches | ${counter(hardwareStat.perRequest.branches, 2)} |
| Branch misses | ${counter(hardwareStat.perRequest.branchMisses, 2)} |
| Cache references | ${counter(hardwareStat.perRequest.cacheReferences, 2)} |
| Cache misses | ${counter(hardwareStat.perRequest.cacheMisses, 3)} |

## Build

The release binary was built with ${build.compiler}, ${build.profile} PGO, and LTO. Training
covers raw GET c${parameters.connections}/p${parameters.pipelining}, POST body collection,
WebSocket depth 1 and depth 16, plus HTTP, WebSocket, and async smoke paths. No
\`-march\` or \`-mtune\` is used.

- SHA-256: \`${build.sha256}\`
- Size: ${formatInteger(build.sizeBytes)} bytes
- ELF: generic x86-64, stripped
- Dynamic dependencies: ${build.dynamicDependencies.join(', ')}; C++ runtime is linked statically

Rebuild the native binary and reproduce the comparison with:

\`\`\`sh
npm run build:native:pgo
SWM_BENCH_REFERENCE=/path/to/uwebsockets.js/ESM_wrapper.mjs \\
  npm run bench:compare:pgo:linux -- benchmark/profiles/pgo-balanced-linux
\`\`\`

The report is generated from \`metadata.json\`, \`runs.json\`, and the complete
\`features/*.json\` suite when feature-path measurements are present. The PGO profile
should be regenerated whenever native wrapper/vendor sources, the Node ABI, the
compiler, or material compiler flags change.
`
}
