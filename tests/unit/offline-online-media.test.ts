import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { DatabaseSync } from 'node:sqlite'
import { LibraryStore } from '../../src/main/database'
import { OfflinePreparation } from '../../src/main/offline-preparation'
import { checkAudio } from '../../src/main/media'
import { OnlineMedia, type OfflineMediaContext } from '../../src/main/sources/online-media'
import { SourceCache } from '../../src/main/sources/source-cache'
import type { OfflinePlan } from '../../src/shared/offline'
import type { SourceAdapter, SourceBook, SourceEpisode } from '../../src/shared/sources'

const book: SourceBook = {
    sourceId: 'ting13',
    id: '39941',
    title: '离线传输测试',
    authors: [],
    narrators: [],
    description: '',
    pageUrl: 'https://www.ting13.cc/youshengxiaoshuo/39941/',
  },
  catalog: SourceEpisode[] = Array.from({ length: 6 }, (_, index) => ({
    sourceId: 'ting13',
    bookId: book.id,
    id: `39941_1_${index + 1}`,
    order: index + 1,
    title: `第${index + 1}集`,
    pageUrl: `https://www.ting13.cc/play/39941_1_${index + 1}.html`,
  })),
  bytes = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(61, 42)]),
  digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex'),
  response = (body = bytes, length = true) =>
    new Response(body, {
      headers: {
        'Content-Type': 'audio/mpeg',
        ...(length ? { 'Content-Length': String(body.length) } : {}),
      },
    }),
  signal = () => new AbortController().signal
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture(
  context: TestContext,
  options: {
    request?: typeof fetch
    mutate?: <T>(action: () => Promise<T>) => Promise<T>
    complete?: boolean
  } = {},
) {
  assert(
    process.platform !== 'win32' || resolve(tmpdir()).toLowerCase().startsWith('c:\\'),
    'Use C Temp, not the constrained artifact drive.',
  )
  const root = await mkdtemp(join(tmpdir(), 'ralb-offline-media-')),
    directory = join(root, 'media'),
    filename = join(root, 'library.sqlite3')
  await mkdir(directory)
  const store = new LibraryStore(filename)
  store.rememberSourceBook(
    book,
    catalog.slice(0, options.complete === false ? 2 : 6),
    options.complete !== false,
  )
  const saved = store.listBooks()[0]!,
    ids = saved.episodes.map((episode) => episode.id),
    requests: string[] = [],
    resolved: string[] = []
  const adapter: SourceAdapter = {
    id: 'ting13',
    search: async () => {
      throw Error('unused')
    },
    getBook: async () => book,
    getEpisodes: async () => ({ items: catalog, nextCursor: null }),
    resolveAudio: async (_bookId, id) => {
      resolved.push(id)
      return {
        sourceId: 'ting13',
        episodeId: id,
        url: `https://car-lv.kuwo.cn/${id}.mp3`,
        pageUrl: `https://www.ting13.cc/play/${id}.html`,
        headers: { Referer: `https://www.ting13.cc/play/${id}.html` },
        expiresAt: null,
      }
    },
  }
  const cache = new SourceCache(store, directory, () => new Set()),
    media = new OnlineMedia(
      store,
      adapter,
      directory,
      () => {},
      async (url, init) => {
        requests.push(String(url))
        return options.request ? options.request(url, init) : response()
      },
      5000,
      cache,
      options.mutate,
    )
  context.after(async () => {
    await media.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  const plan = (indices = [0], budget = bytes.length * indices.length) =>
    store.createOfflinePlan({
      bookId: saved.id,
      episodeIds: indices.map((index) => ids[index]!),
      scope: 'ids',
      profile: { engine: 'paraformer', device: 'cpu' },
      audioBudgetBytes: budget,
    })
  const itemContext = (p: OfflinePlan, index = 0): OfflineMediaContext => {
    const item = store.storedOfflineItems(p.id).find((value) => value.episodeId === ids[index])!
    return {
      planId: p.id,
      planRevision: store.offlinePlan(p.id)!.revision,
      itemId: item.id,
      attempt: item.attempt,
    }
  }
  return {
    root,
    directory,
    filename,
    store,
    media,
    cache,
    ids,
    saved,
    adapter,
    requests,
    resolved,
    plan,
    itemContext,
    prepare: (p: OfflinePlan, index = 0, remaining = bytes.length, canceled = signal()) =>
      media.prepareForOffline(ids[index]!, itemContext(p, index), canceled, remaining),
    async cached(index = 0, body = bytes) {
      const path = join(directory, `${ids[index]}-${randomUUID()}.mp3`),
        fixed = new Date('2026-01-01T00:00:00.000Z')
      await writeFile(path, body)
      await utimes(path, fixed, fixed)
      store.cacheSourceEpisode(ids[index]!, {
        path,
        name: catalog[index]!.title,
        sizeBytes: body.length,
        modifiedAt: (await stat(path)).mtimeMs,
        contentHash: digest(body),
      })
      return store.getAudio(ids[index]!)!
    },
  }
}

function coordinator(f: Awaited<ReturnType<typeof fixture>>) {
  return new OfflinePreparation({
    store: f.store,
    queue: {
      startForOffline: () => {
        throw Error('The existing complete formal transcript must not create a worker.')
      },
      interruptOffline: async () => {},
      reconcileOffline: () => {},
    },
    media: f.media,
    directory: f.directory,
    // Scheduling fixture: media identity, hashing and retention remain real.
    // These tiny ID3 fixtures do not claim codec or recognition quality.
    measureDuration: async () => 1000,
    notify: () => {},
    libraryChanged: () => {},
    log: (error) => {
      throw error
    },
    pollMs: 0,
  })
}

test('a pending persisted audio-ready item rechecks complete bytes before becoming ready, despite unchanged size and mtime', async (context) => {
  const f = await fixture(context),
    original = await f.cached(),
    plan = f.plan(),
    service = coordinator(f)
  await f.prepare(plan)
  f.store.recordSourceDuration(f.ids[0]!, original.contentHash, 1000)
  const formal = f.store.saveTranscript(f.ids[0]!, {
    version: 1,
    kind: 'manual',
    audioHash: original.contentHash,
    coverage: [{ startMs: 0, endMs: 1000 }],
    segments: [{ id: 'manual', startMs: 0, endMs: 1000, text: '保留人工稿。' }],
  })
  const changed = Buffer.from(bytes)
  changed[changed.length - 1] = 99
  await writeFile(original.path, changed)
  await utimes(original.path, new Date(original.modifiedAt), new Date(original.modifiedAt))
  await checkAudio(original)
  assert.notEqual(digest(changed), original.contentHash)
  assert.equal(f.store.offlinePlan(plan.id)!.status, 'queued')
  assert.equal(f.store.storedOfflineItems(plan.id)[0]!.status, 'audio-ready')
  try {
    await service.initialize()
    service.start()
    for (
      let index = 0;
      index < 200 && f.store.offlinePlan(plan.id)!.status !== 'completed';
      index++
    )
      await delay(5)
    assert.equal(f.store.offlinePlan(plan.id)!.status, 'completed')
    const current = f.store.getAudio(f.ids[0]!)!
    assert.equal(digest(await readFile(current.path)), current.contentHash)
    assert.equal(current.contentHash, original.contentHash)
    assert.notEqual(current.path, original.path)
    assert.equal(f.requests.length, 1, 'the corrupted retained cache must be fetched again')
    assert.deepEqual(f.store.getTranscript(f.ids[0]!, original.contentHash), formal)
    assert.equal(f.store.offlineRetainedFiles(plan.id)[0]!.path, current.path)
  } finally {
    await service.close()
  }
})

test('closing the coordinator drains real get/list audits before the database can close', async (context) => {
  for (const method of ['get', 'list'] as const)
    await context.test(method, async (child) => {
      const f = await fixture(child),
        audio = await f.cached(),
        plan = f.plan(),
        service = coordinator(f)
      await f.prepare(plan)
      await rm(audio.path)
      let settled = false
      const read = (
        method === 'get'
          ? service.get({ id: plan.id, itemPage: 0 })
          : service.list({ page: 0, activeOnly: false })
      )
        .then(
          () => undefined,
          (error: unknown) => error,
        )
        .finally(() => {
          settled = true
        })
      try {
        await service.close()
        assert.equal(settled, true, 'close must drain all pending public file audits')
        const result = await read
        assert.ok(!(result instanceof Error) || !/database is not open/.test(result.message))
      } finally {
        await read
        await service.close()
      }
    })
})

test('a closed coordinator refuses new controls and reads without changing persisted plans or refs', async (context) => {
  const f = await fixture(context),
    plan = f.plan(),
    service = coordinator(f)
  const before = f.store.offlinePlan(plan.id),
    refs = f.store.offlineRetainedFiles(plan.id)
  await service.close()
  await assert.rejects(service.update({ id: plan.id, revision: plan.revision, action: 'pause' }), {
    code: 'BUSY',
  })
  await assert.rejects(service.get({ id: plan.id, itemPage: 0 }), { code: 'BUSY' })
  await assert.rejects(service.list({ page: 0, activeOnly: false }), { code: 'BUSY' })
  assert.throws(() => service.release({ id: plan.id, revision: plan.revision }), { code: 'BUSY' })
  assert.deepEqual(f.store.offlinePlan(plan.id), before)
  assert.deepEqual(f.store.offlineRetainedFiles(plan.id), refs)
})

test('media close drains cache statistics that invalidate missing retained audio and rejects later scans', async (context) => {
  const f = await fixture(context),
    plan = f.plan()
  await f.prepare(plan)
  const refs = f.store.offlineRetainedFiles(plan.id)
  await rm(f.directory, { recursive: true })
  let settled = false
  const scan = f.media.cacheState().finally(() => {
    settled = true
  })
  try {
    await f.media.close()
    assert.equal(settled, true, 'close must drain metadata scans before SQLite is closed')
    assert.equal((await scan).offlineFiles, 0)
    assert.equal(f.store.storedOfflineItems(plan.id)[0]!.status, 'needs-attention')
    assert.deepEqual(f.store.offlineRetainedFiles(plan.id), refs)
    await assert.rejects(async () => f.media.cacheState(), { code: 'SOURCE_CANCELED' })
  } finally {
    await scan
  }
})

test('a real offline download publishes its exact retention atomically, and its retained cache can be reused with no remaining new bytes or network', async (context) => {
  const f = await fixture(context),
    plan = f.plan(),
    audio = await f.prepare(plan)
  assert.equal(audio.contentHash, digest(bytes))
  assert.deepEqual(await readFile(audio.path), bytes)
  assert.equal(f.store.sourceCacheFiles().length, 1)
  assert.deepEqual(
    f.store.offlineRetainedFiles().map((file) => ({ ...file })),
    [
      {
        path: audio.path,
        contentHash: audio.contentHash,
        sizeBytes: audio.sizeBytes,
        modifiedAt: audio.modifiedAt,
      },
    ],
  )
  assert.equal((await f.cache.state()).offlineBytes, bytes.length)
  assert.equal((await f.cache.prepare()).clearFiles, 0)
  const reused = await f.prepare(plan, 0, 0)
  assert.equal(reused.path, audio.path)
  assert.equal(f.requests.length, 1)
  assert.equal(f.store.getStoredOfflineItem(f.itemContext(plan).itemId)!.audioReady, true)
})

test('zero budget and unknown-length overflow leave no partial registration; a raised budget retries without losing previously retained files', async (context) => {
  const f = await fixture(context, { request: async () => response(bytes, false) }),
    zero = f.plan([0], 0)
  await assert.rejects(f.prepare(zero, 0, 0), { code: 'FILE_UNAVAILABLE' })
  assert.deepEqual(await readdir(f.directory), [])
  assert.equal(f.store.sourceCacheFiles().length, 0)
  const small = f.plan([1], bytes.length - 1)
  await assert.rejects(f.prepare(small, 1, bytes.length - 1), { code: 'FILE_UNAVAILABLE' })
  assert.deepEqual(await readdir(f.directory), [])
  assert.equal(f.store.offlineRetainedFiles().length, 0)
  f.store.updateOfflinePlan({
    id: small.id,
    revision: small.revision,
    action: 'set-budget',
    audioBudgetBytes: bytes.length,
  })
  const retained = await f.prepare(small, 1, bytes.length)
  assert.equal(retained.sizeBytes, bytes.length)
  await assert.rejects(f.prepare(zero, 0, 0), { code: 'FILE_UNAVAILABLE' })
  assert.deepEqual(await readFile(retained.path), bytes)
  assert.equal(f.store.offlineRetainedFiles().length, 1)
  assert.equal(f.store.getStoredOfflineItem(f.itemContext(zero).itemId)!.audioHash, null)
})

test('offline cache reuse hashes the complete bytes even when corruption preserves the recorded size and modification time', async (context) => {
  const f = await fixture(context),
    cached = await f.cached(),
    plan = f.plan(),
    corrupted = Buffer.from(bytes)
  corrupted[corrupted.length - 1] = 99
  await writeFile(cached.path, corrupted)
  await utimes(cached.path, cached.modifiedAt / 1000, cached.modifiedAt / 1000)
  await checkAudio(cached) // The metadata-only playback guard deliberately still passes.
  const repaired = await f.prepare(plan)
  assert.equal(
    f.requests.length,
    1,
    'A complete SHA check must detect metadata-preserving corruption.',
  )
  assert.notEqual(repaired.path, cached.path)
  assert.equal(repaired.contentHash, digest(bytes))
  assert.deepEqual(await readFile(repaired.path), bytes)
  assert.equal(f.store.offlineRetainedFiles()[0]!.path, repaired.path)
})

test('current playback preempts a plan and drains its partial file; next, another plan and stale owner cancellation cannot steal the current request', async (context) => {
  const beganPlan = deferred<AbortSignal>(),
    beganCurrent = deferred<AbortSignal>(),
    finishCurrent = deferred()
  let requests = 0
  const f = await fixture(context, {
      request: async (_url, init) => {
        requests++
        if (requests === 1)
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes)
                init!.signal!.addEventListener(
                  'abort',
                  () => controller.error(Error('fixture plan aborted')),
                  { once: true },
                )
                beganPlan.resolve(init!.signal!)
              },
            }),
            { headers: { 'Content-Type': 'audio/mpeg' } },
          )
        if (requests === 2)
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                init!.signal!.addEventListener(
                  'abort',
                  () => controller.error(Error('fixture current aborted')),
                  { once: true },
                )
                void finishCurrent.promise.then(() => {
                  controller.enqueue(bytes)
                  controller.close()
                })
                beganCurrent.resolve(init!.signal!)
              },
            }),
            { headers: { 'Content-Type': 'audio/mpeg' } },
          )
        return response()
      },
    }),
    plan = f.plan([0]),
    other = f.plan([1])
  const pending = f.prepare(plan),
    rejected = assert.rejects(pending, { code: 'SOURCE_CANCELED' }),
    planSignal = await beganPlan.promise
  await f.media.cancelOffline(f.itemContext(other, 1).itemId)
  assert.equal(planSignal.aborted, false)
  await assert.rejects(f.media.prepareNext(f.ids[0]!), { code: 'SOURCE_BUSY' })
  await assert.rejects(f.prepare(other, 1), { code: 'SOURCE_BUSY' })
  const current = f.media.prepare(f.ids[1]!),
    currentSignal = await beganCurrent.promise
  try {
    await rejected
    assert.equal(planSignal.aborted, true)
    await f.media.cancelOffline(f.itemContext(plan).itemId)
    await assert.rejects(f.prepare(plan), { code: 'SOURCE_BUSY' })
    assert.equal(currentSignal.aborted, false)
  } finally {
    finishCurrent.resolve()
  }
  const audio = await current
  assert.equal(audio.id, f.ids[1])
  assert.equal(f.store.getAudio(f.ids[0]!), undefined)
  assert.equal(f.store.offlineRetainedFiles().length, 0)
  const resumed = await f.prepare(plan)
  assert.equal(resumed.id, f.ids[0])
  assert.equal(f.store.offlineRetainedFiles()[0]!.path, resumed.path)
  assert.equal((await readdir(f.directory)).filter((path) => path.endsWith('.part')).length, 0)
})

