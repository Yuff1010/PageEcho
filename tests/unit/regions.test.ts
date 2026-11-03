import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  replaceRegion,
  classifyRegion,
  regionReadingRows,
  regionKey,
  MAX_REGIONS,
  readRegionList,
} from '../../src/shared/regions'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { validateRequest } from '../../src/shared/validation'
import type { TranscriptDocument } from '../../src/shared/transcript'

test('relabeling and clearing media ranges split only intersecting intervals and merge equal neighbors', () => {
  const original = [{ startMs: 1000, endMs: 8000, kind: 'advertisement' as const }]
  const split = replaceRegion(original, { startMs: 3000, endMs: 5000, kind: 'recap' })
  assert.deepEqual(split, [
    { startMs: 1000, endMs: 3000, kind: 'advertisement' },
    { startMs: 3000, endMs: 5000, kind: 'recap' },
    { startMs: 5000, endMs: 8000, kind: 'advertisement' },
  ])
  assert.equal(original[0]!.endMs, 8000)
  assert.deepEqual(
    replaceRegion(split, { startMs: 3000, endMs: 5000, kind: 'advertisement' }),
    original,
  )
  assert.deepEqual(replaceRegion(split, { startMs: 2000, endMs: 6000, kind: null }), [
    { startMs: 1000, endMs: 2000, kind: 'advertisement' },
    { startMs: 6000, endMs: 8000, kind: 'advertisement' },
  ])
  const maximum = Array.from({ length: MAX_REGIONS }, (_, i) => ({
    startMs: i * 4,
    endMs: i * 4 + 2,
    kind: 'intro' as const,
  }))
  assert.throws(() => replaceRegion(maximum, { startMs: 9000, endMs: 9001, kind: 'intro' }), {
    code: 'INVALID_REQUEST',
  })
})

test('folding groups only fully contained sentences and keeps partial or mixed boundaries visible', () => {
  const region = { startMs: 1000, endMs: 4000, kind: 'advertisement' as const }
  const sentences = [
    { id: 'ad-1', startMs: 1000, endMs: 2000, text: '广告一' },
    { id: 'ad-2', startMs: 2300, endMs: 3500, text: '广告二' },
    { id: 'boundary', startMs: 3800, endMs: 5000, text: '广告结束，正文继续。' },
    { id: 'body', startMs: 5100, endMs: 6000, text: '正文' },
  ]
  const before = structuredClone(sentences)
  assert.deepEqual(regionReadingRows(sentences, [region], true, new Set()), [
    { type: 'region', index: 0, lastIndex: 1, region },
    { type: 'sentence', index: 2 },
    { type: 'sentence', index: 3 },
  ])
  assert.equal(classifyRegion([region], sentences[2]!).complete, undefined)
  assert.deepEqual(classifyRegion([region], { startMs: 4000, endMs: 5000 }).kinds, [])
  assert.deepEqual(
    classifyRegion([region, { startMs: 4000, endMs: 5000, kind: 'recap' }], sentences[2]!).kinds,
    ['advertisement', 'recap'],
  )
  assert.ok(
    regionReadingRows(sentences, [region], true, new Set([regionKey(region)])).every(
      (row) => row.type === 'sentence',
    ),
  )
  assert.deepEqual(sentences, before)
  assert.deepEqual(readRegionList([region]), [region])
  assert.throws(() => readRegionList({ regions: [region] }), { code: 'INTERNAL' })
  assert.throws(() => readRegionList([region, { ...region, startMs: 3000 }]), { code: 'INTERNAL' })
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), '听读 标注 ')),
    file = join(root, '第32集.mp3')
  await writeFile(file, 'fixed source version')
  const filename = join(root, 'library.sqlite3'),
    store = new LibraryStore(filename)
  store.importBook(await scanBook(file, 'file'))
  const book = store.listBooks()[0]!,
    episode = book.episodes[0]!
  const document: TranscriptDocument = {
    version: 1,
    audioHash: episode.contentHash,
    kind: 'manual',
    coverage: [{ startMs: 0, endMs: 10000 }],
    segments: [{ id: 's1', startMs: 1000, endMs: 5000, text: '原始文字' }],
  }
  store.saveTranscript(episode.id, document)
  store.saveProgress({
    sessionId: '',
    episodeId: episode.id,
    positionMs: 3456,
    durationMs: 10000,
    rate: 1.5,
    volume: 0.4,
  })
  return {
    root,
    file,
    filename,
    store,
    book,
    episode,
    document,
    target: { episodeId: episode.id, audioHash: episode.contentHash },
  }
}

