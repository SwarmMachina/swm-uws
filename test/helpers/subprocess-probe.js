import { spawnSync } from 'node:child_process'

export class SubprocessProbe {
  #fixture
  #timeoutMs

  constructor(fixture, { timeoutMs = 25_000 } = {}) {
    this.#fixture = fixture
    this.#timeoutMs = timeoutMs
  }

  run(scenario) {
    return spawnSync(process.execPath, ['--expose-gc', this.#fixture, scenario], {
      encoding: 'utf8',
      env: {
        ...process.env,
        // Keep allocator caches from obscuring whether native buffers were released.
        // Unsupported allocators ignore these test-only settings.
        MALLOC_ARENA_MAX: '1',
        MALLOC_TRIM_THRESHOLD_: '0',
        MallocSpaceEfficient: '1',
        // Make a large native reserve resident so eager allocation is observable.
        MALLOC_PERTURB_: '165',
        MallocPreScribble: '1',
        MallocScribble: '1'
      },
      timeout: this.#timeoutMs
    })
  }
}
