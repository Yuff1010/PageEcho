import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LibraryStore } from '../../src/main/database'
import { AudioSourceRegistry } from '../../src/main/sources/source-registry'
import { OnlineMedia } from '../../src/main/sources/online-media'
import { validateRequest } from '../../src/shared/validation'
import type { SourceAdapter, SourceBook, SourceEpisode, SourceId } from '../../src/shared/sources'

function book(sourceId: SourceId): SourceBook {
  return {
    sourceId,
    id: '52',
    title: sourceId,
    authors: [],
    narrators: [],
    description: '',
    pageUrl:
      sourceId === 'ting13'
        ? 'https://www.ting13.cc/youshengxiaoshuo/52/'
        : 'https://librivox.org/example/',
  }
}
function episodes(sourceId: SourceId): SourceEpisode[] {
  return [1, 2].map((order) => ({
    sourceId,
    bookId: '52',
    id: String(order),
    title: `Section ${order}`,
    order,
    pageUrl: book(sourceId).pageUrl,
  }))
}
test('schema 15 migration preserves Ting13 UUIDs, audio hash, progress, manual transcript and preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multi-audio-migrate-')),
    filename = join(root, 'library.sqlite3'),
    path = join(root, 'audio.mp3')
  let store = new LibraryStore(filename)
  const id = store.rememberSourceBook(book('ting13'), episodes('ting13'), true),
    first = store.listBooks()[0]!.episodes[0]!,
    bytes = Buffer.from('ID3 synthetic migration fixture'),
    hash = createHash('sha256').update(bytes).digest('hex')
  await writeFile(path, bytes)
  store.cacheSourceEpisode(first.id, {
    path,
    name: first.title,
    sizeBytes: bytes.length,
    modifiedAt: 1,
    contentHash: hash,
  })
  store.saveProgress({
    episodeId: first.id,
    sessionId: randomUUID(),
    positionMs: 1234,
    durationMs: 5000,
    rate: 1,
    volume: 1,
  })
  store.saveTranscript(first.id, {
    version: 1,
    audioHash: hash,
    kind: 'manual',
    coverage: [{ startMs: 0, endMs: 1000 }],
    segments: [{ id: 'human', startMs: 0, endMs: 1000, text: '人工文稿' }],
  })
  store.setSourcePreparation(id, {
    cacheNext: true,
    transcribeNext: false,
    engine: 'whisperx',
    device: 'cpu',
  })
  const before = store.listBooks()
  store.close()
  const legacy = new DatabaseSync(filename)
  legacy.exec(`BEGIN IMMEDIATE;
    DROP TABLE online_pending_progress;
    CREATE TABLE old_online_books (book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE, source_id TEXT NOT NULL CHECK(source_id='ting13'), source_book_id TEXT NOT NULL, metadata_json TEXT NOT NULL, catalog_complete INTEGER NOT NULL DEFAULT 0, preparation_json TEXT, UNIQUE(source_id,source_book_id)) STRICT;
    INSERT INTO old_online_books SELECT * FROM online_books;
    DROP TABLE online_books; ALTER TABLE old_online_books RENAME TO online_books;
    PRAGMA user_version=15; COMMIT;`)
  legacy.close()
  store = new LibraryStore(filename)
  try {
    assert.deepEqual(store.listBooks(), before)
    assert.equal(store.getAudio(first.id)!.contentHash, hash)
    const transcript = store.getTranscript(first.id, hash)
    assert.equal(transcript.status, 'ready')
    if (transcript.status === 'ready')
      assert.equal(transcript.transcript.document.segments[0]!.text, '人工文稿')
    const other = store.rememberSourceBook(book('librivox'), episodes('librivox'), true)
    assert.notEqual(other, id, 'same provider book ID is namespaced')
    const added = store.listBooks().find((b) => b.id === other)!
    assert.equal(added.online!.sourceId, 'librivox')
    assert.equal(added.episodes[0]!.online!.sourceId, 'librivox')
    assert.notEqual(
      added.episodes[0]!.id,
      first.id,
      'same track ID never reuses another provider UUID',
    )
    store.rememberSourceBook(book('ting13'), episodes('ting13').slice(0, 1), false)
    assert.deepEqual(
      store.listBooks().find((b) => b.id === id),
      before[0],
      'partial catalog cannot shrink a saved complete catalog',
    )
    assert.throws(
      () => store.rememberSourceBook(book('ting13'), episodes('ting13').slice(0, 1), true),
      { code: 'SOURCE_CHANGED' },
    )
    assert.equal(store.getEpisode(first.id)!.positionMs, 1234)
  } finally {
    store.close()
  }
})
test('audio registry isolates browsing sessions and routes library playback by persisted source ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'multi-audio-route-')),
    store = new LibraryStore(join(root, 'library.sqlite3'))
  const resolved: SourceId[] = [],
    urls: string[] = [],
    closed: SourceId[] = []
  const registry = new AudioSourceRegistry(
    (['ting13', 'librivox'] as const).map((sourceId) => ({
      adapter: {
        id: sourceId,
        search: async () => ({ items: [], nextCursor: null }),
        getBook: async () => book(sourceId),
        getEpisodes: async () => ({ items: episodes(sourceId), nextCursor: null }),
        resolveAudio: async (_book, episodeId) => {
          resolved.push(sourceId)
          return {
            sourceId,
            episodeId,
            url:
              sourceId === 'ting13'
                ? 'https://car-lv.kuwo.cn/example.mp3'
                : 'https://archive.org/download/example/letter.mp3',
            pageUrl: book(sourceId).pageUrl,
            headers: { Referer: book(sourceId).pageUrl },
            expiresAt: null,
          }
        },
      } satisfies SourceAdapter,
      close: () => {
        closed.push(sourceId)
      },
    })),
  )
  let release!: () => void
  const waiting = new Promise<void>((done) => {
    release = done
  })
  const one = registry.get('ting13').run('first', async (signal) => {
    await waiting
    assert.equal(signal.aborted, false)
    return 1
  })
  const two = registry.get('librivox').run('other', async () => 2)
  assert.equal(await two, 2)
  release()
  assert.equal(await one, 1)
  for (const sourceId of ['ting13', 'librivox'] as const)
    store.rememberSourceBook(book(sourceId), episodes(sourceId), true)
  const bytes = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(128)])
  const media = new OnlineMedia(
    store,
    registry,
    join(root, 'cache'),
    () => {},
    async (url) => {
      urls.push(String(url))
      return new Response(bytes, {
        headers: { 'content-type': 'audio/mpeg', 'content-length': String(bytes.length) },
      })
    },
  )
  try {
    for (const sourceId of ['ting13', 'librivox'] as const) {
      const first = store.listBooks().find((b) => b.online!.sourceId === sourceId)!.episodes[0]!
      await media.prepare(first.id)
      assert.equal(store.getEpisode(first.id)!.online!.sourceId, sourceId)
    }
    assert.deepEqual(resolved, ['ting13', 'librivox'])
    assert.ok(urls[0]!.includes('kuwo.cn'))
    assert.ok(urls[1]!.includes('archive.org'))
  } finally {
    await media.close()
    store.close()
  }
  assert.deepEqual(closed.sort(), ['librivox', 'ting13'])
})
test('source IPC permits both built-ins and rejects unknown sources or injected URLs', () => {
  for (const sourceId of ['ting13', 'librivox']) {
    validateRequest('source:search', [
      { id: randomUUID(), sourceId, query: 'Letters', cursor: null },
    ])
    validateRequest('source:book', [{ id: randomUUID(), sourceId, bookId: '52' }])
  }
  for (const request of [
    { id: randomUUID(), sourceId: 'other', bookId: '52' },
    { id: randomUUID(), sourceId: 'librivox', bookId: 'https://archive.org/' },
  ])
    assert.throws(() => validateRequest('source:book', [request]), { code: 'INVALID_REQUEST' })
})

