import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { TranscriptionQueue, type TranscriptionWorker } from '../../src/main/transcription-queue'
import type { AsrOutcome, AsrRuntime, AsrSubmission, AsrEvent } from '../../src/main/asr-process'

class Worker implements TranscriptionWorker {
  ready = Promise.resolve()
  diagnosticLog = ''
  requests: AsrSubmission[] = []
  priorities: boolean[] = []
  closed = 0
  configuration: Record<string, unknown>
  finish?: (value: AsrOutcome) => void
  publish?: (event: AsrEvent) => void
  constructor(readonly runtime: AsrRuntime) {
    this.configuration = { fixture: true, threads: runtime.cpuThreads ?? 4 }
  }
  async submit(request: AsrSubmission, onEvent: (event: AsrEvent) => void): Promise<AsrOutcome> {
    this.requests.push(request)
    this.publish = onEvent
    return new Promise((resolve) => {
      this.finish = resolve
    })
  }
  cancel() {
    this.finish?.({ status: 'canceled' })
  }
  async close() {
    this.closed++
    this.cancel()
  }
  setLowPriority(low: boolean) {
    this.priorities.push(low)
  }
}
async function until(condition: () => boolean, details?: () => string) {
  for (let i = 0; i < 200 && !condition(); i++) await delay(5)
  assert.ok(condition(), details?.() ?? 'scheduler did not reach the expected state')
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ralb-resource-scheduler-')),
    filename = join(root, 'library.sqlite3')
  for (let i = 0; i < 3; i++) await writeFile(join(root, `${i}.mp3`), `resource fixture ${i}`)
  let store = new LibraryStore(filename)
  store.importBook(await scanBook(root, 'folder'))
  const episodes = store.listBooks()[0]!.episodes
  let idle = 0,
    now = 0
  const workers: Worker[] = [],
    logs: unknown[] = []
  const create = () =>
    new TranscriptionQueue(
      store,
      {
        configured: true,
        runtime: (engine, device) => ({
          engine,
          device,
          python: '',
          script: '',
          models: '',
          ffmpeg: '',
          ffprobe: '',
          cache: '',
          compute: 'int8',
        }),
      },
      () => {},
      (error) => logs.push(error),
      (runtime) => {
        const worker = new Worker(runtime)
        workers.push(worker)
        return worker
      },
      undefined,
      { idleSeconds: () => idle, now: () => now, pollMs: 0, idleReleaseMs: 30000 },
    )
  let queue = create()
  const request = (index = 0) => ({
    episodeId: episodes[index]!.id,
    audioHash: episodes[index]!.contentHash,
    engine: 'paraformer' as const,
    device: 'cpu' as const,
  })
  const policy = (patch: Partial<ReturnType<TranscriptionQueue['resources']>['policy']>) => {
    const state = queue.resources()
    return queue.updateResources({
      revision: state.revision,
      policy: { ...state.policy, ...patch },
    })
  }
  const pause = (paused: boolean) =>
    queue.pauseProcessing({ revision: queue.resources().revision, paused })
  const partial = (worker: Worker, hash: string) => {
    const snapshot = {
      document: {
        version: 1 as const,
        kind: 'transcript' as const,
        audioHash: hash,
        coverage: [{ startMs: 0, endMs: 5000 }],
        segments: [{ id: 's1', startMs: 500, endMs: 4000, text: '已保存的分块文字。' }],
      },
      processedUntilMs: 5000,
      totalChunks: 2,
      cacheKey: 'a'.repeat(64),
      cacheHits: 0,
      issues: [],
    }
    worker.publish!({ type: 'partial', ...snapshot, completedChunks: 1 })
    return snapshot
  }
  return {
    get queue() {
      return queue
    },
    get store() {
      return store
    },
    workers,
    logs,
    request,
    policy,
    pause,
    partial,
    setIdle(value: number) {
      idle = value
      queue.refreshResourceSchedule()
    },
    setNow(value: number) {
      now = value
      queue.refreshResourceSchedule()
    },
    async reopen() {
      await queue.close()
      store.close()
      store = new LibraryStore(filename)
      queue = create()
      queue.start()
    },
    async close() {
      await queue.close()
      store.close()
    },
  }
}

test('resource pause retains the same queued task, prefix, thread configuration and manual-pause state through restart', async () => {
  const f = await fixture()
  try {
    const job = f.queue.generate(f.request()).job!
    await until(() => !!f.workers[0]?.requests.length)
    f.partial(f.workers[0]!, job.audioHash)
    const saved = f.store.getTranscript(job.episodeId, job.audioHash)
    const autoApply = f.store.getJob(job.id)!.autoApply
    f.pause(true)
    await until(() => f.workers[0]!.closed > 0)
    assert.equal(f.store.getJob(job.id)!.status, 'queued')
    assert.equal(f.store.getJob(job.id)!.attempt, 2)
    assert.equal(f.store.getJob(job.id)!.autoApply, autoApply)
    assert.deepEqual(f.store.getTranscript(job.episodeId, job.audioHash), saved)
    await f.reopen()
    assert.equal(f.queue.resources().status, 'paused')
    assert.equal(f.workers.length, 1)
    f.policy({ cpuThreads: 1, lowPriority: true })
    f.pause(false)
    await until(() => !!f.workers[1]?.requests.length)
    assert.equal(f.workers[1]!.runtime.cpuThreads, 4)
    assert.equal(f.workers[1]!.requests[0]!.jobId, job.id)
    assert.deepEqual(f.store.getTranscript(job.episodeId, job.audioHash), saved)
    assert.ok(f.workers[1]!.priorities.includes(true))
  } finally {
    await f.close()
  }
})

