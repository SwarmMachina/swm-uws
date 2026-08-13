import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { runHttp1Load } from '@swarmmachina/benchkit/load/http1'
import { median, percentDelta } from '@swarmmachina/benchkit/statistics'
import { Metrics } from '@swarmmachina/benchkit/measurement'

import { BenchmarkTargetProcess } from './lib/benchmark-target-process.js'
import { benchmarkBlockSchedule } from './lib/benchmark-block-schedule.js'
import { pairedThroughputComparison } from './lib/paired-throughput-comparison.js'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const selectedHeaderNames = ['x-selected-0', 'x-selected-1']
const batchHeaders = ['content-type', 'application/json', 'cache-control', 'no-store', 'x-feature', 'batch']
const batchBody = '{"ok":true}'

if (process.env.SWM_FEATURE_SERVER === '1') {
  await startServer()
} else {
  await runBenchmark()
}

async function runBenchmark() {
  const options = parseOptions(process.argv.slice(2))
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'swm-uws-feature-upstream-'))
  const results = []
  const schedule = benchmarkBlockSchedule(options.blocks, { baseline: 'upstream-manual', candidate: 'swm-helper' })

  process.stderr.write(
    `${options.feature} vs upstream: node=${process.version} body=${options.bodySize}B blocks=${options.blocks} ` +
      `connections=${options.connections} pipelining=${options.pipelining} warmup=${options.warmupMs}ms ` +
      `duration=${options.durationMs}ms workers=${options.workers}\n`
  )

  try {
    for (const entry of schedule) {
      const result = await runSide(entry, options, temporaryDirectory)

      results.push(result)
      process.stderr.write(
        `block=${entry.block} position=${entry.position} ${entry.role.padEnd(9)} ` +
          `${Math.round(result.requestsPerSecond)} req/s p95=${result.p95Ms.toFixed(3)}ms ` +
          `p99=${result.p99Ms.toFixed(3)}ms ELU=${result.runtime.eluPct.toFixed(1)}% ` +
          `RSS=${result.runtime.memMB.rssPeak.toFixed(1)}MiB\n`
      )
    }

    const artifact = summarize(options, results)

    await mkdir(path.dirname(options.output), { recursive: true })
    await writeFile(options.output, `${JSON.stringify(artifact, null, 2)}\n`)
    await writeFile(options.output.replace(/\.json$/, '.md'), renderReport(artifact))
    process.stdout.write(`${options.output.replace(/\.json$/, '.md')}\n`)
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

async function runSide({ block, position, role }, options, temporaryDirectory) {
  const metrics = path.join(temporaryDirectory, `${block}-${position}-${role}.json`)
  const implementation = role === 'candidate' ? 'swm' : 'upstream'
  const binding = role === 'candidate' ? options.swmBinding : options.upstreamBinding
  const command =
    process.platform === 'linux' && options.serverCpu >= 0
      ? ['taskset', ['-c', String(options.serverCpu), process.execPath, fileURLToPath(import.meta.url)]]
      : [process.execPath, [fileURLToPath(import.meta.url)]]
  const target = await BenchmarkTargetProcess.start({
    command: command[0],
    arguments_: command[1],
    cwd: root,
    env: {
      ...process.env,
      SWM_FEATURE_SERVER: '1',
      SWM_FEATURE_IMPLEMENTATION: implementation,
      SWM_FEATURE_KIND: options.feature,
      SWM_FEATURE_BINDING: binding,
      SWM_FEATURE_MAX_BODY: String(options.maxBodySize),
      SWM_PROFILE_METRICS: metrics
    },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc']
  })

  try {
    const loadOptions = featureLoadOptions(options, target.ready.port)

    await runHttp1Load({ ...loadOptions, durationMs: options.warmupMs })
    const measured = await target.measure(() => runHttp1Load({ ...loadOptions, durationMs: options.durationMs }))
    const load = measured.value

    if (load.errors.total || load.non2xx) {
      throw new Error(`${role} block ${block} failed: errors=${load.errors.total}, non2xx=${load.non2xx}`)
    }

    await target.stop({ shutdownMessage: { type: 'shutdown' } })

    return {
      block,
      position,
      role,
      requestsPerSecond: load.requests.averagePerSecond,
      p95Ms: load.latencyMs.p95Ms,
      p99Ms: load.latencyMs.p99Ms,
      runtime: measured.metrics
    }
  } finally {
    await target.stop({ shutdownMessage: { type: 'shutdown' } })
  }
}

async function startServer() {
  const implementation = requiredEnvironment('SWM_FEATURE_IMPLEMENTATION')
  const feature = requiredEnvironment('SWM_FEATURE_KIND')
  const binding = await import(pathToFileURL(requiredEnvironment('SWM_FEATURE_BINDING')).href)
  const maxBodySize = Number(requiredEnvironment('SWM_FEATURE_MAX_BODY'))
  const metrics = new Metrics()
  const state = { value: 0 }

  let app
  let listenSocket

  if (implementation === 'swm') {
    app = binding.createApp()
    installSwmFeature({ app, binding, feature, maxBodySize, state })
  } else if (implementation === 'upstream') {
    const uWS = binding.default ?? binding

    app = uWS.App()
    installUpstreamFeature({ app, feature, maxBodySize, state })
  } else {
    throw new Error(`unsupported SWM_FEATURE_IMPLEMENTATION: ${implementation}`)
  }

  app.get('/__swm_feature_reset', (res) => {
    metrics.stop()
    metrics.start({ sampleMs: 100 })
    res.end('ok')
  })

  process.on('message', (message) => {
    if (message?.type === 'metrics:start') {
      metrics.start({ sampleMs: 100 })
      process.send?.({ type: 'metrics:started', id: message.id })
    } else if (message?.type === 'metrics:stop') {
      process.send?.({ type: 'metrics:result', id: message.id, metrics: metrics.stop(), sink: state.value })
    } else if (message?.type === 'shutdown') {
      close()
    }
  })

  app.listen('127.0.0.1', 0, (socket) => {
    if (!socket) {
      throw new Error('feature benchmark server failed to listen')
    }

    listenSocket = socket
    process.send?.({
      type: 'ready',
      port: binding.us_socket_local_port(socket),
      node: process.version,
      pid: process.pid
    })
  })

  function close() {
    if (listenSocket) {
      binding.us_listen_socket_close(listenSocket)
      listenSocket = undefined
    }

    app.close?.()
    process.exit(0)
  }

  process.on('SIGINT', close)
  process.on('SIGTERM', close)
}

function installSwmFeature({ app, binding, feature, maxBodySize, state }) {
  if (feature === 'collect-length') {
    app.post('/feature', (res) => {
      res.onAborted(() => {})
      const declaredLength = res.collectBodyWithLength(maxBodySize, (body) => {
        if (body === null) {
          res.writeStatus('413 Payload Too Large').end('too large')

          return
        }

        state.value += (declaredLength ?? 0) + body.byteLength + new Uint8Array(body)[0]
        res.end('ok')
      })
    })

    return
  }

  if (feature === 'end-batch') {
    app.get('/feature', (res) => res.endBatch('200 OK', batchHeaders, batchBody))

    return
  }

  if (feature === 'discard-body') {
    app.post('/feature', (res) => {
      const declaredLength = res.collectBodyWithLength(maxBodySize, () => {
        state.value += 1
      })

      state.value += declaredLength ?? 0
      res.discardBody()
      let aborted = false

      res.onAborted(() => {
        aborted = true
      })
      setImmediate(() => {
        if (!aborted) {
          res.cork(() => res.end('discarded'))
        }
      })
    })

    return
  }

  if (feature === 'prefetch') {
    const plan = new binding.RequestPrefetchPlan({ headers: selectedHeaderNames })

    app.get('/feature', (res, req) => {
      let aborted = false

      res.onAborted(() => {
        aborted = true
      })
      const snapshot = req.prefetch(plan)

      setImmediate(() => {
        if (aborted) {
          return
        }

        state.value += snapshot.getHeader('x-selected-0')?.length ?? 0
        state.value += snapshot.getHeader('x-selected-1')?.length ?? 0
        res.cork(() => res.end('ok'))
      })
    })

    return
  }

  throw new Error(`unsupported feature: ${feature}`)
}

function installUpstreamFeature({ app, feature, maxBodySize, state }) {
  if (feature === 'collect-length') {
    app.post('/feature', (res) => {
      res.onAborted(() => {})
      let declaredLength
      let body
      let offset = 0

      res.onDataV2((chunk, remaining) => {
        const view = Buffer.from(chunk)

        if (body === undefined) {
          declaredLength = view.byteLength + Number(remaining)

          if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBodySize) {
            res.writeStatus('413 Payload Too Large').end('too large')

            return
          }

          body = Buffer.allocUnsafe(declaredLength)
        }

        offset += view.copy(body, offset)

        if (Number(remaining) !== 0) {
          return
        }

        state.value += declaredLength + body.byteLength + body[0]
        res.end('ok')
      })
    })

    return
  }

  if (feature === 'end-batch') {
    app.get('/feature', (res) => {
      res.cork(() => {
        res.writeStatus('200 OK')

        for (let index = 0; index < batchHeaders.length; index += 2) {
          res.writeHeader(batchHeaders[index], batchHeaders[index + 1])
        }

        res.end(batchBody)
      })
    })

    return
  }

  if (feature === 'discard-body') {
    app.post('/feature', (res) => {
      let aborted = false

      res.onAborted(() => {
        aborted = true
      })
      res.onDataV2((_chunk, remaining) => {
        if (Number(remaining) === 0) {
          state.value += 1
        }
      })
      setImmediate(() => {
        if (!aborted) {
          res.cork(() => res.end('discarded'))
        }
      })
    })

    return
  }

  if (feature === 'prefetch') {
    app.get('/feature', (res, req) => {
      let aborted = false

      res.onAborted(() => {
        aborted = true
      })
      const entries = []

      // RequestPrefetchSnapshot owns every selected occurrence so it can
      // preserve duplicates and wire order after the route callback. The
      // upstream equivalent must retain the same information; two getHeader
      // calls would retain only first values and benchmark a weaker contract.
      req.forEach((name, value) => {
        if (selectedHeaderNames.includes(name)) {
          entries.push(name, value)
        }
      })

      setImmediate(() => {
        if (aborted) {
          return
        }

        let selected0
        let selected1

        for (let index = 0; index < entries.length; index += 2) {
          if (entries[index] === 'x-selected-0' && selected0 === undefined) {
            selected0 = entries[index + 1]
          }

          if (entries[index] === 'x-selected-1' && selected1 === undefined) {
            selected1 = entries[index + 1]
          }
        }

        state.value += (selected0?.length ?? 0) + (selected1?.length ?? 0)
        res.cork(() => res.end('ok'))
      })
    })

    return
  }

  throw new Error(`unsupported feature: ${feature}`)
}

