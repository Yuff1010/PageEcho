// Synthetic ID3-shaped bytes exercise cache/session semantics, not MP3 decoding.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, stat, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import type { DatabaseSync } from 'node:sqlite'
import { LibraryStore } from '../../src/main/database'
import { OnlineMedia, type OnlinePlayback } from '../../src/main/sources/online-media'
import type {
  ProgressiveMedia,
  ProgressiveMediaSession,
} from '../../src/main/sources/progressive-media'
import type { SourceAdapter, SourceBook, SourceEpisode } from '../../src/shared/sources'
import type { PendingOnlineProof } from '../../src/shared/pending-online-progress'

const FIRST = 32 * 1024
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function synthetic(bytes = 128 * 1024, value = 42) {
  const body = Buffer.alloc(bytes, value)
  body.write('ID3')
  return body
}
function staged(body: Buffer, first = Math.min(FIRST, body.length), knownLength = true) {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let signal: AbortSignal | undefined
  let stopped = false,
    closed = false
  let began!: () => void
  const started = new Promise<void>((resolve) => {
    began = resolve
  })
  const abort = () => {
    if (stopped || closed) return
    stopped = true
    controller!.error(new Error('synthetic request aborted'))
  }
  return {
    started,
    get aborted() {
      return stopped
    },
    get closed() {
      return closed
    },
    response(requestSignal: AbortSignal) {
      signal = requestSignal
      return new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value
            controller.enqueue(body.subarray(0, first))
            signal!.addEventListener('abort', abort, { once: true })
            if (signal!.aborted) abort()
            began()
          },
          cancel() {
            stopped = true
            signal?.removeEventListener('abort', abort)
          },
        }),
        {
          headers: {
            'Content-Type': 'audio/mpeg',
            ...(knownLength ? { 'Content-Length': String(body.length) } : {}),
          },
        },
      )
    },
    finish() {
      assert(controller && !stopped && !closed)
      if (first < body.length) controller.enqueue(body.subarray(first))
      closed = true
      signal?.removeEventListener('abort', abort)
      controller.close()
    },
    truncate() {
      assert(controller && !stopped && !closed)
      closed = true
      signal?.removeEventListener('abort', abort)
      controller.close()
    },
    fail() {
      assert(controller && !stopped && !closed)
      stopped = true
      signal?.removeEventListener('abort', abort)
      controller.error(new Error('synthetic response body failure'))
    },
  }
}
const book: SourceBook = {
  sourceId: 'ting13',
  id: '39941',
  title: '合成渐进播放测试',
  authors: [],
  narrators: [],
  description: 'Synthetic test metadata; no remote requests.',
  pageUrl: 'https://www.ting13.cc/youshengxiaoshuo/39941/',
}
const catalog: SourceEpisode[] = [1, 2].map((order) => ({
  sourceId: 'ting13',
  bookId: book.id,
  id: `39941_1_${order}`,
  order,
  title: `第${order}集`,
  pageUrl: `https://www.ting13.cc/play/39941_1_${order}.html`,
}))
const adapter: SourceAdapter = {
  id: 'ting13',
  search: async () => {
    throw Error('unused')
  },
  getBook: async () => book,
  getEpisodes: async () => ({ items: catalog, nextCursor: null }),
  resolveAudio: async (_book, id) => ({
    sourceId: 'ting13',
    episodeId: id,
    url: 'https://car-lv.kuwo.cn/synthetic.mp3',
    pageUrl: `https://www.ting13.cc/play/${id}.html`,
    headers: { Referer: `https://www.ting13.cc/play/${id}.html` },
    expiresAt: null,
  }),
}
async function fixture(request: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), 'ralb-online-progressive-')),
    filename = join(root, 'library.sqlite3'),
    directory = join(root, 'cache')
  let store = new LibraryStore(filename)
  const bookId = store.rememberSourceBook(book, catalog, true),
    ids = store.listBooks()[0]!.episodes.map((episode) => episode.id)
  const make = (fetcher: typeof fetch) =>
    new OnlineMedia(store, adapter, directory, () => {}, fetcher, 5000)
  let media = make(request)
  return {
    filename,
    directory,
    bookId,
    ids,
    get store() {
      return store
    },
    get media() {
      return media
    },
    async restart(fetcher: typeof fetch) {
      await media.close()
      store.close()
      store = new LibraryStore(filename)
      media = make(fetcher)
    },
    async close() {
      await media.close()
      store.close()
    },
  }
}
async function written(directory: string, bytes: number) {
  const deadline = Date.now() + 3000
  do {
    const files = await readdir(directory).catch(() => [])
    for (const file of files)
      if (file.endsWith('.part') && (await stat(join(directory, file))).size >= bytes) return
    await delay(2)
  } while (Date.now() < deadline)
  assert.fail('Synthetic prefix was not written within the test budget')
}
function save(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  sessionId: string,
  positionMs = 4200,
) {
  const proof = f.media.playbackProof(sessionId)
  assert(proof)
  f.store.savePendingOnlineProgress(
    { episodeId: id, sessionId, positionMs, durationMs: 20000, rate: 1.5, volume: 0.3 },
    proof,
  )
  return proof
}
function progressive(value: OnlinePlayback) {
  assert.equal(value.kind, 'progressive')
  if (value.kind !== 'progressive') throw Error('Expected provisional playback')
  return value
}

