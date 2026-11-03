import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import test, { type TestContext } from 'node:test'
import { LibraryStore, type StoredTranscriptionJob } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { OfflinePreparation } from '../../src/main/offline-preparation'
import type { OfflineItemContext } from '../../src/main/offline-store'
import type {
  OfflinePlan,
  OfflineSelection,
  PreviewOfflinePlanRequest,
} from '../../src/shared/offline'
import { AppError } from '../../src/shared/validation'
import type { SourceBook, SourceEpisode } from '../../src/shared/sources'
import type { TranscriptDocument } from '../../src/shared/transcript'

type Options = ConstructorParameters<typeof OfflinePreparation>[0]
const profile = { engine: 'paraformer', device: 'cpu' } as const
const sourceBook: SourceBook = {
  sourceId: 'ting13',
  id: 'coordinator-book',
  title: '离线协调测试',
  authors: [],
  narrators: [],
  description: '',
  pageUrl: 'https://www.ting13.cc/youshengxiaoshuo/39941/',
}
function catalog(count: number): SourceEpisode[] {
  return Array.from({ length: count }, (_, index) => ({
    sourceId: 'ting13',
    bookId: sourceBook.id,
    id: `source-${index + 1}`,
    title: `第${index + 1}集`,
    order: index + 1,
    pageUrl: `https://www.ting13.cc/play/39941_1_${index + 1}.html`,
  }))
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function until(condition: () => boolean, label = 'coordinator state') {
  for (let i = 0; i < 400 && !condition(); i++) await delay(5)
  assert.ok(condition(), `timed out waiting for ${label}`)
}
function document(
  hash: string,
  endMs = 1000,
  kind: TranscriptDocument['kind'] = 'manual',
): TranscriptDocument {
  return {
    version: 1,
    kind,
    audioHash: hash,
    coverage: [{ startMs: 0, endMs }],
    segments: [
      {
        id: 'fixture-s1',
        startMs: 0,
        endMs: Math.min(endMs, 400),
        text: '控制夹具文字，不作质量参考。',
      },
    ],
  }
}

async function fixture(
  t: TestContext,
  setup: { online?: boolean; count?: number; knownDuration?: boolean; complete?: boolean } = {},
) {
  const base = process.platform === 'win32' ? 'C:/Temp' : tmpdir()
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'ralb-offline-coord-')),
    filename = join(root, 'library.sqlite3')
  let store = new LibraryStore(filename)
  const count = setup.count ?? 2
  if (setup.online) store.rememberSourceBook(sourceBook, catalog(count), setup.complete ?? true)
  else {
    for (let i = 0; i < count; i++)
      await writeFile(join(root, `${i + 1}.mp3`), `owned local media ${i}`)
    store.importBook(await scanBook(root, 'folder'))
    if (setup.knownDuration !== false)
      for (const episode of store.listBooks()[0]!.episodes)
        store.recordSourceDuration(episode.id, episode.contentHash, 1000)
  }
  const book = store.listBooks()[0]!,
    episodes = book.episodes
  let clock = 10000,
    idle = 60,
    notifications = 0,
    libraryChanges = 0,
    reconciliations = 0
  const errors: unknown[] = [],
    starts: { itemId: string; jobId: string; attached: boolean }[] = [],
    downloads: {
      episodeId: string
      context: OfflineItemContext
      signal: AbortSignal
      budget: number
    }[] = [],
    cancellations: string[] = [],
    interrupts: string[][] = []
  let completeCatalog: Options['media']['completeOfflineCatalog'] = async () => {}
  const mediaFile = async (index = 0, suffix = 'media') => {
    const path = join(root, `${suffix}-${index}.mp3`),
      bytes = Buffer.from(`owned source audio ${index}`)
    await writeFile(path, bytes)
    return {
      path,
      name: episodes[index]!.title,
      sizeBytes: bytes.length,
      modifiedAt: (await stat(path)).mtimeMs,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
    }
  }
  let prepare: Options['media']['prepareForOffline'] = async (
    episodeId,
    context,
    signal,
    budget,
  ) => {
    signal.throwIfAborted()
    const audio = await mediaFile(episodes.findIndex((episode) => episode.id === episodeId))
    signal.throwIfAborted()
    if (audio.sizeBytes > budget) throw new AppError('BUSY', '本计划音频预算不足。')
    store.retainOfflineMedia(context, audio)
    return store.getAudio(episodeId)!
  }
  let duration: Options['measureDuration'] = async () => 1000
  const makeCoordinator = () =>
    new OfflinePreparation({
      store,
      directory: root,
      pollMs: 10,
      now: () => clock,
      idleSeconds: () => idle,
      notify: () => {
        notifications++
      },
      libraryChanged: () => {
        libraryChanges++
      },
      log: (error) => errors.push(error),
      measureDuration: (...args) => duration(...args),
      media: {
        completeOfflineCatalog: (...args) => completeCatalog(...args),
        prepareForOffline: (...args) => {
          const [episodeId, context, signal, budget] = args
          downloads.push({ episodeId, context, signal, budget })
          return prepare(...args)
        },
        cancelOffline: async (itemId) => {
          cancellations.push(itemId)
        },
      },
      queue: {
        startForOffline: (itemId, request, context) => {
          const { job, attached } = store.createOrAttachOfflineJob(itemId, request, context)
          starts.push({ itemId, jobId: job.id, attached })
          return job
        },
        interruptOffline: async (ids) => {
          interrupts.push([...ids])
          for (const id of ids) {
            const owner = store.offlineJobOwnership(id),
              job = store.getJob(id)
            if (job?.status === 'running' && owner.planned && !owner.manual && !owner.runnable)
              store.interruptJob(id, job.attempt)
          }
        },
        reconcileOffline: () => {
          reconciliations++
        },
      },
    })
  let service = makeCoordinator()
  const releases: (() => void)[] = []
  t.after(async () => {
    for (const release of releases) release()
    await service.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  const request = (selection: OfflineSelection = { kind: 'all' }): PreviewOfflinePlanRequest => ({
    requestId: randomUUID(),
    bookId: book.id,
    selection,
    profile,
    audioBudgetBytes: setup.online ? 100000 : 0,
  })
  const create = async (selection: OfflineSelection = { kind: 'all' }) =>
    service.create((await service.preview(request(selection))).token)
  const item = (plan: OfflinePlan, index = 0) => store.storedOfflineItems(plan.id)[index]!
  const context = (plan: OfflinePlan, index = 0): OfflineItemContext => {
    const value = item(plan, index)
    return {
      planId: plan.id,
      planRevision: store.offlinePlan(plan.id)!.revision,
      itemId: value.id,
      attempt: value.attempt,
    }
  }
  const finish = (job: StoredTranscriptionJob) => {
    store.setJobStatus(job.id, job.attempt, 'running')
    assert.equal(
      store.acceptJobSnapshot(
        job.id,
        job.attempt,
        {
          document: document(job.audioHash, 1000, 'transcript'),
          processedUntilMs: 1000,
          cacheKey: 'a'.repeat(64),
          cacheHits: 0,
          totalChunks: 1,
          issues: [],
        },
        1,
        true,
        1000,
      ),
      true,
    )
    service.changed()
  }
  return {
    root,
    filename,
    book,
    episodes,
    errors,
    starts,
    downloads,
    cancellations,
    interrupts,
    mediaFile,
    request,
    create,
    item,
    context,
    finish,
    releases,
    get store() {
      return store
    },
    get service() {
      return service
    },
    get notifications() {
      return notifications
    },
    get libraryChanges() {
      return libraryChanges
    },
    get reconciliations() {
      return reconciliations
    },
    setClock(value: number) {
      clock = value
    },
    setIdle(value: number) {
      idle = value
      service.changed()
    },
    setCatalog(value: typeof completeCatalog) {
      completeCatalog = value
    },
    setPrepare(value: typeof prepare) {
      prepare = value
    },
    setDuration(value: typeof duration) {
      duration = value
    },
    async reopen() {
      await service.close()
      store.close()
      store = new LibraryStore(filename)
      service = makeCoordinator()
      return service
    },
  }
}

test('preview is side-effect free, uses 1-based local/online ranges and rejects a >1,000 whole catalog after persisting it', async (t) => {
  const local = await fixture(t, { count: 4 })
  const selected = await local.service.preview(local.request({ kind: 'range', from: 2, to: 3 }))
  assert.deepEqual(
    selected.items.map((item) => item.episodeId),
    local.episodes.slice(1, 3).map((item) => item.id),
  )
  assert.deepEqual(
    selected.items.map((item) => item.order),
    [2, 3],
  )
  assert.equal(local.store.offlinePlans().total, 0)
  assert.equal(local.store.activeJobs().length, 0)
  assert.equal(local.store.offlineMediaReferences().length, 0)
  assert.equal(local.starts.length + local.downloads.length, 0)
  assert.equal(selected.knownAudioBytes, 0)
  const online = await fixture(t, { online: true, count: 2, complete: false })
  online.setCatalog(async () => {
    online.store.rememberSourceBook(sourceBook, catalog(1001), true)
  })
  await assert.rejects(online.service.preview(online.request()), { code: 'INVALID_REQUEST' })
  assert.equal(online.store.listBooks()[0]!.episodes.length, 1001)
  assert.equal(online.store.listBooks()[0]!.online!.catalogComplete, true)
  assert.ok(online.libraryChanges > 0)
  const range = await online.service.preview(
    online.request({ kind: 'range', from: 1000, to: 1001 }),
  )
  assert.deepEqual(
    range.items.map((item) => item.order),
    [1000, 1001],
  )
  assert.equal(range.unknownAudioItems, 2)
  assert.equal(online.store.offlinePlans().total, 0)
  assert.equal(online.downloads.length, 0)
})

test('preview tokens expire, are single-use and reject changed media identity without creating jobs or refs', async (t) => {
  const f = await fixture(t, { count: 1 }),
    first = await f.service.preview(f.request())
  f.setClock(first.expiresAt)
  await assert.rejects(f.service.create(first.token), { code: 'CONFLICT' })
  const second = await f.service.preview(f.request())
  const audio = f.store.getAudio(f.episodes[0]!.id)!
  await writeFile(audio.path, 'changed bytes, different size')
  await assert.rejects(f.service.create(second.token), { code: 'FILE_CHANGED' })
  await assert.rejects(f.service.create(second.token), { code: 'CONFLICT' })
  assert.equal(f.store.offlinePlans().total, 0)
  assert.equal(f.store.activeJobs().length, 0)
  assert.equal(f.store.offlineMediaReferences().length, 0)
})

test('offline ranges remain sorted array positions with sparse orders and never expand unrelated books', async (t) => {
  const f = await fixture(t, { count: 4 })
  const db = new DatabaseSync(f.filename)
  try {
    db.prepare('UPDATE episodes SET sort_order=sort_order*10 WHERE book_id=?').run(f.book.id)
  } finally {
    db.close()
  }
  f.store.listBooks = () => assert.fail('single-book previews must not read the full library')
  const preview = await f.service.preview(f.request({ kind: 'range', from: 2, to: 3 }))
  assert.deepEqual(
    preview.items.map((item) => item.episodeId),
    f.episodes.slice(1, 3).map((episode) => episode.id),
  )
  assert.deepEqual(
    preview.items.map((item) => item.order),
    [11, 21],
  )
  assert.equal(preview.totalItems, 2)
  assert.equal(f.store.offlinePlans().total, 0)
  assert.equal(f.starts.length + f.downloads.length, 0)
})

test('canceling a catalog preview waits for cleanup and invalidates a completed token delivered late', async (t) => {
  const f = await fixture(t, { online: true, count: 1, complete: false }),
    gate = deferred<void>()
  f.releases.push(() => gate.resolve())
  let entered = false,
    aborted = false
  f.setCatalog(async (_id, _selection, signal) => {
    entered = true
    signal.addEventListener(
      'abort',
      () => {
        aborted = true
      },
      { once: true },
    )
    await gate.promise
    signal.throwIfAborted()
  })
  const request = f.request(),
    preview = f.service.preview(request)
  const rejected = assert.rejects(preview, { code: 'SOURCE_CANCELED' })
  await until(() => entered)
  let canceled = false
  const cleanup = f.service.cancelPreview(request.requestId).then(() => {
    canceled = true
  })
  await until(() => aborted)
  assert.equal(canceled, false)
  gate.resolve()
  await Promise.all([cleanup, rejected])
  f.setCatalog(async () => {
    f.store.rememberSourceBook(sourceBook, catalog(1), true)
  })
  const completeRequest = f.request(),
    completed = await f.service.preview(completeRequest)
  await f.service.cancelPreview(completeRequest.requestId)
  await assert.rejects(f.service.create(completed.token), { code: 'CONFLICT' })
  assert.equal(f.store.offlinePlans().total, 0)
})

for (const action of ['pause', 'cancel', 'set-budget'] as const) {
  test(`${action} advances CAS before awaiting a late download and prevents stale retention or subtitle work`, async (t) => {
    const f = await fixture(t, { online: true, count: 1 }),
      plan = await f.create(),
      gate = deferred<void>()
    f.releases.push(() => gate.resolve())
    let entered = false,
      staleRetentionRejected = false
    f.setPrepare(async (episodeId, context) => {
      const audio = await f.mediaFile()
      entered = true
      await gate.promise
      try {
        f.store.retainOfflineMedia(context, audio)
      } catch (error) {
        staleRetentionRejected = (error as AppError).code === 'CONFLICT'
        throw error
      }
      return f.store.getAudio(episodeId)!
    })
    f.service.start()
    await until(() => entered)
    let returned = false
    const update = f.service
      .update(
        action === 'set-budget'
          ? { id: plan.id, revision: plan.revision, action, audioBudgetBytes: 200000 }
          : { id: plan.id, revision: plan.revision, action },
      )
      .then((value) => {
        returned = true
        return value
      })
    await until(() => f.cancellations.length > 0)
    assert.equal(returned, false, 'control command must await download cleanup')
    assert.equal(f.store.offlinePlan(plan.id)!.revision, plan.revision + 1)
    await assert.rejects(
      f.service.update({ id: plan.id, revision: plan.revision, action: 'pause' }),
      { code: 'CONFLICT' },
    )
    // Stop rescheduling after set-budget so only the obsolete attempt is observed.
    const resources = f.store.processingResources()
    f.store.setProcessingPaused({ revision: resources.revision, paused: true })
    gate.resolve()
    const saved = await update
    assert.equal(staleRetentionRejected, true)
    assert.equal(f.store.offlineMediaReferences().length, 0)
    assert.equal(f.starts.length, 0)
    assert.equal(
      saved.status,
      action === 'pause' ? 'paused' : action === 'cancel' ? 'canceled' : 'running',
    )
    assert.equal(f.item(plan).audioVerified, false)
  })
}

test('only one planned ASR job is materialized and overlapping plans attach to the same frozen profile', async (t) => {
  const f = await fixture(t),
    first = await f.create(),
    overlap = await f.create({ kind: 'ids', episodeIds: [f.episodes[0]!.id] })
  f.service.start()
  await until(() => f.starts.length === 2, 'first ASR plus shared attachment')
  assert.equal(f.store.activeJobs().length, 1)
  assert.equal(f.starts[0]!.jobId, f.starts[1]!.jobId)
  assert.equal(f.starts[1]!.attached, true)
  assert.equal(f.store.storedOfflineItems(first.id)[1]!.jobId, null)
  assert.equal(f.item(overlap).jobId, f.starts[0]!.jobId)
  f.finish(f.store.getJob(f.starts[0]!.jobId)!)
  await until(() => f.starts.length === 3, 'second non-overlapping episode')
  assert.notEqual(f.starts[2]!.jobId, f.starts[0]!.jobId)
  assert.equal(f.store.offlinePlan(overlap.id)!.status, 'completed')
  f.finish(f.store.getJob(f.starts[2]!.jobId)!)
  await until(() => f.store.offlinePlan(first.id)!.status === 'completed')
  assert.equal(f.store.offlinePlan(first.id)!.counts.subtitleReady, 2)
  assert.deepEqual(f.errors, [])
})

test('full-coverage partial remains owned and transcribing until the worker commits its final completed result', async (t) => {
  const f = await fixture(t, { count: 1 }),
    plan = await f.create()
  f.service.start()
  await until(() => f.starts.length === 1)
  const job = f.store.getJob(f.starts[0]!.jobId)!
  f.store.setJobStatus(job.id, job.attempt, 'running')
  assert.equal(
    f.store.acceptJobSnapshot(
      job.id,
      job.attempt,
      {
        document: document(job.audioHash, 1000, 'transcript'),
        processedUntilMs: 1000,
        cacheKey: 'a'.repeat(64),
        cacheHits: 0,
        totalChunks: 1,
        issues: [],
      },
      1,
      false,
    ),
    true,
  )
  f.service.changed()
  // Multiple scheduler turns reproduce the final-partial/final-result gap.
  // Full text alone must not park a worker whose terminal result is in flight.
  await delay(35)
  assert.equal(f.item(plan).status, 'transcribing')
  assert.equal(f.store.getJob(job.id)!.status, 'running')
  assert.equal(f.store.offlineJobOwnership(job.id).runnable, true)
  assert.notEqual(f.store.offlinePlan(plan.id)!.status, 'completed')
  f.finish(f.store.getJob(job.id)!)
  await until(() => f.item(plan).status === 'ready')
  assert.equal(f.store.getJob(job.id)!.status, 'completed')
  assert.equal(f.store.offlinePlan(plan.id)!.status, 'completed')
  assert.equal(f.store.offlineJobOwnership(job.id).runnable, false)
})

test('partial manual text and pending previews remain protected instead of spawning replacement ASR or counting ready', async (t) => {
  const f = await fixture(t),
    manualEpisode = f.episodes[0]!,
    previewEpisode = f.episodes[1]!
  f.store.saveTranscript(manualEpisode.id, document(manualEpisode.contentHash, 400))
  const manual = f.store.getTranscript(manualEpisode.id, manualEpisode.contentHash)
  f.store.saveTranscript(previewEpisode.id, document(previewEpisode.contentHash, 400))
  const pending = f.store.createJob({
    episodeId: previewEpisode.id,
    audioHash: previewEpisode.contentHash,
    ...profile,
  })
  f.finish(pending)
  const saved = f.store.getTranscript(previewEpisode.id, previewEpisode.contentHash)
  assert.equal(f.store.getJob(pending.id)!.autoApply, false)
  const preview = await f.service.preview(f.request())
  assert.equal(preview.completeSubtitleItems, 0)
  assert.equal(preview.partialSubtitleItems, 2)
  assert.ok(preview.conflicts.length > 0)
  const plan = await f.service.create(preview.token)
  f.service.start()
  await until(() => f.store.offlinePlan(plan.id)!.status === 'completed-with-issues')
  assert.equal(f.starts.length, 0)
  assert.equal(f.store.offlinePlan(plan.id)!.counts.subtitleReady, 0)
  assert.equal(f.store.offlinePlan(plan.id)!.counts.needsAttention, 2)
  assert.deepEqual(f.store.getTranscript(manualEpisode.id, manualEpisode.contentHash), manual)
  assert.deepEqual(f.store.getTranscript(previewEpisode.id, previewEpisode.contentHash), saved)
  assert.equal(f.store.latestJob(previewEpisode.id, previewEpisode.contentHash)!.id, pending.id)
})

test('a full-looking transcript with unknown duration is not ready until independent duration is obtained', async (t) => {
  const f = await fixture(t, { count: 1, knownDuration: false }),
    episode = f.episodes[0]!,
    gate = deferred<number>()
  f.releases.push(() => gate.resolve(1000))
  f.store.saveTranscript(episode.id, document(episode.contentHash))
  const before = await f.service.preview(f.request())
  assert.equal(before.completeSubtitleItems, 0)
  assert.equal(before.items[0]!.subtitle, 'unknown-duration')
  let measuring = false
  f.setDuration(async (_id, _hash, signal) => {
    measuring = true
    const value = await gate.promise
    signal.throwIfAborted()
    return value
  })
  const plan = await f.service.create(before.token)
  f.service.start()
  await until(() => measuring)
  assert.equal(f.store.offlinePlan(plan.id)!.counts.subtitleReady, 0)
  assert.notEqual(f.store.offlinePlan(plan.id)!.status, 'completed')
  assert.equal(f.starts.length, 0)
  gate.resolve(1000)
  await until(() => f.store.offlinePlan(plan.id)!.status === 'completed')
  assert.equal(f.store.getEpisode(episode.id)!.durationMs, 1000)
  assert.equal(f.starts.length, 0)
})

test('global pause and idle policy gate preparation without changing the frozen engine or device', async (t) => {
  const f = await fixture(t, { online: true, count: 1 })
  let resources = f.store.processingResources()
  resources = f.store.setProcessingPolicy({
    revision: resources.revision,
    policy: { ...resources.policy, backgroundIdleOnly: true },
  })
  f.store.setProcessingPaused({ revision: resources.revision, paused: true })
  const plan = await f.create()
  f.service.start()
  await delay(35)
  assert.equal(f.downloads.length + f.starts.length, 0)
  resources = f.store.processingResources()
  f.setIdle(59)
  f.store.setProcessingPaused({ revision: resources.revision, paused: false })
  f.service.changed()
  await delay(35)
  assert.equal(f.downloads.length + f.starts.length, 0)
  f.setIdle(60)
  await until(() => f.starts.length === 1)
  assert.deepEqual(f.store.getJob(f.starts[0]!.jobId)!.engine, profile.engine)
  assert.deepEqual(f.store.offlinePlan(plan.id)!.profile, profile)
  assert.equal(f.downloads[0]!.budget, 100000)
})

test('global pause aborts in-flight audio and preserves the item for explicit resource resume', async (t) => {
  const f = await fixture(t, { online: true, count: 1 }),
    plan = await f.create(),
    gate = deferred<void>()
  f.releases.push(() => gate.resolve())
  let entered = false
  f.setPrepare(async (episodeId, context, signal) => {
    const audio = await f.mediaFile()
    entered = true
    await gate.promise
    signal.throwIfAborted()
    f.store.retainOfflineMedia(context, audio)
    return f.store.getAudio(episodeId)!
  })
  f.service.start()
  await until(() => entered)
  const attempt = f.item(plan).attempt,
    resources = f.store.processingResources()
  f.store.setProcessingPaused({ revision: resources.revision, paused: true })
  f.service.changed()
  await until(() => f.downloads[0]!.signal.aborted)
  assert.equal(f.cancellations[0], f.item(plan).id)
  gate.resolve()
  await until(() => f.item(plan).status === 'waiting-foreground')
  assert.equal(f.item(plan).attempt, attempt + 1)
  assert.equal(f.store.offlineMediaReferences().length, 0)
  assert.equal(f.starts.length, 0)
  const paused = f.store.processingResources()
  f.store.setProcessingPaused({ revision: paused.revision, paused: false })
  f.service.changed()
  await until(() => f.starts.length === 1)
  assert.equal(f.downloads.length, 2)
  assert.equal(f.store.offlineMediaReferences().length, 1)
})

test('explicit retry of failed ASR reuses the same job and its saved partial transcript', async (t) => {
  const f = await fixture(t, { count: 1 }),
    plan = await f.create()
  f.service.start()
  await until(() => f.starts.length === 1)
  const job = f.store.getJob(f.starts[0]!.jobId)!
  f.store.setJobStatus(job.id, job.attempt, 'running')
  assert.equal(
    f.store.acceptJobSnapshot(
      job.id,
      job.attempt,
      {
        document: document(job.audioHash, 400, 'transcript'),
        processedUntilMs: 400,
        cacheKey: 'a'.repeat(64),
        cacheHits: 0,
        totalChunks: 2,
        issues: [],
      },
      1,
      false,
    ),
    true,
  )
  f.store.setJobStatus(job.id, job.attempt, 'failed', 'controlled worker failure')
  f.service.changed()
  await until(() => f.item(plan).status === 'failed')
  const saved = f.store.getTranscript(job.episodeId, job.audioHash)
  assert.equal(saved.status, 'ready')
  assert.equal(f.store.getJob(job.id)!.processedUntilMs, 400)
  const current = f.store.offlinePlan(plan.id)!
  await f.service.update({ id: current.id, revision: current.revision, action: 'retry-failed' })
  await until(() => f.starts.length === 2)
  assert.equal(f.starts[1]!.jobId, job.id)
  const retried = f.store.getJob(job.id)!
  assert.equal(retried.attempt, job.attempt + 1)
  assert.equal(retried.processedUntilMs, 400)
  assert.deepEqual(f.store.getTranscript(job.episodeId, job.audioHash), saved)
  f.finish(retried)
  await until(() => f.store.offlinePlan(plan.id)!.status === 'completed')
})

test('restart recovers interrupted attempts, preserves validated offline pins and invalidates changed cached files', async (t) => {
  const f = await fixture(t, { online: true }),
    plan = await f.create(),
    media = await f.mediaFile()
  f.store.retainOfflineMedia(f.context(plan), media)
  f.store.updateOfflineItem({ ...f.context(plan), patch: { durationMs: 1000 } })
  f.store.saveTranscript(f.episodes[0]!.id, document(media.contentHash))
  f.store.updateOfflineItem({ ...f.context(plan), patch: { status: 'ready' } })
  f.store.updateOfflineItem({ ...f.context(plan, 1), patch: { status: 'downloading' } })
  const attempt = f.item(plan, 1).attempt
  await f.reopen()
  await f.service.initialize()
  assert.equal(f.item(plan, 1).attempt, attempt + 1)
  assert.equal(f.item(plan, 1).status, 'queued')
  assert.equal(f.store.offlinePlan(plan.id)!.counts.audioReady, 1)
  assert.equal(f.store.offlinePlan(plan.id)!.counts.subtitleReady, 1)
  assert.equal(f.store.offlineRetainedFiles().length, 1)
  assert.ok(f.reconciliations > 0)
  await f.reopen()
  await writeFile(media.path, 'changed retained audio identity')
  await f.service.initialize()
  assert.equal(f.store.offlinePlan(plan.id)!.counts.audioReady, 0)
  assert.equal(f.item(plan).status, 'needs-attention')
  // Invalidating a file never silently releases offline data. Its old complete
  // identity remains pinned until the user explicitly cancels/ends and releases.
  assert.equal(f.store.offlineMediaReferences().length, 1)
  assert.equal(f.starts.length, 0)
  const current = f.store.offlinePlan(plan.id)!
  const canceled = await f.service.update({
    id: current.id,
    revision: current.revision,
    action: 'cancel',
  })
  f.service.release({ id: canceled.id, revision: canceled.revision })
  assert.equal(f.store.offlineMediaReferences().length, 0)
  assert.equal((await stat(media.path)).isFile(), true)
})
