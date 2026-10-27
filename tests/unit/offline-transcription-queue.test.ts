import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { TranscriptionQueue, type TranscriptionWorker } from '../../src/main/transcription-queue'
import type {
  AsrEvent,
  AsrOutcome,
  AsrSnapshot,
  AsrSubmission,
  AsrRuntime,
} from '../../src/main/asr-process'
import type { OfflinePlan, UpdateOfflinePlanRequest } from '../../src/shared/offline'

class Worker implements TranscriptionWorker {
  ready = Promise.resolve()
  diagnosticLog = ''
  configuration: Record<string, unknown>
  requests: AsrSubmission[] = []
  cancelCalls = 0
  closed = false
  publish?: (event: AsrEvent) => void
  private finish?: (value: AsrOutcome) => void
  constructor(readonly runtime: AsrRuntime) {
    this.configuration = { fixture: 'offline-queue', threads: runtime.cpuThreads }
  }
  submit(request: AsrSubmission, publish: (event: AsrEvent) => void) {
    this.requests.push(request)
    this.publish = publish
    return new Promise<AsrOutcome>((done) => {
      this.finish = done
    })
  }
  cancel() {
    this.cancelCalls++
    this.finish?.({ status: 'canceled' })
  }
  async close() {
    this.closed = true
    this.finish?.({ status: 'canceled' })
  }
  complete(hash: string, durationMs = 10000.25) {
    this.finish?.({ status: 'completed', durationMs, ...snapshot(hash, true) })
  }
}
function snapshot(audioHash: string, full = false): AsrSnapshot {
  return {
    document: {
      version: 1,
      kind: 'transcript',
      audioHash,
      coverage: [{ startMs: 0, endMs: full ? 10000 : 5000 }],
      segments: [
        { id: 'first', startMs: 500, endMs: 4500, text: '已保存的第一块文字。' },
        ...(full ? [{ id: 'second', startMs: 5500, endMs: 9500, text: '第二块完整文字。' }] : []),
      ],
    },
    processedUntilMs: full ? 10000 : 5000,
    totalChunks: 2,
    cacheKey: 'a'.repeat(64),
    cacheHits: 0,
    issues: [],
  }
}
async function until(predicate: () => boolean) {
  for (let index = 0; index < 400 && !predicate(); index++) await delay(5)
  assert(predicate(), 'The controlled queue did not reach its required state.')
}
async function fixture(
  context: TestContext,
  checkRuntime?: (runtime: AsrRuntime, signal: AbortSignal) => Promise<void>,
  options: { pollMs?: number } = {},
) {
  const root = await mkdtemp(join(tmpdir(), '听读 持久计划队列 ')),
    file = join(root, 'library.sqlite3')
  for (let index = 0; index < 4; index++)
    await writeFile(join(root, `${index}.mp3`), `Owned offline queue audio ${index}`)
  let store = new LibraryStore(file)
  store.importBook(await scanBook(root, 'folder'))
  const book = store.listBooks()[0]!,
    episodes = book.episodes,
    workers: Worker[] = [],
    logs: unknown[] = []
  let idle = 120
  const createQueue = () =>
    new TranscriptionQueue(
      store,
      {
        configured: true,
        runtime: (engine, device) => ({
          engine,
          device,
          compute: 'int8',
          python: '',
          script: '',
          models: '',
          cache: '',
          ffmpeg: '',
          ffprobe: '',
        }),
      },
      () => {},
      (error) => logs.push(error),
      (runtime) => {
        const worker = new Worker(runtime)
        workers.push(worker)
        return worker
      },
      checkRuntime,
      { pollMs: options.pollMs ?? 0, idleSeconds: () => idle },
    )
  let queue = createQueue()
  const request = (index = 0) => ({
    episodeId: episodes[index]!.id,
    audioHash: episodes[index]!.contentHash,
    engine: 'paraformer' as const,
    device: 'cpu' as const,
  })
  const createPlan = (index = 0) =>
    store.createOfflinePlan({
      bookId: book.id,
      episodeIds: [episodes[index]!.id],
      scope: 'ids',
      profile: { engine: 'paraformer', device: 'cpu' },
      audioBudgetBytes: 2 * 1024 ** 3,
    })
  const item = (plan: OfflinePlan) => store.storedOfflineItems(plan.id)[0]!
  const start = (plan: OfflinePlan, index = 0) => {
    const current = store.offlinePlan(plan.id)!,
      currentItem = item(current)
    return queue.startForOffline(currentItem.id, request(index), {
      planRevision: current.revision,
      attempt: currentItem.attempt,
    })
  }
  const update = (plan: OfflinePlan, action: UpdateOfflinePlanRequest['action']) => {
    assert(action !== 'set-budget')
    return store.updateOfflinePlan({
      id: plan.id,
      revision: store.offlinePlan(plan.id)!.revision,
      action,
    })
  }
  context.after(async () => {
    await queue.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    workers,
    logs,
    episodes,
    request,
    createPlan,
    item,
    start,
    update,
    get queue() {
      return queue
    },
    get store() {
      return store
    },
    partial(worker: Worker, hash: string) {
      worker.publish!({ type: 'partial', ...snapshot(hash), completedChunks: 1 })
    },
    idle(value: number) {
      idle = value
      queue.refreshResourceSchedule()
    },
    pause(paused: boolean) {
      queue.pauseProcessing({ revision: queue.resources().revision, paused })
    },
    async reopen() {
      await queue.close()
      store.close()
      store = new LibraryStore(file)
      queue = createQueue()
      queue.start()
    },
  }
}

test('the real two-second resource timer and passive reconciliation cannot start durable work before initialization explicitly enables the queue', async (context) => {
  const f = await fixture(context, undefined, { pollMs: 2000 }),
    plan = f.createPlan(),
    item = f.item(plan)
  const { job } = f.store.createOrAttachOfflineJob(item.id, f.request(), {
    planRevision: plan.revision,
    attempt: item.attempt,
  })
  f.queue.resources()
  f.queue.state(job.episodeId, job.audioHash)
  f.queue.tasks({ page: 0, activeOnly: true })
  f.queue.updateResources({
    revision: f.queue.resources().revision,
    policy: { cpuThreads: 1, lowPriority: true, backgroundIdleOnly: false },
  })
  f.queue.reconcileOffline()
  await delay(2100)
  assert.equal(f.workers.length, 0)
  assert.equal(f.store.getJob(job.id)!.status, 'queued')
  assert.equal(f.store.getJob(job.id)!.attempt, 1)
  f.queue.start()
  await until(() => f.workers[0]?.requests[0]?.jobId === job.id)
  assert.equal(
    f.workers[0]!.runtime.cpuThreads,
    4,
    "Startup gating must retain the job's frozen thread policy.",
  )
})

test('navigation preserves planned work; a different foreground job interrupts and later resumes its checkpoint and original configuration', async (context) => {
  const f = await fixture(context),
    plan = f.createPlan(1),
    planned = f.start(plan, 1)
  await until(() => f.workers[0]?.requests.length === 1)
  f.partial(f.workers[0]!, planned.audioHash)
  const prefix = f.store.getTranscript(planned.episodeId, planned.audioHash),
    configuration = f.store.getJob(planned.id)!.configurationHash
  f.queue.onEpisodeOpened(f.episodes[1]!.id)
  assert.equal(f.store.getJob(planned.id)!.background, false)
  f.queue.onEpisodeOpened(f.episodes[2]!.id)
  assert.equal(f.store.getJob(planned.id)!.background, true)
  assert.equal(f.store.getJob(planned.id)!.status, 'running')
  assert.equal(f.workers[0]!.cancelCalls, 0)
  assert.equal(f.store.offlineJobOwnership(planned.id).manual, false)
  const manual = f.queue.generate(f.request()).job!
  await until(() => f.workers[1]?.requests.length === 1)
  assert.equal(f.store.getJob(planned.id)!.status, 'queued')
  assert.equal(f.store.getJob(planned.id)!.attempt, 2)
  assert.equal(f.store.getJob(planned.id)!.configurationHash, configuration)
  assert.equal(f.store.getJob(planned.id)!.cpuThreads, 4)
  assert.deepEqual(f.store.getTranscript(planned.episodeId, planned.audioHash), prefix)
  f.workers[1]!.complete(manual.audioHash)
  await until(() => f.workers[1]?.requests.length === 2)
  assert.equal(f.workers[1]!.requests[1]!.jobId, planned.id)
  assert.equal(f.workers[1]!.requests[1]!.attempt, 2)
  f.workers[1]!.complete(planned.audioHash)
  await until(() => f.store.getJob(planned.id)?.status === 'completed')
  assert.equal(f.store.getEpisode(planned.episodeId)!.durationMs, 10000.25)
  assert.equal(
    f.item(plan).durationMs,
    10000.25,
    'Persist the worker duration, not the coverage endpoint.',
  )
  assert.deepEqual(f.logs, [])
})

test('shared plan pause does not stop another owner; pausing all then canceling preserves chunks without reviving across restart', async (context) => {
  const f = await fixture(context),
    first = f.createPlan(),
    second = f.createPlan(),
    job = f.start(first)
  assert.equal(f.start(second).id, job.id)
  await until(() => f.workers[0]?.requests.length === 1)
  f.partial(f.workers[0]!, job.audioHash)
  const prefix = f.store.getTranscript(job.episodeId, job.audioHash)
  f.update(first, 'pause')
  await f.queue.interruptOffline([job.id])
  assert.equal(f.store.getJob(job.id)!.attempt, 1)
  assert.equal(f.workers[0]!.cancelCalls, 0)
  f.update(second, 'pause')
  await f.queue.interruptOffline([job.id])
  assert.equal(f.workers[0]!.closed, true)
  assert.equal(f.store.getJob(job.id)!.status, 'queued')
  assert.equal(f.store.getJob(job.id)!.attempt, 2)
  assert.deepEqual(f.store.getTranscript(job.episodeId, job.audioHash), prefix)
  f.queue.reconcileOffline()
  assert.equal(f.workers.length, 1)
  f.update(first, 'resume')
  f.queue.reconcileOffline()
  await until(() => f.workers[1]?.requests.length === 1)
  assert.equal(f.workers[1]!.requests[0]!.jobId, job.id)
  assert.equal(f.workers[1]!.requests[0]!.attempt, 2)
  f.update(first, 'cancel')
  f.update(second, 'cancel')
  await f.queue.interruptOffline([job.id])
  assert.deepEqual(f.store.getTranscript(job.episodeId, job.audioHash), prefix)
  await f.reopen()
  assert.deepEqual(f.store.offlineJobOwnership(job.id), {
    planned: true,
    runnable: false,
    manual: false,
  })
  assert.equal(f.workers.length, 2)
  assert.equal(f.store.getJob(job.id)!.status, 'queued')
  assert(!f.queue.protectedEpisodeIds.includes(job.episodeId))
  await f.queue.withMaintenance(async () => undefined)
  await f.queue.withModelLease(async () => undefined)
  const manual = f.queue.generate(f.request(2)).job!
  await until(() => f.workers[2]?.requests[0]?.jobId === manual.id)
  assert.equal(f.store.getJob(job.id)!.attempt, 3)
})

test('a different profile cannot claim a plan job, while explicit foreground takeover survives plan pause and cancel', async (context) => {
  const f = await fixture(context),
    plan = f.createPlan()
  f.pause(true)
  const job = f.start(plan)
  assert.throws(() => f.queue.prepare({ ...f.request(), engine: 'whisperx' }), { code: 'BUSY' })
  assert.equal(f.store.offlineJobOwnership(job.id).manual, false)
  assert.equal(f.store.getJob(job.id)!.background, true)
  assert.equal(f.queue.prepare(f.request()).job!.id, job.id)
  assert.equal(f.store.offlineJobOwnership(job.id).manual, true)
  f.update(plan, 'pause')
  await f.queue.interruptOffline([job.id])
  f.update(plan, 'cancel')
  await f.queue.interruptOffline([job.id])
  assert.equal(f.store.getJob(job.id)!.attempt, 1)
  assert.equal(f.store.getJob(job.id)!.status, 'queued')
  await f.reopen()
  assert.equal(f.store.offlineJobOwnership(job.id).manual, true)
  f.pause(false)
  await until(() => f.workers[0]?.requests.length === 1)
  assert.equal(f.workers[0]!.requests[0]!.jobId, job.id)
  f.workers[0]!.complete(job.audioHash)
  await until(() => f.store.getJob(job.id)?.status === 'completed')
})

test('paused plan jobs do not starve eligible work and background idle/global pause policies still control plan inference', async (context) => {
  const f = await fixture(context)
  f.queue.updateResources({
    revision: f.queue.resources().revision,
    policy: { cpuThreads: 1, lowPriority: true, backgroundIdleOnly: true },
  })
  f.idle(0)
  const first = f.createPlan(),
    second = f.createPlan(1),
    paused = f.start(first),
    active = f.start(second, 1)
  f.update(first, 'pause')
  await f.queue.interruptOffline([paused.id])
  f.store.promoteJob(paused.id) // Persisted foreground flag from an earlier session cannot bypass ownership.
  assert.equal(f.queue.resources().status, 'waiting-idle')
  assert.equal(f.workers.length, 0)
  f.idle(120)
  await until(() => f.workers[0]?.requests[0]?.jobId === active.id)
  assert.equal(f.workers[0]!.runtime.cpuThreads, 1)
  f.partial(f.workers[0]!, active.audioHash)
  f.pause(true)
  await until(() => f.workers[0]!.closed)
  assert.equal(f.store.getJob(active.id)!.attempt, 2)
  f.idle(0)
  f.pause(false)
  assert.equal(f.workers.length, 1)
  assert.equal(f.queue.resources().status, 'waiting-idle')
  f.queue.prepare(f.request(1))
  await until(() => f.workers[1]?.requests[0]?.jobId === active.id)
  assert.equal(f.store.getJob(paused.id)!.status, 'queued')
  assert.equal(f.store.getJob(paused.id)!.attempt, 1)
})

test('an offline job preserves an existing partial manual document and finishes into an unapplied preview', async (context) => {
  const f = await fixture(context),
    request = f.request()
  const manual = { ...snapshot(request.audioHash).document, kind: 'manual' as const }
  f.store.saveTranscript(request.episodeId, manual)
  const before = f.store.getTranscript(request.episodeId, request.audioHash),
    plan = f.createPlan(),
    job = f.start(plan)
  assert.equal(job.autoApply, false)
  await until(() => f.workers[0]?.requests.length === 1)
  f.workers[0]!.complete(job.audioHash)
  await until(() => f.store.getJob(job.id)?.status === 'completed')
  assert.deepEqual(f.store.getTranscript(job.episodeId, job.audioHash), before)
  assert.equal(f.queue.preview(job.id).document.coverage[0]!.endMs, 10000)
  assert.equal(f.store.getJob(job.id)!.autoApply, false)
})

test('plan interruption during preflight waits for cleanup and cannot submit a late canceled attempt ahead of a manual job', async (context) => {
  let started!: (signal: AbortSignal) => void, release!: () => void
  const entered = new Promise<AbortSignal>((done) => {
      started = done
    }),
    held = new Promise<void>((done) => {
      release = done
    })
  let checks = 0
  const f = await fixture(context, async (_runtime, signal) => {
      if (checks++ === 0) {
        started(signal)
        await held
      }
    }),
    plan = f.createPlan(),
    job = f.start(plan)
  const signal = await entered
  f.update(plan, 'pause')
  let settled = false
  const interrupted = f.queue.interruptOffline([job.id]).then(() => {
    settled = true
  })
  const manual = f.queue.generate(f.request(1)).job!
  try {
    await delay(10)
    assert.equal(signal.aborted, true)
    assert.equal(settled, false)
    assert.equal(f.workers.length, 0)
  } finally {
    release()
  }
  await interrupted
  await until(() => f.workers[0]?.requests.length === 1)
  assert.equal(f.workers[0]!.requests[0]!.jobId, manual.id)
  assert.equal(f.store.getJob(job.id)!.status, 'queued')
  assert.equal(f.store.getJob(job.id)!.attempt, 2)
  assert(!f.workers.some((worker) => worker.requests.some((request) => request.jobId === job.id)))
})

test('explicit task cancellation is never automatically retried by an offline plan or reconciliation', async (context) => {
  const f = await fixture(context),
    plan = f.createPlan(),
    job = f.start(plan)
  await until(() => f.workers[0]?.requests.length === 1)
  f.queue.cancel(job.id)
  await until(() => f.store.getJob(job.id)?.status === 'canceled')
  assert.throws(() => f.start(plan), { code: 'CONFLICT' })
  f.queue.reconcileOffline()
  await f.reopen()
  assert.equal(f.store.getJob(job.id)!.status, 'canceled')
  assert.equal(f.workers.length, 1)
})

test('stale plan generations cannot create or revive a queue job after pause and resume', async (context) => {
  const f = await fixture(context),
    plan = f.createPlan(),
    item = f.item(plan),
    old = { planRevision: plan.revision, attempt: item.attempt }
  f.update(plan, 'pause')
  assert.throws(() => f.queue.startForOffline(item.id, f.request(), old), { code: 'CONFLICT' })
  f.update(plan, 'resume')
  assert.throws(() => f.queue.startForOffline(item.id, f.request(), old), { code: 'CONFLICT' })
  assert.equal(f.store.activeJobs().length, 0)
  assert.equal(f.workers.length, 0)
  const job = f.start(plan)
  await until(() => f.workers[0]?.requests[0]?.jobId === job.id)
})
