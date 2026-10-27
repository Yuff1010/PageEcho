import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import type { LibraryStore, StoredTranscriptionJob } from '../../src/main/database'
import { OnlinePreparation } from '../../src/main/sources/online-preparation'
import type { OnlineMedia } from '../../src/main/sources/online-media'
import type { TranscriptionQueue } from '../../src/main/transcription-queue'
import type { Book, Episode } from '../../src/shared/contracts'
import type { StartTranscription, SubtitlePreparation } from '../../src/shared/transcription'

const ahead: SubtitlePreparation = {
  mode: 'ahead',
  engine: 'paraformer',
  device: 'cpu',
  prepareNext: true,
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 100 && !condition(); i++) await delay(5)
  assert.ok(condition(), 'expected preparation state was not reached')
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function setup(online = false, settings?: SubtitlePreparation) {
  const bookId = randomUUID()
  const episodes: Episode[] = Array.from({ length: 3 }, (_, index) => ({
    id: randomUUID(),
    bookId,
    title: `第 ${index + 1} 集`,
    order: index + 1,
    sizeBytes: 100,
    modifiedAt: 0,
    contentHash: String(index + 1).repeat(64),
    durationMs: 90000,
    positionMs: 0,
    ...(online
      ? {
          online: {
            sourceId: 'ting13' as const,
            bookId: 'book',
            episodeId: String(index + 1),
            cached: true,
          },
        }
      : {}),
  }))
  const book: Book = {
    id: bookId,
    title: '测试书',
    importedAt: '',
    lastPlayedAt: null,
    currentEpisodeId: null,
    introMs: 0,
    outroMs: 0,
    episodes,
    ...(settings ? { subtitlePreparation: { ...settings } } : {}),
    ...(online
      ? {
          online: {
            sourceId: 'ting13' as const,
            bookId: 'book',
            catalogComplete: true,
            preparation: {
              cacheNext: false,
              transcribeNext: false,
              engine: 'whisperx' as const,
              device: 'cpu' as const,
            },
          },
        }
      : {}),
  }
  const jobs = new Map<string, StoredTranscriptionJob>()
  const calls: { request: StartTranscription; background: boolean }[] = []
  const opened: { id: string; nextId?: string }[] = []
  const downloads: string[] = [],
    measurements: string[] = []
  let configured = true,
    notifications = 0
  let download = async (id: string) =>
    episodes.find(
      (episode) => episode.order === episodes.find((episode) => episode.id === id)!.order + 1,
    )
  let measure = async (id: string) => {
    measurements.push(id)
  }
  const store = {
    listBooks: () => [book],
    getEpisode: (id: string) => episodes.find((episode) => episode.id === id),
    latestJob: (id: string) => jobs.get(id) ?? null,
    getTranscript: () => ({ status: 'missing' }),
  } as unknown as LibraryStore
  const queue = {
    onEpisodeOpened: (id: string, nextId?: string) => {
      opened.push({ id, nextId })
    },
    prepare: (request: StartTranscription, background = false) => {
      if (!configured) throw new Error('请先配置本地组件。')
      calls.push({ request, background })
      if (!jobs.has(request.episodeId))
        jobs.set(request.episodeId, {
          id: randomUUID(),
          ...request,
          background,
          status: 'running',
          attempt: 1,
          stage: 'recognizing',
          processedUntilMs: 0,
          totalChunks: 3,
          completedChunks: 0,
          cacheHits: 0,
          issueCount: 0,
          autoApply: true,
          appliedRevision: 0,
          previewRevision: 0,
          hasPreview: false,
          createdAt: '',
          updatedAt: '',
          error: null,
          configurationHash: null,
          rangeEndMs: 90000,
        })
    },
  } as unknown as TranscriptionQueue
  const media = {
    cancelNext: () => {},
    setCurrent: () => {},
    prepareNext: async (id: string) => {
      downloads.push(id)
      return download(id)
    },
  } as unknown as OnlineMedia
  const preparation = new OnlinePreparation(
    store,
    media,
    queue,
    () => {
      notifications++
    },
    (id) => measure(id),
  )
  return {
    preparation,
    book,
    episodes,
    jobs,
    calls,
    opened,
    downloads,
    measurements,
    notifications: () => notifications,
    configure: (value: boolean) => {
      configured = value
    },
    setDownload: (value: typeof download) => {
      download = value
    },
    setMeasure: (value: typeof measure) => {
      measure = value
    },
  }
}

test('ahead preparation supports local books, publishes prefix progress, and queues the next episode behind current', async () => {
  const t = setup(false, ahead)
  try {
    t.preparation.opened(t.episodes[0]!.id, true)
    await until(() => t.calls.length === 2)
    assert.deepEqual(
      t.calls.map((call) => [call.request.episodeId, call.background]),
      [
        [t.episodes[0]!.id, false],
        [t.episodes[1]!.id, true],
      ],
    )
    assert.deepEqual(t.downloads, [])
    assert.deepEqual(t.opened, [{ id: t.episodes[0]!.id, nextId: t.episodes[1]!.id }])
    const current = t.jobs.get(t.episodes[0]!.id)!
    current.completedChunks = 1
    current.processedUntilMs = 30000
    t.preparation.changed(current)
    assert.equal(t.preparation.state().stage, 'transcribing')
    assert.match(t.preparation.state().message, /本集已生成 1\/3 段.*后台完成整集/)
    current.status = 'completed'
    t.preparation.changed(current)
    assert.match(t.preparation.state().message, /下一集字幕/)
    const next = t.jobs.get(t.episodes[1]!.id)!
    next.status = 'completed'
    t.preparation.changed(next)
    assert.equal(t.preparation.state().stage, 'ready')
  } finally {
    await t.preparation.close()
  }
})