test('a canceled task stays canceled when global processing is resumed', async () => {
  const f = await fixture()
  try {
    f.pause(true)
    const job = f.queue.generate(f.request()).job!
    f.queue.cancel(job.id)
    f.pause(false)
    assert.equal(f.store.getJob(job.id)!.status, 'canceled')
    assert.equal(f.workers.length, 0)
  } finally {
    await f.close()
  }
})

test('idle-only applies to background jobs; foreground promotion bypasses idle and active background work yields to user activity', async () => {
  const f = await fixture()
  try {
    f.policy({ backgroundIdleOnly: true })
    f.queue.generateBackground(f.request())
    assert.equal(f.queue.resources().status, 'waiting-idle')
    assert.equal(f.workers.length, 0)
    const job = f.queue.prepare(f.request(), false).job!
    await until(() => !!f.workers[0]?.requests.length)
    assert.equal(f.store.getJob(job.id)!.background, false)
    f.setIdle(0)
    assert.equal(f.store.getJob(job.id)!.status, 'running')
    f.queue.cancel(job.id)
    await until(() => f.store.getJob(job.id)!.status === 'canceled')
    f.queue.generateBackground(f.request(1))
    await until(() => f.queue.resources().status === 'waiting-idle')
    f.setIdle(120)
    await until(
      () => !!f.workers.at(-1)?.requests.some((r) => r.audioHash === f.request(1).audioHash),
      () =>
        JSON.stringify({
          state: f.queue.resources(),
          jobs: f.store.activeJobs(),
          workers: f.workers.map((w) => ({ requests: w.requests, closed: w.closed })),
          logs: f.logs.map(String),
        }),
    )
    const background = f.store.latestJob(f.request(1).episodeId, f.request(1).audioHash)!
    const runningAttempt = background.attempt
    f.partial(f.workers.at(-1)!, background.audioHash)
    f.setIdle(0)
    await until(() => f.queue.resources().status === 'waiting-idle')
    const waiting = f.store.getJob(background.id)!
    assert.equal(waiting.status, 'queued')
    assert.equal(waiting.attempt, runningAttempt + 1)
    assert.equal(waiting.processedUntilMs, 5000)
    assert.ok(f.workers.at(-1)!.closed > 0)
  } finally {
    await f.close()
  }
})

test('thread policy changes affect new tasks; priority updates current worker without changing its numerical configuration', async () => {
  const f = await fixture()
  try {
    const old = f.queue.generate(f.request()).job!
    await until(() => !!f.workers[0]?.requests.length)
    f.policy({ cpuThreads: 1, lowPriority: true })
    assert.equal(f.store.getJob(old.id)!.cpuThreads, 4)
    assert.equal(f.workers[0]!.configuration.threads, 4)
    assert.equal(f.workers[0]!.priorities.at(-1), true)
    const fresh = f.queue.generate(f.request(1)).job!
    assert.equal(fresh.cpuThreads, 1)
    f.queue.cancel(old.id)
    await until(() => !!f.workers[1]?.requests.length)
    assert.equal(f.workers[1]!.runtime.cpuThreads, 1)
    assert.equal(f.workers[1]!.runtime.device, 'cpu')
    assert.equal(f.workers[1]!.runtime.engine, 'paraformer')
  } finally {
    await f.close()
  }
})

test('completed idle workers are closed after the release interval and a later task creates a fresh process', async () => {
  const f = await fixture()
  try {
    const job = f.queue.generate(f.request()).job!
    await until(() => !!f.workers[0]?.requests.length)
    const snapshot = f.partial(f.workers[0]!, job.audioHash)
    f.workers[0]!.finish!({ status: 'completed', ...snapshot, durationMs: 5000 })
    await until(() => f.store.getJob(job.id)?.status === 'completed')
    f.setNow(29999)
    assert.equal(f.workers[0]!.closed, 0)
    f.setNow(30000)
    await until(() => f.workers[0]!.closed > 0)
    f.queue.generate(f.request(1))
    await until(() => !!f.workers[1]?.requests.length)
    assert.equal(f.logs.length, 0)
  } finally {
    await f.close()
  }
})

test('manual resource pause aborts a model lease and a stale settings revision cannot resume it', async () => {
  const f = await fixture()
  try {
    let aborted = false
    const revision = f.queue.resources().revision
    const lease = f.queue.withModelLease(
      async (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(signal.reason)
            },
            { once: true },
          )
        }),
    )
    const rejected = assert.rejects(lease, { name: 'AbortError' })
    await until(() => f.queue.resources().status === 'model-lease')
    f.pause(true)
    await rejected
    assert.equal(aborted, true)
    assert.equal(f.queue.resources().status, 'paused')
    assert.throws(() => f.queue.pauseProcessing({ revision, paused: false }), { code: 'CONFLICT' })
    assert.equal(f.queue.resources().paused, true)
  } finally {
    await f.close()
  }
})
