import { readFile, writeFile } from 'node:fs/promises'

import { format } from 'prettier'

const directory = new URL('../benchmark/profiles/pgo-balanced-linux/', import.meta.url)
const check = process.argv.includes('--check')
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== '--check')

if (unknownArguments.length) {
  throw new Error(`unknown arguments: ${unknownArguments.join(', ')}`)
}

const metadata = await readJson('metadata.json')
const runs = await readJson('runs.json')

validateInputs(metadata, runs)

const swmRequestsPerSecond = runs.map((run) => run.swmRps)
const uwsRequestsPerSecond = runs.map((run) => run.uwsRps)
const pairedDeltas = runs.map((run) => ((run.swmRps - run.uwsRps) / run.uwsRps) * 100)
const pairedDeltaIqrPct = quartiles(pairedDeltas)

const summary = {
  environment: metadata.environment,
  build: metadata.build,
  parameters: metadata.parameters,
  results: {
    swmRequestsPerSecondMedian: median(swmRequestsPerSecond),
    uwsRequestsPerSecondMedian: median(uwsRequestsPerSecond),
    pairedDeltaMedianPct: median(pairedDeltas),
    pairedDeltaIqrPct,
    positivePairedRounds: pairedDeltas.filter((value) => value > 0).length,
    swmLatencyMsMedian: metadata.measurements.swmLatencyMsMedian,
    uwsLatencyMsMedian: metadata.measurements.uwsLatencyMsMedian,
    errors: metadata.measurements.errors
  },
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
    if (actual !== expected) stale.push(name)
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
    if (run.round !== index + 1) throw new Error(`run ${index + 1} has an invalid round number`)
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

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function quartiles(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const lower = sorted.slice(0, middle)
  const upper = sorted.slice(Math.ceil(sorted.length / 2))
  return [median(lower), median(upper)]
}

function renderReport(value) {
  const { environment, build, parameters, results, hardwareStat } = value
  const integerFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
  const formatInteger = (number) => integerFormatter.format(number)
  const fixed = (number, digits) => number.toFixed(digits)
  const latency = (side, percentile) => fixed(results[`${side}LatencyMsMedian`][percentile], 3)

  return `# Portable balanced PGO+LTO: raw HTTP response

The \`${environment.package}\` development candidate is faster than the pinned
\`${environment.upstream}\` reference on the identical raw GET response path.

| Result | swm-uws | upstream uWS |
| --- | ---: | ---: |
| Median throughput | ${formatInteger(results.swmRequestsPerSecondMedian)} req/s | ${formatInteger(results.uwsRequestsPerSecondMedian)} req/s |
| Median p95 | ${latency('swm', 'p95')} ms | ${latency('uws', 'p95')} ms |
| Median p97.5 | ${latency('swm', 'p97_5')} ms | ${latency('uws', 'p97_5')} ms |
| Median p99 | ${latency('swm', 'p99')} ms | ${latency('uws', 'p99')} ms |

Paired throughput delta: **+${fixed(results.pairedDeltaMedianPct, 2)}%**,
IQR using Tukey hinges **[+${fixed(results.pairedDeltaIqrPct[0], 2)}%, +${fixed(results.pairedDeltaIqrPct[1], 2)}%]**.
All ${results.positivePairedRounds} paired rounds were positive. There were ${results.errors} request errors.

## Protocol

- ${environment.os}, ${environment.cpu}, ${environment.logicalCpus} logical CPUs, ${environment.ramGiB} GiB RAM
- Node.js ${environment.node}, ABI v${environment.abi}
- ${parameters.runs} ${parameters.order} rounds
- ${parameters.connections} connections, pipelining ${parameters.pipelining}
- ${parameters.warmupSeconds} second warmup, ${parameters.durationSeconds} second measurement
- server pinned to CPU ${parameters.serverCpu}; ${parameters.clientWorkers} client workers pinned to CPUs ${parameters.clientCpus}
- identical bundled server, \`App/get/writeHeader/end\` handler, and byte-identical GET

## Hardware counters

An independent stat-only run produced ${formatInteger(hardwareStat.requestsPerSecond)} req/s
with p99 ${fixed(hardwareStat.latencyMs.p99, 3)} ms.

| Counter | Per request |
| --- | ---: |
| Cycles | ${fixed(hardwareStat.perRequest.cycles, 2)} |
| Instructions | ${fixed(hardwareStat.perRequest.instructions, 2)} |
| Branches | ${fixed(hardwareStat.perRequest.branches, 2)} |
| Branch misses | ${fixed(hardwareStat.perRequest.branchMisses, 2)} |
| Cache references | ${fixed(hardwareStat.perRequest.cacheReferences, 2)} |
| Cache misses | ${fixed(hardwareStat.perRequest.cacheMisses, 3)} |

## Build

The release binary was built with ${build.compiler}, ${build.profile} PGO, and LTO. Training
covers raw GET c${parameters.connections}/p${parameters.pipelining}, POST body collection,
WebSocket depth 1 and depth 16, plus HTTP, WebSocket, and async smoke paths. No
\`-march\` or \`-mtune\` is used.

- SHA-256: \`${build.sha256}\`
- Size: ${formatInteger(build.sizeBytes)} bytes
- ELF: generic x86-64, stripped
- Dynamic dependencies: libc, libm, dynamic loader; C++ runtime is linked statically

Rebuild the native binary and regenerate this report with:

\`\`\`sh
npm run build:native:pgo
npm run bench:report
\`\`\`

The report is generated from \`metadata.json\` and \`runs.json\`. The PGO profile
should be regenerated whenever native wrapper/vendor sources, the Node ABI, the
compiler, or material compiler flags change.
`
}
