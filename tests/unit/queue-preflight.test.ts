import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import type { AsrOutcome, AsrRuntime, AsrSnapshot, AsrSubmission } from '../../src/main/asr-process'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { TranscriptionQueue, type TranscriptionWorker } from '../../src/main/transcription-queue'

type Check = (runtime: AsrRuntime, signal: AbortSignal) => Promise<void>
async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await delay(5)
  assert.ok(condition(), 'expected preflight state was not reached')
}
class Worker implements TranscriptionWorker {
  ready = Promise.resolve()
  configuration = { fixture: true }
  diagnosticLog = ''
  requests: AsrSubmission[] = []
  private finish?: (outcome: AsrOutcome) => void
  submit(request: AsrSubmission): Promise<AsrOutcome> {
    this.requests.push(request)
    return new Promise((resolve) => {
      this.finish = resolve
    })
  }
  cancel() {
    this.finish?.({ status: 'canceled' })
  }
  async close() {
    this.cancel()
  }
}
async function setup(check: Check, count = 1) {
  const root = await mkdtemp(join(tmpdir(), 'ralb-preflight-'))
  for (let i = 0; i < count; i++) await writeFile(join(root, `${i}.mp3`), `audio ${i}`)
  const store = new LibraryStore(join(root, 'library.sqlite3'))
  store.importBook(await scanBook(root, 'folder'))
  const episodes = store.listBooks()[0]!.episodes
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
    check,
  )
  const request = (index = 0) => ({
    episodeId: episodes[index]!.id,
    audioHash: episodes[index]!.contentHash,
    engine: 'paraformer' as const,
    device: 'cpu' as const,
  })
  return { store, episodes, workers, logs, queue, request }
}
function snapshot(audioHash: string): AsrSnapshot {
  return {
    document: {
      version: 1,
      audioHash,
      kind: 'transcript',
      coverage: [{ startMs: 0, endMs: 5000 }],
      segments: [{ id: 's1', startMs: 500, endMs: 4000, text: '已保存的部分文字。' }],
    },
    processedUntilMs: 5000,
    cacheKey: 'a'.repeat(64),
    cacheHits: 0,
    totalChunks: 2,
    issues: [],
  }
}
function blockedCheck() {
  let entered = false,
    aborted = false
  let release!: () => void
  const check: Check = async (_runtime, signal) => {
    entered = true
    await new Promise<void>((resolve, reject) => {
      release = resolve
      const abort = () => {
        aborted = true
        reject(signal.reason)
      }
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
  }
  return { check, entered: () => entered, aborted: () => aborted, release: () => release() }
}

test('failed preflight does not start inference or replace the saved prefix/manual document', async () => {
  const t = await setup(async () => {
    throw new Error('模型资源缺失，请重新配置组件。')
  }, 2)
  try {
    const prefixJob = t.store.createJob(t.request())
    t.store.setJobStatus(prefixJob.id, 1, 'running')
    t.store.acceptJobSnapshot(prefixJob.id, 1, snapshot(prefixJob.audioHash), 1, false)
    t.store.setJobStatus(prefixJob.id, 1, 'failed')
    const prefix = t.store.getTranscript(prefixJob.episodeId, prefixJob.audioHash)
    t.queue.retry(prefixJob.id)
    await until(() => t.store.getJob(prefixJob.id)?.status === 'failed')
    assert.match(t.store.getJob(prefixJob.id)!.error!, /模型资源缺失/)
    assert.equal(t.store.getJob(prefixJob.id)!.processedUntilMs, 5000)
    assert.deepEqual(t.store.getTranscript(prefixJob.episodeId, prefixJob.audioHash), prefix)
    const second = t.episodes[1]!
    t.store.saveTranscript(second.id, { ...snapshot(second.contentHash).document, kind: 'manual' })
    const manual = t.store.getTranscript(second.id, second.contentHash)
    const job = t.queue.generate(t.request(1)).job!
    await until(() => t.store.getJob(job.id)?.status === 'failed')
    assert.deepEqual(t.store.getTranscript(second.id, second.contentHash), manual)
    assert.equal(t.workers.length, 0)
  } finally {
    await t.queue.close()
    t.store.close()
  }
})

test('canceling a blocked component check aborts it promptly without spawning a worker or recording failure', async () => {
  const gate = blockedCheck()
  const t = await setup(gate.check)
  try {
    const job = t.queue.generate(t.request()).job!
    await until(gate.entered)
    assert.equal(t.store.getJob(job.id)!.stage, 'checking-components')
    t.queue.cancel(job.id)
    await until(() => t.store.getJob(job.id)?.status === 'canceled')
    assert.equal(gate.aborted(), true)
    assert.equal(t.workers.length, 0)
    assert.deepEqual(t.logs, [])
    gate.release()
    await delay(5)
    assert.equal(t.workers.length, 0)
  } finally {
    await t.queue.close()
    t.store.close()
  }
})

test('shutdown aborts an owned component check while leaving the interrupted job resumable', async () => {
  const gate = blockedCheck()
  const t = await setup(gate.check)
  const job = t.queue.generate(t.request()).job!
  await until(gate.entered)
  await t.queue.close()
  try {
    assert.equal(gate.aborted(), true)
    assert.equal(t.store.getJob(job.id)!.status, 'queued')
    assert.equal(t.store.getJob(job.id)!.attempt, 2)
    assert.equal(t.workers.length, 0)
    assert.deepEqual(t.logs, [])
  } finally {
    t.store.close()
  }
})

test('a current episode preempts the background preflight and reaches inference before that job resumes', async () => {
  const gate = blockedCheck()
  let checks = 0
  const t = await setup(async (runtime, signal) => {
    if (++checks === 1) await gate.check(runtime, signal)
  }, 2)
  try {
    t.queue.generateBackground(t.request(1))
    const background = t.store.latestJob(t.episodes[1]!.id, t.episodes[1]!.contentHash)!
    await until(gate.entered)
    const current = t.queue.generate(t.request()).job!
    await until(() => t.workers[0]?.requests.length === 1)
    assert.equal(gate.aborted(), true)
    assert.equal(t.workers[0]!.requests[0]!.jobId, current.id)
    assert.equal(t.store.getJob(background.id)!.status, 'queued')
    assert.equal(t.store.getJob(background.id)!.attempt, 2)
    assert.deepEqual(t.logs, [])
  } finally {
    await t.queue.close()
    t.store.close()
  }
})