test(
  'a written prefix exposes playback from one GET without StoredAudio, then full SHA and saved position commit together',
  { timeout: 10000 },
  async () => {
    const body = synthetic(),
      transfer = staged(body),
      proofs: PendingOnlineProof[] = []
    let requests = 0
    const f = await fixture(async (_url, options) => {
      requests++
      assert.equal(options?.method ?? 'GET', 'GET')
      assert.equal(new Headers(options?.headers).get('range'), null)
      assert.equal(options?.redirect, 'manual')
      return transfer.response(options!.signal!)
    })
    const id = f.ids[0]!,
      session = randomUUID()
    try {
      const result = progressive(
        await f.media.preparePlayback(id, session, (proof) => proofs.push({ ...proof })),
      )
      assert.equal(transfer.closed, false)
      assert.equal(f.store.getAudio(id), undefined)
      assert.equal(f.store.getEpisode(id)!.contentHash, '')
      assert.equal(f.store.getEpisode(id)!.online!.cached, false)
      assert.equal(f.media.currentBusy, true)
      const proof = save(f, id, session)
      assert.equal(proof.bytes, FIRST)
      assert.equal(proof.sha256, digest(body.subarray(0, FIRST)))
      assert.equal(proof.totalBytes, body.length)
      assert(proofs.length > 0)
      const response = await f.media.servePlayback(
        new Request(result.stream.url, { headers: { Range: 'bytes=0-31' } }),
        'https://renderer.example',
      )
      assert.equal(response.status, 206)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), body.subarray(0, 32))
      transfer.finish()
      const audio = await result.completed
      assert.equal(audio.contentHash, digest(body))
      assert.equal(f.store.getAudio(id)!.contentHash, digest(body))
      assert.equal(f.store.getEpisode(id)!.positionMs, 4200)
      assert.equal(f.store.getPendingOnlineProgress(id), null)
      assert.deepEqual(await readFile(audio.path), body)
      assert.equal(result.stream.state, 'complete')
      const afterRename = await f.media.servePlayback(
        new Request(result.stream.url, { headers: { Range: 'bytes=-24' } }),
        'https://renderer.example',
      )
      assert.deepEqual(Buffer.from(await afterRename.arrayBuffer()), body.subarray(-24))
      assert.equal(requests, 1)
    } finally {
      await f.close()
    }
  },
)

