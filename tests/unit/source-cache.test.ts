import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  writeFile,
  stat,
  readFile,
  symlink,
  rename,
  unlink,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { LibraryStore } from '../../src/main/database'
import { SourceCache } from '../../src/main/sources/source-cache'
import { scanBook } from '../../src/main/files'
import { continueSourceCatalog } from '../../src/main/sources/source-continuation'
import type { SourceAdapter, SourceBook, SourceEpisode } from '../../src/shared/sources'
import { validateRequest } from '../../src/shared/validation'
import { DatabaseSync } from 'node:sqlite'

const book: SourceBook = {
  sourceId: 'ting13',
  id: '39941',
  title: '书籍',
  authors: [],
  narrators: [],
  description: '测试',
  pageUrl: 'https://www.ting13.cc/youshengxiaoshuo/39941/',
}
const catalog: SourceEpisode[] = Array.from({ length: 4 }, (_, i) => ({
  sourceId: 'ting13',
  bookId: book.id,
  id: `39941_1_${i + 1}`,
  order: i + 1,
  title: `第${i + 1}集`,
  pageUrl: `https://www.ting13.cc/play/39941_1_${i + 1}.html`,
}))
async function setup() {
  const root = await mkdtemp(join(tmpdir(), '听读缓存清理 ')),
    directory = join(root, 'cache'),
    filename = join(root, 'library.sqlite3')
  await mkdir(directory)
  const store = new LibraryStore(filename)
  store.rememberSourceBook(book, catalog, false)
  const episodes = store.listBooks()[0]!.episodes
  const files = []
  for (const [i, e] of episodes.entries()) {
    const path = join(directory, `${e.id}-${randomUUID()}.mp3`),
      bytes = Buffer.alloc(100 + i, i)
    await writeFile(path, bytes)
    const info = await stat(path)
    store.cacheSourceEpisode(e.id, {
      path,
      name: e.title,
      sizeBytes: bytes.length,
      modifiedAt: info.mtimeMs,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
    })
    files.push(path)
  }
  const pins = new Set([episodes[0]!.id, episodes[1]!.id])
  const cache = new SourceCache(store, directory, () => pins, 500)
  return { root, directory, filename, store, episodes, files, pins, cache }
}

test('online cache clear protects current/tasks and preserves transcript, bookmarks and progress of evicted audio', async () => {
  const t = await setup(),
    episode = t.store.getEpisode(t.episodes[2]!.id)!
  t.store.saveProgress({
    sessionId: episode.id,
    episodeId: episode.id,
    positionMs: 500,
    durationMs: 1000,
    rate: 1,
    volume: 0,
  })
  const manual = t.store.saveTranscript(episode.id, {
    version: 1,
    audioHash: episode.contentHash,
    kind: 'manual',
    coverage: [{ startMs: 0, endMs: 1000 }],
    segments: [{ id: 's', startMs: 0, endMs: 1000, text: '保留' }],
  })
  const bookmark = t.store.saveBookmark({
    episodeId: episode.id,
    audioHash: episode.contentHash,
    positionMs: 500,
    note: '保留',
  })
  await writeFile(join(t.directory, 'unknown.txt'), 'keep')
  const preview = await t.cache.prepare()
  assert.equal(preview.clearFiles, 2)
  assert.equal(preview.protectedFiles, 2)
  assert.equal(preview.retained, 1)
  const result = await t.cache.clear(preview.token)
  assert.equal(result.files, 2)
  assert.equal((await readFile(t.files[0]!)).length, 100)
  await assert.rejects(readFile(t.files[2]!))
  assert.equal(await readFile(join(t.directory, 'unknown.txt'), 'utf8'), 'keep')
  assert.equal(t.store.getEpisode(episode.id)!.online!.cached, false)
  assert.equal(t.store.getEpisode(episode.id)!.positionMs, 500)
  assert.deepEqual(t.store.getTranscript(episode.id, episode.contentHash), manual)
  assert.equal(t.store.listBookmarks(episode.bookId)[0]!.id, bookmark.id)
  await assert.rejects(t.cache.clear(preview.token), { code: 'CONFLICT' })
  t.store.close()
})