test('cancel waits for the final cache mutation and rejects a late complete file without publishing a cache or retention row', async (context) => {
  const entered = deferred(),
    release = deferred()
  let mutations = 0
  const f = await fixture(context, {
      mutate: async (action) => {
        if (++mutations === 2) {
          entered.resolve()
          await release.promise
        }
        return action()
      },
    }),
    plan = f.plan(),
    pending = f.prepare(plan),
    rejected = assert.rejects(pending, { code: 'SOURCE_CANCELED' })
  await entered.promise
  f.store.updateOfflinePlan({ id: plan.id, revision: plan.revision, action: 'cancel' })
  let finished = false
  const canceled = f.media.cancelOffline(f.itemContext(plan).itemId).then(() => {
    finished = true
  })
  try {
    await delay(10)
    assert.equal(finished, false)
    assert.equal((await readdir(f.directory)).filter((name) => name.endsWith('.mp3')).length, 1)
    assert.equal(f.store.sourceCacheFiles().length, 0)
    assert.equal(f.store.offlineRetainedFiles().length, 0)
  } finally {
    release.resolve()
  }
  await canceled
  await rejected
  assert.deepEqual(await readdir(f.directory), [])
  assert.equal(f.store.getAudio(f.ids[0]!), undefined)
  assert.equal(f.store.getStoredOfflineItem(f.itemContext(plan).itemId)!.status, 'canceled')
})