test(
  'cancel preserves prefix proof and position across restart; reopening waits for a complete matching response before restoring',
  { timeout: 10000 },
  async () => {
    const body = synthetic(),
      first = staged(body),
      second = staged(body)
    const f = await fixture(async (_url, options) => first.response(options!.signal!)),
      id = f.ids[0]!,
      session = randomUUID()
    try {
      const initial = progressive(await f.media.preparePlayback(id, session, () => {}))
      const prior = save(f, id, session, 7300)
      const canceled = assert.rejects(initial.completed, { code: 'SOURCE_CANCELED' })
      await f.media.releasePlayback(session)
      await canceled
      assert.equal(first.aborted, true)
      assert.equal(f.store.getAudio(id), undefined)
      assert.equal(f.store.getPendingOnlineProgress(id)!.positionMs, 7300)
      assert.deepEqual(await readdir(f.directory), [])
      await f.restart(async (_url, options) => second.response(options!.signal!))
      assert.deepEqual(f.store.getPendingOnlineProgress(id)!.proof, prior)
      const next = randomUUID(),
        notifications: PendingOnlineProof[] = []
      const reopening = f.media.preparePlayback(id, next, (proof) => notifications.push(proof))
      await second.started
      await written(f.directory, FIRST)
      assert.equal(f.store.getAudio(id), undefined)
      assert.equal(notifications.length, 0)
      second.finish()
      const restored = await reopening
      assert.equal(restored.kind, 'complete')
      assert.equal(f.store.getEpisode(id)!.positionMs, 7300)
      assert.equal(f.store.getPendingOnlineProgress(id), null)
      assert.equal(f.store.getAudio(id)!.contentHash, digest(body))
    } finally {
      await f.close()
    }
  },
)

test(
  'changed prefix, changed total length and a new entity shorter than the old prefix discard pending position',
  { timeout: 15000 },
  async () => {
    const original = synthetic()
    for (const replacement of [
      synthetic(original.length, 91),
      Buffer.concat([original, Buffer.alloc(123, 9)]),
      synthetic(16 * 1024),
    ]) {
      const first = staged(original),
        second = staged(replacement)
      let requests = 0
      const f = await fixture(async (_url, options) =>
        (++requests === 1 ? first : second).response(options!.signal!),
      )
      const id = f.ids[0]!,
        session = randomUUID()
      try {
        const initial = progressive(await f.media.preparePlayback(id, session, () => {}))
        save(f, id, session, 8800)
        const canceled = assert.rejects(initial.completed, { code: 'SOURCE_CANCELED' })
        await f.media.releasePlayback(session)
        await canceled
        const reopening = f.media.preparePlayback(id, randomUUID(), () =>
          assert.fail('Pending resumes must not expose a fresh stream'),
        )
        await second.started
        await written(f.directory, Math.min(FIRST, replacement.length))
        second.finish()
        assert.equal((await reopening).kind, 'complete')
        assert.equal(f.store.getAudio(id)!.contentHash, digest(replacement))
        assert.equal(f.store.getEpisode(id)!.positionMs, 0)
        assert.equal(f.store.getEpisode(id)!.durationMs, null)
        assert.equal(f.store.getPendingOnlineProgress(id), null)
        assert.equal(requests, 2)
      } finally {
        await f.close()
      }
    }
  },
)

test(
  'a shorter complete background cache is accepted on reopening without binding the old pending position or fetching again',
  { timeout: 10000 },
  async () => {
    const first = staged(synthetic()),
      replacement = synthetic(16 * 1024)
    let requests = 0
    const f = await fixture(async (_url, options) => {
      if (++requests === 1) return first.response(options!.signal!)
      return new Response(replacement, {
        headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(replacement.length) },
      })
    })
    const id = f.ids[0]!,
      session = randomUUID()
    try {
      const initial = progressive(await f.media.preparePlayback(id, session, () => {}))
      save(f, id, session)
      const canceled = assert.rejects(initial.completed, { code: 'SOURCE_CANCELED' })
      await f.media.releasePlayback(session)
      await canceled
      await f.media.prepare(id)
      assert(f.store.getPendingOnlineProgress(id))
      const result = await f.media.preparePlayback(id, randomUUID(), () =>
        assert.fail('Complete cache should not be streamed'),
      )
      assert.equal(result.kind, 'complete')
      assert.equal(f.store.getAudio(id)!.contentHash, digest(replacement))
      assert.equal(f.store.getEpisode(id)!.positionMs, 0)
      assert.equal(f.store.getPendingOnlineProgress(id), null)
      assert.equal(requests, 2)
    } finally {
      await f.close()
    }
  },
)

