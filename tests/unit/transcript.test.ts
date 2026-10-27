import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, openSync, ftruncateSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import {
  locateTranscript,
  MAX_TRANSCRIPT_BYTES,
  validateTranscript,
  type TranscriptDocument,
} from '../../src/shared/transcript'
import { validateRequest } from '../../src/shared/validation'
import { readTranscript } from '../../src/main/transcripts'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'

const hash = 'a'.repeat(64)
function document(): TranscriptDocument {
  return {
    version: 1,
    audioHash: hash,
    kind: 'manual',
    coverage: [
      { startMs: 0, endMs: 5000 },
      { startMs: 7000, endMs: 10000 },
    ],
    segments: [
      { id: 's1', startMs: 1000, endMs: 2000, text: '第一句' },
      { id: 's2', startMs: 3000, endMs: 4000, text: '第二句' },
      { id: 's3', startMs: 7000, endMs: 9000, text: '第三句' },
    ],
  }
}

test('transcript validation binds the audio version, preserves Unicode and accepts an empty covered region', () => {
  assert.deepEqual(validateTranscript(document(), hash, 10000), document())
  const empty = { ...document(), segments: [] }
  assert.deepEqual(validateTranscript(empty, hash), empty)
  assert.throws(() => validateTranscript(document(), 'b'.repeat(64)), {
    code: 'AUDIO_VERSION_MISMATCH',
  })
  assert.throws(() => validateTranscript(document(), hash, 9990), { code: 'INVALID_TRANSCRIPT' })
})

test('transcript validation rejects unordered, overlapping, duplicate, uncovered and malformed sentences', () => {
  const initial = document()
  for (const candidate of [
    { ...initial, version: 2 },
    { ...initial, path: 'C:/secret' },
    { ...initial, audioHash: 'bad' },
    { ...initial, kind: 'unknown' },
    { ...initial, coverage: [] },
    {
      ...initial,
      coverage: [
        { startMs: 0, endMs: 8000 },
        { startMs: 7000, endMs: 10000 },
      ],
    },
    { ...initial, segments: [...initial.segments].reverse() },
    { ...initial, segments: [initial.segments[0], { ...initial.segments[1], id: 's1' }] },
    { ...initial, segments: [{ ...initial.segments[0], startMs: -1 }] },
    { ...initial, segments: [{ ...initial.segments[0], endMs: 1000 }] },
    { ...initial, segments: [{ ...initial.segments[0], startMs: 1.5 }] },
    { ...initial, segments: [{ ...initial.segments[0], text: '   ' }] },
    { ...initial, segments: [{ ...initial.segments[0], startMs: 4500, endMs: 7500 }] },
    { ...initial, segments: [{ ...initial.segments[0], endMs: 3500 }, initial.segments[1]] },
  ])
    assert.throws(() => validateTranscript(candidate, hash), { code: 'INVALID_TRANSCRIPT' })
})

test('timeline lookup uses half-open intervals and distinguishes pauses, uncovered regions and end', () => {
  const value = document()
  for (const [time, status, index] of [
    [0, 'pause', -1],
    [999, 'pause', -1],
    [1000, 'sentence', 0],
    [1999, 'sentence', 0],
    [2000, 'pause', -1],
    [3000, 'sentence', 1],
    [5000, 'uncovered', -1],
    [6999, 'uncovered', -1],
    [7000, 'sentence', 2],
    [9000, 'pause', -1],
    [10000, 'ended', -1],
  ] as const) {
    const actual = locateTranscript(value, time, 10000)
    assert.equal(actual.status, status, String(time))
    assert.equal(actual.index, index, String(time))
  }
  assert.equal(locateTranscript(value, 1200, 10000).index, 0)
  assert.equal(locateTranscript(value, 8100, 10000).index, 2)
  assert.equal(locateTranscript(value, 1400, 10000).index, 0)
})

test('a 100,000-sentence index resolves distant positions without relying on chapter numbers', () => {
  const value: TranscriptDocument = {
    version: 1,
    audioHash: hash,
    kind: 'original',
    coverage: [{ startMs: 0, endMs: 10000000 }],
    segments: Array.from({ length: 100000 }, (_, index) => ({
      id: String(index),
      startMs: index * 100,
      endMs: index * 100 + 80,
      text: index === 50000 ? '第十九章中间的文字' : '句子',
    })),
  }
  const parsed = validateTranscript(value, hash)
  assert.equal(locateTranscript(parsed, 5000020, 10000000).index, 50000)
  assert.equal(locateTranscript(parsed, 9999990, 10000000).status, 'pause')
  assert.equal(locateTranscript(parsed, 100020, 10000000).index, 1000)
})

