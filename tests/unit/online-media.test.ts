import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { LibraryStore } from '../../src/main/database'
import { OnlineMedia } from '../../src/main/sources/online-media'
import type { SourceAdapter, SourceBook, SourceEpisode } from '../../src/shared/sources'
import { validateRequest } from '../../src/shared/validation'

const book: SourceBook = {
  sourceId: 'ting13',
  id: '39941',
  title: '测试书籍',
  authors: [],
  narrators: [],
  description: '测试',
  pageUrl: 'https://www.ting13.cc/youshengxiaoshuo/39941/',
}
const episodes: SourceEpisode[] = Array.from({ length: 3 }, (_, i) => ({
  sourceId: 'ting13',
  bookId: book.id,
  id: `39941_1_${i + 1}`,
  title: `第${i + 1}集`,
  order: i + 1,
  pageUrl: `https://www.ting13.cc/play/39941_1_${i + 1}.html`,
}))
const bytes = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(4096, 42)])
const mp3 = (body = bytes) =>
  new Response(body, {
    headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(body.length) },
  })
async function fixture(request: typeof fetch, timeout = 3000) {
  const root = await mkdtemp(join(tmpdir(), '听读在线缓存 '))
  const filename = join(root, 'library.sqlite3'),
    directory = join(root, 'cache')
  const store = new LibraryStore(filename)
  store.rememberSourceBook(book, episodes.slice(0, 2), false)
  let resolves = 0,
    closed = 0
  const adapter: SourceAdapter = {
    id: 'ting13',
    search: async () => {
      throw Error('unused')
    },
    getBook: async () => book,
    getEpisodes: async () => ({ items: episodes, nextCursor: null }),
    resolveAudio: async (_book, id) => {
      resolves++
      return {
        sourceId: 'ting13',
        episodeId: id,
        url: `https://car-lv.kuwo.cn/${resolves}.mp3`,
        pageUrl: `https://www.ting13.cc/play/${id}.html`,
        headers: { Referer: `https://www.ting13.cc/play/${id}.html` },
        expiresAt: null,
      }
    },
  }
  const media = new OnlineMedia(
    store,
    adapter,
    directory,
    () => {
      closed++
    },
    request,
    timeout,
  )
  return {
    root,
    filename,
    directory,
    store,
    media,
    ids: store.listBooks()[0]!.episodes.map((e) => e.id),
    counts: () => ({ resolves, closed }),
  }
}

test('online catalog migration preserves local state and stable uncached source identities', async () => {
  const f = await fixture(async () => mp3())
  const id = f.ids[0]!
  assert.equal(f.store.getAudio(id), undefined)
  assert.equal(f.store.getEpisode(id)!.contentHash, '')
  assert.equal(f.store.getEpisode(id)!.online!.cached, false)
  const cached = await f.media.prepare(id)
  f.store.saveProgress({
    episodeId: id,
    sessionId: id,
    positionMs: 1234,
    durationMs: 5000,
    rate: 1.5,
    volume: 0,
  })
  await f.media.close()
  f.store.close()
  const old = new DatabaseSync(f.filename)
  old.exec(
    'DROP TABLE subtitle_import_commands; DROP TABLE subtitle_import_sources; DROP TABLE transcript_edit_commands; DROP TABLE transcript_edit_members; DROP TABLE transcript_edit_heads; DROP TABLE transcript_edit_groups; DROP TABLE offline_media_refs; DROP TABLE offline_plan_items; DROP TABLE offline_job_owners; DROP TABLE offline_plans; DROP TABLE processing_resources; ALTER TABLE transcription_jobs DROP COLUMN cpu_threads; DROP TABLE book_subtitle_settings; DROP TABLE reading_books; DROP TABLE original_alignments; DROP TABLE book_originals; DROP TABLE original_documents; DROP TABLE source_media_files; ALTER TABLE transcription_jobs DROP COLUMN background; DROP TABLE online_episodes; DROP TABLE online_books; PRAGMA user_version=6;',
  )
  old.close()
  const migrated = new LibraryStore(f.filename)
  assert.equal(migrated.getPlayerState().currentEpisodeId, id)
  assert.equal(migrated.getEpisode(id)!.positionMs, 1234)
  assert.equal(migrated.getAudio(id)!.contentHash, cached.contentHash)
  migrated.rememberSourceBook(
    { ...book, id: '39942' },
    episodes.map((e) => ({ ...e, bookId: '39942', id: e.id.replace('39941', '39942') })),
    true,
  )
  const added = migrated.listBooks().find((b) => b.online)!
  const ids = added.episodes.map((e) => e.id)
  migrated.rememberSourceBook(
    { ...book, id: '39942' },
    episodes
      .slice(0, 2)
      .map((e) => ({ ...e, bookId: '39942', id: e.id.replace('39941', '39942') })),
    false,
  )
  assert.deepEqual(
    migrated
      .listBooks()
      .find((b) => b.id === added.id)!
      .episodes.map((e) => e.id),
    ids,
  )
  assert.equal(migrated.listBooks().find((b) => b.id === added.id)!.online!.catalogComplete, true)
  const before = JSON.stringify(migrated.listBooks())
  assert.throws(
    () =>
      migrated.rememberSourceBook(
        { ...book, id: '39942' },
        [{ ...episodes[0]!, bookId: '39942', id: '39942_1_99' }],
        false,
      ),
    { code: 'SOURCE_CHANGED' },
  )
  assert.equal(JSON.stringify(migrated.listBooks()), before)
  migrated.close()
})

