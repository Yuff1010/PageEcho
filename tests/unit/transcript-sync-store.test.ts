import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import type { AsrSnapshot } from '../../src/main/asr-process'
import type { TranscriptDocument, TranscriptVersion } from '../../src/shared/transcript'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ralb-transcript-sync-')),
    path = join(root, 'episode.mp3'),
    filename = join(root, 'library.sqlite3')
  await writeFile(path, 'isolated synchronization audio')
  const store = new LibraryStore(filename)
  store.importBook(await scanBook(path, 'file'))
  const book = store.listBooks()[0]!,
    episode = book.episodes[0]!
  store.recordSourceDuration(episode.id, episode.contentHash, 90_000)
  const target = { episodeId: episode.id, audioHash: episode.contentHash }
  const document = (startMs = 0, endMs = 30_000, text = '保留原始文字。'): TranscriptDocument => ({
    version: 1,
    audioHash: episode.contentHash,
    kind: 'transcript',
    coverage: [{ startMs, endMs }],
    segments: [{ id: `s-${startMs}`, startMs: startMs + 100, endMs: endMs - 100, text }],
  })
  const snapshot = (value: TranscriptDocument): AsrSnapshot => ({
    document: value,
    processedUntilMs: value.coverage[0]?.startMs === 0 ? value.coverage[0].endMs : 0,
    cacheKey: 'a'.repeat(64),
    totalChunks: 3,
    cacheHits: 0,
    issues: [],
  })
  return { store, filename, path, book, episode, target, document, snapshot }
}

test('conditional reads distinguish identity, old and future revisions, empty text, stale audio and removal', async () => {
  const f = await fixture()
  try {
    const unknown = { id: 'unknown', revision: 1 }
    assert.deepEqual(f.store.getTranscriptIfChanged(f.episode.id, f.episode.contentHash, unknown), {
      status: 'missing',
    })
    const input = { ...f.document(), segments: [] }
    const saved = f.store.saveTranscript(f.episode.id, input)
    assert.equal(saved.status, 'ready')
    if (saved.status !== 'ready') throw new Error('Expected saved transcript')
    const known: TranscriptVersion = {
      id: saved.transcript.id,
      revision: saved.transcript.revision,
    }
    input.coverage[0]!.endMs = 1000
    assert.equal(saved.transcript.document.coverage[0]!.endMs, 30_000)
    assert.deepEqual(f.store.getTranscriptIfChanged(f.episode.id, f.episode.contentHash, known), {
      status: 'unchanged',
      version: known,
    })
    for (const version of [unknown, { ...known, revision: 0 }, { ...known, revision: 99 }]) {
      const result = f.store.getTranscriptIfChanged(f.episode.id, f.episode.contentHash, version)
      assert.equal(result.status, 'ready')
      if (result.status !== 'ready') throw new Error('Expected complete fallback')
      assert.deepEqual(result.transcript.document.segments, [])
      assert.equal(result.transcript.document.coverage[0]!.endMs, 30_000)
    }
    f.store.saveTranscript(f.episode.id, f.document(60_000, 90_000))
    const newer = f.store.getTranscriptIfChanged(f.episode.id, f.episode.contentHash, known)
    assert.equal(newer.status, 'ready')
    if (newer.status !== 'ready') throw new Error('Expected new revision')
    assert.equal(newer.transcript.id, known.id)
    assert.equal(newer.transcript.revision, known.revision + 1)
    await writeFile(f.path, 'changed synchronization audio')
    f.store.importBook(await scanBook(f.path, 'file'))
    const newHash = f.store.getAudio(f.episode.id)!.contentHash
    assert.deepEqual(f.store.getTranscriptIfChanged(f.episode.id, newHash, known), {
      status: 'stale',
    })
    f.store.removeBook(f.book.id)
    assert.deepEqual(f.store.getTranscriptHeader(f.episode.id, f.episode.contentHash), {
      status: 'missing',
    })
  } finally {
    f.store.close()
  }
})

