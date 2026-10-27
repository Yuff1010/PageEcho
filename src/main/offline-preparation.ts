import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { statfs } from 'node:fs/promises'
import type { Book, Episode } from '../shared/contracts'
import {
  MAX_OFFLINE_ITEMS,
  type OfflinePlan,
  type OfflinePlanPreview,
  type OfflinePreviewItem,
  type OfflineSelection,
  type PreviewOfflinePlanRequest,
  type UpdateOfflinePlanRequest,
} from '../shared/offline'
import { AppError, validateRequest } from '../shared/validation'
import { SourceError } from '../shared/sources'
import type { LibraryStore } from './database'
import type { OfflineItemContext, OfflinePlanControl, StoredOfflineItem } from './offline-store'
import { checkAudio } from './media'
import type { OnlineMedia } from './sources/online-media'
import type { TranscriptionQueue } from './transcription-queue'

const RUNNABLE = new Set(['queued', 'running'])
const TERMINAL_ITEM = new Set(['ready', 'failed', 'needs-attention', 'canceled'])
const ACTIVE_JOB = new Set(['queued', 'running', 'canceling'])
const PREVIEW_TTL_MS = 300_000
interface Options {
  store: LibraryStore
  queue: Pick<TranscriptionQueue, 'startForOffline' | 'interruptOffline' | 'reconcileOffline'>
  media: Pick<OnlineMedia, 'prepareForOffline' | 'cancelOffline' | 'completeOfflineCatalog'>
  directory: string
  measureDuration: (id: string, hash: string, signal: AbortSignal) => Promise<number>
  notify: () => void
  libraryChanged: () => void
  log: (error: unknown) => void
  idleSeconds?: () => number
  now?: () => number
  pollMs?: number
}
interface PreviewToken {
  request: PreviewOfflinePlanRequest
  episodeIds: string[]
  fingerprint: string
  expiresAt: number
}
interface AudioWork {
  context: OfflineItemContext
  controller: AbortController
  done: Promise<void>
}

