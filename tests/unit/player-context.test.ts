import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Bookmark } from '../../src/shared/listening'
import type {
  DesktopApi,
  PlaybackSource,
  PlaybackSourceChange,
  ProgressUpdate,
  Result,
} from '../../src/shared/contracts'
import type { LibraryMutation, LibraryOverview, PlaybackContext } from '../../src/shared/library'

class AudioFixture extends EventTarget {
  src = ''
  preload = ''
  hidden = false
  currentTime = 0
  duration = 70
  playbackRate = 1
  volume = 1
  paused = true
  seeking = false
  ended = false
  readyState = 4
  loads = 0
  plays = 0
  buffered = { length: 1, start: () => 0, end: () => 70 }
  get currentSrc() {
    return this.src
  }
  setAttribute() {}
  removeAttribute(name: string) {
    if (name === 'src') this.src = ''
  }
  load() {
    this.loads++
  }
  async play() {
    this.plays++
    this.paused = false
    this.dispatchEvent(new Event('playing'))
  }
  pause() {
    if (!this.paused) {
      this.paused = true
      this.dispatchEvent(new Event('pause'))
    }
  }
  metadata() {
    this.dispatchEvent(new Event('loadedmetadata'))
  }
}
const nothing = () => () => {}
const stub = {
  onFlush: nothing,
  onTranscriptionChanged: nothing,
  onComponentChanged: nothing,
  onPlaybackSourceChanged: nothing,
}
const browser = { desktop: stub as unknown as DesktopApi, setInterval, clearInterval }
Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { createElement: () => new AudioFixture(), body: { append() {} } },
})
Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 1 })
const { PlayerController } = await import('../../src/renderer/src/player')
const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const failed = (): Result<never> => ({
  ok: false,
  error: { code: 'CONFLICT', message: 'Synthetic unavailable result' },
})
const flush = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve()
}
function deferred<T>() {
  let release!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
function context(
  episodeId: string,
  options: {
    bookId?: string
    order?: number
    hash?: string
    next?: string | null
    previous?: string | null
    online?: boolean
  } = {},
): PlaybackContext {
  const bookId = options.bookId ?? 'book-one'
  return {
    book: {
      id: bookId,
      title: '合成书籍 ' + bookId,
      importedAt: '2026-11-02T00:00:00.000Z',
      lastPlayedAt: null,
      currentEpisodeId: null,
      introMs: 2000,
      outroMs: 3000,
      subtitlePreparation: {
        mode: 'manual',
        engine: 'whisperx',
        device: 'cpu',
        prepareNext: false,
      },
      ...(options.online
        ? {
            online: {
              sourceId: 'ting13',
              bookId: 'source-book',
              catalogComplete: false,
              preparation: {
                cacheNext: false,
                transcribeNext: false,
                engine: 'whisperx',
                device: 'cpu',
              },
            },
          }
        : {}),
    },
    episode: {
      id: episodeId,
      bookId,
      title: '合成章节 ' + episodeId,
      order: options.order ?? 0,
      sizeBytes: 64000,
      modifiedAt: 1,
      contentHash: options.hash ?? 'a'.repeat(64),
      durationMs: 70000,
      positionMs: 12345,
    },
    previousEpisodeId: options.previous ?? null,
    nextEpisodeId: options.next ?? null,
  }
}
function fixture(...values: PlaybackContext[]) {
  const contexts = new Map(values.map((value) => [value.episode.id, value]))
  const opened: string[] = [],
    released: string[] = [],
    queried: string[] = [],
    saved: ProgressUpdate[] = [],
    events: LibraryMutation[] = []
  let sourceChanged: (change: PlaybackSourceChange) => void = () => {}
  let sessions = 0
  const api = {
    ...stub,
    onPlaybackSourceChanged: (callback: typeof sourceChanged) => {
      sourceChanged = callback
      return () => {}
    },
    getPlaybackContext: async ({
      episodeId,
    }: {
      episodeId: string
    }): Promise<Result<PlaybackContext | null>> => {
      queried.push(episodeId)
      return ok(structuredClone(contexts.get(episodeId) ?? null))
    },
    openEpisode: async ({ id }: { id: string }): Promise<Result<PlaybackSource>> => {
      opened.push(id)
      const value = contexts.get(id)
      if (!value) return failed()
      const fresh = structuredClone(value)
      return ok({
        sessionId: 'session-' + ++sessions,
        episode: fresh.episode,
        context: fresh,
        url: 'readlisten://app/synthetic/' + id,
      })
    },
    saveProgress: async (update: ProgressUpdate): Promise<Result<void>> => {
      saved.push(structuredClone(update))
      return ok(undefined)
    },
    releasePlayback: async ({ sessionId }: { sessionId: string }): Promise<Result<void>> => {
      released.push(sessionId)
      return ok(undefined)
    },
    cancelEpisodeOpen: async () => ok(undefined),
    getPlaybackSourceState: async () => ok(null),
    getTranscriptionSummary: async () => failed(),
    prioritizeTranscription: async () => ok(undefined),
    startAutomaticSubtitles: async ({
      episodeId,
    }: {
      episodeId: string
    }): ReturnType<DesktopApi['startAutomaticSubtitles']> =>
      ok({
        status: 'disabled' as const,
        settings: null,
        message: '',
        transcription: null,
        context: structuredClone(contexts.get(episodeId) ?? null),
        mutation: { changedBookIds: [], removedBookIds: [], filesChanged: false },
      }),
    continueSourceBook: async (): Promise<Result<LibraryMutation>> =>
      ok({ changedBookIds: [], removedBookIds: [], filesChanged: false }),
  }
  browser.desktop = api as unknown as DesktopApi
  const player = new PlayerController(),
    audio = player.audio as unknown as AudioFixture
  player.subscribeLibraryMutation((event) => events.push(event))
  const ready = async (id: string) => {
    await player.load(id, false)
    audio.metadata()
    await player.save()
    await flush()
  }
  return {
    player,
    audio,
    api,
    contexts,
    opened,
    released,
    queried,
    saved,
    events,
    ready,
    changed: (event: PlaybackSourceChange) => sourceChanged(event),
  }
}
const overview = (currentEpisodeId: string | null = null): LibraryOverview => ({
  version: 'synthetic',
  dataLocation: 'synthetic',
  files: [],
  books: [],
  currentEpisodeId,
  preferences: { rate: 1.25, volume: 0.37 },
})
function bookmark(episodeId: string, hash = 'a'.repeat(64)): Bookmark {
  return {
    id: 'bookmark',
    bookId: 'book-one',
    episodeId,
    audioHash: hash,
    episodeTitle: '合成章节',
    positionMs: 25000,
    note: '',
    createdAt: '2026-11-02T00:00:00.000Z',
    stale: false,
  }
}

test('overview initializes preferences once and shelf contents cannot replace a persistent session', async () => {
  const f = fixture(context('first'))
  f.player.initializeOverview(overview())
  await f.ready('first')
  const audio = f.audio,
    session = f.player.getSessionId(),
    loads = audio.loads
  f.player.initializeOverview({
    ...overview('removed-from-filter'),
    preferences: { rate: 3, volume: 1 },
  })
  await f.player.refreshContext(['unrelated-book'])
  assert.equal(f.player.audio, audio)
  assert.equal(f.player.getSessionId(), session)
  assert.equal(audio.loads, loads)
  assert.equal(f.player.getSnapshot().rate, 1.25)
  assert.equal(f.player.getSnapshot().volume, 0.37)
  assert.deepEqual(f.opened, ['first'])
  assert.deepEqual(f.queried, ['first'])
  await f.player.stop()
})

test('a late initial overview cannot restore history over an explicit newer user choice', async () => {
  const f = fixture(context('chosen'), context('history'))
  await f.ready('chosen')
  f.player.initializeOverview(overview('history'))
  await flush()
  assert.deepEqual(f.opened, ['chosen'])
  assert.equal(f.player.getSnapshot().episode?.id, 'chosen')
  await f.player.stop()
})

test('context refresh updates settings without resetting the media clock and confirms deletion or changed audio', async () => {
  const f = fixture(context('first'))
  await f.ready('first')
  f.audio.currentTime = 31
  const loads = f.audio.loads,
    url = f.audio.src
  f.contexts.get('first')!.book.title = '更新的书名'
  f.contexts.get('first')!.book.introMs = 5000
  f.contexts.get('first')!.episode.positionMs = 1
  await f.player.refreshContext()
  assert.equal(f.audio.currentTime, 31)
  assert.equal(f.audio.loads, loads)
  assert.equal(f.audio.src, url)
  assert.equal(f.player.getSnapshot().bookTitle, '更新的书名')
  f.api.getPlaybackContext = async () => failed()
  await f.player.refreshContext()
  assert.equal(f.player.getSnapshot().ready, true)
  f.api.getPlaybackContext = async () =>
    ok({
      ...context('first'),
      episode: { ...context('first').episode, contentHash: 'b'.repeat(64) },
    })
  await f.player.refreshContext()
  assert.equal(f.player.getSessionId(), null)
  assert.equal(f.audio.src, '')
  const other = fixture(context('deleted'))
  await other.ready('deleted')
  other.contexts.delete('deleted')
  await other.player.refreshContext()
  assert.equal(other.player.getSessionId(), null)
})

test('late context and open results cannot stop or replace a newer episode session', async () => {
  const f = fixture(context('first'), context('second'), context('slow'))
  await f.ready('first')
  const reply = deferred<Result<PlaybackContext | null>>(),
    realGet = f.api.getPlaybackContext
  f.api.getPlaybackContext = async ({ episodeId }) =>
    episodeId === 'first' ? reply.promise : realGet({ episodeId })
  const pending = f.player.refreshContext()
  await f.ready('second')
  const session = f.player.getSessionId()
  reply.release(ok(null))
  await pending
  assert.equal(f.player.getSessionId(), session)
  assert.equal(f.player.getSnapshot().episode?.id, 'second')
  const open = deferred<Result<PlaybackSource>>(),
    realOpen = f.api.openEpisode
  f.api.openEpisode = async ({ id }) => (id === 'slow' ? open.promise : realOpen({ id }))
  const slow = f.player.load('slow', false)
  await flush()
  await f.ready('second')
  open.release(
    ok({
      sessionId: 'late-session',
      url: 'late',
      context: context('slow'),
      episode: context('slow').episode,
    }),
  )
  await slow
  assert.equal(f.player.getSnapshot().episode?.id, 'second')
  assert(f.released.includes('late-session'))
  await f.player.stop()
})

test('bookmarks validate the actual opened audio identity without requiring a loaded shelf', async () => {
  const f = fixture(context('marked'))
  await f.player.openBookmark(bookmark('marked'))
  f.audio.metadata()
  await flush()
  assert.equal(f.audio.currentTime, 25)
  assert.deepEqual(f.opened, ['marked'])
  await f.player.stop()
  const changed = fixture(context('changed', { hash: 'b'.repeat(64) }))
  await changed.player.openBookmark(bookmark('changed'))
  assert.match(changed.player.getSnapshot().error, /旧音频版本/)
  assert.equal(changed.audio.src, '')
  assert.deepEqual(changed.released, ['session-1'])
  assert.equal(changed.player.getSessionId(), null)
  await changed.player.stop()
})

test('next follows real context neighbors across order gaps and duplicate orders', async () => {
  const f = fixture(
    context('zero', { order: 0, next: 'gap' }),
    context('gap', { order: 7, previous: 'zero', next: 'tie' }),
    context('tie', { order: 7, previous: 'gap' }),
  )
  await f.ready('zero')
  await f.player.next(1, false)
  f.audio.metadata()
  await flush()
  assert.equal(f.player.getSnapshot().episode?.id, 'gap')
  assert.equal(f.audio.currentTime, 2)
  await f.player.next(1, false)
  assert.equal(f.player.getSnapshot().episode?.id, 'tie')
  await f.player.next(-1, false)
  assert.equal(f.player.getSnapshot().episode?.id, 'gap')
  assert.deepEqual(f.opened, ['zero', 'gap', 'tie', 'gap'])
  await f.player.stop()
})

test('next remains available after an unreadable episode fails to open', async () => {
  const unavailable = context('missing', { next: 'available' })
  const available = context('available', { previous: 'missing' })
  const f = fixture(unavailable, available)
  const open = f.api.openEpisode
  f.api.openEpisode = async (request) => (request.id === 'missing' ? failed() : open(request))
  await f.player.load('missing', false)
  assert.match(f.player.getSnapshot().error, /unavailable/)
  await f.player.next(1, false)
  assert.deepEqual(f.opened, ['available'])
  assert.equal(f.player.getSnapshot().episode?.id, 'available')
  await f.player.stop()
})

test('an incomplete online catalog continues then rereads only the current context before advancing', async () => {
  const f = fixture(context('last', { online: true }), context('continued', { online: true }))
  f.api.continueSourceBook = async () => {
    f.contexts.get('last')!.nextEpisodeId = 'continued'
    return ok({
      changedBookIds: ['book-one'],
      removedBookIds: [],
      filesChanged: false,
      bookId: 'book-one',
      episodeId: 'last',
    })
  }
  await f.ready('last')
  await f.player.next(1, false)
  assert.equal(f.player.getSnapshot().episode?.id, 'continued')
  assert.deepEqual(f.queried, ['last', 'last', 'continued'])
  await f.player.stop()
})

test('late catalog continuation cannot autoplay after a newer choice', async () => {
  const f = fixture(context('last', { online: true }), context('newer', { bookId: 'another' }))
  const result = deferred<Result<LibraryMutation>>()
  f.api.continueSourceBook = () => result.promise
  await f.ready('last')
  const continuing = f.player.next(1, true)
  await f.ready('newer')
  result.release(ok({ changedBookIds: ['book-one'], removedBookIds: [], filesChanged: false }))
  await continuing
  assert.equal(f.player.getSnapshot().episode?.id, 'newer')
  assert.equal(f.audio.plays, 0)
  await f.player.stop()
})

test('explicit pause invalidates unresolved continuation without advancing or starting audio', async () => {
  const f = fixture(context('last', { online: true }), context('next', { online: true }))
  const result = deferred<Result<LibraryMutation>>()
  f.api.continueSourceBook = () => result.promise
  await f.ready('last')
  const continuing = f.player.next(1, true)
  f.player.pause()
  f.contexts.get('last')!.nextEpisodeId = 'next'
  result.release(ok({ changedBookIds: ['book-one'], removedBookIds: [], filesChanged: false }))
  await continuing
  assert.deepEqual(f.opened, ['last'])
  assert.equal(f.audio.plays, 0)
  assert.equal(f.player.getSnapshot().playing, false)
  await f.player.stop()
})

test('overlapping refreshes keep the latest context and a pre-ready cache entry cannot promote pending audio', async () => {
  const f = fixture(context('first'))
  await f.ready('first')
  const stale = deferred<Result<PlaybackContext | null>>(),
    fresh = context('first')
  fresh.book.title = '最新书名'
  let calls = 0
  f.api.getPlaybackContext = async () => (++calls === 1 ? stale.promise : ok(fresh))
  const old = f.player.refreshContext()
  await f.player.refreshContext()
  stale.release(ok(null))
  await old
  assert.equal(f.player.getSnapshot().bookTitle, '最新书名')
  assert(f.player.getSessionId())
  await f.player.stop()
  const pending = fixture(context('pending', { hash: '' }))
  const realOpen = pending.api.openEpisode
  pending.api.openEpisode = async ({ id }) => {
    const result = await realOpen({ id })
    return result.ok
      ? ok({ ...result.value, pending: { receivedBytes: 32768, totalBytes: 64000 } })
      : result
  }
  await pending.ready('pending')
  pending.contexts.set('pending', context('pending'))
  await pending.player.refreshContext()
  assert.equal(pending.player.getSnapshot().episode?.contentHash, '')
  assert(pending.player.getSnapshot().audioPending)
  assert.equal(pending.player.getContext()?.episode.contentHash, '')
  await pending.player.stop()
})

test('late automatic subtitle replies cannot replace a newer context or emit stale library updates', async () => {
  const f = fixture(context('first'), context('second'))
  await f.ready('first')
  const reply = deferred<Awaited<ReturnType<typeof f.api.startAutomaticSubtitles>>>()
  f.api.startAutomaticSubtitles = () => reply.promise
  const preparing = f.player.prepareSubtitles(true)
  await f.ready('second')
  const count = f.events.length
  reply.release(
    ok({
      status: 'disabled',
      settings: null,
      transcription: null,
      message: '',
      context: context('first'),
      mutation: { changedBookIds: ['book-one'], removedBookIds: [], filesChanged: false },
    }),
  )
  assert.equal(await preparing, null)
  assert.equal(f.player.getSnapshot().episode?.id, 'second')
  assert.equal(f.events.length, count)
  await f.player.stop()
})

test('progressive ready transfers the authenticated identity on the same media URL and ignores older sessions', async () => {
  const f = fixture(context('pending', { hash: '' }))
  const realOpen = f.api.openEpisode
  f.api.openEpisode = async ({ id }) => {
    const value = await realOpen({ id })
    return value.ok
      ? ok({ ...value.value, pending: { receivedBytes: 32768, totalBytes: 64000 } })
      : value
  }
  await f.ready('pending')
  f.audio.currentTime = 34
  const loads = f.audio.loads,
    url = f.audio.src,
    sessionId = f.player.getSessionId()!
  f.changed({
    status: 'ready',
    sessionId: 'old',
    episodeId: 'pending',
    episode: context('pending').episode,
    context: context('pending'),
  })
  assert.equal(f.player.getSnapshot().episode?.contentHash, '')
  f.contexts.set('pending', context('pending'))
  f.changed({
    status: 'ready',
    sessionId,
    episodeId: 'pending',
    episode: context('pending').episode,
    context: context('pending'),
  })
  await flush()
  assert.equal(f.player.getSnapshot().episode?.contentHash, 'a'.repeat(64))
  assert.equal(f.player.getSessionId(), sessionId)
  assert.equal(f.audio.src, url)
  assert.equal(f.audio.loads, loads)
  assert.equal(f.audio.currentTime, 34)
  assert.equal(f.player.getSnapshot().audioPending, null)
  await f.player.stop()
})

test('successful progress saves emit a bounded receipt and update context without fetching shelf or metadata', async () => {
  const f = fixture(context('first'))
  const receipts: import('../../src/renderer/src/player').PlayerLibraryMutation[] = []
  f.player.subscribeLibraryMutation((value) => receipts.push(value))
  await f.ready('first')
  const calls = f.queried.length
  f.audio.currentTime = 22
  f.player.setRate(1.5)
  f.player.setVolume(0.4)
  await f.player.save()
  const receipt = receipts.at(-1)!
  assert.deepEqual(receipt.changedBookIds, ['book-one'])
  assert.deepEqual(receipt.removedBookIds, [])
  assert.equal(receipt.filesChanged, false)
  assert.equal(receipt.progress?.positionMs, 22000)
  assert.equal(receipt.progress?.rate, 1.5)
  assert.equal(receipt.progress?.volume, 0.4)
  assert.equal(f.player.getContext()?.episode.positionMs, 22000)
  assert.equal(f.queried.length, calls)
  assert.equal('books' in receipt, false)
  await f.player.stop()
})

test('a slow successful save completes persistence but cannot publish old progress after a newer selection', async () => {
  const f = fixture(context('first'), context('second', { bookId: 'other-book' }))
  const receipts: import('../../src/renderer/src/player').PlayerLibraryMutation[] = []
  f.player.subscribeLibraryMutation((value) => receipts.push(value))
  await f.ready('first')
  const gate = deferred<Result<void>>(),
    originalSave = f.api.saveProgress
  let calls = 0
  f.api.saveProgress = async (update) => {
    if (++calls === 1) {
      const result = await gate.promise
      if (!result.ok) return result
    }
    return originalSave(update)
  }
  f.audio.currentTime = 30
  const saving = f.player.save()
  await flush()
  const receiptStart = receipts.length,
    selecting = f.player.load('second', false)
  gate.release(ok(undefined))
  await saving
  await selecting
  assert.equal(f.player.getSnapshot().episode?.id, 'second')
  assert(f.saved.some((update) => update.episodeId === 'first' && update.positionMs === 30000))
  assert(receipts.slice(receiptStart).some((value) => value.changedBookIds.includes('book-one')))
  assert(!receipts.slice(receiptStart).some((value) => value.progress?.episodeId === 'first'))
  f.audio.metadata()
  await f.player.save()
  assert.equal(receipts.at(-1)?.progress?.episodeId, 'second')
  await f.player.stop()
})

test('a stale automatic subtitle response cannot stop the same recording after manual work supersedes it', async () => {
  const f = fixture(context('first'))
  await f.ready('first')
  await f.player.play()
  const source = f.audio.src
  f.api.startAutomaticSubtitles = async () =>
    ok({
      status: 'stale',
      settings: null,
      message: 'Superseded by manual work',
      transcription: null,
      context: null,
      mutation: { changedBookIds: [], removedBookIds: [], filesChanged: false },
    })
  await f.player.prepareSubtitles(true)
  assert.equal(f.audio.src, source)
  assert.equal(f.audio.paused, false)
  assert.equal(f.player.getSnapshot().episode?.id, 'first')
  assert.equal(f.released.length, 0)
  await f.player.stop()
})
