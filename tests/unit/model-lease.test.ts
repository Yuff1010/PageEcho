import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import type { AsrOutcome, AsrSubmission } from '../../src/main/asr-process'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { TranscriptionQueue, type TranscriptionWorker } from '../../src/main/transcription-queue'

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) await delay(5)
  assert.ok(condition(), 'expected model ownership state was not reached')
}
class Worker implements TranscriptionWorker {
  ready = Promise.resolve()
  configuration = { fixture: 'model-lease-only' }
  diagnosticLog = ''
  requests: AsrSubmission[] = []
  closeCalls = 0
  closed = false
  closeBarrier?: Promise<void>
  order: string[] = []
  private finish?: (outcome: AsrOutcome) => void
  submit(request: AsrSubmission): Promise<AsrOutcome> {
    this.requests.push(request)
    return new Promise((resolve) => {
      this.finish = resolve
    })
  }
  complete() {
    const request = this.requests.at(-1)!
    this.finish?.({
      status: 'completed',
      durationMs: 2000,
      document: {
        version: 1,
        audioHash: request.audioHash,
        kind: 'transcript',
        coverage: [{ startMs: 0, endMs: 2000 }],
        segments: [
          { id: 'fixture', startMs: 100, endMs: 1500, text: '合成队列测试，不是模型识别结果。' },
        ],
      },
      processedUntilMs: 2000,
      cacheKey: 'a'.repeat(64),
      cacheHits: 0,
      totalChunks: 1,
      issues: [],
    })
  }
  cancel() {
    this.finish?.({ status: 'canceled' })
  }
  async close() {
    this.closeCalls++
    this.order.push('worker-close-start')
    await this.closeBarrier
    this.closed = true
    this.cancel()
    this.order.push('worker-close-end')
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ralb-model-lease-'))
  await writeFile(join(root, 'fixture.mp3'), 'model lease test audio identity')
  const store = new LibraryStore(join(root, 'library.sqlite3'))
  store.importBook(await scanBook(root, 'folder'))
  const episode = store.listBooks()[0]!.episodes[0]!
  store.recordSourceDuration(episode.id, episode.contentHash, 2000)
  const workers: Worker[] = [],
    logs: unknown[] = []
  const queue = new TranscriptionQueue(
    store,
    {
      configured: true,
      runtime: (engine, device) => ({
        python: '',
        script: '',
        models: '',
        cache: '',
        ffmpeg: '',
        ffprobe: '',
        engine,
        device,
        compute: 'int8',
      }),
    },
    () => {},
    (error) => logs.push(error),
    () => {
      const worker = new Worker()
      workers.push(worker)
      return worker
    },
  )
  const request = {
    episodeId: episode.id,
    audioHash: episode.contentHash,
    engine: 'paraformer' as const,
    device: 'cpu' as const,
  }
  return {
    store,
    queue,
    request,
    workers,
    logs,
    async idleWorker() {
      const job = queue.generate(request).job!
      await until(() => workers.at(-1)?.requests.length === 1)
      workers.at(-1)!.complete()
      await until(() => store.getJob(job.id)?.status === 'completed')
      return workers.at(-1)!
    },
    async close() {
      await queue.close()
      store.close()
    },
  }
}

test('an active transcription refuses a model lease without closing or canceling its worker', async () => {
  const f = await fixture()
  try {
    const job = f.queue.generate(f.request).job!
    await until(() => f.workers[0]?.requests.length === 1)
    let entered = false
    await assert.rejects(
      f.queue.withModelLease(async () => {
        entered = true
      }),
      { code: 'BUSY' },
    )
    assert.equal(entered, false)
    assert.equal(f.workers[0]!.closeCalls, 0)
    assert.equal(f.workers[0]!.closed, false)
    assert.equal(f.store.getJob(job.id)!.status, 'running')
    assert.equal(f.queue.maintaining, false)
  } finally {
    await f.close()
  }
})

test('a saved queued job also prevents a lease before any worker is spawned', async () => {
  const f = await fixture()
  try {
    const job = f.store.createJob(f.request)
    await assert.rejects(
      f.queue.withModelLease(async () => 'unreachable'),
      { code: 'BUSY' },
    )
    assert.equal(f.workers.length, 0)
    assert.equal(f.store.getJob(job.id)!.status, 'queued')
    assert.equal(f.queue.maintaining, false)
  } finally {
    await f.close()
  }
})

test('an idle worker fully closes before a lease enters and is not reused afterward', async () => {
  const f = await fixture(),
    closing = gate()
  try {
    const worker = await f.idleWorker()
    worker.closeBarrier = closing.promise
    let entered = false
    const lease = f.queue.withModelLease(async (signal) => {
      entered = true
      worker.order.push('lease')
      assert.equal(signal.aborted, false)
      assert.equal(worker.closed, true)
      return 42
    })
    assert.equal(worker.closeCalls, 1)
    assert.equal(entered, false)
    assert.equal(f.queue.maintaining, true)
    assert.throws(() => f.queue.generate(f.request), { code: 'BUSY' })
    closing.release()
    assert.equal(await lease, 42)
    assert.deepEqual(worker.order, ['worker-close-start', 'worker-close-end', 'lease'])
    assert.equal(f.queue.maintaining, false)
    f.queue.generate(f.request)
    await until(() => f.workers[1]?.requests.length === 1)
    assert.equal(f.workers.length, 2)
    assert.equal(worker.requests.length, 1)
    assert.deepEqual(f.logs, [])
  } finally {
    closing.release()
    await f.close()
  }
})

test('a held lease rejects generation, retry and both maintenance modes without mutating the failed job', async () => {
  const f = await fixture(),
    held = gate()
  try {
    const failed = f.store.createJob(f.request)
    f.store.setJobStatus(failed.id, failed.attempt, 'failed', 'synthetic retry fixture')
    let entered = false,
      maintenanceEntered = false
    const lease = f.queue.withModelLease(async () => {
      entered = true
      await held.promise
      return 'released'
    })
    await until(() => entered)
    assert.equal(f.queue.maintaining, true)
    assert.throws(() => f.queue.generate(f.request), { code: 'BUSY' })
    assert.throws(() => f.queue.prepare(f.request), { code: 'BUSY' })
    assert.throws(() => f.queue.retry(failed.id), { code: 'BUSY' })
    for (const mediaOnly of [false, true])
      await assert.rejects(
        f.queue.withMaintenance(async () => {
          maintenanceEntered = true
        }, mediaOnly),
        { code: 'BUSY' },
      )
    await assert.rejects(
      f.queue.withModelLease(async () => 'another model'),
      { code: 'BUSY' },
    )
    assert.equal(maintenanceEntered, false)
    assert.equal(f.store.getJob(failed.id)!.attempt, 1)
    assert.equal(f.store.getJob(failed.id)!.status, 'failed')
    assert.equal(f.store.activeJobs().length, 0)
    assert.equal(f.workers.length, 0)
    held.release()
    assert.equal(await lease, 'released')
    assert.equal(f.queue.maintaining, false)
    f.queue.retry(failed.id)
    await until(() => f.workers[0]?.requests.length === 1)
    assert.equal(f.store.getJob(failed.id)!.attempt, 2)
  } finally {
    held.release()
    await f.close()
  }
})

test('a failed lease releases ownership so subsequent leases and maintenance can proceed', async () => {
  const f = await fixture()
  try {
    const failure = new Error('synthetic alignment failure')
    await assert.rejects(
      f.queue.withModelLease(async () => {
        throw failure
      }),
      (error) => error === failure,
    )
    assert.equal(f.queue.maintaining, false)
    assert.equal(await f.queue.withModelLease(async () => 'next lease'), 'next lease')
    assert.equal(await f.queue.withMaintenance(async () => 'maintenance'), 'maintenance')
    assert.equal(f.queue.maintaining, false)
    assert.deepEqual(f.logs, [])
  } finally {
    await f.close()
  }
})

test('queue shutdown aborts a held lease and waits for its owned cleanup to finish', async () => {
  const f = await fixture(),
    cleanup = gate()
  let closed = false,
    entered = false,
    aborted = false
  try {
    const lease = f.queue.withModelLease(async (signal) => {
      entered = true
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted = true
            resolve()
          },
          { once: true },
        ),
      )
      await cleanup.promise
      signal.throwIfAborted()
    })
    const rejected = assert.rejects(lease, { name: 'AbortError' })
    await until(() => entered)
    const closing = f.queue.close().then(() => {
      closed = true
    })
    await until(() => aborted)
    assert.equal(closed, false)
    assert.equal(f.queue.maintaining, true)
    assert.throws(() => f.queue.generate(f.request), { code: 'BUSY' })
    cleanup.release()
    await rejected
    await closing
    assert.equal(closed, true)
    assert.equal(f.queue.maintaining, false)
    assert.deepEqual(f.logs, [])
  } finally {
    cleanup.release()
    await f.close()
  }
})

test('shutdown while the idle worker is closing never enters the lease action', async () => {
  const f = await fixture(),
    cleanup = gate()
  try {
    const worker = await f.idleWorker()
    worker.closeBarrier = cleanup.promise
    let entered = false,
      closed = false
    const lease = f.queue.withModelLease(async () => {
      entered = true
    })
    const rejected = assert.rejects(lease, { name: 'AbortError' })
    const closing = f.queue.close().then(() => {
      closed = true
    })
    assert.equal(worker.closeCalls, 1)
    assert.equal(closed, false)
    cleanup.release()
    await rejected
    await closing
    assert.equal(entered, false)
    assert.equal(worker.closed, true)
    assert.equal(worker.closeCalls, 1)
    assert.equal(f.queue.maintaining, false)
    assert.deepEqual(f.logs, [])
  } finally {
    cleanup.release()
    await f.close()
  }
})