test('marks survive text replacement and restart, reject stale writers and assets, and cascade on book deletion', async () => {
  const t = await setup()
  const change = { ...t.target, revision: 0, startMs: 1000, endMs: 3000, kind: 'intro' as const }
  let store = t.store
  try {
    const before = store.getTranscript(t.episode.id, t.episode.contentHash)
    let marked = store.markTranscriptRegion(change)
    assert.equal(marked.revision, 1)
    assert.deepEqual(store.getTranscript(t.episode.id, t.episode.contentHash), before)
    assert.equal(store.getEpisode(t.episode.id)!.positionMs, 3456)
    assert.equal(
      store.markTranscriptRegion({ ...change, revision: 1 }).revision,
      1,
      'an identical edit is idempotent',
    )
    assert.throws(() => store.markTranscriptRegion({ ...change, kind: 'recap' }), {
      code: 'CONFLICT',
    })
    assert.throws(() => store.markTranscriptRegion({ ...change, revision: 1, endMs: 10002 }), {
      code: 'INVALID_REQUEST',
    })
    const connection = Reflect.get(store, 'db') as DatabaseSync
    connection.exec(
      "CREATE TRIGGER fail_regions BEFORE UPDATE ON transcript_regions BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END",
    )
    assert.throws(
      () => store.markTranscriptRegion({ ...change, revision: 1, kind: 'recap' }),
      /fixture storage failure/,
    )
    assert.deepEqual(store.getTranscriptRegions(t.episode.id, t.episode.contentHash), marked)
    connection.exec('DROP TRIGGER fail_regions')
    marked = store.markTranscriptRegion({
      ...change,
      revision: 1,
      previous: { startMs: 1000, endMs: 3000 },
      startMs: 1500,
      endMs: 2500,
    })
    assert.deepEqual(
      marked.regions,
      [{ startMs: 1500, endMs: 2500, kind: 'intro' }],
      'editing a managed range replaces its old bounds',
    )
    assert.throws(
      () =>
        store.markTranscriptRegion({
          ...change,
          revision: marked.revision,
          previous: { startMs: 1000, endMs: 3000 },
        }),
      { code: 'CONFLICT' },
    )
    store.saveTranscript(t.episode.id, {
      ...t.document,
      kind: 'transcript',
      segments: [{ id: 'regenerated', startMs: 800, endMs: 5200, text: '重新生成的句子' }],
    })
    assert.deepEqual(store.getTranscriptRegions(t.episode.id, t.episode.contentHash), marked)
    store.close()
    store = new LibraryStore(t.filename)
    assert.deepEqual(store.getTranscriptRegions(t.episode.id, t.episode.contentHash), marked)
    assert.equal(store.getEpisode(t.episode.id)!.positionMs, 3456)
    await writeFile(t.file, 'changed source version')
    store.importBook(await scanBook(t.file, 'file'))
    const current = store.listBooks()[0]!.episodes[0]!
    assert.throws(() => store.getTranscriptRegions(t.episode.id, t.episode.contentHash), {
      code: 'FILE_CHANGED',
    })
    assert.throws(() => store.markTranscriptRegion({ ...change, revision: 1 }), {
      code: 'FILE_CHANGED',
    })
    assert.deepEqual(store.getTranscriptRegions(current.id, current.contentHash), {
      revision: 0,
      regions: [],
    })
    store.removeBook(t.book.id)
    const db = Reflect.get(store, 'db') as DatabaseSync
    assert.equal(db.prepare('SELECT count(*) AS n FROM transcript_regions').get()!.n, 0)
  } finally {
    store.close()
  }
})