function featureLoadOptions(options, port) {
  const bodyFeature = options.feature === 'collect-length' || options.feature === 'discard-body'
  const headers = {}

  if (options.feature === 'prefetch') {
    for (let index = 0; index < 20; index++) {
      headers[index < selectedHeaderNames.length ? selectedHeaderNames[index] : `x-input-${index}`] = 'value'
    }
  }

  return {
    url: `http://127.0.0.1:${port}/feature`,
    method: bodyFeature ? 'POST' : 'GET',
    body: bodyFeature ? Buffer.alloc(options.bodySize, 0x61) : undefined,
    headers,
    connections: options.connections,
    pipelining: options.pipelining,
    workers: options.workers
  }
}

function summarize(options, results) {
  const baseline = medians(results.filter((result) => result.role === 'baseline'))
  const candidate = medians(results.filter((result) => result.role === 'candidate'))
  const pairedThroughput = pairedThroughputComparison(results, options.blocks)

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.availableParallelism()
    },
    parameters: options,
    medians: {
      upstreamManual: baseline,
      swmHelper: candidate,
      pairedThroughputDeltaPct: pairedThroughput.medianPairedDeltaPct,
      pairedThroughputIqrPct: [pairedThroughput.iqr.q1, pairedThroughput.iqr.q3],
      winningPairs: pairedThroughput.winningPairs,
      deltaPct: {
        requestsPerSecond: percentDelta(candidate.requestsPerSecond, baseline.requestsPerSecond),
        p95Ms: percentDelta(candidate.p95Ms, baseline.p95Ms),
        p99Ms: percentDelta(candidate.p99Ms, baseline.p99Ms),
        eluPct: percentDelta(candidate.eluPct, baseline.eluPct),
        rssPeakMiB: percentDelta(candidate.rssPeakMiB, baseline.rssPeakMiB)
      }
    },
    results
  }
}