test('complete cache is hashed, persists across restart, and is reusable without any network', async () => {
  let requests = 0
  const f = await fixture(async (_url, options) => {
    requests++
    assert.equal(options!.redirect, 'manual')
    assert.equal(new Headers(options!.headers).get('Referer'), episodes[0]!.pageUrl)
    return mp3()
  })
  const id = f.ids[0]!,
    audio = await f.media.prepare(id)
  assert.equal(audio.contentHash, createHash('sha256').update(bytes).digest('hex'))
  assert.deepEqual(await readFile(audio.path), bytes)
  f.store.saveProgress({
    episodeId: id,
    sessionId: id,
    positionMs: 2000,
    durationMs: 8000,
    rate: 1,
    volume: 0,
  })
  assert.equal((await f.media.prepare(id)).path, audio.path)
  assert.equal(requests, 1)
  await f.media.close()
  f.store.close()
  const reopened = new LibraryStore(f.filename)
  const adapter = {
    id: 'ting13',
    resolveAudio: async () => {
      throw Error('network forbidden')
    },
  } as unknown as SourceAdapter
  const offline = new OnlineMedia(
    reopened,
    adapter,
    f.directory,
    () => {},
    async () => {
      throw Error('network forbidden')
    },
  )
  assert.equal((await offline.prepare(id)).contentHash, audio.contentHash)
  assert.equal(reopened.getEpisode(id)!.positionMs, 2000)
  await offline.close()
  reopened.close()
})

test('expired URL resolves once again; corruption fetches a new content version and resets progress', async () => {
  let requests = 0,
    changed = false
  const f = await fixture(async () => {
    requests++
    if (requests === 1) return new Response(null, { status: 403 })
    return mp3(changed ? Buffer.concat([bytes, Buffer.from('new version')]) : bytes)
  })
  const id = f.ids[0]!,
    original = await f.media.prepare(id)
  const manual = f.store.saveTranscript(id, {
    version: 1,
    audioHash: original.contentHash,
    kind: 'manual',
    coverage: [{ startMs: 0, endMs: 1000 }],
    segments: [{ id: 'human', startMs: 0, endMs: 1000, text: '保留人工文稿' }],
  })
  const mark = f.store.saveBookmark({
    episodeId: id,
    audioHash: original.contentHash,
    positionMs: 500,
    note: '保留旧版书签',
  })
  assert.equal(f.counts().resolves, 2)
  assert.equal(requests, 2)
  f.store.saveProgress({
    episodeId: id,
    sessionId: id,
    positionMs: 2000,
    durationMs: 8000,
    rate: 1,
    volume: 0,
  })
  await writeFile(original.path, 'damaged')
  changed = true
  const replacement = await f.media.prepare(id)
  assert.notEqual(replacement.contentHash, original.contentHash)
  assert.equal(f.store.getEpisode(id)!.positionMs, 0)
  assert.equal(f.store.getEpisode(id)!.durationMs, null)
  assert.equal(f.ids[0], id)
  assert.deepEqual(f.store.getTranscript(id, original.contentHash), manual)
  assert.equal(f.store.getTranscript(id, replacement.contentHash).status, 'stale')
  assert.equal(f.store.listBookmarks(f.store.getEpisode(id)!.bookId)[0]!.id, mark.id)
  await f.media.close()
  f.store.close()
})

test('HTML, truncated audio, unsafe redirects and oversized responses leave no playable or partial files', async () => {
  for (const response of [
    () => new Response('<html>blocked</html>', { headers: { 'Content-Type': 'text/html' } }),
    () =>
      new Response(bytes, {
        headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(bytes.length + 1) },
      }),
    () => new Response('not an mp3 file', { headers: { 'Content-Type': 'audio/mpeg' } }),
    () => new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/private' } }),
    () =>
      new Response(bytes, {
        headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(300 * 1024 * 1024) },
      }),
  ]) {
    let count = 0
    const f = await fixture(async () => {
      count++
      return response()
    })
    await assert.rejects(f.media.prepare(f.ids[0]!), { code: 'SOURCE_MEDIA_UNAVAILABLE' })
    assert.equal(f.store.getAudio(f.ids[0]!), undefined)
    assert.deepEqual(await readdir(f.directory), [])
    assert.equal(count, 1)
    await f.media.close()
    f.store.close()
  }
})

