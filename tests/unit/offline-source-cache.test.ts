import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { SourceCache } from '../../src/main/sources/source-cache'
import type { OfflinePlan } from '../../src/shared/offline'
import type { SourceBook, SourceEpisode } from '../../src/shared/sources'

const MiB = 1024 ** 2,
  book: SourceBook = {
    sourceId: 'ting13',
    id: '39941',
    title: '离线保留测试',
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
  }))
async function fixture(context: TestContext) {
  assert(
    process.platform !== 'win32' || resolve(tmpdir()).toLowerCase().startsWith('c:\\'),
    'Keep large isolated test files on C Temp.',
  )
  const root = await mkdtemp(join(tmpdir(), 'ralb-offline-retention-')),
    directory = join(root, 'media'),
    filename = join(root, 'library.sqlite3')
  await mkdir(directory)
  let store = new LibraryStore(filename)
  store.rememberSourceBook(book, catalog, true)
  const savedBook = store.listBooks()[0]!,
    episodes = savedBook.episodes,
    pins = new Set<string>()
  let cache = new SourceCache(store, directory, () => pins)
  context.after(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  const plan = (indices: number[]) =>
    store.createOfflinePlan({
      bookId: savedBook.id,
      episodeIds: indices.map((index) => episodes[index]!.id),
      scope: 'ids',
      profile: { engine: 'paraformer', device: 'cpu' },
      audioBudgetBytes: 1024 * MiB,
    })
  const retain = (
    p: OfflinePlan,
    index: number,
    audio: NonNullable<ReturnType<LibraryStore['getAudio']>>,
  ) => {
    const item = store
      .storedOfflineItems(p.id)
      .find((value) => value.episodeId === episodes[index]!.id)!
    return store.retainOfflineMedia(
      {
        planId: p.id,
        planRevision: store.offlinePlan(p.id)!.revision,
        itemId: item.id,
        attempt: item.attempt,
      },
      audio,
    )
  }
  const cancelRelease = (p: OfflinePlan) => {
    const ended = store.updateOfflinePlan({
      id: p.id,
      revision: store.offlinePlan(p.id)!.revision,
      action: 'cancel',
    })
    return store.releaseOfflineMedia(p.id, ended.revision)
  }
  return {
    root,
    directory,
    episodes,
    pins,
    plan,
    retain,
    cancelRelease,
    get store() {
      return store
    },
    get cache() {
      return cache
    },
    async file(index: number, size = 96, fill = index + 1) {
      const episode = episodes[index]!,
        path = join(directory, `${episode.id}-${randomUUID()}.mp3`),
        handle = await open(path, 'wx')
      try {
        // Real logical files, real stat identity and streaming SHA. No 180 MiB
        // buffers, real downloads, models, codecs or ASR quality are involved.
        await handle.truncate(size)
        await handle.write(Buffer.from([73, 68, 51, fill]), 0, 4, 0)
        await handle.sync()
      } finally {
        await handle.close()
      }
      const digest = createHash('sha256')
      for await (const bytes of createReadStream(path)) digest.update(bytes)
      const audio = {
        path,
        name: episode.title,
        sizeBytes: size,
        modifiedAt: (await stat(path)).mtimeMs,
        contentHash: digest.digest('hex'),
      }
      store.cacheSourceEpisode(episode.id, audio)
      return store.getAudio(episode.id)!
    },
    reopen() {
      store.close()
      store = new LibraryStore(filename)
      cache = new SourceCache(store, directory, () => pins)
    },
  }
}

test('more than 512 MiB of retained audio survives temporary LRU, clear and restart, then explicit release permits eviction without deleting reading data', async (context) => {
  const f = await fixture(context),
    plan = f.plan([0, 1, 2]),
    retained = []
  for (let index = 0; index < 3; index++) {
    const audio = await f.file(index, 180 * MiB)
    retained.push(audio)
    f.retain(plan, index, audio)
  }
  const firstTemporary = await f.file(3, 200 * MiB),
    secondTemporary = await f.file(4, 200 * MiB)
  const state = await f.cache.state()
  assert.equal(state.limitBytes, 512 * MiB)
  assert.equal(state.offlineBytes, 540 * MiB)
  assert.equal(state.offlineFiles, 3)
  assert.equal(state.bytes, 400 * MiB)
  assert.equal(state.protectedFiles, 0)
  await f.cache.reserve(256 * MiB, f.episodes[5]!.id)
  await assert.rejects(stat(firstTemporary.path), { code: 'ENOENT' })
  assert.equal((await stat(secondTemporary.path)).size, 200 * MiB)
  for (const audio of retained) assert.equal((await stat(audio.path)).size, 180 * MiB)
  const episode = f.store.getEpisode(f.episodes[0]!.id)!
  const manual = f.store.saveTranscript(episode.id, {
    version: 1,
    kind: 'manual',
    audioHash: episode.contentHash,
    coverage: [{ startMs: 0, endMs: 1000 }],
    segments: [{ id: 'kept', startMs: 0, endMs: 1000, text: '人工文稿保留。' }],
  })
  f.store.saveProgress({
    sessionId: '',
    episodeId: episode.id,
    positionMs: 500,
    durationMs: 1000,
    rate: 1.5,
    volume: 0,
  })
  const bookmark = f.store.saveBookmark({
    episodeId: episode.id,
    audioHash: episode.contentHash,
    positionMs: 500,
    note: '保留',
  })
  const preview = await f.cache.prepare()
  assert.equal(preview.clearFiles, 1)
  assert.equal(preview.clearBytes, 200 * MiB)
  await f.cache.clear(preview.token)
  f.reopen()
  assert.equal((await f.cache.state()).offlineBytes, 540 * MiB)
  assert.equal((await f.cache.prepare()).clearFiles, 0)
  f.cancelRelease(plan)
  const released = await f.cache.prepare()
  assert.equal(released.offlineFiles, 0)
  assert.equal(released.clearFiles, 3)
  await f.cache.clear(released.token)
  for (const audio of retained) await assert.rejects(stat(audio.path), { code: 'ENOENT' })
  assert.deepEqual(f.store.getTranscript(episode.id, episode.contentHash), manual)
  assert.equal(f.store.getEpisode(episode.id)!.positionMs, 500)
  assert.equal(f.store.listBookmarks(episode.bookId)[0]!.id, bookmark.id)
})

test('retention acquired after preview invalidates clearing; shared refs, current pins and a local import each prevent deleting their exact file', async (context) => {
  const f = await fixture(context),
    first = await f.file(0),
    second = await f.file(1),
    a = f.plan([0]),
    b = f.plan([0, 1])
  f.retain(a, 0, first)
  const beforeRetain = await f.cache.prepare()
  assert.equal(beforeRetain.clearFiles, 1)
  f.retain(b, 0, first)
  f.retain(b, 1, second)
  await assert.rejects(f.cache.clear(beforeRetain.token), { code: 'CONFLICT' })
  f.cancelRelease(a)
  assert.equal(f.store.offlineRetainedFiles().length, 2)
  assert.equal((await f.cache.prepare()).clearFiles, 0)
  f.cancelRelease(b)
  const beforePin = await f.cache.prepare()
  f.pins.add(f.episodes[0]!.id)
  await assert.rejects(f.cache.clear(beforePin.token), { code: 'CONFLICT' })
  const pinned = await f.cache.prepare()
  assert.equal(pinned.protectedFiles, 1)
  await f.cache.clear(pinned.token)
  assert.equal((await readFile(first.path)).length, first.sizeBytes)
  await assert.rejects(stat(second.path), { code: 'ENOENT' })
  f.store.importBook(await scanBook(first.path, 'file'))
  f.pins.clear()
  const imported = await f.cache.prepare()
  assert.equal(imported.clearFiles, 0)
  await f.cache.clear(imported.token)
  assert.equal((await stat(first.path)).size, first.sizeBytes)
})

test('a retained old content version does not falsely retain a different complete file for the same episode', async (context) => {
  const f = await fixture(context),
    original = await f.file(0),
    plan = f.plan([0])
  f.retain(plan, 0, original)
  const replacement = await f.file(0, 128, 99)
  assert.notEqual(replacement.contentHash, original.contentHash)
  const state = await f.cache.prepare()
  assert.equal(state.offlineFiles, 1)
  assert.equal(state.offlineBytes, original.sizeBytes)
  assert.equal(state.clearFiles, 1)
  assert.equal(state.clearBytes, replacement.sizeBytes)
  assert.equal(
    f.store.getOfflineReadiness(f.store.storedOfflineItems(plan.id)[0]!.id).audioReady,
    false,
  )
  await f.cache.clear(state.token)
  await assert.rejects(stat(replacement.path), { code: 'ENOENT' })
  assert.equal((await stat(original.path)).size, original.sizeBytes)
  assert.equal(f.store.offlineRetainedFiles()[0]!.contentHash, original.contentHash)
})

test('missing cache roots, missing retained files and changed files invalidate readiness without releasing retained ownership', async (context) => {
  for (const change of ['missing-root', 'missing-file', 'changed-file'] as const)
    await context.test(change, async (child) => {
      const f = await fixture(child),
        audio = await f.file(0),
        plan = f.plan([0])
      f.retain(plan, 0, audio)
      const before = f.store.storedOfflineItems(plan.id)[0]!,
        refs = f.store.offlineRetainedFiles(plan.id)
      assert.equal(f.store.getOfflineReadiness(before.id).audioReady, true)
      if (change === 'missing-root') await rm(f.directory, { recursive: true })
      else if (change === 'missing-file') await rm(audio.path)
      else {
        const handle = await open(audio.path, 'r+')
        try {
          await handle.truncate(audio.sizeBytes + 1)
        } finally {
          await handle.close()
        }
      }
      const state = await f.cache.prepare(),
        after = f.store.storedOfflineItems(plan.id)[0]!
      assert.equal(state.offlineFiles, 0)
      assert.equal(state.clearFiles, 0)
      assert.equal(after.status, 'needs-attention')
      assert.equal(after.attempt, before.attempt + 1)
      assert.equal(f.store.getOfflineReadiness(after.id).audioReady, false)
      assert.deepEqual(f.store.offlineRetainedFiles(plan.id), refs)
      // Repeated cache statistics must not continually invalidate the same item.
      await f.cache.state()
      assert.equal(f.store.storedOfflineItems(plan.id)[0]!.attempt, after.attempt)
      f.reopen()
      assert.equal(f.store.getOfflineReadiness(after.id).audioReady, false)
      assert.equal(f.store.storedOfflineItems(plan.id)[0]!.status, 'needs-attention')
      assert.deepEqual(f.store.offlineRetainedFiles(plan.id), refs)
      if (change === 'changed-file')
        assert.equal((await stat(audio.path)).size, audio.sizeBytes + 1)
    })
})