test(
  'ahead subtitle preference waits for complete audio even when a sufficient prefix has arrived',
  { timeout: 10000 },
  async () => {
    const body = synthetic(),
      transfer = staged(body)
    const f = await fixture(async (_url, options) => transfer.response(options!.signal!)),
      id = f.ids[0]!
    try {
      f.store.setSubtitlePreparation(f.bookId, {
        mode: 'ahead',
        engine: 'whisperx',
        device: 'cpu',
        prepareNext: false,
      })
      const result = f.media.preparePlayback(id, randomUUID(), () =>
        assert.fail('Ahead mode must not expose a progressive source'),
      )
      await transfer.started
      await written(f.directory, FIRST)
      assert.equal(f.store.getAudio(id), undefined)
      transfer.finish()
      const complete = await result
      assert.equal(complete.kind, 'complete')
      assert.equal(f.store.getAudio(id)!.contentHash, digest(body))
    } finally {
      await f.close()
    }
  },
)

test(
  'same-episode replacement drains the first response; an old release or save cannot cancel or overwrite its new session',
  { timeout: 10000 },
  async () => {
    const body = synthetic(),
      first = staged(body),
      second = staged(body)
    let requests = 0
    const f = await fixture(async (_url, options) =>
      (++requests === 1 ? first : second).response(options!.signal!),
    )
    const id = f.ids[0]!,
      old = randomUUID(),
      current = randomUUID()
    try {
      const initial = progressive(await f.media.preparePlayback(id, old, () => {}))
      const canceled = assert.rejects(initial.completed, { code: 'SOURCE_CANCELED' })
      const replacement = progressive(await f.media.preparePlayback(id, current, () => {}))
      await canceled
      assert.equal(first.aborted, true)
      const currentProof = save(f, id, current, 6100)
      await f.media.releasePlayback(old)
      assert.equal(second.aborted, false)
      assert.deepEqual(f.media.playbackProof(current), currentProof)
      assert.throws(
        () =>
          f.store.savePendingOnlineProgress(
            {
              episodeId: id,
              sessionId: old,
              positionMs: 50,
              durationMs: 20000,
              rate: 1,
              volume: 1,
            },
            currentProof,
          ),
        { code: 'INVALID_REQUEST' },
      )
      second.finish()
      await replacement.completed
      assert.equal(f.store.getEpisode(id)!.positionMs, 6100)
      assert.equal(f.store.getAudio(id)!.contentHash, digest(body))
      assert.equal(requests, 2)
    } finally {
      await f.close()
    }
  },
)

test(
  'response failure and truncation after early playback leave no registered audio or partial files and preserve pending evidence',
  { timeout: 10000 },
  async () => {
    for (const failure of ['error', 'truncated'] as const) {
      const transfer = staged(synthetic())
      const f = await fixture(async (_url, options) => transfer.response(options!.signal!)),
        id = f.ids[0]!,
        session = randomUUID()
      try {
        const result = progressive(await f.media.preparePlayback(id, session, () => {}))
        const prior = save(f, id, session, 5100)
        const rejected = assert.rejects(result.completed, { code: 'SOURCE_MEDIA_UNAVAILABLE' })
        if (failure === 'error') transfer.fail()
        else transfer.truncate()
        await rejected
        assert.equal(f.store.getAudio(id), undefined)
        assert.equal(f.store.getEpisode(id)!.contentHash, '')
        assert.equal(f.store.getEpisode(id)!.online!.cached, false)
        assert.equal(f.store.getPendingOnlineProgress(id)!.positionMs, 5100)
        assert.deepEqual(f.store.getPendingOnlineProgress(id)!.proof, prior)
        assert.deepEqual(await readdir(f.directory), [])
        assert.equal(result.stream.state, 'failed')
      } finally {
        await f.close()
      }
    }
  },
)

test(
  'unknown content length uses complete-file fallback rather than inventing a stream size',
  { timeout: 10000 },
  async () => {
    const body = synthetic(),
      transfer = staged(body, FIRST, false)
    const f = await fixture(async (_url, options) => transfer.response(options!.signal!)),
      id = f.ids[0]!
    try {
      const result = f.media.preparePlayback(id, randomUUID(), () =>
        assert.fail('Unknown-length response must not expose partial identity'),
      )
      await transfer.started
      await written(f.directory, FIRST)
      assert.equal(f.store.getAudio(id), undefined)
      transfer.finish()
      assert.equal((await result).kind, 'complete')
      assert.equal(f.store.getAudio(id)!.contentHash, digest(body))
    } finally {
      await f.close()
    }
  },
)

