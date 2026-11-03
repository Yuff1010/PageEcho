import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { LibraryStore } from '../../src/main/database'
import { AudioSourceRegistry } from '../../src/main/sources/source-registry'
import { audioSourceMediaUrl, audioSourcePageUrl } from '../../src/main/sources/source-policy'
import { validateRequest } from '../../src/shared/validation'
import { validateTextSourceArgs } from '../../src/main/sources/text-validation'
import { TEXT_SOURCE_CHANNELS } from '../../src/shared/text-source-api'
import {
  isSourceId,
  type SourceAdapter,
  type SourceBook,
  type SourceId,
} from '../../src/shared/sources'

const sourceId = 'plugin:fixture-reader:audio' as const
const makeBook = (source: SourceId, id = '52'): SourceBook => ({
  sourceId: source,
  id,
  title: '合成书籍',
  authors: [],
  narrators: [],
  description: '',
  pageUrl: 'https://books.example/book',
})
function add(store: LibraryStore, source: SourceId, id = '52') {
  return store.rememberSourceBook(
    makeBook(source, id),
    [
      {
        sourceId: source,
        bookId: id,
        id: 'chapter:一',
        title: '合成第一集',
        order: 1,
        pageUrl: 'https://books.example/episode',
      },
    ],
    true,
  )
}

test('schema16 migrates both built-in origins without losing identities and supports persistent plugin string IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ralb-plugin-schema-'))
  const path = join(root, 'library.sqlite3')
  let store = new LibraryStore(path)
  add(store, 'ting13')
  add(store, 'librivox')
  const episode = store.listBooks()[0]!.episodes[0]!
  const audioPath = resolve('tests/fixtures/tone.mp3')
  const metadata = await stat(audioPath)
  store.cacheSourceEpisode(episode.id, {
    path: audioPath,
    name: episode.title,
    sizeBytes: metadata.size,
    modifiedAt: metadata.mtimeMs,
    contentHash: createHash('sha256')
      .update(await readFile(audioPath))
      .digest('hex'),
  })
  store.saveProgress({
    episodeId: episode.id,
    sessionId: randomUUID(),
    positionMs: 1200,
    durationMs: 5000,
    rate: 1,
    volume: 0,
  })
  const before = store.listBooks()
  store.close()
  const legacy = new DatabaseSync(path)
  legacy.exec(`BEGIN IMMEDIATE;
    DROP TABLE online_pending_progress;
    CREATE TABLE online_books_v16 (book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE, source_id TEXT NOT NULL CHECK(source_id IN ('ting13','librivox')), source_book_id TEXT NOT NULL, metadata_json TEXT NOT NULL, catalog_complete INTEGER NOT NULL DEFAULT 0, preparation_json TEXT, UNIQUE(source_id,source_book_id)) STRICT;
    INSERT INTO online_books_v16 SELECT * FROM online_books;
    DROP TABLE online_books; ALTER TABLE online_books_v16 RENAME TO online_books;
    PRAGMA user_version=16; COMMIT;`)
  legacy.close()
  store = new LibraryStore(path)
  assert.deepEqual(store.listBooks(), before)
  const pluginBook = add(store, sourceId, 'work:中文/1')
  assert.notEqual(pluginBook, before[0]!.id)
  assert.equal(add(store, sourceId, 'work:中文/1'), pluginBook)
  store.close()
  store = new LibraryStore(path)
  try {
    const saved = store.listBooks().find((book) => book.id === pluginBook)!
    assert.equal(saved.online?.sourceId, sourceId)
    assert.equal(saved.online?.bookId, 'work:中文/1')
    assert.equal(saved.episodes[0]!.online?.episodeId, 'chapter:一')
    assert.equal(
      store.listBooks().find((book) => book.id === before[0]!.id)!.episodes[0]!.positionMs,
      1200,
    )
  } finally {
    store.close()
  }
})

