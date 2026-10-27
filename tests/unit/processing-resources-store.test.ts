import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { parseOriginal } from '../../src/main/original/parse'
import type { TranscriptDocument } from '../../src/shared/transcript'

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), '听读 资源存储 ')),
    filename = join(directory, 'library.sqlite3')
  for (const name of ['第1集.mp3', '第2集.mp3']) writeFileSync(join(directory, name), name)
  const store = new LibraryStore(filename)
  store.importBook(await scanBook(directory, 'folder'))
  return { filename, store, book: store.listBooks()[0]! }
}
function document(audioHash: string): TranscriptDocument {
  return {
    version: 1,
    kind: 'manual',
    audioHash,
    coverage: [{ startMs: 0, endMs: 10000 }],
    segments: [{ id: 's1', startMs: 1000, endMs: 5000, text: '已经人工修订并确定的原文。' }],
  }
}

test('schema 11 migrates to 12 with old four-thread jobs, configuration identity, preview, manual revisions and original corrections intact', async () => {
  const t = await setup(),
    episode = t.book.episodes[0]!,
    target = { episodeId: episode.id, audioHash: episode.contentHash }
  t.store.recordSourceDuration(episode.id, episode.contentHash, 10000)
  const initial = t.store.saveTranscript(episode.id, document(episode.contentHash))
  assert.equal(initial.status, 'ready')
  const saved = t.store.editTranscript({
    ...target,
    revision: 1,
    segmentId: 's1',
    text: '已经人工修订并确认的原文。',
  })
  assert.equal(saved.status, 'ready')
  if (saved.status !== 'ready') throw new Error('Missing manual transcript')
  const original = t.store.originals.import(
    target,
    parseOriginal(Buffer.from('已经人工修订并确认的原文。'), '原文.txt'),
  )
  t.store.originals.saveAlignment(
    target,
    original.info!.id,
    saved.transcript.id,
    saved.transcript.revision,
    0,
    [
      {
        segmentId: 's1',
        startMs: 1000,
        endMs: 5000,
        asrText: saved.transcript.document.segments[0]!.text,
        reviewed: false,
        candidates: [],
        selected: { first: 0, last: 0, method: 'auto' },
      },
    ],
  )
  const corrected = t.store.originals.correct({
    ...target,
    originalId: original.info!.id,
    revision: 1,
    segmentId: 's1',
    selection: { first: 0, last: 0 },
    startMs: 1250,
    endMs: 4750,
  })
  t.store.saveProgress({
    sessionId: '',
    episodeId: episode.id,
    positionMs: 2345,
    durationMs: 10000,
    rate: 1.5,
    volume: 0.35,
  })
  const job = t.store.createJob({ ...target, engine: 'whisperx', device: 'cpu' })
  t.store.setJobStatus(job.id, job.attempt, 'running')
  t.store.bindJobConfiguration(job.id, job.attempt, 'a'.repeat(64))
  const preview = {
    ...document(episode.contentHash),
    kind: 'transcript' as const,
    coverage: [{ startMs: 0, endMs: 5000 }],
  }
  t.store.acceptJobSnapshot(
    job.id,
    job.attempt,
    {
      document: preview,
      processedUntilMs: 5000,
      totalChunks: 2,
      cacheHits: 1,
      cacheKey: 'b'.repeat(64),
      issues: [],
    },
    1,
    false,
  )
  const oldJob = t.store.getJob(job.id)!,
    books = t.store.listBooks(),
    player = t.store.getPlayerState()
  t.store.close()
  const old = new DatabaseSync(t.filename)
  old.exec(
    'DROP TABLE subtitle_import_commands; DROP TABLE subtitle_import_sources; DROP TABLE transcript_edit_commands; DROP TABLE transcript_edit_members; DROP TABLE transcript_edit_heads; DROP TABLE transcript_edit_groups; DROP TABLE offline_media_refs; DROP TABLE offline_plan_items; DROP TABLE offline_job_owners; DROP TABLE offline_plans; DROP TABLE processing_resources; ALTER TABLE transcription_jobs DROP COLUMN cpu_threads; PRAGMA user_version=11;',
  )
  assert.equal(old.prepare('PRAGMA user_version').get()?.user_version, 11)
  assert.equal(
    old
      .prepare(
        "SELECT COUNT(*) AS count FROM pragma_table_info('transcription_jobs') WHERE name='cpu_threads'",
      )
      .get()?.count,
    0,
  )
  old.close()
  const migrated = new LibraryStore(t.filename)
  try {
    assert.deepEqual(migrated.listBooks(), books)
    assert.deepEqual(migrated.getPlayerState(), player)
    assert.deepEqual(migrated.getTranscript(episode.id, episode.contentHash), saved)
    assert.deepEqual(migrated.originals.state(target), corrected)
    assert.deepEqual(migrated.getJob(job.id), { ...oldJob, cpuThreads: 4 })
    assert.deepEqual(migrated.jobDocument(job.id), preview)
    assert.deepEqual(migrated.processingResources(), {
      revision: 1,
      policy: { cpuThreads: 4, lowPriority: false, backgroundIdleOnly: false },
      paused: false,
    })
    const check = new DatabaseSync(t.filename)
    assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 15)
    check.close()
  } finally {
    migrated.close()
  }
})

