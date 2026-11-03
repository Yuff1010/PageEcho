import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { listeningRange } from '../../src/shared/listening'
import { validateRequest } from '../../src/shared/validation'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), '听读 书签 '))
  const file = join(root, '第01集.mp3')
  await writeFile(file, 'original fixture audio')
  const database = join(root, 'library.sqlite3'),
    store = new LibraryStore(database)
  store.importBook(await scanBook(file, 'file'))
  return { root, file, database, store, book: store.listBooks()[0]! }
}

test('bookmarks retain original media coordinates, notes and asset identity through reimport and restart', async () => {
  const t = await setup(),
    episode = t.book.episodes[0]!
  try {
    t.store.setBookSkips(t.book.id, { introMs: 5000, outroMs: 3000 })
    const mark = t.store.saveBookmark({
      episodeId: episode.id,
      audioHash: episode.contentHash,
      positionMs: 1250,
      note: '最初的书签',
    })
    t.store.editBookmark(mark.id, '记住这里 <script>普通文字</script>')
    assert.equal(
      t.store.saveBookmark({
        episodeId: episode.id,
        audioHash: episode.contentHash,
        positionMs: 1250,
        note: '',
      }).id,
      mark.id,
    )
    assert.equal(t.store.listBookmarks(t.book.id)[0]!.note, '记住这里 <script>普通文字</script>')
    t.store.importBook(await scanBook(t.file, 'file'))
    assert.equal(t.store.listBookmarks(t.book.id)[0]!.stale, false)
    await writeFile(t.file, 'different audio bytes')
    t.store.importBook(await scanBook(t.file, 'file'))
    assert.equal(t.store.listBooks()[0]!.introMs, 5000)
    assert.equal(t.store.listBookmarks(t.book.id)[0]!.stale, true)
    assert.throws(
      () =>
        t.store.saveBookmark({
          episodeId: episode.id,
          audioHash: episode.contentHash,
          positionMs: 1250,
          note: '',
        }),
      { code: 'FILE_CHANGED' },
    )
    t.store.close()
    const reopened = new LibraryStore(t.database)
    try {
      assert.equal(reopened.listBookmarks(t.book.id)[0]!.positionMs, 1250)
      assert.equal(reopened.listBookmarks(t.book.id)[0]!.stale, true)
      reopened.removeBook(t.book.id)
      assert.deepEqual(reopened.listBookmarks(t.book.id), [])
    } finally {
      reopened.close()
    }
  } finally {
    try {
      t.store.close()
    } catch {
      /* Already closed before reopening. */
    }
  }
})

test('skip ranges use original coordinates and disable both skips for short or exact-length chapters', () => {
  assert.deepEqual(listeningRange(60000, { introMs: 5000, outroMs: 8000 }), {
    startMs: 5000,
    endMs: 52000,
    skipsDisabled: false,
  })
  assert.deepEqual(listeningRange(13000, { introMs: 5000, outroMs: 8000 }), {
    startMs: 0,
    endMs: 13000,
    skipsDisabled: true,
  })
  assert.deepEqual(listeningRange(3000, { introMs: 5000, outroMs: 0 }), {
    startMs: 0,
    endMs: 3000,
    skipsDisabled: true,
  })
  assert.deepEqual(listeningRange(60000, { introMs: 0, outroMs: 0 }), {
    startMs: 0,
    endMs: 60000,
    skipsDisabled: false,
  })
})

test('schema v4 migration preserves progress, transcript revision and an interrupted ASR job', async () => {
  const t = await setup(),
    episode = t.book.episodes[0]!
  const doc = {
    version: 1 as const,
    audioHash: episode.contentHash,
    kind: 'manual' as const,
    coverage: [{ startMs: 0, endMs: 10000 }],
    segments: [{ id: 's1', startMs: 1000, endMs: 3000, text: '保存旧文稿。' }],
  }
  t.store.saveTranscript(episode.id, doc)
  t.store.saveProgress({
    sessionId: '',
    episodeId: episode.id,
    positionMs: 2345,
    durationMs: 10000,
    rate: 1.5,
    volume: 0.4,
  })
  const job = t.store.createJob({
    episodeId: episode.id,
    audioHash: episode.contentHash,
    engine: 'whisperx',
    device: 'cpu',
  })
  t.store.setJobStatus(job.id, 1, 'running')
  t.store.close()
  const old = new DatabaseSync(t.database)
  old.exec(
    'DROP TABLE online_pending_progress; DROP TABLE subtitle_import_commands; DROP TABLE subtitle_import_sources; DROP TABLE transcript_edit_commands; DROP TABLE transcript_edit_members; DROP TABLE transcript_edit_heads; DROP TABLE transcript_edit_groups; DROP TABLE offline_media_refs; DROP TABLE offline_plan_items; DROP TABLE offline_job_owners; DROP TABLE offline_plans; DROP TABLE processing_resources; ALTER TABLE transcription_jobs DROP COLUMN cpu_threads; DROP TABLE book_subtitle_settings; DROP TABLE reading_books; DROP TABLE original_alignments; DROP TABLE book_originals; DROP TABLE original_documents; DROP TABLE source_media_files; ALTER TABLE transcription_jobs DROP COLUMN background; DROP TABLE online_episodes; DROP TABLE online_books; DROP TABLE transcript_regions; DROP TABLE bookmarks; DROP TABLE book_listening_settings; PRAGMA user_version=4;',
  )
  old.close()
  const migrated = new LibraryStore(t.database)
  try {
    const book = migrated.listBooks()[0]!
    assert.equal(book.introMs, 0)
    assert.equal(book.outroMs, 0)
    assert.equal(book.episodes[0]!.positionMs, 2345)
    assert.equal(migrated.getPlayerState().preferences.rate, 1.5)
    assert.equal(migrated.getJob(job.id)!.status, 'running')
    const transcript = migrated.getTranscript(episode.id, episode.contentHash)
    assert.equal(transcript.status === 'ready' && transcript.transcript.revision, 1)
    assert.deepEqual(migrated.listBookmarks(book.id), [])
  } finally {
    migrated.close()
  }
})

test('listening IPC rejects invalid coordinates, long notes, paths and unbounded skips', () => {
  const id = '5cd6b9c2-7d12-4234-8d80-464014161e77',
    hash = 'a'.repeat(64)
  validateRequest('listening:book-skips', [{ id, introMs: 5000, outroMs: 0 }])
  validateRequest('listening:bookmark-save', [
    { episodeId: id, audioHash: hash, positionMs: 1250, note: '' },
  ])
  for (const introMs of [-1, 0.5, Infinity, 3600001, '1000'])
    assert.throws(() => validateRequest('listening:book-skips', [{ id, introMs, outroMs: 0 }]), {
      code: 'INVALID_REQUEST',
    })
  for (const extra of [
    { positionMs: -1 },
    { positionMs: 1.25 },
    { audioHash: 'b' },
    { note: '字'.repeat(1001) },
    { path: 'D:/private' },
  ])
    assert.throws(
      () =>
        validateRequest('listening:bookmark-save', [
          { episodeId: id, audioHash: hash, positionMs: 1250, note: '', ...extra },
        ]),
      { code: 'INVALID_REQUEST' },
    )
})
