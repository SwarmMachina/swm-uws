import { setTimeout as delay } from 'node:timers/promises'

export { delay }

export async function waitFor(predicate, timeoutMs, { intervalMs = 25, description = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs

  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error(`${description} timed out after ${timeoutMs}ms`)
    }

    await delay(intervalMs)
  }
}

export async function withTimeout(promise, timeoutMs, message) {
  let timer

  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