test('active transfer cancellation and deadline clean partial files and allow a later retry', async () => {
  for (const cancel of [true, false]) {
    let began!: () => void
    const streaming = new Promise<void>((resolve) => {
      began = resolve
    })
    let first = true
    const f = await fixture(
      async (_url, options) => {
        if (!first) return mp3()
        first = false
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes)
              began()
              options!.signal!.addEventListener(
                'abort',
                () => controller.error(new Error('aborted')),
                { once: true },
              )
            },
          }),
          { headers: { 'Content-Type': 'audio/mpeg' } },
        )
      },
      cancel ? 3000 : 100,
    )
    const pending = f.media.prepare(f.ids[0]!)
    const rejected = assert.rejects(pending, {
      code: cancel ? 'SOURCE_CANCELED' : 'SOURCE_TIMEOUT',
    })
    await streaming
    if (cancel) f.media.cancel(f.ids[0]!)
    await rejected
    assert.equal(f.store.getAudio(f.ids[0]!), undefined)
    assert.deepEqual(await readdir(f.directory), [])
    await f.media.prepare(f.ids[0]!)
    await f.media.close()
    await f.media.close()
    assert.equal(f.counts().closed, 1)
    f.store.close()
  }
})

test('online add/cancel IPC accepts identities and rejects paths, raw URLs and extra fields', () => {
  const id = '132837a1-7361-429a-8cd1-bbe452fc0752'
  validateRequest('source:add', [{ id, sourceId: 'ting13', bookId: '39941' }])
  validateRequest('player:cancel-open', [{ id }])
  assert.throws(() =>
    validateRequest('source:add', [
      { id, sourceId: 'ting13', bookId: '39941', url: 'https://example.com' },
    ]),
  )
  assert.throws(() => validateRequest('source:add', [{ id, sourceId: 'ting13', bookId: '../1' }]))
  assert.throws(() => validateRequest('player:cancel-open', [{ id: 'C:/file.mp3' }]))
})

test('rapid reopening of the same episode cancels and drains the prior transfer before retrying', async () => {
  let began!: () => void
  const started = new Promise<void>((resolve) => {
    began = resolve
  })
  let requests = 0,
    aborted = false
  const f = await fixture(async (_url, options) => {
    requests++
    if (requests > 1) {
      assert.equal(aborted, true)
      return mp3()
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
          began()
          options!.signal!.addEventListener(
            'abort',
            () => {
              aborted = true
              controller.error(new Error('aborted'))
            },
            { once: true },
          )
        },
      }),
      { headers: { 'Content-Type': 'audio/mpeg' } },
    )
  })
  const first = f.media.prepare(f.ids[0]!)
  const rejected = assert.rejects(first, { code: 'SOURCE_CANCELED' })
  await started
  const second = f.media.prepare(f.ids[0]!)
  await rejected
  const result = await second
  assert.equal(result.id, f.ids[0])
  assert.equal(requests, 2)
  assert.deepEqual(await readdir(f.directory), [result.path.split(/[\\/]/).at(-1)])
  await f.media.close()
  f.store.close()
})

test('a current episode preempts speculative next-audio transfer and drains its partial file', async () => {
  let begin!: () => void
  const started = new Promise<void>((resolve) => {
    begin = resolve
  })
  let requests = 0,
    aborted = false
  const f = await fixture(async (_url, options) => {
    requests++
    if (requests > 1) {
      assert.ok(aborted)
      return mp3()
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
          begin()
          options!.signal!.addEventListener(
            'abort',
            () => {
              aborted = true
              controller.error(Error('aborted'))
            },
            { once: true },
          )
        },
      }),
      { headers: { 'Content-Type': 'audio/mpeg' } },
    )
  })
  const pending = f.media.prepareNext(f.ids[0]!)
  const rejected = assert.rejects(pending, { code: 'SOURCE_CANCELED' })
  await started
  const foreground = f.media.prepare(f.ids[0]!)
  await rejected
  const cached = await foreground
  assert.equal(cached.id, f.ids[0])
  assert.equal(f.store.getAudio(f.ids[1]!), undefined)
  assert.equal((await readdir(f.directory)).length, 1)
  await f.media.close()
  f.store.close()
})