test(
  'a pending-transfer database failure rolls back full cache registration and preserves the exact saved snapshot',
  { timeout: 10000 },
  async () => {
    const transfer = staged(synthetic())
    const f = await fixture(async (_url, options) => transfer.response(options!.signal!)),
      id = f.ids[0]!,
      session = randomUUID()
    try {
      const result = progressive(await f.media.preparePlayback(id, session, () => {}))
      save(f, id, session, 4700)
      const saved = f.store.getPendingOnlineProgress(id)
      const db = Reflect.get(f.store, 'db') as DatabaseSync
      db.exec(`CREATE TRIGGER fail_progressive_commit BEFORE DELETE ON online_pending_progress
      BEGIN SELECT RAISE(ABORT,'synthetic transfer failure'); END;`)
      const rejected = assert.rejects(result.completed, { code: 'SOURCE_MEDIA_UNAVAILABLE' })
      transfer.finish()
      await rejected
      assert.equal(f.store.getAudio(id), undefined)
      assert.equal(f.store.sourceCacheFiles().length, 0)
      assert.equal(f.store.getEpisode(id)!.online!.cached, false)
      assert.deepEqual(f.store.getPendingOnlineProgress(id), saved)
      assert.deepEqual(await readdir(f.directory), [])
    } finally {
      await f.close()
    }
  },
)

test(
  'canceling after a spool handle opens but before create returns drains the handle and never offers or leaks a session',
  { timeout: 15000 },
  async (context) => {
    let transfer = staged(synthetic()),
      requests = 0
    const f = await fixture(async (_url, options) => {
      requests++
      return transfer.response(options!.signal!)
    })
    const id = f.ids[0]!,
      registry = Reflect.get(f.media, 'streams') as ProgressiveMedia
    const create = registry.create.bind(registry)
    try {
      // More cancellations than the registry's 16-session limit prove that the
      // real create path releases its capacity as well as the public URL.
      for (let attempt = 0; attempt < 18; attempt++) {
        transfer = staged(synthetic())
        let unlock!: () => void, acquired!: (value: ProgressiveMediaSession) => void
        const gate = new Promise<void>((resolve) => {
          unlock = resolve
        })
        const opened = new Promise<ProgressiveMediaSession>((resolve) => {
          acquired = resolve
        })
        const wrapped = context.mock.method(
          registry,
          'create',
          async (...args: Parameters<ProgressiveMedia['create']>) => {
            const session = await create(...args)
            acquired(session) // The actual read-only file handle is already open.
            await gate
            return session
          },
        )
        const sessionId = randomUUID()
        const opening = f.media.preparePlayback(id, sessionId, () =>
          assert.fail('Canceled create must not publish progress'),
        )
        try {
          const created = await Promise.race([
            opened,
            opening.then(() => assert.fail('Playback escaped the creation gate')),
          ])
          const file = Reflect.get(created, 'file') as FileHandle
          assert((await file.stat()).isFile())
          const rejected = assert.rejects(opening, { code: 'SOURCE_CANCELED' })
          let drained = false
          const releasing = f.media.releasePlayback(sessionId).then(() => {
            drained = true
          })
          assert.equal(transfer.aborted, true)
          assert.equal(drained, false)
          unlock()
          await releasing
          await rejected
          assert.equal(created.state, 'closed')
          await assert.rejects(file.stat(), { code: 'EBADF' })
          const missing = await registry.serve(new Request(created.url), 'https://renderer.example')
          assert.equal(missing.status, 404)
          assert.equal(f.media.playbackProof(sessionId), null)
          assert.equal(f.store.getAudio(id), undefined)
          assert.equal(f.store.getPendingOnlineProgress(id), null)
          assert.deepEqual(await readdir(f.directory), [])
        } finally {
          unlock()
          await f.media.releasePlayback(sessionId)
          wrapped.mock.restore()
        }
      }
      transfer = staged(synthetic())
      const final = progressive(await f.media.preparePlayback(id, randomUUID(), () => {}))
      transfer.finish()
      assert.equal((await final.completed).contentHash, digest(synthetic()))
      assert.equal(requests, 19)
    } finally {
      await f.close()
    }
  },
)
