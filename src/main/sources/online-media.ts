import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, realpath, rename, stat, statfs, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { LibraryStore, StoredAudio } from '../database'
import { checkAudio } from '../media'
import { AppError } from '../../shared/validation'
import {
  isPluginSourceId,
  SourceError,
  type SourceAdapter,
  type SourceId,
} from '../../shared/sources'
import type { Episode } from '../../shared/contracts'
import type { SourceCache } from './source-cache'
import type { OfflineSelection } from '../../shared/offline'
import { continueSourceCatalog } from './source-continuation'
import { SourceOperations } from './source-browser'
import { AudioSourceRegistry } from './source-registry'
import { audioSourceMediaUrl, audioSourcePageUrl } from './source-policy'
import { ProgressiveMedia, type ProgressiveMediaSession } from './progressive-media'
import type {
  PendingOnlinePosition,
  PendingOnlineProof,
} from '../../shared/pending-online-progress'

const MAX_BYTES = 256 * 1024 * 1024
const RESERVE_BYTES = 32 * 1024 * 1024
const FIRST_PLAYBACK_BYTES = 32 * 1024

export interface OfflineMediaContext {
  planId: string
  itemId: string
  planRevision: number
  attempt: number
}
type RequestKind = 'current' | 'next' | 'maintenance' | 'plan'

export type OnlinePlayback =
  | { kind: 'complete'; audio: StoredAudio }
  | { kind: 'progressive'; stream: ProgressiveMediaSession; completed: Promise<StoredAudio> }
interface PlaybackDownload {
  sessionId: string
  leased: boolean
  resume: PendingOnlinePosition | null
  allowStream: boolean
  stream?: ProgressiveMediaSession
  proof?: PendingOnlineProof
  done?: Promise<StoredAudio>
  ready(stream: ProgressiveMediaSession): void
  progress(proof: PendingOnlineProof): void
}

async function prefixProof(
  path: string,
  bytes: number,
  totalBytes: number,
  signal: AbortSignal,
): Promise<PendingOnlineProof> {
  const hash = createHash('sha256')
  let received = 0
  for await (const chunk of createReadStream(path, { start: 0, end: bytes - 1, signal })) {
    received += chunk.length
    hash.update(chunk)
  }
  return { bytes: received, sha256: hash.digest('hex'), totalBytes }
}

async function digest(path: string, signal?: AbortSignal) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path, { signal })) hash.update(bytes)
  return hash.digest('hex')
}

// Complete, hash-bound files feed the existing Range protocol and ASR queue.
// The renderer supplies only a library UUID; temporary provider URLs stay in memory.
export class OnlineMedia {
  private readonly requests: SourceOperations
  private readonly streams: ProgressiveMedia
  private readonly playback = new Map<string, PlaybackDownload>()
  private readonly statistics = new Set<Promise<unknown>>()
  private closed = false
  private active:
    | {
        episodeId: string
        requestId: string
        kind: RequestKind
        owner?: string
        done: Promise<unknown>
      }
    | undefined
  private currentEpisodeId: string | null = null
  constructor(
    private readonly store: LibraryStore,
    private readonly adapters: SourceAdapter | AudioSourceRegistry,
    private readonly directory: string,
    closeLoader: () => void,
    private readonly request: typeof fetch = (input, init) => globalThis.fetch(input, init),
    private readonly timeoutMs = 120000,
    private readonly cache?: SourceCache,
    private readonly mutateCache: <T>(action: () => Promise<T>) => Promise<T> = (action) =>
      action(),
  ) {
    this.requests = new SourceOperations(closeLoader)
    this.streams = new ProgressiveMedia(directory)
  }

  private adapter(sourceId: SourceId): SourceAdapter {
    if (this.adapters instanceof AudioSourceRegistry) return this.adapters.get(sourceId).adapter
    if (this.adapters.id !== sourceId)
      throw new SourceError('INVALID_SOURCE_REQUEST', '在线音频来源与已保存的章节不一致。')
    return this.adapters
  }