test('resource policy and paused intent use independent durable CAS revisions without stale overwrites', async () => {
  const t = await setup()
  let store = t.store
  try {
    const initial = store.processingResources(),
      changed = store.setProcessingPolicy({
        revision: initial.revision,
        policy: { cpuThreads: 1, lowPriority: true, backgroundIdleOnly: true },
      })
    assert.equal(changed.revision, initial.revision + 1)
    assert.throws(
      () => store.setProcessingPolicy({ revision: initial.revision, policy: initial.policy }),
      { code: 'CONFLICT' },
    )
    assert.throws(() => store.setProcessingPaused({ revision: initial.revision, paused: true }), {
      code: 'CONFLICT',
    })
    assert.deepEqual(store.processingResources(), changed)
    const paused = store.setProcessingPaused({ revision: changed.revision, paused: true })
    assert.deepEqual(paused.policy, changed.policy)
    store.close()
    store = new LibraryStore(t.filename)
    assert.deepEqual(store.processingResources(), paused)
    const updatedWhilePaused = store.setProcessingPolicy({
      revision: paused.revision,
      policy: { cpuThreads: 2, lowPriority: false, backgroundIdleOnly: false },
    })
    assert.equal(updatedWhilePaused.paused, true)
    assert.throws(() => store.setProcessingPaused({ revision: paused.revision, paused: false }), {
      code: 'CONFLICT',
    })
    const resumed = store.setProcessingPaused({
      revision: updatedWhilePaused.revision,
      paused: false,
    })
    assert.equal(resumed.paused, false)
    assert.deepEqual(resumed.policy, updatedWhilePaused.policy)
  } finally {
    store.close()
  }
})

test('new jobs freeze the selected thread count and policy changes or retries never rewrite existing job configuration', async () => {
  const t = await setup(),
    [first, second] = t.book.episodes,
    request = {
      episodeId: first!.id,
      audioHash: first!.contentHash,
      engine: 'whisperx' as const,
      device: 'cpu' as const,
    }
  let store = t.store
  try {
    const old = store.createJob(request)
    assert.equal(old.cpuThreads, 4)
    store.setJobStatus(old.id, old.attempt, 'running')
    store.bindJobConfiguration(old.id, old.attempt, 'c'.repeat(64))
    store.setJobStatus(old.id, old.attempt, 'failed', 'interrupted fixture')
    const current = store.processingResources()
    store.setProcessingPolicy({
      revision: current.revision,
      policy: { cpuThreads: 1, lowPriority: true, backgroundIdleOnly: false },
    })
    const next = store.createJob(
      { ...request, episodeId: second!.id, audioHash: second!.contentHash },
      true,
    )
    assert.equal(next.cpuThreads, 1)
    const retry = store.retryJob(old.id)
    assert.equal(retry.id, old.id)
    assert.equal(retry.attempt, old.attempt + 1)
    assert.equal(retry.cpuThreads, 4)
    assert.equal(retry.configurationHash, 'c'.repeat(64))
    assert.equal(store.getJob(old.id)!.cpuThreads, 4)
    store.close()
    store = new LibraryStore(t.filename)
    assert.equal(store.processingResources().policy.cpuThreads, 1)
    assert.equal(store.getJob(old.id)!.cpuThreads, 4)
    assert.equal(store.getJob(next.id)!.cpuThreads, 1)
  } finally {
    store.close()
  }
})