function medians(values) {
  return {
    requestsPerSecond: median(values.map((value) => value.requestsPerSecond)),
    p95Ms: median(values.map((value) => value.p95Ms)),
    p99Ms: median(values.map((value) => value.p99Ms)),
    eluPct: median(values.map((value) => value.runtime.eluPct)),
    rssPeakMiB: median(values.map((value) => value.runtime.memMB.rssPeak)),
    heapUsedPeakMiB: median(values.map((value) => value.runtime.memMB.heapUsedPeak))
  }
}

function renderReport(artifact) {
  const { upstreamManual, swmHelper, deltaPct } = artifact.medians

  return (
    `# ${featureDescription(artifact.parameters.feature)}\n\n` +
    `| Metric | Upstream manual | swm helper | Delta |\n| --- | ---: | ---: | ---: |\n` +
    `| Throughput | ${Math.round(upstreamManual.requestsPerSecond)} req/s | ${Math.round(swmHelper.requestsPerSecond)} req/s | ${signed(deltaPct.requestsPerSecond)} |\n` +
    `| p95 | ${upstreamManual.p95Ms.toFixed(3)} ms | ${swmHelper.p95Ms.toFixed(3)} ms | ${signed(deltaPct.p95Ms)} |\n` +
    `| p99 | ${upstreamManual.p99Ms.toFixed(3)} ms | ${swmHelper.p99Ms.toFixed(3)} ms | ${signed(deltaPct.p99Ms)} |\n` +
    `| Target ELU | ${upstreamManual.eluPct.toFixed(1)}% | ${swmHelper.eluPct.toFixed(1)}% | ${signed(deltaPct.eluPct)} |\n` +
    `| Target RSS peak | ${upstreamManual.rssPeakMiB.toFixed(1)} MiB | ${swmHelper.rssPeakMiB.toFixed(1)} MiB | ${signed(deltaPct.rssPeakMiB)} |\n\n` +
    `Paired throughput delta: **${signed(artifact.medians.pairedThroughputDeltaPct)}**; ` +
    `IQR **[${signed(artifact.medians.pairedThroughputIqrPct[0])}, ${signed(artifact.medians.pairedThroughputIqrPct[1])}]**; ` +
    `${artifact.medians.winningPairs}/${artifact.parameters.blocks} pairs favored swm-uws.\n`
  )
}