test('plugin source request validation permits bounded opaque IDs while preserving builtin numeric ID rules', () => {
  const id = randomUUID()
  assert.equal(isSourceId(sourceId), true)
  for (const source of [
    'plugin:../bad:source',
    'plugin::source',
    'plugin:fixture:',
    'plugin:fixture:bad/id',
  ])
    assert.equal(isSourceId(source), false)
  validateRequest('source:book', [{ id, sourceId, bookId: 'work:中文/1' }])
  validateTextSourceArgs(TEXT_SOURCE_CHANNELS.browse, [
    { requestId: id, sourceId: 'plugin:fixture.books:text', query: '测试' },
  ])
  validateTextSourceArgs(TEXT_SOURCE_CHANNELS.import, [
    {
      requestId: id,
      sourceId: 'plugin:fixture.books:text',
      workId: 'work:中文/1',
      chapterIds: ['chapter:一'],
    },
  ])
  assert.throws(() =>
    validateTextSourceArgs(TEXT_SOURCE_CHANNELS.browse, [
      { requestId: id, sourceId: 'plugin::text', query: '测试' },
    ]),
  )
  validateRequest('source:episodes', [{ id, sourceId, bookId: 'work:中文/1', cursor: 'page:2' }])
  validateRequest('source:search', [{ id, sourceId, query: 'a'.repeat(200), cursor: null }])
  for (const request of [
    { id, sourceId, bookId: 'x'.repeat(513) },
    { id, sourceId, bookId: 'control\u0000value' },
    { id, sourceId: 'ting13', bookId: 'work:中文/1' },
    { id, sourceId: 'plugin::missing', bookId: '1' },
  ])
    assert.throws(() => validateRequest('source:book', [request]))
  assert.throws(() =>
    validateRequest('source:episodes', [{ id, sourceId, bookId: '1', cursor: 'x'.repeat(2049) }]),
  )
})

test('dynamic registry updates use a new adapter while old requests finish and removed sources reject new requests', async () => {
  let finish!: () => void
  const held = new Promise<void>((resolve) => {
    finish = resolve
  })
  const adapter = (title: string, block = false): SourceAdapter => ({
    id: sourceId,
    search: async () => {
      if (block) await held
      return { items: [{ ...makeBook(sourceId), title }], nextCursor: null }
    },
    getBook: async () => makeBook(sourceId),
    getEpisodes: async () => ({ items: [], nextCursor: null }),
    resolveAudio: async () => {
      throw new Error('unused')
    },
  })
  let current: SourceAdapter | undefined = adapter('old', true)
  const registry = new AudioSourceRegistry([], () => current)
  const previous = registry.get(sourceId)
  const pending = previous.run('old-request', (signal) =>
    previous.adapter.search('fixture', undefined, signal),
  )
  current = adapter('new')
  const next = registry.get(sourceId)
  assert.notEqual(next, previous)
  assert.equal(
    (await next.run('new-request', (signal) => next.adapter.search('fixture', undefined, signal)))
      .items[0]!.title,
    'new',
  )
  finish()
  assert.equal((await pending).items[0]!.title, 'old')
  current = undefined
  assert.throws(() => registry.get(sourceId), /停用或移除/)
  await registry.close()
})

test('plugin URL policies never fall through to builtin media permissions', () => {
  assert.throws(() => audioSourceMediaUrl(sourceId, 'https://archive.org/download/example/a.mp3'))
  assert.throws(() => audioSourcePageUrl(sourceId, 'https://librivox.org/example'))
  const policy = {
    mediaUrl: (value: string) => {
      const url = new URL(value)
      if (url.origin !== 'https://media.example') throw new Error('denied')
      return url.href
    },
    pageUrl: (value: string) => {
      const url = new URL(value)
      if (url.origin !== 'https://books.example') throw new Error('denied')
      return url
    },
  }
  assert.equal(
    audioSourceMediaUrl(sourceId, 'https://media.example/a.mp3', undefined, policy),
    'https://media.example/a.mp3',
  )
  assert.equal(
    audioSourcePageUrl(sourceId, 'https://books.example/book', policy).origin,
    'https://books.example',
  )
  assert.throws(() =>
    audioSourceMediaUrl(sourceId, 'https://foreign.example/a.mp3', undefined, policy),
  )
})