test('cache preview invalidates on changed file, changed pins and directory junction without touching outside targets', async () => {
  const t = await setup()
  const first = await t.cache.prepare()
  t.pins.add(t.episodes[2]!.id)
  await assert.rejects(t.cache.clear(first.token), { code: 'CONFLICT' })
  const second = await t.cache.prepare()
  await writeFile(t.files[3]!, 'changed')
  await assert.rejects(t.cache.clear(second.token), { code: 'CONFLICT' })
  const third = await t.cache.prepare(),
    moved = join(t.root, 'original'),
    outside = await mkdtemp(join(tmpdir(), '听读外部保留 '))
  await writeFile(join(outside, 'keep.txt'), 'keep')
  await rename(t.directory, moved)
  await symlink(outside, t.directory, 'junction')
  await assert.rejects(t.cache.clear(third.token), { code: 'CONFLICT' })
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep')
  assert.equal((await readFile(join(moved, t.files[0]!.split(/[\\/]/).at(-1)!))).length, 100)
  t.store.close()
})

test('LRU reservation retains pinned assets and refuses an impossible reservation; local imports of cache paths stay untouched', async () => {
  const t = await setup()
  await t.cache.reserve(190, t.episodes[3]!.id)
  assert.equal(t.store.getEpisode(t.episodes[2]!.id)!.online!.cached, false)
  assert.equal(t.store.getEpisode(t.episodes[3]!.id)!.online!.cached, true)
  await assert.rejects(t.cache.reserve(600, t.episodes[3]!.id), {
    code: 'SOURCE_MEDIA_UNAVAILABLE',
  })
  t.pins.clear()
  t.store.importBook(await scanBook(t.files[0]!, 'file'))
  const preview = await t.cache.prepare()
  await t.cache.clear(preview.token)
  assert.equal((await readFile(t.files[0]!)).length, 100)
  assert.equal((await t.cache.state()).retained, 1)
  t.store.close()
})

test('v7 migration registers actual cache ownership and retains generated/manual data and stable source UUIDs', async () => {
  const t = await setup(),
    ids = t.episodes.map((e) => e.id)
  const e = t.store.getEpisode(ids[0]!)!
  const manual = t.store.saveTranscript(e.id, {
    version: 1,
    kind: 'manual',
    audioHash: e.contentHash,
    coverage: [{ startMs: 0, endMs: 1000 }],
    segments: [{ id: 's', startMs: 0, endMs: 1000, text: '迁移保留' }],
  })
  t.store.close()
  const old = new DatabaseSync(t.filename)
  old.exec(
    'DROP TABLE online_pending_progress; DROP TABLE subtitle_import_commands; DROP TABLE subtitle_import_sources; DROP TABLE transcript_edit_commands; DROP TABLE transcript_edit_members; DROP TABLE transcript_edit_heads; DROP TABLE transcript_edit_groups; DROP TABLE offline_media_refs; DROP TABLE offline_plan_items; DROP TABLE offline_job_owners; DROP TABLE offline_plans; DROP TABLE processing_resources; ALTER TABLE transcription_jobs DROP COLUMN cpu_threads; DROP TABLE book_subtitle_settings; DROP TABLE reading_books; DROP TABLE original_alignments; DROP TABLE book_originals; DROP TABLE original_documents; DROP TABLE source_media_files; ALTER TABLE online_episodes DROP COLUMN cache_available; ALTER TABLE online_books DROP COLUMN preparation_json; ALTER TABLE transcription_jobs DROP COLUMN background; PRAGMA user_version=7;',
  )
  old.close()
  const migrated = new LibraryStore(t.filename)
  assert.deepEqual(
    migrated.listBooks()[0]!.episodes.map((e) => e.id),
    ids,
  )
  assert.ok(migrated.listBooks()[0]!.episodes.every((e) => e.online!.cached))
  assert.equal(migrated.sourceCacheFiles().length, 4)
  assert.deepEqual(migrated.getTranscript(e.id, e.contentHash), manual)
  assert.equal(migrated.listBooks()[0]!.online!.preparation.cacheNext, false)
  migrated.close()
})