test('coverage headers preserve all disjoint ranges, isolate caller mutations and observe external database writes', async () => {
  const f = await fixture(),
    external = new DatabaseSync(f.filename)
  try {
    const value = f.document()
    value.coverage = [
      { startMs: 0, endMs: 10_000 },
      { startMs: 20_000, endMs: 30_000 },
      { startMs: 40_000, endMs: 50_000 },
      { startMs: 60_000, endMs: 70_000 },
      { startMs: 80_000, endMs: 90_000 },
    ]
    value.segments = []
    f.store.saveTranscript(f.episode.id, value)
    const first = f.store.getTranscriptHeader(f.episode.id, f.episode.contentHash)
    assert.equal(first.status, 'ready')
    if (first.status !== 'ready') throw new Error('Expected coverage header')
    assert.deepEqual(first.transcript.coverage, value.coverage)
    assert.equal('document' in first.transcript, false)
    first.transcript.coverage[0]!.endMs = 1
    first.transcript.coverage.pop()
    const second = f.store.getTranscriptHeader(f.episode.id, f.episode.contentHash)
    assert.equal(second.status, 'ready')
    if (second.status !== 'ready') throw new Error('Expected fresh coverage')
    assert.deepEqual(second.transcript.coverage, value.coverage)
    // An independent connection is deliberately allowed to leave revision alone;
    // data_version must still invalidate cached coverage.
    const changed = { ...value, coverage: [{ startMs: 60_000, endMs: 90_000 }] }
    external
      .prepare('UPDATE transcripts SET document_json=? WHERE episode_id=? AND audio_hash=?')
      .run(JSON.stringify(changed), f.episode.id, f.episode.contentHash)
    const third = f.store.getTranscriptHeader(f.episode.id, f.episode.contentHash)
    assert.equal(third.status, 'ready')
    if (third.status !== 'ready') throw new Error('Expected externally updated coverage')
    assert.deepEqual(third.transcript.coverage, changed.coverage)
    const [status] = f.store.subtitleStatuses([{ ...f.target, positionMs: 65_000 }])
    assert.equal(status!.savedCoverage.coveredMs, 30_000)
    assert.equal(status!.savedCoverage.leadMs, 25_000)
    assert.equal(status!.savedCoverage.prefixMs, 0)
  } finally {
    external.close()
    f.store.close()
  }
})

test('an external commit between BEGIN and the first read cannot pair new metadata with cached old coverage', async () => {
  const f = await fixture(),
    external = new DatabaseSync(f.filename),
    connection = Reflect.get(f.store, 'db') as DatabaseSync,
    execute = connection.exec.bind(connection)
  try {
    const initial = f.document()
    f.store.saveTranscript(f.episode.id, initial)
    assert.equal(f.store.getTranscriptHeader(f.episode.id, f.episode.contentHash).status, 'ready')
    const changed = f.document(60_000, 90_000, '并发连接写入。')
    let committed = false
    // This is an actual second-connection write at the deferred-transaction
    // boundary. It leaves revision unchanged to require data_version checking.
    connection.exec = (sql: string) => {
      execute(sql)
      if (sql === 'BEGIN' && !committed) {
        external
          .prepare('UPDATE transcripts SET document_json=?,imported_at=? WHERE episode_id=?')
          .run(JSON.stringify(changed), 'external-commit', f.episode.id)
        committed = true
      }
    }
    const header = f.store.getTranscriptHeader(f.episode.id, f.episode.contentHash)
    assert.equal(committed, true)
    assert.equal(header.status, 'ready')
    if (header.status !== 'ready') throw new Error('Expected externally changed header')
    assert.equal(header.transcript.importedAt, 'external-commit')
    assert.deepEqual(header.transcript.coverage, changed.coverage)
  } finally {
    connection.exec = execute
    external.close()
    f.store.close()
  }
})

test('snapshot publication never retains caller-owned documents and external preview changes survive the next merge', async () => {
  const f = await fixture(),
    external = new DatabaseSync(f.filename)
  try {
    const job = f.store.createJob({ ...f.target, engine: 'whisperx', device: 'cpu' })
    assert.equal(job.hasPreview, false)
    f.store.setJobStatus(job.id, job.attempt, 'running')
    const input = f.snapshot(f.document())
    assert.equal(f.store.acceptJobSnapshot(job.id, job.attempt, input, 1, false), true)
    assert.equal(f.store.getJob(job.id)!.hasPreview, true)
    input.document.segments[0]!.text = '调用方后来篡改的文字。'
    input.document.coverage[0]!.endMs = 1000
    const exposed = f.store.jobDocument(job.id)!
    exposed.segments[0]!.text = '读取者后来篡改的文字。'
    assert.equal(
      f.store.acceptJobSnapshot(
        job.id,
        job.attempt,
        f.snapshot(f.document(60_000, 90_000)),
        2,
        false,
      ),
      true,
    )
    assert.equal(f.store.jobDocument(job.id)!.segments[0]!.text, '保留原始文字。')
    const externalDocument = f.store.jobDocument(job.id)!
    externalDocument.segments[0]!.text = '外部连接真正保存的文字。'
    external
      .prepare('UPDATE transcription_jobs SET document_json=? WHERE id=?')
      .run(JSON.stringify(externalDocument), job.id)
    assert.equal(
      f.store.acceptJobSnapshot(
        job.id,
        job.attempt,
        f.snapshot(f.document(30_000, 60_000)),
        3,
        true,
      ),
      true,
    )
    const result = f.store.getTranscript(f.episode.id, f.episode.contentHash)
    assert.equal(result.status, 'ready')
    if (result.status !== 'ready') throw new Error('Expected merged transcript')
    assert.equal(result.transcript.document.segments[0]!.text, '外部连接真正保存的文字。')
    assert.equal(result.transcript.document.segments.length, 3)
    assert.deepEqual(result.transcript.document.coverage, [{ startMs: 0, endMs: 90_000 }])
  } finally {
    external.close()
    f.store.close()
  }
})

