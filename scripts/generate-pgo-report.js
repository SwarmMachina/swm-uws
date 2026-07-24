import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { pairedComparison } from '@swarmmachina/benchkit/statistics'
import { format } from 'prettier'

let directory = new URL('../benchmark/profiles/pgo-balanced-linux/', import.meta.url)
let check = false

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
  hardwareStat: metadata.hardwareStat
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
  const { environment, build, parameters, results, runtime: runtimeResults, guard, hardwareStat } = value
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

${runtimeSection}${guardSection}## Hardware counters

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

The report is generated from \`metadata.json\` and \`runs.json\`. The PGO profile
should be regenerated whenever native wrapper/vendor sources, the Node ABI, the
compiler, or material compiler flags change.
`
}