test('next-audio ASR is bounded by the measured playback duration, guarded by content identity', async () => {
  const t = await setup(),
    e = t.store.getEpisode(t.episodes[0]!.id)!
  t.store.recordSourceDuration(e.id, 'f'.repeat(64), 431423.991)
  assert.equal(t.store.getEpisode(e.id)!.durationMs, null)
  t.store.recordSourceDuration(e.id, e.contentHash, 431423.991)
  const job = t.store.createJob(
    { episodeId: e.id, audioHash: e.contentHash, engine: 'paraformer', device: 'cuda' },
    true,
  )
  assert.equal(job.rangeEndMs, 431424)
  assert.equal(job.background, true)
  assert.throws(() => t.store.recordSourceDuration(e.id, e.contentHash, NaN), {
    code: 'INVALID_REQUEST',
  })
  t.store.close()
})

test('fresh cursor traversal resumes a saved page boundary after restart and preserves existing source IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), '听读目录续页 ')),
    filename = join(root, 'db.sqlite3')
  let store = new LibraryStore(filename)
  store.rememberSourceBook(book, catalog.slice(0, 2), false)
  const before = store.listBooks()[0]!.episodes.map((e) => e.id)
  store.close()
  store = new LibraryStore(filename)
  const requests: (string | undefined)[] = []
  const adapter = {
    id: 'ting13',
    getBook: async () => book,
    getEpisodes: async (_id: string, cursor?: string) => {
      requests.push(cursor)
      return cursor
        ? { items: catalog.slice(2), nextCursor: null }
        : { items: catalog.slice(0, 2), nextCursor: 'fresh-only' }
    },
  } as unknown as SourceAdapter
  await continueSourceCatalog(store, adapter, before[1]!, new AbortController().signal)
  assert.deepEqual(requests, [undefined, 'fresh-only'])
  assert.deepEqual(
    store
      .listBooks()[0]!
      .episodes.slice(0, 2)
      .map((e) => e.id),
    before,
  )
  assert.equal(store.listBooks()[0]!.episodes.length, 4)
  assert.equal(store.listBooks()[0]!.online!.catalogComplete, true)
  await continueSourceCatalog(store, adapter, before[0]!, new AbortController().signal)
  assert.equal(requests.length, 2)
  store.close()
})

test('canceled, changed or shortened catalogs do not replace saved source metadata', async () => {
  const t = await setup(),
    id = t.episodes.at(-1)!.id,
    before = JSON.stringify(t.store.listBooks())
  const controller = new AbortController()
  const changed = {
    id: 'ting13',
    getBook: async () => book,
    getEpisodes: async () => ({
      items: catalog.map((e, i) => (i === 3 ? { ...e, id: '39941_1_999' } : e)),
      nextCursor: null,
    }),
  } as unknown as SourceAdapter
  await assert.rejects(continueSourceCatalog(t.store, changed, id, controller.signal), {
    code: 'SOURCE_CHANGED',
  })
  const canceled = {
    ...changed,
    getBook: async () => {
      controller.abort()
      return book
    },
  }
  await assert.rejects(continueSourceCatalog(t.store, canceled, id, controller.signal))
  assert.equal(JSON.stringify(t.store.listBooks()), before)
  assert.throws(() => t.store.rememberSourceBook(book, catalog.slice(0, 2), true), {
    code: 'SOURCE_CHANGED',
  })
  await unlink(t.files[3]!)
  await t.cache.state()
  assert.equal(t.store.getEpisode(id)!.online!.cached, false)
  t.store.close()
})

test('online settings/cleanup/continuation IPC rejects paths, extra fields, forged options and additional arguments', () => {
  const id = randomUUID(),
    settings = { cacheNext: true, transcribeNext: true, engine: 'paraformer', device: 'cuda' }
  validateRequest('source:preparation', [{ id, settings }])
  validateRequest('source:continuation', [{ id }])
  validateRequest('source:cache-clear', [{ token: id }])
  validateRequest('source:cache-state', [])
  validateRequest('source:cache-preview', [])
  assert.throws(() =>
    validateRequest('source:preparation', [
      { id, settings: { ...settings, script: 'C:/evil.py' } },
    ]),
  )
  assert.throws(() =>
    validateRequest('source:preparation', [{ id, settings: { ...settings, engine: 'custom' } }]),
  )
  assert.throws(() => validateRequest('source:cache-clear', [{ token: id, path: 'C:/' }]))
  assert.throws(() => validateRequest('source:continuation', [{ id: 'C:/file' }]))
})