test('LibriVox media rejects cross-provider resolution and file-changing redirects before registration', async () => {
  for (const wrongIdentity of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), 'multi-audio-reject-'))
    const store = new LibraryStore(join(root, 'library.sqlite3'))
    store.rememberSourceBook(book('librivox'), episodes('librivox'), true)
    const first = store.listBooks()[0]!.episodes[0]!
    let requests = 0
    const adapter: SourceAdapter = {
      id: 'librivox',
      search: async () => ({ items: [], nextCursor: null }),
      getBook: async () => book('librivox'),
      getEpisodes: async () => ({ items: episodes('librivox'), nextCursor: null }),
      resolveAudio: async (_book, episodeId) => ({
        sourceId: wrongIdentity ? 'ting13' : 'librivox',
        episodeId,
        url: 'https://archive.org/download/example/letter.mp3',
        pageUrl: book('librivox').pageUrl,
        headers: { Referer: book('librivox').pageUrl },
        expiresAt: null,
      }),
    }
    const media = new OnlineMedia(
      store,
      adapter,
      join(root, 'cache'),
      () => {},
      async () => {
        requests++
        return new Response(null, {
          status: 302,
          headers: {
            location: 'https://dn721501.ca.archive.org/0/items/different_book/letter.mp3',
          },
        })
      },
    )
    try {
      await assert.rejects(media.prepare(first.id), {
        code: wrongIdentity ? 'SOURCE_CHANGED' : 'SOURCE_MEDIA_UNAVAILABLE',
      })
      assert.equal(requests, wrongIdentity ? 0 : 1)
      assert.equal(store.getAudio(first.id), undefined)
      assert.equal(store.getEpisode(first.id)!.online!.cached, false)
    } finally {
      await media.close()
      store.close()
    }
  }
})