test('bounded UTF-8 JSON reading rejects corrupt, oversized and mismatched documents', async () => {
  const root = mkdtempSync(join(tmpdir(), '听读 transcript '))
  const path = join(root, '人工 文稿.json')
  writeFileSync(path, JSON.stringify(document()))
  assert.deepEqual(await readTranscript(path, hash, null), document())
  await assert.rejects(readTranscript(path, 'b'.repeat(64), null), {
    code: 'AUDIO_VERSION_MISMATCH',
  })
  writeFileSync(path, '{ bad JSON')
  await assert.rejects(readTranscript(path, hash, null), { code: 'INVALID_TRANSCRIPT' })
  writeFileSync(path, Buffer.from([0xff, 0xfe, 0xfd]))
  await assert.rejects(readTranscript(path, hash, null), { code: 'INVALID_TRANSCRIPT' })
  const file = openSync(path, 'w')
  ftruncateSync(file, MAX_TRANSCRIPT_BYTES + 1)
  closeSync(file)
  await assert.rejects(readTranscript(path, hash, null), { code: 'INVALID_TRANSCRIPT' })
})

test('transcripts persist, replace by revision, become stale on changed audio and cascade on removal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ralb-transcript-store-'))
  const path = join(root, '第32集.mp3')
  writeFileSync(path, 'first audio version')
  const filename = join(root, 'library.sqlite3')
  let store = new LibraryStore(filename)
  store.importBook(await scanBook(path, 'file'))
  const book = store.listBooks()[0]!
  const episode = book.episodes[0]!
  const original = { ...document(), audioHash: episode.contentHash }
  assert.deepEqual(store.getTranscript(episode.id, episode.contentHash), { status: 'missing' })
  store.saveTranscript(episode.id, original)
  store.saveTranscript(episode.id, { ...original, kind: 'original' })
  store.close()
  store = new LibraryStore(filename)
  const restored = store.getTranscript(episode.id, episode.contentHash)
  assert.equal(restored.status, 'ready')
  if (restored.status !== 'ready') throw new Error('Expected document')
  assert.equal(restored.transcript.revision, 2)
  assert.equal(restored.transcript.document.kind, 'original')
  writeFileSync(path, 'new audio content')
  store.importBook(await scanBook(path, 'file'))
  const nextHash = store.getAudio(episode.id)!.contentHash
  assert.deepEqual(store.getTranscript(episode.id, nextHash), { status: 'stale' })
  assert.throws(() => store.saveTranscript(episode.id, original), { code: 'FILE_CHANGED' })
  store.removeBook(book.id)
  assert.deepEqual(store.getTranscript(episode.id, episode.contentHash), { status: 'missing' })
  store.close()
})

test('schema v2 upgrades without losing M1 book, position and volume', () => {
  const filename = join(mkdtempSync(join(tmpdir(), 'ralb-v2-')), 'v2.sqlite3')
  const db = new DatabaseSync(filename)
  db.exec(`CREATE TABLE selected_files(id TEXT PRIMARY KEY, locator TEXT, name TEXT, size_bytes INTEGER, modified_at REAL, selected_at TEXT);
    CREATE TABLE books(id TEXT PRIMARY KEY, title TEXT, source_locator TEXT, kind TEXT, imported_at TEXT, last_played_at TEXT, current_episode_id TEXT);
    CREATE TABLE episodes(id TEXT PRIMARY KEY, book_id TEXT, title TEXT, sort_order INTEGER, locator TEXT, size_bytes INTEGER, modified_at REAL, content_hash TEXT, duration_ms REAL, position_ms REAL);
    CREATE TABLE player_settings(singleton INTEGER PRIMARY KEY, current_episode_id TEXT, rate REAL, volume REAL);
    INSERT INTO books VALUES('book', '旧书', 'D:/book', 'folder', '2026-10-19', NULL, 'episode');
    INSERT INTO episodes VALUES('episode', 'book', '第32集', 0, 'D:/book/32.mp3', 10, 0, '${hash}', 60000, 23500);
    INSERT INTO player_settings VALUES(1, 'episode', 1.5, 0.35); PRAGMA user_version = 2;`)
  db.close()
  const store = new LibraryStore(filename)
  assert.equal(store.listBooks()[0]!.episodes[0]!.positionMs, 23500)
  assert.deepEqual(store.getPlayerState().preferences, { rate: 1.5, volume: 0.35 })
  assert.equal(store.getTranscript('episode', hash).status, 'missing')
  store.close()
})

test('transcript IPC only accepts a known episode ID and complete content version', () => {
  const id = 'a02a836c-1f16-44bf-a0aa-55cd14976534'
  for (const channel of ['transcript:get', 'transcript:import']) {
    validateRequest(channel, [{ episodeId: id, audioHash: hash }])
    for (const request of [
      { episodeId: id },
      { episodeId: id, audioHash: hash, path: 'C:/secret.json' },
      { episodeId: '../secret', audioHash: hash },
    ])
      assert.throws(() => validateRequest(channel, [request]), { code: 'INVALID_REQUEST' })
  }
})