test('v5 migration preserves bookmarks, settings, progress, transcript and an unfinished job', async () => {
  const t = await setup()
  t.store.setBookSkips(t.book.id, { introMs: 1000, outroMs: 2000 })
  const bookmark = t.store.saveBookmark({ ...t.target, positionMs: 3456, note: '保留' })
  const job = t.store.createJob({ ...t.target, engine: 'whisperx', device: 'cpu' })
  t.store.setJobStatus(job.id, job.attempt, 'running')
  t.store.close()
  const old = new DatabaseSync(t.filename)
  old.exec(
    'DROP TABLE online_pending_progress; DROP TABLE subtitle_import_commands; DROP TABLE subtitle_import_sources; DROP TABLE transcript_edit_commands; DROP TABLE transcript_edit_members; DROP TABLE transcript_edit_heads; DROP TABLE transcript_edit_groups; DROP TABLE offline_media_refs; DROP TABLE offline_plan_items; DROP TABLE offline_job_owners; DROP TABLE offline_plans; DROP TABLE processing_resources; ALTER TABLE transcription_jobs DROP COLUMN cpu_threads; DROP TABLE book_subtitle_settings; DROP TABLE reading_books; DROP TABLE original_alignments; DROP TABLE book_originals; DROP TABLE original_documents; DROP TABLE source_media_files; ALTER TABLE transcription_jobs DROP COLUMN background; DROP TABLE online_episodes; DROP TABLE online_books; DROP TABLE transcript_regions; PRAGMA user_version=5;',
  )
  old.close()
  const migrated = new LibraryStore(t.filename)
  try {
    assert.deepEqual(migrated.getTranscriptRegions(t.episode.id, t.episode.contentHash), {
      revision: 0,
      regions: [],
    })
    assert.equal(migrated.listBookmarks(t.book.id)[0]!.id, bookmark.id)
    assert.equal(migrated.listBooks()[0]!.introMs, 1000)
    assert.equal(migrated.getEpisode(t.episode.id)!.positionMs, 3456)
    assert.equal(migrated.getJob(job.id)!.status, 'running')
    const transcript = migrated.getTranscript(t.episode.id, t.episode.contentHash)
    assert.equal(transcript.status === 'ready' && transcript.transcript.revision, 1)
  } finally {
    migrated.close()
  }
})

test('region IPC accepts only bounded original ranges, known categories, asset identity and a revision', () => {
  const target = { episodeId: '5cd6b9c2-7d12-4234-8d80-464014161e77', audioHash: 'a'.repeat(64) }
  const valid = { ...target, revision: 0, startMs: 1000, endMs: 3000, kind: 'advertisement' }
  validateRequest('transcript:regions', [target])
  validateRequest('transcript:region-mark', [valid])
  validateRequest('transcript:region-mark', [{ ...valid, kind: null }])
  validateRequest('transcript:region-mark', [
    { ...valid, previous: { startMs: 2000, endMs: 4000 } },
  ])
  for (const changes of [
    { kind: ['advertisement'] },
    { kind: 'script' },
    { startMs: -1 },
    { endMs: 1000 },
    { endMs: 3000.5 },
    { endMs: Infinity },
    { revision: true },
    { audioHash: 'invalid' },
    { path: 'D:/private' },
    { previous: { startMs: -1, endMs: 4000 } },
    { previous: { startMs: 1000, endMs: 2000, path: 'D:/private' } },
  ])
    assert.throws(() => validateRequest('transcript:region-mark', [{ ...valid, ...changes }]), {
      code: 'INVALID_REQUEST',
    })
})