test('a real SQLite retention failure rolls back cache registration and removes the newly renamed file before a clean retry', async (context) => {
  const f = await fixture(context),
    plan = f.plan(),
    db = Reflect.get(f.store, 'db') as DatabaseSync
  db.exec(
    "CREATE TRIGGER reject_offline_download_ref BEFORE INSERT ON offline_media_refs BEGIN SELECT RAISE(ABORT,'fixture retention write failure'); END",
  )
  await assert.rejects(f.prepare(plan), { code: 'SOURCE_MEDIA_UNAVAILABLE' })
  assert.deepEqual(await readdir(f.directory), [])
  assert.equal(f.store.getAudio(f.ids[0]!), undefined)
  assert.equal(f.store.sourceCacheFiles().length, 0)
  assert.equal(f.store.offlineRetainedFiles().length, 0)
  assert.equal(f.store.getStoredOfflineItem(f.itemContext(plan).itemId)!.audioHash, null)
  db.exec('DROP TRIGGER reject_offline_download_ref')
  const completed = await f.prepare(plan)
  assert.equal(f.store.sourceCacheFiles()[0]!.path, completed.path)
  assert.equal(f.store.offlineRetainedFiles()[0]!.path, completed.path)
})

test('offline all-catalog completion traverses fresh pages, persists every stable identity and supports a bounded range without pretending it is the full book', async (context) => {
  const f = await fixture(context, { complete: false }),
    original = [...f.ids],
    calls: (string | undefined)[] = []
  f.adapter.getEpisodes = async (_id, cursor) => {
    calls.push(cursor)
    return cursor === undefined
      ? { items: catalog.slice(0, 2), nextCursor: 'page-2' }
      : cursor === 'page-2'
        ? { items: catalog.slice(2, 4), nextCursor: 'page-3' }
        : { items: catalog.slice(4), nextCursor: null }
  }
  await f.media.completeOfflineCatalog(f.saved.id, { kind: 'range', from: 1, to: 3 }, signal())
  assert.deepEqual(calls, [undefined, 'page-2'])
  assert.equal(f.store.listBooks()[0]!.episodes.length, 4)
  assert.equal(f.store.listBooks()[0]!.online!.catalogComplete, false)
  calls.length = 0
  await f.media.completeOfflineCatalog(f.saved.id, { kind: 'all' }, signal())
  assert.deepEqual(calls, [undefined, 'page-2', 'page-3'])
  const complete = f.store.listBooks()[0]!
  assert.equal(complete.episodes.length, 6)
  assert.equal(complete.online!.catalogComplete, true)
  assert.deepEqual(
    complete.episodes.slice(0, 2).map((episode) => episode.id),
    original,
  )
  const reopened = new LibraryStore(f.filename)
  try {
    assert.deepEqual(
      reopened.listBooks()[0]!.episodes.map((episode) => episode.id),
      complete.episodes.map((episode) => episode.id),
    )
  } finally {
    reopened.close()
  }
})

test('canceled late catalog pages and repeated cursors never publish a partial all-book catalog', async (context) => {
  const f = await fixture(context, { complete: false }),
    entered = deferred(),
    release = deferred(),
    controller = new AbortController(),
    before = f.store.listBooks()
  let pages = 0
  f.adapter.getEpisodes = async () => {
    if (pages++ === 0) return { items: catalog.slice(0, 2), nextCursor: 'late-page' }
    entered.resolve()
    await release.promise
    return { items: catalog.slice(2), nextCursor: null }
  }
  const pending = f.media.completeOfflineCatalog(f.saved.id, { kind: 'all' }, controller.signal),
    rejected = assert.rejects(pending)
  await entered.promise
  controller.abort()
  release.resolve()
  await rejected
  assert.deepEqual(f.store.listBooks(), before)
  f.adapter.getEpisodes = async () => ({ items: catalog.slice(0, 2), nextCursor: 'same-cursor' })
  await assert.rejects(f.media.completeOfflineCatalog(f.saved.id, { kind: 'all' }, signal()), {
    code: 'SOURCE_CHANGED',
  })
  assert.deepEqual(f.store.listBooks(), before)
})