  cancel(id: string) {
    if (this.active?.episodeId === id) this.requests.cancel(this.active.requestId)
  }
  async close() {
    this.closed = true
    await Promise.all([this.requests.close(), this.streams.close()])
    for (const id of this.playback.keys()) this.store.endPendingOnlinePlayback(id)
    this.playback.clear()
    if (this.adapters instanceof AudioSourceRegistry) await this.adapters.close()
    await Promise.allSettled([...this.statistics])
  }
  setCurrent(id: string) {
    this.currentEpisodeId = id
  }
  get protectedEpisodeIds(): string[] {
    return [this.currentEpisodeId, this.active?.episodeId].filter((id): id is string => !!id)
  }
  get currentBusy() {
    return this.active?.kind === 'current'
  }
  cancelNext() {
    if (this.active?.kind === 'next') this.requests.cancel(this.active.requestId)
  }
  async cancelOffline(itemId: string): Promise<void> {
    const active = this.active
    if (active?.kind !== 'plan' || active.owner !== itemId) return
    this.requests.cancel(active.requestId)
    await active.done.catch(() => undefined)
  }
  private run<T>(
    id: string,
    kind: RequestKind,
    action: (signal: AbortSignal) => Promise<T>,
    owner?: string,
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(new SourceError('SOURCE_CANCELED', '在线音频服务已关闭。'))
    if (
      kind !== 'current' &&
      this.active &&
      (['current', 'maintenance'].includes(this.active.kind) ||
        (this.active.kind === 'plan' && ['plan', 'next'].includes(kind)))
    )
      return Promise.reject(new SourceError('SOURCE_BUSY', '当前集正在获取，请稍后重试。'))
    const requestId = randomUUID()
    const active = {
      episodeId: id,
      requestId,
      kind,
      owner,
      done: Promise.resolve() as Promise<unknown>,
    }
    this.active = active
    const operation = this.requests.run(requestId, action).finally(() => {
      if (this.active?.requestId === requestId) this.active = undefined
    })
    active.done = operation
    return operation
  }
  continueAfter(id: string): Promise<void> {
    return this.run(id, 'current', (signal) => this.extend(id, signal))
  }
  private async extend(id: string, canceled: AbortSignal) {
    const deadline = AbortSignal.timeout(60000),
      signal = AbortSignal.any([deadline, canceled])
    try {
      const current = this.store.getEpisode(id)
      if (!current?.online) throw new SourceError('SOURCE_CHANGED', '在线章节已移除。')
      await continueSourceCatalog(this.store, this.adapter(current.online.sourceId), id, signal)
    } catch (error) {
      if (canceled.aborted) throw new SourceError('SOURCE_CANCELED', '目录续载已取消。')
      if (deadline.aborted) throw new SourceError('SOURCE_TIMEOUT', '目录续载超时，请重试。')
      throw error
    }
  }
  prepareNext(id: string): Promise<Episode | undefined> {
    return this.run(id, 'next', async (signal) => {
      await this.extend(id, signal)
      const current = this.store.getEpisode(id)
      const next =
        current &&
        this.store
          .listBooks()
          .find((book) => book.id === current.bookId)
          ?.episodes.find((e) => e.order === current.order + 1)
      if (!next) return
      await this.prepareFile(next.id, signal)
      return this.store.getEpisode(next.id)
    })
  }
  cacheState() {
    if (this.closed)
      return Promise.reject(new SourceError('SOURCE_CANCELED', '在线音频服务已关闭。'))
    const operation = this.cache!.state().finally(() => this.statistics.delete(operation))
    this.statistics.add(operation)
    return operation
  }
  previewClear() {
    return this.run(this.currentEpisodeId ?? randomUUID(), 'maintenance', () =>
      this.cache!.prepare(),
    )
  }
  clearCache(token: string) {
    return this.run(this.currentEpisodeId ?? randomUUID(), 'maintenance', () =>
      this.mutateCache(() => this.cache!.clear(token)),
    )
  }