test('restoring or opening a saved automatic book never starts ASR until playback activates it', async () => {
  for (const mode of ['auto', 'ahead'] as const) {
    const t = setup(false, { ...ahead, mode })
    try {
      t.preparation.opened(t.episodes[0]!.id)
      await until(() => t.opened.length === 1)
      t.preparation.componentChanged()
      await until(() => t.opened.length === 2)
      assert.equal(t.calls.length, 0)
      assert.equal(t.preparation.state().stage, 'idle')
      t.preparation.opened(t.episodes[0]!.id, true)
      await until(() => t.calls.length === 2)
      assert.equal(t.calls[0]!.request.episodeId, t.episodes[0]!.id)
      assert.equal(t.calls[1]!.background, true)
    } finally {
      await t.preparation.close()
    }
  }
})

test('saved manual strategy overrides legacy transcription while online audio caching remains independent', async () => {
  const t = setup(true, { ...ahead, mode: 'manual' })
  t.book.online!.preparation.transcribeNext = true
  t.book.online!.preparation.cacheNext = true
  try {
    t.preparation.opened(t.episodes[0]!.id, true)
    await until(() => t.preparation.state().stage === 'ready')
    assert.deepEqual(t.calls, [])
    assert.deepEqual(t.downloads, [t.episodes[0]!.id])
    assert.deepEqual(t.opened, [{ id: t.episodes[0]!.id, nextId: undefined }])
    assert.match(t.preparation.state().message, /音频已缓存/)
  } finally {
    await t.preparation.close()
  }
})

test('unsaved strategy retains legacy online preparation and measures the next file before scheduling ASR', async () => {
  const t = setup(true)
  t.book.online!.preparation.transcribeNext = true
  const duration = deferred<void>()
  t.setMeasure(async (id) => {
    t.measurements.push(id)
    await duration.promise
  })
  try {
    t.preparation.opened(t.episodes[0]!.id, true)
    await until(() => t.measurements.length === 1)
    assert.equal(t.calls.length, 1)
    assert.equal(t.calls[0]!.background, false)
    assert.deepEqual(t.downloads, [t.episodes[0]!.id])
    duration.resolve()
    await until(() => t.calls.length === 2)
    assert.equal(t.calls[1]!.background, true)
    assert.equal(t.calls[1]!.request.engine, 'whisperx')
  } finally {
    duration.resolve()
    await t.preparation.close()
  }
})

test('current-only ahead mode skips speculative audio and next-episode generation', async () => {
  const t = setup(true, { ...ahead, prepareNext: false })
  try {
    t.preparation.opened(t.episodes[0]!.id, true)
    await until(() => t.calls.length === 1)
    assert.deepEqual(t.downloads, [])
    assert.equal(t.preparation.state().nextEpisodeId, null)
  } finally {
    await t.preparation.close()
  }
})

test('component errors stay asynchronous, preserve independent caching, and recover after configuration', async () => {
  const t = setup(true, { ...ahead, prepareNext: false })
  t.book.online!.preparation.cacheNext = true
  t.configure(false)
  try {
    assert.doesNotThrow(() => t.preparation.opened(t.episodes[0]!.id, true))
    await until(() => t.downloads.length === 1)
    assert.equal(t.preparation.state().stage, 'failed')
    assert.match(t.preparation.state().message, /组件/)
    t.configure(true)
    t.preparation.componentChanged()
    await until(() => t.calls.length === 1)
    assert.equal(t.preparation.state().stage, 'transcribing')
    const job = t.jobs.get(t.episodes[0]!.id)!
    job.status = 'failed'
    job.error = '测试失败，可重试。'
    t.preparation.changed(job)
    assert.equal(t.preparation.state().stage, 'failed')
    assert.match(t.preparation.state().message, /本集字幕任务已停止.*测试失败/)
  } finally {
    await t.preparation.close()
  }
})

test('switching episodes ignores an old next download and shutdown waits for all owned preparation operations', async () => {
  const t = setup(true, ahead)
  const oldDownload = deferred<Episode | undefined>()
  t.setDownload(async (id) => (id === t.episodes[0]!.id ? oldDownload.promise : undefined))
  t.preparation.opened(t.episodes[0]!.id, true)
  await until(() => t.downloads.length === 1)
  t.preparation.opened(t.episodes[2]!.id, true)
  await until(() => t.calls.length === 2)
  let closed = false
  const closing = t.preparation.close().then(() => {
    closed = true
  })
  await delay(10)
  assert.equal(closed, false)
  oldDownload.resolve(t.episodes[1])
  await closing
  assert.equal(
    t.calls.some((call) => call.background),
    false,
  )
  const count = t.notifications()
  t.preparation.changed({ episodeId: t.episodes[0]!.id, audioHash: t.episodes[0]!.contentHash })
  t.preparation.opened(t.episodes[0]!.id, true)
  assert.equal(t.notifications(), count)
})