test('an external commit immediately after publication invalidates both snapshot and coverage caches', async () => {
  const f = await fixture(),
    external = new DatabaseSync(f.filename),
    connection = Reflect.get(f.store, 'db') as DatabaseSync,
    execute = connection.exec.bind(connection)
  try {
    const job = f.store.createJob({ ...f.target, engine: 'whisperx', device: 'cpu' })
    f.store.setJobStatus(job.id, job.attempt, 'running')
    const changed = f.document(30_000, 60_000, '紧邻提交的外部来源。')
    let committed = false
    connection.exec = (sql: string) => {
      execute(sql)
      if (sql === 'COMMIT' && !committed) {
        external.exec('BEGIN IMMEDIATE')
        external
          .prepare('UPDATE transcription_jobs SET document_json=? WHERE id=?')
          .run(JSON.stringify(changed), job.id)
        external
          .prepare('UPDATE transcripts SET document_json=? WHERE episode_id=?')
          .run(JSON.stringify(changed), f.episode.id)
        external.exec('COMMIT')
        committed = true
      }
    }
    assert.equal(
      f.store.acceptJobSnapshot(job.id, job.attempt, f.snapshot(f.document()), 1, false),
      true,
    )
    assert.equal(committed, true)
    const header = f.store.getTranscriptHeader(f.episode.id, f.episode.contentHash)
    assert.equal(header.status, 'ready')
    if (header.status !== 'ready') throw new Error('Expected external formal coverage')
    assert.deepEqual(header.transcript.coverage, changed.coverage)
    f.store.acceptJobSnapshot(job.id, job.attempt, f.snapshot(f.document(60_000, 90_000)), 2, false)
    const merged = f.store.jobDocument(job.id)!
    assert.deepEqual(merged.coverage, [{ startMs: 30_000, endMs: 90_000 }])
    assert.equal(merged.segments[0]!.text, changed.segments[0]!.text)
  } finally {
    connection.exec = execute
    external.close()
    f.store.close()
  }
})

test('a rolled-back formal write cannot poison cached coverage or a later successful snapshot', async () => {
  const f = await fixture(),
    external = new DatabaseSync(f.filename)
  try {
    const job = f.store.createJob({ ...f.target, engine: 'whisperx', device: 'cpu' })
    f.store.setJobStatus(job.id, job.attempt, 'running')
    f.store.acceptJobSnapshot(job.id, job.attempt, f.snapshot(f.document()), 1, false)
    const before = f.store.getTranscript(f.episode.id, f.episode.contentHash)
    const header = f.store.getTranscriptHeader(f.episode.id, f.episode.contentHash)
    external.exec(`CREATE TRIGGER reject_sync_snapshot BEFORE UPDATE OF document_json ON transcription_jobs
      BEGIN SELECT RAISE(ABORT,'owned snapshot write failure'); END`)
    assert.throws(
      () =>
        f.store.acceptJobSnapshot(
          job.id,
          job.attempt,
          f.snapshot(f.document(60_000, 90_000)),
          2,
          false,
        ),
      /owned snapshot write failure/u,
    )
    assert.deepEqual(f.store.getTranscript(f.episode.id, f.episode.contentHash), before)
    assert.deepEqual(f.store.getTranscriptHeader(f.episode.id, f.episode.contentHash), header)
    external.exec('DROP TRIGGER reject_sync_snapshot')
    assert.equal(
      f.store.acceptJobSnapshot(
        job.id,
        job.attempt,
        f.snapshot(f.document(30_000, 60_000)),
        2,
        false,
      ),
      true,
    )
    const after = f.store.getTranscriptHeader(f.episode.id, f.episode.contentHash)
    assert.equal(after.status, 'ready')
    if (after.status !== 'ready') throw new Error('Expected successful replacement')
    assert.equal(before.status, 'ready')
    if (before.status !== 'ready') throw new Error('Expected prior revision')
    assert.equal(after.transcript.revision, before.transcript.revision + 1)
    assert.deepEqual(after.transcript.coverage, [{ startMs: 0, endMs: 60_000 }])
    assert.equal(f.store.jobDocument(job.id)!.segments.length, 2)
  } finally {
    external.close()
    f.store.close()
  }
})
