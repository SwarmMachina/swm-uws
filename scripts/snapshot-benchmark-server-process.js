import { spawn } from 'node:child_process'
import path from 'node:path'

import { terminateChildProcess } from '@swarmmachina/benchkit/orchestration'

export class SnapshotBenchmarkServerProcess {
  #binding
  #child = null
  #metricsPath
  #mode
  #port
  #root
  #stderr = ''

  constructor({ binding, metricsPath, mode, port, root }) {
    this.#binding = binding
    this.#metricsPath = metricsPath
    this.#mode = mode
    this.#port = port
    this.#root = root
  }

  async start() {
    if (this.#child) {
      throw new Error('snapshot benchmark server is already running')
    }

    const child = spawn(process.execPath, ['--expose-gc', path.join(this.#root, 'scripts/bench-snapshot-server.js')], {
      cwd: this.#root,
      env: {
        ...process.env,
        SWM_SNAPSHOT_BENCH_BINDING: path.resolve(this.#binding),
        SWM_SNAPSHOT_BENCH_MODE: this.#mode,
        SWM_SNAPSHOT_BENCH_METRICS: this.#metricsPath,
        SWM_SNAPSHOT_BENCH_PORT: String(this.#port)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    this.#child = child
    this.#stderr = ''
    child.stderr.on('data', (chunk) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-64 * 1024)
    })

    try {
      await this.#waitUntilReady(child)
    } catch (error) {
      try {
        await terminateChildProcess(child, { graceMs: 100, killMs: 1_000 })
        this.#child = null
      } catch (terminationError) {
        throw new AggregateError([error, terminationError], 'failed to start and terminate snapshot benchmark server', {
          cause: terminationError
        })
      }

      throw error
    }
  }

  async stop() {
    const child = this.#child

    if (!child) {
      return
    }

    const { exit } = await terminateChildProcess(child, { graceMs: 10_000, killMs: 1_000 })

    this.#child = null

    if (exit.code !== 0) {
      throw new Error(
        `snapshot benchmark server exited with ${exit.code ?? exit.signal ?? 'an unknown status'}: ${this.#stderr}`
      )
    }
  }

  #waitUntilReady(child) {
    return new Promise((resolve, reject) => {
      let output = ''
      let settled = false

      const timer = setTimeout(
        () => settle(new Error(`snapshot benchmark server readiness timed out: ${this.#stderr}`)),
        10_000
      )
      const cleanup = () => {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        child.off('error', onError)
        child.off('exit', onExit)
      }
      const settle = (error) => {
        if (settled) {
          return
        }

        settled = true
        cleanup()

        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }
      const onData = (chunk) => {
        output = `${output}${chunk}`.slice(-1_024)

        if (output.includes('ready ')) {
          settle()
        }
      }
      const onError = (error) => settle(new Error('failed to start snapshot benchmark server', { cause: error }))
      const onExit = (code, signal) => {
        settle(
          new Error(
            `snapshot benchmark server exited before readiness (${code ?? signal ?? 'unknown'}): ${this.#stderr}`
          )
        )
      }

      child.stdout.on('data', onData)
      child.once('error', onError)
      child.once('exit', onExit)
    })
  }
}
