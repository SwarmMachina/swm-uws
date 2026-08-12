import { spawn } from 'node:child_process'

import { terminateChildProcess, waitForChildExit, waitForMessage } from '@swarmmachina/benchkit/orchestration'

export class BenchmarkTargetProcess {
  #child
  #messageId = 0
  #ready
  #stopped = false

  constructor(child, ready) {
    this.#child = child
    this.#ready = Object.freeze({ ...ready })
  }

  static async start({ command, arguments_, cwd, env, stdio, readyTimeoutMs = 30_000 }) {
    const child = spawn(command, arguments_, { cwd, env, stdio })

    try {
      const ready = await waitForMessage(child, (message) => message?.type === 'ready', readyTimeoutMs)

      return new BenchmarkTargetProcess(child, ready)
    } catch (error) {
      await terminateChildProcess(child, { graceMs: 1_000, killMs: 1_000 }).catch(() => {})
      throw error
    }
  }

  get ready() {
    return this.#ready
  }

  async measure(run, { timeoutMs = 5_000 } = {}) {
    const id = ++this.#messageId

    await this.#request({ type: 'metrics:start', id }, 'metrics:started', timeoutMs)

    let value
    let runError

    try {
      value = await run()
    } catch (error) {
      runError = error
    }

    let response

    try {
      response = await this.#request({ type: 'metrics:stop', id }, 'metrics:result', timeoutMs)
    } catch (error) {
      if (runError) {
        throw new AggregateError([runError, error], 'benchmark run and metrics collection failed', { cause: error })
      }

      throw error
    }

    if (runError) {
      throw runError
    }

    return { value, metrics: response.metrics }
  }

  async stop({ shutdownMessage, graceMs = 1_000 } = {}) {
    if (this.#stopped) {
      return
    }

    this.#stopped = true

    if (shutdownMessage && this.#child.connected) {
      try {
        this.#child.send(shutdownMessage)
      } catch {
        // The bounded termination path below handles an IPC race with child exit.
      }

      if (await waitForChildExit(this.#child, graceMs)) {
        return
      }
    }

    await terminateChildProcess(this.#child, { graceMs, killMs: 1_000 })
  }

  async #request(request, responseType, timeoutMs) {
    if (this.#stopped || !this.#child.connected) {
      throw new Error(`benchmark target cannot handle ${request.type}`)
    }

    const response = waitForMessage(
      this.#child,
      (message) => message?.type === responseType && message.id === request.id,
      timeoutMs
    )

    try {
      await new Promise((resolve, reject) => {
        this.#child.send(request, (error) => (error ? reject(error) : resolve()))
      })
    } catch (error) {
      response.catch(() => {})
      throw error
    }

    return response
  }
}