function featureDescription(feature) {
  const descriptions = {
    'collect-length': 'collectBodyWithLength versus upstream manual onDataV2',
    'end-batch': 'endBatch versus upstream corked writeStatus/writeHeader/end',
    'discard-body': 'discardBody versus upstream manual onDataV2 drain',
    prefetch: 'request prefetch versus upstream retained selected-header entries'
  }

  return descriptions[feature] ?? feature
}

function parseOptions(arguments_) {
  const values = Object.fromEntries(
    arguments_.map((argument, index) => {
      if (!argument.startsWith('--')) {
        return [String(index), argument]
      }

      const [name, value] = argument.slice(2).split('=', 2)

      return [name, value]
    })
  )
  const number = (name, fallback) => Number(values[name] ?? fallback)
  const required = (name) => {
    if (!values[name]) {
      throw new Error(`--${name} is required`)
    }

    return path.resolve(values[name])
  }
  const options = {
    feature: values.feature ?? 'collect-length',
    swmBinding: required('swmBinding'),
    upstreamBinding: required('upstreamBinding'),
    output: required('output'),
    bodySize: number('bodySize', 256),
    maxBodySize: number('maxBodySize', 64 * 1024 * 1024),
    blocks: number('blocks', 6),
    connections: number('connections', 100),
    pipelining: number('pipelining', 10),
    warmupMs: number('warmupMs', 2_000),
    durationMs: number('durationMs', 5_000),
    workers: number('workers', 4),
    serverCpu: number('serverCpu', 2)
  }

  for (const [name, value] of Object.entries(options)) {
    const minimum = name === 'serverCpu' ? -1 : 1

    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < minimum)) {
      throw new RangeError(`--${name} must be a safe integer of at least ${minimum}`)
    }
  }

  if (options.blocks < 2 || options.blocks % 2 !== 0) {
    throw new RangeError('--blocks must be an even integer of at least 2')
  }

  if (!['collect-length', 'end-batch', 'discard-body', 'prefetch'].includes(options.feature)) {
    throw new Error(`unsupported --feature=${options.feature}`)
  }

  return options
}

function requiredEnvironment(name) {
  const value = process.env[name]

  if (!value) {
    throw new Error(`${name} is required`)
  }

  return value
}

function signed(value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}
