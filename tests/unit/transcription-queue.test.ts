import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { TranscriptionQueue, type TranscriptionWorker } from '../../src/main/transcription-queue'
import type { AsrEvent, AsrOutcome, AsrSnapshot, AsrSubmission } from '../../src/main/asr-process'
import { validateRequest } from '../../src/shared/validation'
import { isSmallTranscriptEdit } from '../../src/shared/transcript'

class Worker implements TranscriptionWorker {
  ready = Promise.resolve()
  configuration = { version: 'fixture-1' }
  diagnosticLog = ''
  requests: AsrSubmission[] = []
  priorities: { id: string; attempt: number; positionMs: number }[] = []
  closed = false
  private callback?: (event: AsrEvent) => void
  private resolve?: (outcome: AsrOutcome) => void
  private reject?: (error: Error) => void
  submit(value: AsrSubmission, callback: (event: AsrEvent) => void): Promise<AsrOutcome> {
    this.requests.push(value)
    this.callback = callback
    return new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
  emit(event: AsrEvent) {
    try {
      this.callback?.(event)
    } catch (error) {
      this.reject?.(error as Error)
    }
  }
  complete(snapshot: AsrSnapshot) {
    this.resolve?.({ status: 'completed', durationMs: 10000, ...snapshot })
  }
  fail() {
    this.reject?.(new Error('fixture failure'))
  }
  cancel() {
    this.resolve?.({ status: 'canceled' })
  }
  prioritize(id: string, attempt: number, positionMs: number) {
    this.priorities.push({ id, attempt, positionMs })
  }
  async close() {
    this.closed = true
    this.resolve?.({ status: 'canceled' })
  }
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await delay(5)
  assert.ok(condition(), 'expected queue state was not reached')
}
async function setup(count = 1) {
  const root = await mkdtemp(join(tmpdir(), '听读 task '))
  for (let i = 0; i < count; i++) await writeFile(join(root, `${i}.mp3`), `known audio ${i}`)
  const filename = join(root, 'library.sqlite3')
  const store = new LibraryStore(filename)
  store.importBook(await scanBook(root, 'folder'))
  const episodes = store.listBooks()[0]!.episodes
  const workers: Worker[] = []
  let workerVersion = 'fixture-1'
  const component = {
    configured: true,
    runtime: (engine: 'whisperx' | 'paraformer', device: 'cpu' | 'cuda') => ({
      python: '',
      script: '',
      models: '',
      cache: '',
      ffmpeg: '',
      ffprobe: '',
      engine,
      device,
      compute: 'int8' as const,
    }),
  }
  const factory = () => {
    const worker = new Worker()
    worker.configuration = { version: workerVersion }
    workers.push(worker)
    return worker
  }
  const queue = new TranscriptionQueue(
    store,
    component,
    () => undefined,
    () => undefined,
    factory,
  )
  const generate = (index = 0) =>
    queue.generate({
      episodeId: episodes[index]!.id,
      audioHash: episodes[index]!.contentHash,
      engine: 'whisperx',
      device: 'cpu',
    })
  return {
    root,
    filename,
    store,
    episodes,
    workers,
    component,
    factory,
    queue,
    generate,
    setWorkerVersion: (value: string) => {
      workerVersion = value
    },
  }
}
function snapshot(hash: string, full = false): AsrSnapshot {
  return {
    document: {
      version: 1,
      audioHash: hash,
      kind: 'transcript',
      coverage: [{ startMs: 0, endMs: full ? 10000 : 5000 }],
      segments: [
        { id: 's1', startMs: 1000, endMs: 3000, text: '第十九章，故事开始了。' },
        ...(full ? [{ id: 's2', startMs: 6000, endMs: 9000, text: '明天继续出发。' }] : []),
      ],
    },
    processedUntilMs: full ? 10000 : 5000,
    cacheKey: 'a'.repeat(64),
    cacheHits: 0,
    totalChunks: 2,
    issues: [],
  }
}

test('summary and conditional synchronization keep progress live without returning unchanged sentence bodies', async () => {
  const t = await setup()
  try {
    const episode = t.episodes[0]!,
      job = t.generate().job!
    assert.equal(
      t.queue.summary(episode.id, episode.contentHash).transcriptHeader.status,
      'missing',
    )
    await until(() => t.workers[0]?.requests.length === 1)
    t.workers[0]!.emit({ type: 'partial', ...snapshot(job.audioHash), completedChunks: 1 })
    const first = t.queue.sync(episode.id, episode.contentHash)
    assert.equal(first.transcript.status, 'ready')
    if (first.transcript.status !== 'ready') throw new Error('Expected full first synchronization')
    const known = {
      id: first.transcript.transcript.id,
      revision: first.transcript.transcript.revision,
    }
    const summary = t.queue.summary(episode.id, episode.contentHash)
    assert.equal(summary.transcriptHeader.status, 'ready')
    assert.ok(!JSON.stringify(summary).includes('第十九章'))
    assert.ok(!JSON.stringify(summary).includes('segments'))
    if (summary.transcriptHeader.status !== 'ready') throw new Error('Expected summary coverage')
    assert.deepEqual(summary.transcriptHeader.transcript.coverage, [{ startMs: 0, endMs: 5000 }])
    t.workers[0]!.emit({ type: 'progress', stage: 'aligning', processedUntilMs: 5000 })
    const progress = t.queue.sync(episode.id, episode.contentHash, known)
    assert.equal(progress.job!.stage, 'aligning')
    assert.deepEqual(progress.transcript, { status: 'unchanged', version: known })
    t.workers[0]!.emit({ type: 'partial', ...snapshot(job.audioHash, true), completedChunks: 2 })
    const changed = t.queue.sync(episode.id, episode.contentHash, known)
    assert.equal(changed.transcript.status, 'ready')
    if (changed.transcript.status !== 'ready') throw new Error('Expected new full revision')
    assert.equal(changed.transcript.transcript.document.segments.length, 2)
    assert.throws(() => t.queue.summary(episode.id, 'f'.repeat(64)), { code: 'FILE_CHANGED' })
    assert.throws(() => t.queue.sync(episode.id, 'f'.repeat(64), known), { code: 'FILE_CHANGED' })
  } finally {
    await t.queue.close()
    t.store.close()
  }
})

test('foreground generation starts at saved media position and seeks reprioritize without restarting or reviving cancellation', async () => {
  const t = await setup()
  try {
    const episode = t.episodes[0]!
    t.store.saveProgress({
      sessionId: '',
      episodeId: episode.id,
      positionMs: 6000,
      durationMs: 10000,
      rate: 1.5,
      volume: 1,
    })
    const job = t.generate().job!
    await until(() => t.workers[0]?.requests.length === 1)
    assert.equal(t.workers[0]!.requests[0]!.priorityMs, 6000)
    t.queue.prioritize(episode.id, episode.contentHash, 1000)
    assert.deepEqual(t.workers[0]!.priorities, [{ id: job.id, attempt: 1, positionMs: 1000 }])
    assert.equal(t.store.getJob(job.id)!.attempt, 1)
    assert.equal(t.workers[0]!.requests.length, 1)
    assert.throws(() => t.queue.prioritize(episode.id, 'b'.repeat(64), 3000), {
      code: 'FILE_CHANGED',
    })
    t.queue.cancel(job.id)
    t.queue.prioritize(episode.id, episode.contentHash, 9000)
    assert.equal(t.workers[0]!.priorities.length, 1)
    await until(() => t.store.getJob(job.id)?.status === 'canceled')
  } finally {
    await t.queue.close()
    t.store.close()
  }
})

test('foreground generation preempts an active next-episode task and later resumes its saved prefix', async () => {
  const t = await setup(2)
  try {
    const next = t.episodes[1]!
    t.queue.generateBackground({
      episodeId: next.id,
      audioHash: next.contentHash,
      engine: 'whisperx',
      device: 'cpu',
    })
    const background = t.store.latestJob(next.id, next.contentHash)!
    assert.equal(background.background, true)
    await until(() => t.workers[0]?.requests.length === 1)
    t.workers[0]!.emit({ type: 'partial', ...snapshot(next.contentHash), completedChunks: 1 })
    const prefix = t.store.getTranscript(next.id, next.contentHash)
    const current = t.generate(0).job!
    await until(() => t.workers[1]?.requests.length === 1)
    assert.equal(t.store.getJob(current.id)!.status, 'running')
    assert.equal(t.store.getJob(background.id)!.status, 'queued')
    assert.equal(t.store.getJob(background.id)!.attempt, 2)
    assert.deepEqual(t.store.getTranscript(next.id, next.contentHash), prefix)
    t.workers[1]!.complete(snapshot(current.audioHash, true))
    await until(() => t.workers[1]?.requests.length === 2)
    assert.equal(t.workers[1]!.requests[1]!.jobId, background.id)
    t.workers[1]!.complete(snapshot(next.contentHash, true))
    await until(() => t.store.getJob(background.id)?.status === 'completed')
    assert.equal(t.store.getJob(current.id)!.background, false)
  } finally {
    await t.queue.close()
    t.store.close()
  }
})

test('opening a prepared episode promotes its task and media maintenance pins active audio while excluding new submissions', async () => {
  const t = await setup(3)
  try {
    for (const e of t.episodes.slice(0, 2))
      t.queue.generateBackground({
        episodeId: e.id,
        audioHash: e.contentHash,
        engine: 'whisperx',
        device: 'cpu',
      })
    await until(() => t.workers[0]?.requests.length === 1)
    const next = t.store.latestJob(t.episodes[1]!.id, t.episodes[1]!.contentHash)!
    t.queue.onEpisodeOpened(t.episodes[1]!.id)
    await until(() => t.workers[1]?.requests.length === 1)
    assert.equal(t.store.getJob(next.id)!.background, false)
    assert.ok(t.queue.protectedEpisodeIds.includes(t.episodes[1]!.id))
    let release!: () => void
    const lock = new Promise<void>((resolve) => {
      release = resolve
    })
    const maintenance = t.queue.withMaintenance(() => lock, true)
    assert.throws(() => t.generate(2), { code: 'BUSY' })
    assert.equal(t.workers[1]!.closed, false)
    release()
    await maintenance
    t.workers[1]!.complete(snapshot(t.episodes[1]!.contentHash, true))
    await until(() => t.store.getJob(next.id)?.status === 'completed')
  } finally {
    await t.queue.close()
    t.store.close()
  }
})

test('queue publishes prefixes but protects user corrections from later model snapshots', async () => {
  const t = await setup()
  try {
    const job = t.generate().job!
    await until(() => t.workers[0]?.requests.length === 1)
    const worker = t.workers[0]!,
      hash = job.audioHash
    worker.emit({ type: 'partial', ...snapshot(hash), completedChunks: 1 })
    const first = t.store.getTranscript(job.episodeId, hash)
    assert.equal(first.status, 'ready')
    if (first.status !== 'ready') throw new Error('missing transcript')
    t.store.editTranscript({
      episodeId: job.episodeId,
      audioHash: hash,
      revision: first.transcript.revision,
      segmentId: 's1',
      text: '第十九章，故事继续了。',
    })
    worker.emit({ type: 'partial', ...snapshot(hash, true), completedChunks: 2 })
    worker.complete(snapshot(hash, true))
    await until(() => t.store.getJob(job.id)?.status === 'completed')
    const current = t.store.getTranscript(job.episodeId, hash)
    assert.equal(
      current.status === 'ready' && current.transcript.document.segments[0]!.text,
      '第十九章，故事继续了。',
    )
    assert.equal(t.store.getJob(job.id)!.autoApply, false)
    assert.equal(t.queue.preview(job.id).document.segments.length, 2)
    assert.throws(() => t.store.applyJob(job.id, 0), { code: 'CONFLICT' })
    const applied = t.store.applyJob(job.id, 2)
    assert.equal(applied.status === 'ready' && applied.transcript.document.segments.length, 2)
  } finally {
    await t.queue.close()
    t.store.close()
  }
})

test('automatic preparation streams a prefix, continues the existing job, and reuses a completed transcript', async () => {
  const t = await setup()
  try {
    const episode = t.episodes[0]!
    const request = {
      episodeId: episode.id,
      audioHash: episode.contentHash,
      engine: 'whisperx' as const,
      device: 'cpu' as const,
    }
    const first = t.queue.prepare(request).job!
    await until(() => t.workers[0]?.requests.length === 1)
    t.workers[0]!.emit({ type: 'partial', ...snapshot(first.audioHash), completedChunks: 1 })
    const partial = t.queue.prepare(request)
    assert.equal(partial.transcript.status, 'ready')
    assert.equal(partial.job!.id, first.id)
    assert.equal(partial.job!.status, 'running')
    assert.equal(partial.job!.autoApply, true)
    assert.equal(t.workers[0]!.requests.length, 1)
    t.workers[0]!.complete(snapshot(first.audioHash, true))
    await until(() => t.store.getJob(first.id)?.status === 'completed')
    const complete = t.queue.prepare(request)
    assert.equal(complete.job!.id, first.id)
    assert.equal(complete.job!.status, 'completed')
    assert.equal(
      complete.transcript.status === 'ready' &&
        complete.transcript.transcript.document.segments.length,
      2,
    )
    assert.equal(t.store.listJobs({ page: 0, activeOnly: false }).total, 1)
  } finally {
    await t.queue.close()
    t.store.close()
  }
})

test('automatic preparation resumes switch-canceled partial work using the same job and preserves later corrections', async () => {
  const t = await setup(2)
  try {
    const episode = t.episodes[0]!
    const request = {
      episodeId: episode.id,
      audioHash: episode.contentHash,
      engine: 'whisperx' as const,
      device: 'cpu' as const,
    }
    const first = t.queue.prepare(request).job!
    await until(() => t.workers[0]?.requests.length === 1)
    t.workers[0]!.emit({ type: 'partial', ...snapshot(first.audioHash), completedChunks: 1 })
    t.queue.onEpisodeOpened(t.episodes[1]!.id)
    await until(() => t.store.getJob(first.id)?.status === 'canceled')
    t.queue.onEpisodeOpened(episode.id)
    const resumed = t.queue.prepare(request).job!
    assert.equal(resumed.id, first.id)
    assert.equal(resumed.attempt, 2)
    assert.equal(resumed.autoApply, true)
    await until(() => t.workers[1]?.requests.length === 1)
    const current = t.store.getTranscript(episode.id, episode.contentHash)
    assert.equal(current.status, 'ready')
    if (current.status !== 'ready') throw new Error('missing prefix')
    t.store.editTranscript({
      ...request,
      revision: current.transcript.revision,
      segmentId: 's1',
      text: '第十九章，故事继续了。',
    })
    t.workers[1]!.complete(snapshot(first.audioHash, true))
    await until(() => t.store.getJob(first.id)?.status === 'completed')
    const protectedText = t.store.getTranscript(episode.id, episode.contentHash)
    assert.equal(
      protectedText.status === 'ready' && protectedText.transcript.document.segments[0]!.text,
      '第十九章，故事继续了。',
    )
    assert.equal(t.store.getJob(first.id)!.autoApply, false)
  } finally {
    await t.queue.close()
    t.store.close()
  }
})

test('quickly reopening a switch-canceling task resumes after it settles, while user cancellation remains stopped', async () => {
  const t = await setup(2)
  try {
    const first = t.episodes[0]!
    const request = {
      episodeId: first.id,
      audioHash: first.contentHash,
      engine: 'whisperx' as const,
      device: 'cpu' as const,
    }
    const job = t.queue.prepare(request).job!
    await until(() => t.workers[0]?.requests.length === 1)
    t.queue.onEpisodeOpened(t.episodes[1]!.id)
    assert.equal(t.store.getJob(job.id)!.status, 'canceling')
    t.queue.onEpisodeOpened(first.id)
    t.queue.prepare(request)
    await until(() => t.workers[1]?.requests.length === 1)
    assert.equal(t.store.getJob(job.id)!.attempt, 2)
    t.queue.cancel(job.id)
    await until(() => t.store.getJob(job.id)?.status === 'canceled')
    assert.equal(t.queue.prepare(request).job!.status, 'canceled')
    assert.equal(t.workers.length, 2)
    t.queue.retry(job.id)
    await until(() => t.workers[2]?.requests.length === 1)
    t.workers[2]!.fail()
    await until(() => t.store.getJob(job.id)?.status === 'failed')
    assert.equal(t.queue.prepare(request).job!.status, 'failed')
    assert.equal(t.workers.length, 3)
  } finally {
    await t.queue.close()
    t.store.close()
  }
})

test('switching chapters while user cancellation settles never makes the partial task resumable again', async () => {
  const t = await setup(2)
  try {
    const first = t.episodes[0]!
    const request = {
      episodeId: first.id,
      audioHash: first.contentHash,
      engine: 'whisperx' as const,
      device: 'cpu' as const,
    }
    const job = t.queue.prepare(request).job!
    await until(() => t.workers[0]?.requests.length === 1)
    t.workers[0]!.emit({ type: 'partial', ...snapshot(job.audioHash), completedChunks: 1 })
    t.queue.cancel(job.id)
    assert.equal(t.store.getJob(job.id)!.status, 'canceling')
    t.queue.onEpisodeOpened(t.episodes[1]!.id)
    assert.equal(t.store.getJob(job.id)!.error, null, 'a switch cannot replace the user reason')
    t.queue.onEpisodeOpened(first.id)
    t.queue.prepare(request)
    await until(() => t.store.getJob(job.id)?.status === 'canceled')
    const partial = t.store.getTranscript(first.id, first.contentHash)
    assert.equal(partial.status === 'ready' && partial.transcript.revision, 1)
    assert.equal(t.queue.prepare(request, true).job!.status, 'canceled')
    await delay(10)
    assert.equal(t.workers.length, 1)
    assert.equal(t.store.getJob(job.id)!.attempt, 1)
    t.queue.retry(job.id)
    await until(() => t.workers[1]?.requests.length === 1)
    assert.equal(t.queue.preparationStopped(request), false)
  } finally {
    await t.queue.close()
    t.store.close()
  }
})

test('canceling before a job exists blocks next-episode and offline admission until an explicit generation', async () => {
  const t = await setup(2)
  try {
    const episode = t.episodes[1]!
    const request = {
      episodeId: episode.id,
      audioHash: episode.contentHash,
      engine: 'whisperx' as const,
      device: 'cpu' as const,
    }
    assert.equal(t.queue.stopPreparation(request).job, null)
    assert.equal(t.queue.preparationStopped(request), true)
    t.queue.onEpisodeOpened(t.episodes[0]!.id, episode.id)
    assert.equal(t.queue.prepare(request, true).job, null)
    assert.equal(t.queue.prepare(request).job, null)
    assert.throws(() => t.queue.startForOffline('no-item-admitted', request), {
      code: 'CONFLICT',
    })
    assert.deepEqual(t.store.activeJobs(), [])
    assert.equal(t.workers.length, 0)
    const job = t.queue.generate(request).job!
    assert.equal(t.queue.preparationStopped(request), false)
    await until(() => t.workers[0]?.requests.length === 1)
    assert.equal(t.workers[0]!.requests[0]!.jobId, job.id)
  } finally {
    await t.queue.close()
    t.store.close()
  }
})

test('canceling while a worker is loading closes it without waiting for ready or submitting audio', async () => {
  const t = await setup()
  let rejectReady!: (error: Error) => void
  class LoadingWorker extends Worker {
    override ready = new Promise<void>((_done, reject) => {
      rejectReady = reject
    })
    override async close() {
      await super.close()
      rejectReady(new Error('fixture canceled during worker startup'))
    }
  }
  const worker = new LoadingWorker()
  let loading = false
  const queue = new TranscriptionQueue(
    t.store,
    t.component,
    () => {},
    () => {},
    () => {
      loading = true
      return worker
    },
  )
  try {
    const episode = t.episodes[0]!
    const job = queue.generate({
      episodeId: episode.id,
      audioHash: episode.contentHash,
      engine: 'whisperx',
      device: 'cpu',
    }).job!
    await until(() => queue.resources().active?.jobId === job.id)
    await until(() => loading)
    queue.cancel(job.id)
    await until(() => t.store.getJob(job.id)?.status === 'canceled')
    assert.equal(worker.closed, true)
    assert.deepEqual(worker.requests, [])
    assert.equal(t.store.getJob(job.id)!.error, null)
  } finally {
    await queue.close()
    await t.queue.close()
    t.store.close()
  }
})

test('automatic preparation keeps an imported document without starting a worker', async () => {
  const t = await setup()
  try {
    const episode = t.episodes[0]!
    t.store.saveTranscript(episode.id, {
      ...snapshot(episode.contentHash).document,
      kind: 'manual',
    })
    const state = t.queue.prepare({
      episodeId: episode.id,
      audioHash: episode.contentHash,
      engine: 'whisperx',
      device: 'cpu',
    })
    assert.equal(state.job, null)
    assert.equal(
      state.transcript.status === 'ready' && state.transcript.transcript.document.kind,
      'manual',
    )
    assert.equal(t.workers.length, 0)
  } finally {
    await t.queue.close()
    t.store.close()
  }
})

test('resuming a formerly opened episode as next demotes it behind the current task', async () => {
  const t = await setup(2)
  try {
    const next = t.episodes[1]!
    const nextRequest = {
      episodeId: next.id,
      audioHash: next.contentHash,
      engine: 'whisperx' as const,
      device: 'cpu' as const,
    }
    const job = t.queue.prepare(nextRequest).job!
    await until(() => t.workers[0]?.requests.length === 1)
    t.queue.onEpisodeOpened(t.episodes[0]!.id, next.id)
    const current = t.generate(0).job!
    t.queue.prepare(nextRequest, true)
    await until(() => t.workers[1]?.requests.length === 1)
    assert.equal(t.workers[1]!.requests[0]!.jobId, current.id)
    assert.equal(t.store.getJob(job.id)!.background, true)
    assert.equal(t.store.getJob(job.id)!.status, 'queued')
    assert.equal(t.store.getJob(job.id)!.attempt, 2)
    t.workers[1]!.complete(snapshot(current.audioHash, true))
    await until(() => t.workers[1]?.requests.length === 2)
    assert.equal(t.workers[1]!.requests[1]!.jobId, job.id)
    t.workers[1]!.complete(snapshot(next.contentHash, true))
    await until(() => t.store.getJob(job.id)?.status === 'completed')
  } finally {
    await t.queue.close()
    t.store.close()
  }
})

test('existing manual text is kept until the user explicitly applies a finished preview', async () => {
  const t = await setup()
  try {
    const episode = t.episodes[0]!
    t.store.saveTranscript(episode.id, {
      ...snapshot(episode.contentHash).document,
      kind: 'manual',
    })
    const job = t.generate().job!
    await until(() => t.workers[0]?.requests.length === 1)
    assert.equal(job.autoApply, false)
    t.workers[0]!.emit({ type: 'partial', ...snapshot(job.audioHash), completedChunks: 1 })
    t.workers[0]!.complete(snapshot(job.audioHash, true))
    await until(() => t.store.getJob(job.id)?.status === 'completed')
    const original = t.store.getTranscript(episode.id, episode.contentHash)
    assert.equal(original.status === 'ready' && original.transcript.revision, 1)
    const replacement = t.store.applyJob(job.id, 1)
    assert.equal(
      replacement.status === 'ready' && replacement.transcript.document.kind,
      'transcript',
    )
  } finally {
    await t.queue.close()
    t.store.close()
  }
})

test('cancel suppresses late messages and retry preserves the prefix without revision churn', async () => {
  const t = await setup()
  try {
    const job = t.generate().job!
    await until(() => t.workers[0]?.requests.length === 1)
    const partial = { type: 'partial' as const, ...snapshot(job.audioHash), completedChunks: 1 }
    t.workers[0]!.emit(partial)
    t.queue.cancel(job.id)
    t.workers[0]!.emit({ type: 'partial', ...snapshot(job.audioHash, true), completedChunks: 2 })
    await until(() => t.store.getJob(job.id)?.status === 'canceled')
    assert.equal(t.store.getJob(job.id)!.processedUntilMs, 5000)
    t.queue.retry(job.id)
    await until(() => t.workers[1]?.requests.length === 1)
    assert.equal(t.workers[1]!.requests[0]!.attempt, 2)
    t.workers[1]!.emit(partial)
    const state = t.store.getTranscript(job.episodeId, job.audioHash)
    assert.equal(state.status === 'ready' && state.transcript.revision, 1)
    t.workers[1]!.complete(snapshot(job.audioHash, true))
    await until(() => t.store.getJob(job.id)?.status === 'completed')
  } finally {
    await t.queue.close()
    t.store.close()
  }
})

test('durable recovery requeues a running attempt, preserves cancellation intent and rejects old results', async () => {
  const t = await setup(2)
  const first = t.store.createJob({
    episodeId: t.episodes[0]!.id,
    audioHash: t.episodes[0]!.contentHash,
    engine: 'whisperx',
    device: 'cpu',
  })
  const second = t.store.createJob({
    episodeId: t.episodes[1]!.id,
    audioHash: t.episodes[1]!.contentHash,
    engine: 'whisperx',
    device: 'cpu',
  })
  t.store.setJobStatus(first.id, 1, 'running')
  t.store.acceptJobSnapshot(first.id, 1, snapshot(first.audioHash), 1, false)
  t.store.setJobStatus(second.id, 1, 'canceling')
  await t.queue.close()
  t.store.close()
  const restored = new LibraryStore(t.filename)
  const next = new TranscriptionQueue(
    restored,
    t.component,
    () => undefined,
    () => undefined,
    t.factory,
  )
  try {
    assert.equal(restored.getJob(first.id)!.status, 'queued')
    assert.equal(restored.getJob(first.id)!.attempt, 2)
    assert.equal(restored.getJob(second.id)!.status, 'canceled')
    assert.equal(
      restored.acceptJobSnapshot(first.id, 1, snapshot(first.audioHash, true), 2, true),
      false,
    )
    next.start()
    await until(() => t.workers[0]?.requests.length === 1)
    t.workers[0]!.complete(snapshot(first.audioHash, true))
    await until(() => restored.getJob(first.id)?.status === 'completed')
  } finally {
    await next.close()
    restored.close()
  }
})

test('queue runs serially, reuses its worker, and switching episodes cancels other jobs', async () => {
  const t = await setup(2)
  try {
    const first = t.generate().job!,
      second = t.generate(1).job!
    assert.equal(t.store.getJob(second.id)!.status, 'queued')
    await until(() => t.workers[0]?.requests.length === 1)
    t.workers[0]!.complete(snapshot(first.audioHash, true))
    await until(() => t.workers[0]?.requests.length === 2)
    assert.equal(t.workers.length, 1)
    t.queue.onEpisodeOpened(first.episodeId)
    await until(() => t.store.getJob(second.id)?.status === 'canceled')
  } finally {
    await t.queue.close()
    t.store.close()
  }
})

test('runtime version change fails a retry rather than mixing incompatible partial results', async () => {
  const t = await setup()
  try {
    const job = t.generate().job!
    await until(() => t.workers[0]?.requests.length === 1)
    t.workers[0]!.emit({ type: 'partial', ...snapshot(job.audioHash), completedChunks: 1 })
    t.workers[0]!.fail()
    await until(() => t.store.getJob(job.id)?.status === 'failed')
    t.setWorkerVersion('fixture-2')
    t.queue.retry(job.id)
    await until(() => t.store.getJob(job.id)?.status === 'failed')
    assert.equal(t.store.getJob(job.id)!.processedUntilMs, 5000)
  } finally {
    await t.queue.close()
    t.store.close()
  }
})

test('transcription IPC rejects paths, extra fields, invalid devices and stale edit input shapes', () => {
  const id = '5cd6b9c2-7d12-4234-8d80-464014161e77',
    hash = 'a'.repeat(64)
  const valid = { episodeId: id, audioHash: hash, engine: 'whisperx', device: 'cpu' }
  validateRequest('transcription:start', [valid])
  for (const candidate of [
    { ...valid, path: resolve('secret') },
    { ...valid, device: 'auto' },
    { ...valid, engine: 'custom' },
  ])
    assert.throws(() => validateRequest('transcription:start', [candidate]), {
      code: 'INVALID_REQUEST',
    })
  validateRequest('transcript:edit', [
    { episodeId: id, audioHash: hash, revision: 1, segmentId: 's1', text: '文字' },
  ])
  assert.throws(() => validateRequest('transcription:apply', [{ id, revision: -1 }]), {
    code: 'INVALID_REQUEST',
  })
  assert.equal(
    isSmallTranscriptEdit('他合上书，决定明天再出发。', '他合上书，决定后天再出发。'),
    true,
  )
  assert.equal(
    isSmallTranscriptEdit('他合上书，决定明天再出发。', '完全不同的长篇内容，需要重新拆分和对齐。'),
    false,
  )
})

test('schema v3 migrates without losing the book, progress, manual transcript or revision', async () => {
  const t = await setup()
  const episode = t.episodes[0]!
  t.store.saveTranscript(episode.id, { ...snapshot(episode.contentHash).document, kind: 'manual' })
  t.store.saveProgress({
    sessionId: '',
    episodeId: episode.id,
    positionMs: 2350,
    durationMs: 10000,
    rate: 1.5,
    volume: 0.35,
  })
  await t.queue.close()
  t.store.close()
  const old = new DatabaseSync(t.filename)
  old.exec(
    'DROP TABLE online_pending_progress; DROP TABLE subtitle_import_commands; DROP TABLE subtitle_import_sources; DROP TABLE transcript_edit_commands; DROP TABLE transcript_edit_members; DROP TABLE transcript_edit_heads; DROP TABLE transcript_edit_groups; DROP TABLE offline_media_refs; DROP TABLE offline_plan_items; DROP TABLE offline_job_owners; DROP TABLE offline_plans; DROP TABLE processing_resources; DROP TABLE book_subtitle_settings; DROP TABLE reading_books; DROP TABLE original_alignments; DROP TABLE book_originals; DROP TABLE original_documents; DROP TABLE source_media_files; DROP TABLE online_episodes; DROP TABLE online_books; DROP TABLE transcript_regions; DROP TABLE bookmarks; DROP TABLE book_listening_settings; DROP TABLE transcription_jobs; PRAGMA user_version=3;',
  )
  old.close()
  const migrated = new LibraryStore(t.filename)
  try {
    assert.equal(migrated.getEpisode(episode.id)!.positionMs, 2350)
    assert.equal(migrated.getPlayerState().preferences.volume, 0.35)
    const document = migrated.getTranscript(episode.id, episode.contentHash)
    assert.equal(document.status === 'ready' && document.transcript.revision, 1)
    assert.equal(document.status === 'ready' && document.transcript.document.kind, 'manual')
    assert.deepEqual(migrated.activeJobs(), [])
  } finally {
    migrated.close()
  }
})

test('shutdown before worker initialization persists an interrupted attempt without leaving a child', async () => {
  const t = await setup()
  const job = t.generate().job!
  await t.queue.close()
  assert.equal(t.workers.length, 0)
  assert.equal(t.store.getJob(job.id)!.status, 'queued')
  assert.equal(t.store.getJob(job.id)!.attempt, 2)
  t.store.close()
})

test('maintenance excludes generate and retry, rejects active jobs, and shutdown awaits its lease', async () => {
  const t = await setup()
  const job = t.generate().job!
  await until(() => t.workers[0]?.requests.length === 1)
  await assert.rejects(
    t.queue.withMaintenance(async () => undefined),
    { code: 'BUSY' },
  )
  t.queue.cancel(job.id)
  await until(() => t.store.getJob(job.id)?.status === 'canceled')
  let release: () => void = () => undefined
  const operation = t.queue.withMaintenance(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  await until(() => t.queue.maintaining)
  await delay(0)
  assert.throws(() => t.generate(), { code: 'BUSY' })
  assert.throws(() => t.queue.retry(job.id), { code: 'BUSY' })
  let closed = false
  const closing = t.queue.close().then(() => {
    closed = true
  })
  await delay(10)
  assert.equal(closed, false)
  release()
  await operation
  await closing
  t.store.close()
})

test('task history is paginated, ordered and filtered independently of transcript documents', async () => {
  const t = await setup()
  try {
    const episode = t.episodes[0]!
    for (let i = 0; i < 27; i++) {
      const job = t.store.createJob({
        episodeId: episode.id,
        audioHash: episode.contentHash,
        engine: 'whisperx',
        device: 'cpu',
      })
      t.store.setJobStatus(job.id, job.attempt, i === 26 ? 'queued' : 'failed')
    }
    assert.equal(t.store.listJobs({ page: 0, activeOnly: false }).jobs.length, 25)
    assert.equal(t.store.listJobs({ page: 1, activeOnly: false }).jobs.length, 2)
    const active = t.store.listJobs({ page: 0, activeOnly: true })
    assert.equal(active.total, 1)
    assert.equal(active.active, 1)
    assert.equal(active.jobs[0]!.stale, false)
    assert.equal(active.jobs[0]!.episodeTitle, episode.title)
  } finally {
    await t.queue.close()
    t.store.close()
  }
})

test('real SQLITE_FULL rolls back a growing snapshot, preserves saved text and progress, then permits retry', async () => {
  const t = await setup()
  const db = Reflect.get(t.store, 'db') as DatabaseSync
  try {
    const job = t.generate().job!
    await until(() => t.workers[0]?.requests.length === 1)
    t.workers[0]!.emit({ type: 'partial', ...snapshot(job.audioHash), completedChunks: 1 })
    t.store.saveProgress({
      sessionId: '',
      episodeId: job.episodeId,
      positionMs: 2350,
      durationMs: 10000,
      rate: 1.5,
      volume: 0.35,
    })
    const previous = t.store.getTranscript(job.episodeId, job.audioHash)
    const preview = t.store.jobDocument(job.id)
    const pageCount = Number(db.prepare('PRAGMA page_count').get()!.page_count)
    db.exec(`PRAGMA max_page_count = ${pageCount}`)
    const growing = snapshot(job.audioHash, true)
    growing.document.segments = Array.from({ length: 200 }, (_, index) => ({
      id: `full-${index}`,
      startMs: index * 40,
      endMs: index * 40 + 30,
      text: '测试'.repeat(4000),
    }))
    assert.throws(
      () => t.store.acceptJobSnapshot(job.id, job.attempt, growing, 2, true),
      (error: unknown) => error instanceof Error && Reflect.get(error, 'errcode') === 13,
    )
    assert.equal(db.isTransaction, false)
    assert.deepEqual(t.store.getTranscript(job.episodeId, job.audioHash), previous)
    assert.deepEqual(t.store.jobDocument(job.id), preview)
    assert.equal(t.store.getEpisode(job.episodeId)!.positionMs, 2350)
    t.workers[0]!.emit({ type: 'partial', ...growing, completedChunks: 2 })
    await until(() => t.store.getJob(job.id)?.status === 'failed')
    assert.match(t.store.getJob(job.id)!.error!, /空间不足/)
    assert.equal(t.store.getJob(job.id)!.processedUntilMs, 5000)
    db.exec('PRAGMA max_page_count = 1073741823')
    t.queue.retry(job.id)
    await until(() => t.workers[1]?.requests.length === 1)
    t.workers[1]!.complete(snapshot(job.audioHash, true))
    await until(() => t.store.getJob(job.id)?.status === 'completed')
    assert.equal(t.store.getEpisode(job.episodeId)!.positionMs, 2350)
  } finally {
    db.exec('PRAGMA max_page_count = 1073741823')
    await t.queue.close()
    t.store.close()
  }
})

test('failure to persist even the terminal state pauses the queue, remains visible, and can be retried after storage recovers', async () => {
  const t = await setup(2)
  const db = Reflect.get(t.store, 'db') as DatabaseSync
  try {
    const job = t.generate().job!
    await until(() => t.workers[0]?.requests.length === 1)
    t.workers[0]!.emit({ type: 'partial', ...snapshot(job.audioHash), completedChunks: 1 })
    const second = t.generate(1).job!
    db.exec(`CREATE TRIGGER reject_terminal BEFORE UPDATE OF status ON transcription_jobs
      WHEN NEW.status IN ('failed','canceled') BEGIN SELECT RAISE(ABORT,'injected terminal write failure'); END`)
    t.workers[0]!.fail()
    await until(() => t.queue.state(job.episodeId, job.audioHash).job?.status === 'failed')
    assert.equal(t.workers[0]!.closed, true)
    assert.equal(
      t.store.getJob(job.id)!.status,
      'running',
      'the database retains its last durable state',
    )
    assert.match(t.queue.state(job.episodeId, job.audioHash).job!.error!, /队列已暂停/)
    assert.equal(
      t.queue.tasks({ page: 0, activeOnly: false }).jobs.find((item) => item.id === job.id)!.status,
      'failed',
    )
    assert.deepEqual(
      t.queue.tasks({ page: 0, activeOnly: true }).jobs.map((item) => item.id),
      [second.id],
    )
    assert.equal(t.queue.tasks({ page: 0, activeOnly: false }).active, 1)
    assert.throws(() => t.queue.retry(job.id), { code: 'INTERNAL' })
    assert.equal(t.store.getJob(second.id)!.status, 'queued')
    db.exec('DROP TRIGGER reject_terminal')
    t.queue.retry(job.id)
    await until(() => t.workers[1]?.requests.length === 1)
    assert.equal(t.workers[1]!.requests[0]!.attempt, 2)
    t.workers[1]!.complete(snapshot(job.audioHash, true))
    await until(() => t.workers[1]?.requests.length === 2)
    t.workers[1]!.complete(snapshot(second.audioHash, true))
    await until(() => t.store.getJob(second.id)?.status === 'completed')
  } finally {
    db.exec('DROP TRIGGER IF EXISTS reject_terminal')
    await t.queue.close()
    t.store.close()
  }
})

test('shutdown closes the worker even when interruption state cannot be saved', async () => {
  const t = await setup()
  const db = Reflect.get(t.store, 'db') as DatabaseSync
  const job = t.generate().job!
  await until(() => t.workers[0]?.requests.length === 1)
  t.workers[0]!.emit({ type: 'partial', ...snapshot(job.audioHash), completedChunks: 1 })
  db.exec(`CREATE TRIGGER reject_interrupt BEFORE UPDATE OF status ON transcription_jobs
    WHEN NEW.status='queued' BEGIN SELECT RAISE(ABORT,'injected interruption write failure'); END`)
  await t.queue.close()
  assert.equal(t.workers[0]!.closed, true)
  assert.equal(t.store.getJob(job.id)!.status, 'running')
  db.exec('DROP TRIGGER reject_interrupt')
  t.store.close()
  const reopened = new LibraryStore(t.filename)
  try {
    reopened.recoverJobs()
    assert.equal(reopened.getJob(job.id)!.attempt, 2)
    assert.equal(reopened.getJob(job.id)!.processedUntilMs, 5000)
  } finally {
    reopened.close()
  }
})
