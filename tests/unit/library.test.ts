import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { MEDIA_PREFIX, parseRange, serveMedia } from '../../src/main/media'
import { validateRequest } from '../../src/shared/validation'

test('folder scan uses natural order and SHA-256 content identity, omitting other files', async () => {
  const root = mkdtempSync(join(tmpdir(), '听读 library '))
  for (const name of ['第10集.mp3', '第2集.mp3', '第1集.mp3'])
    writeFileSync(join(root, name), 'abc')
  writeFileSync(join(root, 'notes.txt'), 'ignore')
  mkdirSync(join(root, '下卷'))
  writeFileSync(join(root, '下卷', '第1集.wav'), 'abc')
  const book = await scanBook(root, 'folder')
  assert.deepEqual(book.episodes.map((episode) => episode.name).slice(0, 3), [
    '第1集.mp3',
    '第2集.mp3',
    '第10集.mp3',
  ])
  assert.equal(book.episodes.length, 4)
  assert.equal(
    book.episodes[0]!.contentHash,
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
  const empty = mkdtempSync(join(tmpdir(), 'ralb-empty-'))
  await assert.rejects(scanBook(empty, 'folder'), { code: 'FILE_UNAVAILABLE' })
})

test('books and progress persist; reimports keep IDs and reset only changed audio versions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ralb-progress-'))
  const file = join(root, 'chapter.mp3')
  writeFileSync(file, 'abc')
  const filename = join(root, 'library.sqlite3')
  let store = new LibraryStore(filename)
  store.importBook(await scanBook(file, 'file'))
  const original = store.listBooks()[0]!
  const episode = original.episodes[0]!
  store.saveProgress({
    episodeId: episode.id,
    sessionId: episode.id,
    positionMs: 23500,
    durationMs: 60000,
    rate: 1.5,
    volume: 0.4,
  })
  store.close()
  store = new LibraryStore(filename)
  assert.equal(store.getPlayerState().currentEpisodeId, episode.id)
  assert.deepEqual(store.getPlayerState().preferences, { rate: 1.5, volume: 0.4 })
  store.importBook(await scanBook(file, 'file'))
  assert.equal(store.listBooks()[0]!.id, original.id)
  assert.equal(store.getEpisode(episode.id)!.positionMs, 23500)
  writeFileSync(file, 'changed content')
  const changed = await scanBook(file, 'file')
  store.importBook(changed)
  assert.equal(store.getEpisode(episode.id)!.positionMs, 0)
  assert.equal(store.getEpisode(episode.id)!.durationMs, null)
  assert.notEqual(store.getEpisode(episode.id)!.contentHash, episode.contentHash)
  assert.throws(() =>
    store.importBook({ ...changed, episodes: [{ ...changed.episodes[0]!, sizeBytes: 0 }] }),
  )
  assert.equal(store.listBooks().length, 1)
  store.removeBook(original.id)
  assert.equal(store.getPlayerState().currentEpisodeId, null)
  assert.equal(store.getAudio(episode.id), undefined)
  store.close()
})

test('v1 migration preserves M0 history without pretending it has a content hash', () => {
  const filename = join(mkdtempSync(join(tmpdir(), 'ralb-v1-')), 'v1.sqlite3')
  const db = new DatabaseSync(filename)
  db.exec(`CREATE TABLE selected_files(id TEXT PRIMARY KEY, locator TEXT UNIQUE COLLATE NOCASE,
    name TEXT, size_bytes INTEGER, modified_at REAL, selected_at TEXT);
    INSERT INTO selected_files VALUES ('legacy', 'D:/book.mp3', 'book.mp3', 3, 0, '2026-10-19');
    PRAGMA user_version = 1;`)
  db.close()
  const store = new LibraryStore(filename)
  assert.equal(store.listFiles()[0]!.name, 'book.mp3')
  assert.deepEqual(store.listBooks(), [])
  store.close()
})

test('Range parser handles closed, open, suffix and invalid byte intervals', () => {
  for (const [value, expected] of [
    [null, { start: 0, end: 99 }],
    ['bytes=10-19', { start: 10, end: 19 }],
    ['bytes=95-', { start: 95, end: 99 }],
    ['bytes=-10', { start: 90, end: 99 }],
    ['bytes=90-999', { start: 90, end: 99 }],
    ['bytes=-999', { start: 0, end: 99 }],
    ['bytes=100-', null],
    ['bytes=20-10', null],
    ['bytes=-0', null],
    ['bytes=1-2,4-5', null],
    ['bytes=-', null],
    ['bytes=9007199254740992-', null],
  ] as const)
    assert.deepEqual(parseRange(value, 100), expected, String(value))
})

test('media handler streams exact ranges, HEAD and errors without exposing arbitrary paths', async () => {
  const root = mkdtempSync(join(tmpdir(), '听读 media '))
  const path = join(root, 'test.wav')
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
  writeFileSync(path, bytes)
  const store = new LibraryStore(':memory:')
  store.importBook(await scanBook(path, 'file'))
  const episode = store.listBooks()[0]!.episodes[0]!
  const url = `${MEDIA_PREFIX}${episode.id}/${episode.contentHash}`
  const serve = (request: Request) => serveMedia(request, store, 'readlisten://app')
  const range = await serve(new Request(url, { headers: { Range: 'bytes=90-109' } }))
  assert.equal(range.status, 206)
  assert.equal(range.headers.get('content-range'), 'bytes 90-109/256')
  assert.equal(range.headers.get('content-length'), '20')
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(90, 110))
  const head = await serve(new Request(url, { method: 'HEAD' }))
  assert.equal(head.headers.get('content-length'), '256')
  assert.equal((await head.arrayBuffer()).byteLength, 0)
  const badRange = await serve(new Request(url, { headers: { Range: 'bytes=256-' } }))
  assert.equal(badRange.status, 416)
  assert.equal(badRange.headers.get('content-range'), 'bytes */256')
  assert.equal((await serve(new Request(url, { method: 'POST' }))).status, 405)
  assert.equal((await serve(new Request(`${MEDIA_PREFIX}../../secret`))).status, 403)
  assert.equal(
    (await serve(new Request(url.replace(episode.contentHash, '0'.repeat(64))))).status,
    404,
  )
  writeFileSync(path, 'changed')
  assert.equal((await serve(new Request(url))).status, 409)
  unlinkSync(path)
  assert.equal((await serve(new Request(url))).status, 404)
  store.close()
})

test('new IPC contracts reject invalid progress, duplicated chapters and extra path fields', () => {
  const id = 'a02a836c-1f16-44bf-a0aa-55cd14976534'
  const update = {
    sessionId: id,
    episodeId: id,
    positionMs: 5000,
    durationMs: 10000,
    rate: 1,
    volume: 0.5,
  }
  validateRequest('player:save-progress', [update])
  validateRequest('library:confirm-import', [{ id, episodeIds: [id] }])
  for (const request of [
    { ...update, rate: NaN },
    { ...update, volume: 2 },
    { ...update, positionMs: -1 },
    { ...update, path: 'D:/secret' },
  ])
    assert.throws(() => validateRequest('player:save-progress', [request]), {
      code: 'INVALID_REQUEST',
    })
  assert.throws(() => validateRequest('library:confirm-import', [{ id, episodeIds: [id, id] }]))
})