  prepare(id: string): Promise<StoredAudio> {
    return this.run(id, 'current', (signal) => this.prepareFile(id, signal))
  }
  /** Only a fresh, unverified episode can be exposed before a complete hash exists. */
  preparePlayback(
    id: string,
    sessionId: string,
    progress: (proof: PendingOnlineProof) => void,
  ): Promise<OnlinePlayback> {
    const episode = this.store.getEpisode(id)
    if (!episode?.online)
      return Promise.reject(new SourceError('SOURCE_CHANGED', '在线章节已移除。'))
    const leased = !episode.contentHash || !!this.store.getPendingOnlineProgress(id)
    const resume = leased ? this.store.beginPendingOnlinePlayback(id, sessionId).resume : null
    let offered = false
    let accept!: (value: OnlinePlayback) => void
    let reject!: (error: unknown) => void
    const ready = new Promise<OnlinePlayback>((resolve, fail) => {
      accept = resolve
      reject = fail
    })
    const download: PlaybackDownload = {
      sessionId,
      leased,
      resume,
      allowStream:
        !episode.contentHash &&
        !resume &&
        this.store.getSubtitlePreparation(episode.bookId)?.mode !== 'ahead',
      ready: (stream) => {
        offered = true
        accept({ kind: 'progressive', stream, completed: download.done! })
      },
      progress,
    }
    this.playback.set(sessionId, download)
    const completed = this.run(
      id,
      'current',
      (signal) => this.prepareFile(id, signal, undefined, download),
      sessionId,
    )
    download.done = completed
    void completed
      .then(
        (audio) => accept({ kind: 'complete', audio }),
        async (error) => {
          if (!offered) {
            try {
              if (download.stream) await this.streams.release(download.stream.id)
            } finally {
              this.playback.delete(sessionId)
              this.store.endPendingOnlinePlayback(sessionId)
            }
          }
          reject(error)
        },
      )
      .catch(reject)
    return ready
  }
  playbackProof(sessionId: string): PendingOnlineProof | null {
    const proof = this.playback.get(sessionId)?.proof
    return proof ? { ...proof } : null
  }
  servePlayback(request: Request, rendererOrigin: string): Promise<Response> {
    return this.streams.serve(request, rendererOrigin)
  }
  async releasePlayback(sessionId: string): Promise<void> {
    const download = this.playback.get(sessionId)
    if (this.active?.owner === sessionId) this.requests.cancel(this.active.requestId)
    if (download?.stream) await this.streams.release(download.stream.id)
    await download?.done?.catch(() => undefined)
    // Creation may have been in flight when cancellation first checked the map.
    if (download?.stream) await this.streams.release(download.stream.id)
    this.playback.delete(sessionId)
    this.store.endPendingOnlinePlayback(sessionId)
  }
  prepareForOffline(
    id: string,
    context: OfflineMediaContext,
    canceled: AbortSignal,
    remainingBytes: number,
  ): Promise<StoredAudio> {
    return this.run(
      id,
      'plan',
      (signal) =>
        this.prepareFile(id, AbortSignal.any([signal, canceled]), { context, remainingBytes }),
      context.itemId,
    )
  }
  async completeOfflineCatalog(
    bookId: string,
    selection: OfflineSelection,
    canceled: AbortSignal,
  ): Promise<void> {
    if (this.closed) throw new SourceError('SOURCE_CANCELED', '在线音频服务已关闭。')
    const known = this.store.listBooks().find((book) => book.id === bookId)
    if (
      !known?.online ||
      known.online.catalogComplete ||
      selection.kind === 'ids' ||
      (selection.kind === 'range' && known.episodes.length >= selection.to)
    )
      return
    return this.run(bookId, 'maintenance', async (operationSignal) => {
      const signal = AbortSignal.any([operationSignal, canceled, AbortSignal.timeout(60000)])
      signal.throwIfAborted()
      const adapter = this.adapter(known.online!.sourceId)
      const book = await adapter.getBook(known.online!.bookId, signal)
      if (book.id !== known.online!.bookId || book.sourceId !== known.online!.sourceId)
        throw new SourceError('SOURCE_CHANGED', '书源书籍身份已变化，请重新打开。')
      const episodes = [] as import('../../shared/sources').SourceEpisode[]
      const seen = new Set<string>()
      let cursor: string | undefined
      for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
        signal.throwIfAborted()
        const page = await adapter.getEpisodes(book.id, cursor, signal)
        if (!page.items.length || (page.nextCursor !== null && seen.has(page.nextCursor)))
          throw new SourceError('SOURCE_CHANGED', '书源目录分页异常，已保留原目录。')
        episodes.push(...page.items)
        if (episodes.length > 100000)
          throw new AppError('INVALID_REQUEST', '目录超过 100,000 集读取上限，请选择已加载的范围。')
        if (!page.nextCursor || (selection.kind === 'range' && episodes.length >= selection.to)) {
          signal.throwIfAborted()
          if (
            !this.store
              .listBooks()
              .some(
                (saved) =>
                  saved.id === bookId &&
                  saved.online?.bookId === book.id &&
                  saved.online.sourceId === book.sourceId,
              )
          )
            throw new SourceError('SOURCE_CHANGED', '书籍已移除，请重新预览。')
          this.store.rememberSourceBook(book, episodes, page.nextCursor === null)
          return
        }
        seen.add(page.nextCursor)
        cursor = page.nextCursor
      }
      throw new SourceError('SOURCE_CHANGED', '目录分页超过读取上限，请选择已加载的分集范围。')
    })
  }
  private async prepareFile(
    id: string,
    canceled: AbortSignal,
    offline?: { context: OfflineMediaContext; remainingBytes: number },
    playback?: PlaybackDownload,
  ): Promise<StoredAudio> {
    const episode = this.store.getEpisode(id)
    if (!episode?.online) throw new SourceError('SOURCE_CHANGED', '在线章节已移除。')
    const cached = this.store.getAudio(id)
    if (cached) {
      let valid = false
      try {
        await checkAudio(cached)
        valid = (await digest(cached.path, canceled)) === cached.contentHash
      } catch {
        /* A missing or damaged cache is fetched again; old transcripts remain versioned. */
      }
      if (valid) {
        try {
          canceled.throwIfAborted()
          const observedProof = playback?.resume
            ? await prefixProof(
                cached.path,
                playback.resume.proof.bytes,
                cached.sizeBytes,
                canceled,
              )
            : undefined
          await this.mutateCache(async () => {
            canceled.throwIfAborted()
            if (offline) this.store.retainOfflineMedia(offline.context, cached)
            else if (playback?.resume && observedProof)
              this.store.cacheSourceEpisode(id, cached, {
                kind: 'resume',
                sessionId: playback.sessionId,
                revision: playback.resume.revision,
                observedProof,
              })
            else this.store.touchSourceCache(id)
          })
        } catch (error) {
          if (canceled.aborted) throw new SourceError('SOURCE_CANCELED', '音频缓存已取消。')
          throw error
        }
        return cached
      }
    }
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), this.timeoutMs)
    const signal = AbortSignal.any([canceled, deadline.signal])
    const temporary = join(this.directory, `${id}-${randomUUID()}.part`)
    let completed: string | undefined
    try {
      signal.throwIfAborted()
      await mkdir(this.directory, { recursive: true })
      const adapter = this.adapter(episode.online.sourceId)
      for (let attempt = 0; attempt < 2; attempt++) {
        const resolved = await adapter.resolveAudio(
          episode.online.bookId,
          episode.online.episodeId,
          signal,
        )
        if (
          resolved.sourceId !== episode.online.sourceId ||
          resolved.episodeId !== episode.online.episodeId
        )
          throw new SourceError('SOURCE_CHANGED', '音频解析返回了其他来源或分集。')
        let url = audioSourceMediaUrl(
          episode.online.sourceId,
          resolved.url,
          undefined,
          adapter.urlPolicy,
        )
        const referer = audioSourcePageUrl(
          episode.online.sourceId,
          isPluginSourceId(episode.online.sourceId) ? resolved.headers.Referer : resolved.pageUrl,
          adapter.urlPolicy,
        ).href
        const headers: Record<string, string> = { Referer: referer, 'Accept-Encoding': 'identity' }
        if (isPluginSourceId(episode.online.sourceId)) {
          for (const [name, value] of Object.entries(resolved.headers)) {
            if (
              !['referer', 'user-agent', 'origin', 'accept'].includes(name.toLowerCase()) ||
              value.length > 2048 ||
              /\p{Cc}/u.test(value)
            )
              throw new SourceError('SOURCE_MEDIA_UNAVAILABLE', '插件返回了不允许的媒体请求头。')
            if (name.toLowerCase() !== 'referer') headers[name] = value
          }
        }
        let response: Response | undefined
        for (let redirect = 0; redirect <= 4; redirect++) {
          response = await this.request(url, {
            signal,
            redirect: 'manual',
            headers,
          })
          if (![301, 302, 303, 307, 308].includes(response.status)) break
          const location = response.headers.get('location')
          await response.body?.cancel()
          if (!location || redirect === 4)
            throw new SourceError('SOURCE_MEDIA_UNAVAILABLE', '音频地址重定向过多或不完整。')
          url = audioSourceMediaUrl(
            episode.online.sourceId,
            new URL(location, url).href,
            resolved.url,
            adapter.urlPolicy,
          )
        }
        if (!response) throw new SourceError('SOURCE_MEDIA_UNAVAILABLE', '未收到音频响应。')
        if ([401, 403, 410].includes(response.status) && attempt === 0) {
          await response.body?.cancel()
          continue // One fresh page resolution, without persisting or guessing expiry.
        }
        const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
        const length = response.headers.get('content-length')
        const expected = length === null ? null : Number(length)
        if (
          response.status !== 200 ||
          response.headers.has('content-range') ||
          (response.headers.has('content-encoding') &&
            response.headers.get('content-encoding') !== 'identity') ||
          type !== 'audio/mpeg' ||
          !response.body ||
          (expected !== null &&
            (!Number.isSafeInteger(expected) || expected <= 0 || expected > MAX_BYTES))
        ) {
          await response.body?.cancel()
          throw new SourceError(
            'SOURCE_MEDIA_UNAVAILABLE',
            '音频服务未返回完整 MP3，可能已失效或暂不可用，请重试。',
          )
        }
        if (
          offline &&
          (offline.remainingBytes <= 0 || (expected !== null && expected > offline.remainingBytes))
        ) {
          await response.body.cancel()
          throw new AppError(
            'FILE_UNAVAILABLE',
            '本计划在线音频预算不足，请提高预算后重试；已保留的音频不受影响。',
          )
        }
        const space = await statfs(this.directory)
        if (space.bavail * space.bsize < (expected ?? MAX_BYTES) + RESERVE_BYTES) {
          await response.body.cancel()
          throw new SourceError('SOURCE_MEDIA_UNAVAILABLE', '缓存磁盘空间不足，请清理空间后重试。')
        }
        if (this.cache)
          await this.mutateCache(() => this.cache!.reserve(expected ?? MAX_BYTES, id, !!offline))
        const file = await open(temporary, 'wx')
        const hash = createHash('sha256')
        const resumeHash = playback?.resume ? createHash('sha256') : undefined
        let resumeBytes = 0
        let size = 0,
          prefix = Buffer.alloc(0)
        try {
          for await (const chunk of response.body) {
            signal.throwIfAborted()
            size += chunk.byteLength
            if (size > MAX_BYTES || (expected !== null && size > expected))
              throw new SourceError('SOURCE_MEDIA_UNAVAILABLE', '音频大小超出本次缓存上限。')
            if (offline && size > offline.remainingBytes)
              throw new AppError(
                'FILE_UNAVAILABLE',
                '本计划在线音频预算不足，请提高预算后重试；此前完整文件保留。',
              )
            if (prefix.length < 12)
              prefix = Buffer.concat([prefix, Buffer.from(chunk)]).subarray(0, 12)
            await file.writeFile(chunk)
            // No proof is observable until the complete chunk has been written.
            hash.update(chunk)
            if (resumeHash && playback?.resume) {
              const part = chunk.subarray(0, Math.max(0, playback.resume.proof.bytes - resumeBytes))
              resumeHash.update(part)
              resumeBytes += part.length
            }
            const validPrefix =
              prefix.length >= 12 &&
              (prefix.subarray(0, 3).toString() === 'ID3' ||
                (prefix[0] === 255 && (prefix[1]! & 224) === 224))
            if (
              playback?.allowStream &&
              expected !== null &&
              size >= Math.min(FIRST_PLAYBACK_BYTES, expected) &&
              validPrefix
            ) {
              if (!playback.stream) {
                playback.stream = await this.streams.create(id, temporary, expected)
                signal.throwIfAborted()
                playback.stream.markWritten(size)
                playback.proof = {
                  bytes: size,
                  sha256: hash.copy().digest('hex'),
                  totalBytes: expected,
                }
                playback.ready(playback.stream)
              } else playback.stream.markWritten(size)
              playback.proof = {
                bytes: size,
                sha256: hash.copy().digest('hex'),
                totalBytes: expected,
              }
              playback.progress(playback.proof)
            }
          }
          if (
            size < 12 ||
            (expected !== null && size !== expected) ||
            !(
              prefix.subarray(0, 3).toString() === 'ID3' ||
              (prefix[0] === 255 && (prefix[1]! & 224) === 224)
            )
          )
            throw new SourceError('SOURCE_MEDIA_UNAVAILABLE', '音频响应不完整或格式错误，请重试。')
          await file.sync()
        } finally {
          await file.close()
        }
        signal.throwIfAborted()
        const contentHash = hash.digest('hex')
        completed = join(this.directory, `${id}-${randomUUID()}.mp3`)
        await rename(temporary, completed)
        const info = await stat(completed)
        signal.throwIfAborted()
        const audio = {
          path: await realpath(completed),
          name: episode.title,
          sizeBytes: size,
          modifiedAt: info.mtimeMs,
          contentHash,
        }
        await this.mutateCache(async () => {
          signal.throwIfAborted()
          if (offline) this.store.retainOfflineMedia(offline.context, audio)
          else
            this.store.cacheSourceEpisode(
              id,
              audio,
              playback?.leased
                ? playback.resume && resumeHash
                  ? {
                      kind: 'resume',
                      sessionId: playback.sessionId,
                      revision: playback.resume.revision,
                      observedProof: {
                        bytes: resumeBytes,
                        sha256: resumeHash.digest('hex'),
                        totalBytes: size,
                      },
                    }
                  : { kind: 'live', sessionId: playback.sessionId }
                : undefined,
            )
          completed = undefined // The database and any retention reference now own this complete file.
        })
        await playback?.stream?.complete()
        return this.store.getAudio(id)!
      }
      throw new SourceError('SOURCE_MEDIA_UNAVAILABLE', '音频地址重新解析后仍不可用，请稍后重试。')
    } catch (error) {
      await playback?.stream?.fail(error)
      if (canceled.aborted) throw new SourceError('SOURCE_CANCELED', '音频缓存已取消。')
      if (deadline.signal.aborted) throw new SourceError('SOURCE_TIMEOUT', '音频缓存超时，请重试。')
      if (error instanceof SourceError || error instanceof AppError) throw error
      throw new SourceError(
        'SOURCE_MEDIA_UNAVAILABLE',
        '音频缓存未完成，请检查网络与磁盘空间后重试。',
      )
    } finally {
      clearTimeout(timer)
      deadline.abort()
      await unlink(temporary).catch(() => undefined)
      if (completed) await unlink(completed).catch(() => undefined)
    }
  }
}