/** Persistent plans own references and jobs; this coordinator owns only bounded live work. */
export class OfflinePreparation {
  private readonly store: LibraryStore
  private readonly lifetime = new AbortController()
  private readonly tokens = new Map<string, PreviewToken>()
  private readonly previews = new Map<
    string,
    { controller: AbortController; done: Promise<OfflinePlanPreview> }
  >()
  private active: AudioWork | undefined
  private timer: NodeJS.Timeout | undefined
  private started = false
  private closed = false
  private ticking = false
  private scheduled = false
  private pending = false
  private tickDone: Promise<void> | undefined
  private readonly requests = new Set<Promise<unknown>>()
  private readonly retryAfter = new Map<string, number>()
  private readonly audioChecked = new Map<string, string>()
  private readonly durationChecked = new Map<string, string>()
  private readonly checkedAt = new Map<string, number>()
  constructor(private readonly options: Options) {
    this.store = options.store
  }
  private now() {
    return this.options.now?.() ?? Date.now()
  }
  private ensureOpen(): void {
    if (this.closed) throw new AppError('BUSY', '应用正在退出。')
  }
  private request<T>(action: () => Promise<T>): Promise<T> {
    try {
      this.ensureOpen()
      const done = action().finally(() => this.requests.delete(done))
      this.requests.add(done)
      return done
    } catch (error) {
      return Promise.reject(error)
    }
  }
  initialize(): Promise<void> {
    return this.request(() => this.initializeImpl())
  }
  /** Must precede queue.start(): recover ownership before any persisted job can run. */
  private async initializeImpl(): Promise<void> {
    this.store.recoverOfflinePlans()
    const files = this.store.offlineRetainedFiles()
    for (let offset = 0; offset < files.length; offset += 8) {
      this.lifetime.signal.throwIfAborted()
      await Promise.all(
        files.slice(offset, offset + 8).map(async (file) => {
          try {
            await checkAudio({ ...file, id: '', name: '' })
          } catch (error) {
            if (!(error instanceof AppError)) throw error
            this.store.invalidateOfflineMedia(file, error.message)
          }
        }),
      )
    }
    for (const plan of this.store.offlinePlans(0, true).plans) await this.auditMedia(plan)
    this.options.queue.reconcileOffline()
  }
  start(): void {
    if (this.closed || this.started) return
    this.started = true
    if ((this.options.pollMs ?? 2000) > 0) {
      this.timer = setInterval(() => this.changed(), this.options.pollMs ?? 2000)
      this.timer.unref()
    }
    this.changed()
  }
  changed(): void {
    if (this.closed || !this.started || this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.closed) return
      if (this.ticking) {
        this.pending = true
        return
      }
      const done = this.tick()
        .catch(this.options.log)
        .finally(() => {
          if (this.tickDone === done) this.tickDone = undefined
        })
      this.tickDone = done
    })
  }
  private publish(library = false): void {
    if (this.closed) return
    this.options.notify()
    if (library) this.options.libraryChanged()
  }
  private book(id: string): Book {
    const book = this.store.listBooks().find((value) => value.id === id)
    if (!book) throw new AppError('FILE_UNAVAILABLE', '书籍已移除，请重新选择。')
    return book
  }
  private select(book: Book, selection: OfflineSelection): Episode[] {
    const episodes = [...book.episodes].sort((a, b) => a.order - b.order)
    if (selection.kind === 'all' && book.online && !book.online.catalogComplete)
      throw new AppError('SOURCE_CHANGED', '选集目录尚未补全，不能把部分目录当成整书。')
    const result =
      selection.kind === 'all'
        ? episodes
        : selection.kind === 'range'
          ? episodes.slice(selection.from - 1, selection.to)
          : episodes.filter((episode) => selection.episodeIds.includes(episode.id))
    if (
      !result.length ||
      (selection.kind === 'range' && result.length !== selection.to - selection.from + 1) ||
      (selection.kind === 'ids' && result.length !== selection.episodeIds.length)
    )
      throw new AppError('INVALID_REQUEST', '选择中有未加载或已移除的分集，请刷新目录。')
    if (result.length > MAX_OFFLINE_ITEMS)
      throw new AppError(
        'INVALID_REQUEST',
        '选集目录已更新；每个离线计划最多 1,000 集，请选择连续范围或分集。',
      )
    return result
  }
  private fingerprint(book: Book, episodes: Episode[]): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          bookId: book.id,
          source: book.online && { ...book.online, preparation: undefined },
          episodes: episodes.map((episode) => {
            const audio = this.store.getAudio(episode.id)
            return {
              id: episode.id,
              bookId: episode.bookId,
              title: episode.title,
              order: episode.order,
              online: episode.online,
              hash: episode.contentHash,
              audio: audio && {
                path: audio.path,
                contentHash: audio.contentHash,
                sizeBytes: audio.sizeBytes,
                modifiedAt: audio.modifiedAt,
              },
            }
          }),
        }),
      )
      .digest('hex')
  }
  preview(request: PreviewOfflinePlanRequest): Promise<OfflinePlanPreview> {
    return this.request(() => this.previewImpl(request))
  }
  private async previewImpl(request: PreviewOfflinePlanRequest): Promise<OfflinePlanPreview> {
    validateRequest('offline:preview', [request])
    if (this.closed) throw new AppError('BUSY', '应用正在退出。')
    if (this.previews.size >= 5 || this.previews.has(request.requestId))
      throw new AppError('BUSY', '已有离线预览正在进行，请先取消或等待完成。')
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
    const done = this.buildPreview(structuredClone(request), signal).finally(() => {
      this.previews.delete(request.requestId)
    })
    this.previews.set(request.requestId, { controller, done })
    return done
  }
  private async buildPreview(
    request: PreviewOfflinePlanRequest,
    signal: AbortSignal,
  ): Promise<OfflinePlanPreview> {
    try {
      signal.throwIfAborted()
      await this.options.media.completeOfflineCatalog(request.bookId, request.selection, signal)
      // Catalog completion is useful even when the ensuing all-selection exceeds the limit.
      this.publish(true)
      signal.throwIfAborted()
      const book = this.book(request.bookId),
        selected = this.select(book, request.selection),
        fingerprint = this.fingerprint(book, selected)
      const items: OfflinePreviewItem[] = []
      for (const episode of selected) {
        signal.throwIfAborted()
        const audio = this.store.getAudio(episode.id)
        let cached = false,
          conflict: string | null = null
        if (audio) {
          try {
            await checkAudio(audio)
            cached = true
          } catch (error) {
            if (!(error instanceof AppError)) throw error
            if (!episode.online) conflict = error.message
          }
        }
        const status = episode.contentHash
          ? this.store.subtitleStatuses([
              { episodeId: episode.id, audioHash: episode.contentHash, positionMs: 0 },
            ])[0]
          : null
        const subtitle: OfflinePreviewItem['subtitle'] = status?.savedCoverage.complete
          ? 'complete'
          : status?.savedStatus === 'ready'
            ? status.durationMs === null
              ? 'unknown-duration'
              : 'partial'
            : 'missing'
        if (subtitle === 'partial' || subtitle === 'unknown-duration')
          conflict ??= '已有正式文稿；不完整或未知时长的人工内容会保留，需核对后处理。'
        if (status?.job?.hasPreview && !status.job.autoApply && subtitle !== 'complete')
          conflict ??= '已有待采用的新稿，请先在字幕任务中处理。'
        items.push({
          episodeId: episode.id,
          title: episode.title,
          order: book.online ? episode.order : episode.order + 1,
          online: !!episode.online,
          cached,
          audioHash: episode.contentHash || null,
          mediaBytes: cached && audio ? audio.sizeBytes : null,
          subtitle,
          conflict,
        })
      }
      signal.throwIfAborted()
      const current = this.book(book.id)
      if (this.fingerprint(current, this.select(current, request.selection)) !== fingerprint)
        throw new AppError('CONFLICT', '预览期间书籍或音频版本已变化，请重新预览。')
      const space = await statfs(this.options.directory)
      signal.throwIfAborted()
      const token = randomUUID(),
        expiresAt = this.now() + PREVIEW_TTL_MS
      for (const [key, value] of this.tokens)
        if (value.expiresAt <= this.now()) this.tokens.delete(key)
      // Only a handful of bounded previews survive; previews never create jobs or media refs.
      while (this.tokens.size >= 5) this.tokens.delete(this.tokens.keys().next().value!)
      this.tokens.set(token, {
        request,
        episodeIds: selected.map((episode) => episode.id),
        fingerprint,
        expiresAt,
      })
      const online = items.filter((item) => item.online)
      const knownAudioBytes = online.reduce((sum, item) => sum + (item.mediaBytes ?? 0), 0)
      const conflicts = [
        ...new Set(items.flatMap((item) => (item.conflict ? [item.conflict] : []))),
      ]
      if (knownAudioBytes > request.audioBudgetBytes)
        conflicts.push('已知在线音频大小超过本计划预算，请提高预算；未知项仍需额外空间。')
      return {
        token,
        expiresAt,
        bookId: book.id,
        bookTitle: book.title,
        selection: request.selection,
        profile: request.profile,
        audioBudgetBytes: request.audioBudgetBytes,
        catalogComplete: !book.online || book.online.catalogComplete,
        totalItems: items.length,
        knownAudioBytes,
        unknownAudioItems: online.filter((item) => item.mediaBytes === null).length,
        existingAudioItems: items.filter((item) => item.cached).length,
        completeSubtitleItems: items.filter((item) => item.subtitle === 'complete').length,
        partialSubtitleItems: items.filter((item) => item.subtitle === 'partial').length,
        freeBytes: space.bavail * space.bsize,
        conflicts,
        items,
      }
    } catch (error) {
      if (signal.aborted) throw new SourceError('SOURCE_CANCELED', '离线计划预览已取消。')
      throw error
    }
  }
  cancelPreview(requestId: string): Promise<void> {
    return this.request(() => this.cancelPreviewImpl(requestId))
  }
  private async cancelPreviewImpl(requestId: string): Promise<void> {
    const operation = this.previews.get(requestId)
    operation?.controller.abort()
    await operation?.done.catch(() => undefined)
    // A late cancellation after completion also invalidates its unconsumed token.
    for (const [token, value] of this.tokens)
      if (value.request.requestId === requestId) this.tokens.delete(token)
  }
  create(token: string): Promise<OfflinePlan> {
    return this.request(() => this.createImpl(token))
  }
  private async createImpl(token: string): Promise<OfflinePlan> {
    const preview = this.tokens.get(token)
    this.tokens.delete(token)
    if (this.closed || !preview || preview.expiresAt <= this.now())
      throw new AppError('CONFLICT', '离线计划预览已失效，请重新预览。')
    const book = this.book(preview.request.bookId),
      selected = this.select(book, preview.request.selection)
    if (this.fingerprint(book, selected) !== preview.fingerprint)
      throw new AppError('CONFLICT', '书籍或音频版本已变化，请重新预览。')
    for (const episode of selected) {
      const audio = this.store.getAudio(episode.id)
      if (audio && !episode.online) await checkAudio(audio)
    }
    this.lifetime.signal.throwIfAborted()
    const currentBook = this.book(book.id)
    if (
      this.fingerprint(currentBook, this.select(currentBook, preview.request.selection)) !==
      preview.fingerprint
    )
      throw new AppError('CONFLICT', '书籍或音频版本已变化，请重新预览。')
    const plan = this.store.createOfflinePlan({
      bookId: book.id,
      episodeIds: preview.episodeIds,
      scope: preview.request.selection.kind,
      profile: preview.request.profile,
      audioBudgetBytes: preview.request.audioBudgetBytes,
    })
    this.publish()
    this.changed()
    return plan
  }
  list(request: { page: number; activeOnly: boolean }) {
    return this.request(() => this.listImpl(request))
  }
  private async listImpl(request: { page: number; activeOnly: boolean }) {
    const result = this.store.offlinePlans(request.page, request.activeOnly)
    for (const plan of result.plans) await this.auditMedia(plan)
    return this.store.offlinePlans(request.page, request.activeOnly)
  }
  get(request: { id: string; itemPage: number }) {
    return this.request(() => this.getImpl(request))
  }
  private async getImpl(request: { id: string; itemPage: number }) {
    const plan = this.store.offlinePlan(request.id)
    if (!plan) throw new AppError('INVALID_REQUEST', '离线计划不存在。')
    await this.auditMedia(plan)
    return {
      plan: this.store.offlinePlan(request.id)!,
      items: this.store.offlineItems(request.id, request.itemPage),
    }
  }
  update(request: UpdateOfflinePlanRequest): Promise<OfflinePlan> {
    return this.request(() => this.updateImpl(request))
  }
  private async updateImpl(request: UpdateOfflinePlanRequest): Promise<OfflinePlan> {
    const jobs = this.store.offlinePlanJobIds(request.id)
    this.store.updateOfflinePlan(request)
    await this.stopAudio(request.id)
    await this.options.queue.interruptOffline(jobs)
    this.options.queue.reconcileOffline()
    this.publish(true)
    this.changed()
    return this.store.offlinePlan(request.id)!
  }
  release(request: { id: string; revision: number }): OfflinePlan {
    this.ensureOpen()
    const plan = this.store.releaseOfflineMedia(request.id, request.revision)
    this.publish(true)
    return plan
  }
  private async auditMedia(plan: OfflinePlan): Promise<void> {
    const items = this.store
      .storedOfflineItems(plan.id)
      .filter((item) => item.audioVerified && item.file)
    let changed = false
    for (let offset = 0; offset < items.length; offset += 8)
      await Promise.all(
        items.slice(offset, offset + 8).map(async (item) => {
          const key = JSON.stringify(item.file)
          if ((this.checkedAt.get(key) ?? -Infinity) + 10_000 > this.now()) return
          try {
            await checkAudio({ ...item.file!, id: item.episodeId })
            if (this.checkedAt.size >= 10_000) this.checkedAt.clear()
            this.checkedAt.set(key, this.now())
          } catch (error) {
            if (!(error instanceof AppError)) throw error
            this.store.invalidateOfflineMedia(item.file!, error.message)
            changed = true
          }
        }),
      )
    if (changed) {
      this.publish()
      this.changed()
    }
  }
  private allowed(): boolean {
    const resources = this.store.processingResources()
    return (
      !resources.paused &&
      (!resources.policy.backgroundIdleOnly || (this.options.idleSeconds?.() ?? 0) >= 60)
    )
  }
  private context(plan: OfflinePlanControl, item: StoredOfflineItem): OfflineItemContext {
    return { planId: plan.id, planRevision: plan.revision, itemId: item.id, attempt: item.attempt }
  }
  private current(context: OfflineItemContext): boolean {
    const plan = this.store.offlinePlanControl(context.planId),
      item = this.store.getStoredOfflineItem(context.itemId)
    return (
      !this.closed &&
      !!plan &&
      RUNNABLE.has(plan.status) &&
      plan.revision === context.planRevision &&
      item?.attempt === context.attempt &&
      !TERMINAL_ITEM.has(item.status)
    )
  }
  private patch(
    context: OfflineItemContext,
    patch: Parameters<LibraryStore['updateOfflineItem']>[0]['patch'],
    advanceAttempt = false,
  ) {
    const value = this.store.updateOfflineItem({ ...context, patch, advanceAttempt })
    this.publish()
    return value
  }
  private async stopAudio(planId?: string): Promise<void> {
    const active = this.active
    if (!active || (planId && active.context.planId !== planId)) return
    active.controller.abort()
    await this.options.media.cancelOffline(active.context.itemId)
    await active.done
  }
  private async tick(): Promise<void> {
    if (this.closed || !this.started || this.ticking) return
    this.ticking = true
    try {
      if (this.active && (!this.current(this.active.context) || !this.allowed())) {
        const context = this.active.context
        if (this.current(context))
          this.patch(context, { status: 'waiting-foreground', error: null }, true)
        await this.stopAudio()
      }
      this.options.queue.reconcileOffline()
      if (!this.allowed()) return
      const plans = this.store.offlineSchedulingPlans()
      // Oldest first; a bounded active plan set cannot hide behind history pagination.
      for (const plan of plans.reverse()) {
        for (const item of this.store.storedOfflineItems(plan.id)) {
          if (this.closed || !this.allowed()) return
          if (TERMINAL_ITEM.has(item.status) || this.active?.context.itemId === item.id) continue
          if ((this.retryAfter.get(item.id) ?? 0) > this.now()) continue
          const freshPlan = this.store.offlinePlanControl(plan.id)!
          if (!RUNNABLE.has(freshPlan.status)) break
          const context = this.context(freshPlan, item),
            readiness = this.store.getOfflineReadiness(item.id)
          if (readiness.changed) {
            this.patch(context, {
              status: 'needs-attention',
              error: '章节或音频版本已变化，旧计划不会自动替换；请重新预览。',
            })
            continue
          }
          if (
            readiness.audioReady &&
            (this.audioChecked.get(item.id) !== item.audioHash ||
              this.durationChecked.get(item.id) !== item.audioHash)
          ) {
            if (!this.active) this.beginAudio(freshPlan, item)
            continue
          }
          const job = item.jobId ? this.store.getJob(item.jobId) : null
          if (job && ACTIVE_JOB.has(job.status)) {
            if (item.status !== 'transcribing')
              this.patch(context, { status: 'transcribing', error: null })
            continue
          }
          // The final chunk can already cover the episode before the worker's terminal
          // snapshot arrives. Keep ownership runnable until that snapshot is committed.
          if (readiness.audioReady && readiness.subtitleReady) {
            this.patch(context, { status: 'ready', error: null })
            continue
          }
          if (job && !item.retryRequested) {
            this.patch(context, {
              status: job.status === 'failed' ? 'failed' : 'needs-attention',
              error:
                job.error ??
                (job.status === 'canceled'
                  ? '转写已被用户取消，请在任务页明确重试。'
                  : '生成任务已结束，正式文稿尚未整集覆盖；请核对待采用稿。'),
            })
            if (job.status === 'failed') {
              const currentPlan = this.store.offlinePlanControl(plan.id)!
              if (RUNNABLE.has(currentPlan.status)) {
                this.store.blockOfflinePlan(
                  plan.id,
                  currentPlan.revision,
                  '字幕生成失败；修复原因后重试失败项。',
                )
                await this.stopAudio(plan.id)
                await this.options.queue.interruptOffline(this.store.offlinePlanJobIds(plan.id))
                this.publish()
              }
              break
            }
            continue
          }
          if (!readiness.audioReady || readiness.durationMs === null) {
            if (!this.active) this.beginAudio(freshPlan, item)
            continue
          }
          const latest = item.audioHash
            ? this.store.latestJob(item.episodeId, item.audioHash)
            : null
          const continuing =
            latest?.autoApply &&
            latest.engine === plan.profile.engine &&
            latest.device === plan.profile.device &&
            (ACTIVE_JOB.has(latest.status) || (latest.status === 'failed' && item.retryRequested))
          if (
            readiness.subtitleState === 'preview' ||
            ((readiness.subtitleState === 'partial' ||
              readiness.subtitleState === 'unknown-duration') &&
              (!continuing || readiness.subtitleSource !== 'transcript'))
          ) {
            this.patch(context, {
              status: 'needs-attention',
              error: '已有人工文稿、部分正式稿或待采用稿；请在伴读页核对，离线计划不会覆盖。',
            })
            continue
          }
          const planned = this.store.activeJobs().filter((active) => {
            const owner = this.store.offlineJobOwnership(active.id)
            return owner.planned && owner.runnable
          })
          if (planned.some((active) => active.id !== latest?.id)) continue
          try {
            this.options.queue.startForOffline(
              item.id,
              { episodeId: item.episodeId, audioHash: item.audioHash!, ...plan.profile },
              { planRevision: context.planRevision, attempt: context.attempt },
            )
            this.publish()
          } catch (error) {
            await this.failed(context, error)
          }
        }
      }
    } finally {
      this.ticking = false
      if (this.pending) {
        this.pending = false
        this.changed()
      }
    }
  }
  private beginAudio(plan: OfflinePlanControl, item: StoredOfflineItem): void {
    const controller = new AbortController(),
      context = this.context(plan, item)
    const active: AudioWork = { context, controller, done: Promise.resolve() }
    this.active = active
    active.done = this.prepareAudio(plan, item, controller.signal)
      .catch((error: unknown) => this.failed(context, error))
      .catch(this.options.log)
      .finally(() => {
        if (this.active === active) this.active = undefined
        this.changed()
      })
  }
  private async prepareAudio(
    plan: OfflinePlanControl,
    item: StoredOfflineItem,
    canceled: AbortSignal,
  ): Promise<void> {
    const context = this.context(plan, item),
      signal = AbortSignal.any([canceled, this.lifetime.signal])
    let audio = this.store.getAudio(item.episodeId)
    if (
      !this.store.getOfflineReadiness(item.id).audioReady ||
      this.audioChecked.get(item.id) !== item.audioHash
    ) {
      this.patch(context, { status: 'downloading', error: null })
      if (item.source) {
        const others = this.store
          .offlineMediaReferences()
          .filter((ref) => ref.planId === plan.id && ref.itemId !== item.id)
        const occupied = [
          ...new Map(
            others.map((file) => [
              JSON.stringify([file.path, file.contentHash, file.sizeBytes, file.modifiedAt]),
              file.sizeBytes,
            ]),
          ).values(),
        ].reduce((sum, bytes) => sum + bytes, 0)
        audio = await this.options.media.prepareForOffline(
          item.episodeId,
          context,
          signal,
          Math.max(0, plan.audioBudgetBytes - occupied),
        )
      } else {
        if (!audio) throw new AppError('FILE_UNAVAILABLE', '本地音频已移除，请重新导入。')
        await checkAudio(audio)
        const hash = createHash('sha256')
        for await (const bytes of createReadStream(audio.path, { signal })) hash.update(bytes)
        signal.throwIfAborted()
        if (hash.digest('hex') !== item.audioHash)
          throw new AppError('FILE_CHANGED', '本地音频内容已变化，请重新导入；旧文稿已保留。')
        await checkAudio(audio)
        this.store.retainOfflineMedia(context, audio)
      }
      if (this.audioChecked.size >= 10_000) this.audioChecked.clear()
      this.audioChecked.set(item.id, audio!.contentHash)
      this.publish(true)
    }
    signal.throwIfAborted()
    if (!this.current(context) || !audio) return
    if (this.durationChecked.get(item.id) !== audio.contentHash) {
      const durationMs = await this.options.measureDuration(
        item.episodeId,
        audio.contentHash,
        signal,
      )
      signal.throwIfAborted()
      this.patch(context, { durationMs, status: 'audio-ready', error: null })
      if (this.durationChecked.size >= 10_000) this.durationChecked.clear()
      this.durationChecked.set(item.id, audio.contentHash)
      this.publish(true)
    }
  }
  private async failed(context: OfflineItemContext, error: unknown): Promise<void> {
    if (!this.current(context)) return
    const code = error instanceof AppError || error instanceof SourceError ? error.code : '',
      message = error instanceof Error ? error.message.slice(0, 1900) : '离线准备未完成，请重试。'
    if (
      code === 'SOURCE_BUSY' ||
      code === 'SOURCE_CANCELED' ||
      (code === 'BUSY' && /维护|清理|后台处理正在使用组件/.test(message))
    ) {
      this.patch(context, { status: 'waiting-foreground', error: '前台操作优先，稍后继续。' }, true)
      this.retryAfter.set(context.itemId, this.now() + 2000)
      return
    }
    if (
      code === 'RUNTIME_UNAVAILABLE' ||
      code === 'SOURCE_VERIFICATION_REQUIRED' ||
      code === 'SOURCE_UNAVAILABLE' ||
      /预算|空间不足|磁盘/.test(message)
    ) {
      this.store.blockOfflinePlan(context.planId, context.planRevision, message)
      await this.options.queue.interruptOffline(this.store.offlinePlanJobIds(context.planId))
      this.publish()
      return
    }
    const attention = [
      'FILE_CHANGED',
      'FILE_UNAVAILABLE',
      'SOURCE_CHANGED',
      'CONFLICT',
      'BUSY',
    ].includes(code)
    this.patch(context, { status: attention ? 'needs-attention' : 'failed', error: message })
    if (code === 'FILE_CHANGED' || code === 'FILE_UNAVAILABLE') {
      const item = this.store.getStoredOfflineItem(context.itemId)
      if (item?.file) this.store.invalidateOfflineMedia(item.file, message)
    }
    if (!code) this.options.log(error)
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.started = false
    clearInterval(this.timer)
    this.lifetime.abort()
    this.tokens.clear()
    for (const preview of this.previews.values()) preview.controller.abort()
    await Promise.allSettled([...this.previews.values()].map((preview) => preview.done))
    await this.stopAudio()
    await this.tickDone
    await Promise.allSettled([...this.requests])
  }
}
