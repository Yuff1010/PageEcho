import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import type { LibraryStore } from './database'
import { checkAudio } from './media'
import {
  decodeSubtitleImport,
  readSubtitleImportFile,
  type SubtitleImportFile,
} from './subtitle-import-file'
import { parseTimedSubtitles } from './subtitle-import-parser'
import { readTranscript } from './transcripts'
import {
  MAX_SUBTITLE_IMPORT_PREVIEWS,
  SUBTITLE_IMPORT_PAGE_SIZE,
  SUBTITLE_IMPORT_PREVIEW_TTL_MS,
  type ApplySubtitleImport,
  type ResolvedSubtitleImportEncoding,
  type SubtitleImportOptions,
  type SubtitleImportPageRequest,
  type SubtitleImportPreview,
  type SubtitleImportPreviewRequest,
  type SubtitleImportRequest,
  type SubtitleImportResult,
  type SubtitleImportSelection,
  type TimedSubtitleMetadata,
  type TranscriptImportBaseline,
} from '../shared/subtitle-import'
import {
  validateTranscript,
  type TranscriptDocument,
  type TranscriptRequest,
  type TranscriptState,
} from '../shared/transcript'
import { AppError } from '../shared/validation'

interface Options {
  store: LibraryStore
  notify: (target: TranscriptRequest) => void
  now?: () => number
}
interface Request {
  id: string
  controller: AbortController
  expiresAt: number
  pending: Set<Promise<unknown>>
}
interface Plan {
  token: string
  revision: number
  owner: Request
  target: TranscriptRequest
  baseline: TranscriptImportBaseline
  episodeTitle: string
  file: SubtitleImportFile
  options: SubtitleImportOptions
  encoding: ResolvedSubtitleImportEncoding | null
  durationMs: number | null
  document: TranscriptDocument | null
  metadata: TimedSubtitleMetadata | null
  status: SubtitleImportPreview['status']
  errors: string[]
  busy: boolean
}

/** Paths and source bytes stay in Main; only explicit adoption writes a new baseline. */
export class SubtitleImportService {
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly requests = new Map<string, Request>()
  private readonly plans = new Map<string, Plan>()
  private closed = false
  constructor(private readonly options: Options) {}
  private now() {
    return this.options.now?.() ?? Date.now()
  }
  private open() {
    if (this.closed) throw new AppError('BUSY', '应用正在退出，没有导入新的字幕。')
  }
  private track<T>(action: () => Promise<T>, owner?: Request): Promise<T> {
    try {
      this.open()
      const done = action().finally(() => {
        this.pending.delete(done)
        owner?.pending.delete(done)
      })
      this.pending.add(done)
      owner?.pending.add(done)
      return done
    } catch (error) {
      return Promise.reject(error)
    }
  }
  private drop(owner: Request) {
    owner.controller.abort()
    for (const [token, plan] of this.plans) if (plan.owner === owner) this.plans.delete(token)
    this.requests.delete(owner.id)
  }
  private expire() {
    for (const owner of this.requests.values()) if (owner.expiresAt <= this.now()) this.drop(owner)
  }
  private plan(token: string, revision: number): Plan {
    this.open()
    this.expire()
    const value = this.plans.get(token)
    if (!value || value.revision !== revision || value.owner.controller.signal.aborted)
      throw new AppError('CONFLICT', '字幕预览已过期、取消或选项已变化，请重新预览。')
    return value
  }
  private assertBaseline(plan: Pick<Plan, 'target' | 'baseline'>) {
    const actual = this.options.store.transcriptImportBaseline(plan.target)
    if (JSON.stringify(actual) !== JSON.stringify(plan.baseline))
      throw new AppError('CONFLICT', '正式文稿已变化，旧字幕预览没有覆盖新修改。请重新选择文件。')
  }
  private signal(owner: Request) {
    return AbortSignal.any([owner.controller.signal, this.lifetime.signal])
  }
  private async choose(
    select: () => Promise<string | null>,
    signal: AbortSignal,
  ): Promise<string | null> {
    signal.throwIfAborted()
    let abort: (() => void) | undefined
    try {
      return await Promise.race([
        select(),
        new Promise<never>((_, reject) => {
          abort = () => reject(new AppError('CONFLICT', '字幕导入已取消。'))
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        }),
      ])
    } finally {
      if (abort) signal.removeEventListener('abort', abort)
    }
  }
  private parse(plan: Plan) {
    plan.document = null
    plan.metadata = null
    plan.encoding = null
    plan.errors = []
    let decoded: ReturnType<typeof decodeSubtitleImport>
    try {
      decoded = decodeSubtitleImport(plan.file, plan.options.encoding)
      plan.encoding = decoded.encoding
    } catch (error) {
      if (!(error instanceof AppError)) throw error
      plan.status = plan.file.format === 'srt' ? 'encoding-required' : 'invalid'
      plan.errors = [error.message.slice(0, 500)]
      return
    }
    try {
      const result = parseTimedSubtitles(
        decoded.text,
        plan.file.format,
        plan.target.audioHash,
        plan.durationMs,
        plan.options.offsetMs,
      )
      plan.document = result.document
      plan.metadata = result.metadata
      if (decoded.encoding !== 'utf-8')
        plan.metadata.warnings.push({ code: 'encoding-converted', count: 1, firstLine: null })
      if (plan.options.offsetMs)
        plan.metadata.warnings.push({ code: 'time-offset', count: 1, firstLine: null })
      plan.status = 'ready'
    } catch (error) {
      if (!(error instanceof AppError)) throw error
      plan.status = 'invalid'
      plan.errors = [error.message.slice(0, 500)]
    }
  }
  importJson(
    target: TranscriptRequest,
    select: () => Promise<string | null>,
  ): Promise<{ canceled: true } | { canceled: false; state: TranscriptState }> {
    this.open()
    const baseline = this.options.store.transcriptImportBaseline(target)
    return this.track(async () => {
      const signal = this.lifetime.signal
      try {
        const path = await this.choose(select, signal)
        if (!path) return { canceled: true }
        const document = await readTranscript(
          path,
          target.audioHash,
          this.options.store.getEpisode(target.episodeId)?.durationMs ?? null,
          signal,
        )
        signal.throwIfAborted()
        this.open()
        this.assertBaseline({ target, baseline })
        const state = this.options.store.saveTranscript(target.episodeId, document)
        this.options.notify(target)
        return { canceled: false, state }
      } catch (error) {
        if (signal.aborted) return { canceled: true }
        throw error
      }
    })
  }
  preview(
    request: SubtitleImportRequest,
    select: () => Promise<string | null>,
  ): Promise<SubtitleImportSelection> {
    this.open()
    this.expire()
    if (this.requests.has(request.requestId) || this.requests.size >= MAX_SUBTITLE_IMPORT_PREVIEWS)
      return Promise.reject(new AppError('BUSY', '已有字幕导入预览，请先取消或完成当前操作。'))
    const target = { episodeId: request.episodeId, audioHash: request.audioHash },
      baseline = this.options.store.transcriptImportBaseline(target),
      episode = this.options.store.getEpisode(target.episodeId)!,
      owner: Request = {
        id: request.requestId,
        controller: new AbortController(),
        expiresAt: this.now() + SUBTITLE_IMPORT_PREVIEW_TTL_MS,
        pending: new Set(),
      }
    this.requests.set(owner.id, owner)
    return this.track(async () => {
      const signal = this.signal(owner)
      try {
        const path = await this.choose(select, signal)
        if (!path) {
          this.drop(owner)
          return { canceled: true }
        }
        const file = await readSubtitleImportFile(path, signal)
        this.open()
        this.assertBaseline({ target, baseline })
        const plan: Plan = {
          token: randomUUID(),
          revision: 1,
          owner,
          target,
          baseline,
          episodeTitle: episode.title,
          file,
          options: { encoding: request.encoding, offsetMs: request.offsetMs },
          encoding: null,
          durationMs: this.options.store.getEpisode(target.episodeId)?.durationMs ?? null,
          document: null,
          metadata: null,
          status: 'invalid',
          errors: [],
          busy: false,
        }
        await setImmediate(undefined, { signal })
        this.parse(plan)
        signal.throwIfAborted()
        this.assertBaseline(plan)
        this.plans.set(plan.token, plan)
        return { canceled: false, preview: this.page({ token: plan.token, revision: 1, page: 0 }) }
      } catch (error) {
        const canceled = signal.aborted
        this.drop(owner)
        if (canceled) return { canceled: true }
        throw error
      }
    }, owner)
  }
  page(request: SubtitleImportPageRequest): SubtitleImportPreview {
    const plan = this.plan(request.token, request.revision),
      segments = plan.document?.segments ?? [],
      coverage = plan.document?.coverage,
      pages = Math.max(1, Math.ceil(segments.length / SUBTITLE_IMPORT_PAGE_SIZE))
    this.assertBaseline(plan)
    if (!Number.isSafeInteger(request.page) || request.page < 0 || request.page >= pages)
      throw new AppError('INVALID_REQUEST', '字幕预览页码无效。')
    return {
      ...plan.target,
      token: plan.token,
      revision: plan.revision,
      expiresAt: plan.owner.expiresAt,
      episodeTitle: plan.episodeTitle,
      previousRevision: plan.baseline.revision,
      fileName: plan.file.fileName,
      format: plan.file.format,
      sourceBytes: plan.file.bytes.length,
      sourceSha256: plan.file.sha256,
      options: { ...plan.options },
      encoding: plan.encoding,
      status: plan.status,
      errors: [...plan.errors],
      metadata: plan.metadata ? structuredClone(plan.metadata) : null,
      durationMs: plan.durationMs,
      coverage: coverage?.length
        ? {
            ranges: coverage.length,
            coveredMs: coverage.reduce((sum, value) => sum + value.endMs - value.startMs, 0),
            firstMs: coverage[0]!.startMs,
            lastMs: coverage.at(-1)!.endMs,
          }
        : null,
      page: request.page,
      pages,
      rows: structuredClone(
        segments.slice(
          request.page * SUBTITLE_IMPORT_PAGE_SIZE,
          (request.page + 1) * SUBTITLE_IMPORT_PAGE_SIZE,
        ),
      ),
    }
  }
  update(request: SubtitleImportPreviewRequest): Promise<SubtitleImportPreview> {
    const plan = this.plan(request.token, request.revision)
    if (plan.busy) return Promise.reject(new AppError('BUSY', '字幕预览正在处理，请稍候。'))
    plan.busy = true
    return this.track(async () => {
      const signal = this.signal(plan.owner)
      try {
        await setImmediate(undefined, { signal })
        this.assertBaseline(plan)
        plan.options = { encoding: request.encoding, offsetMs: request.offsetMs }
        plan.durationMs = this.options.store.getEpisode(plan.target.episodeId)?.durationMs ?? null
        this.parse(plan)
        plan.revision++
        return this.page({ token: plan.token, revision: plan.revision, page: 0 })
      } catch (error) {
        if (signal.aborted) throw new AppError('CONFLICT', '字幕预览已取消，原文稿保持。')
        throw error
      } finally {
        plan.busy = false
      }
    }, plan.owner)
  }
  apply(request: ApplySubtitleImport): Promise<SubtitleImportResult> {
    this.open()
    const replay = this.options.store.replaySubtitleImport(request)
    if (replay) return Promise.resolve(replay)
    const plan = this.plan(request.token, request.revision)
    if (plan.busy) return Promise.reject(new AppError('BUSY', '字幕预览正在处理，请稍候。'))
    if (!plan.document || !plan.metadata || !plan.encoding || plan.status !== 'ready')
      return Promise.reject(
        new AppError('INVALID_TRANSCRIPT', '字幕预览尚未通过，请先修正文件或编码。'),
      )
    plan.busy = true
    return this.track(async () => {
      const signal = this.signal(plan.owner)
      try {
        const audio = this.options.store.getAudio(plan.target.episodeId)
        if (!audio || audio.contentHash !== plan.target.audioHash)
          throw new AppError('FILE_CHANGED', '音频版本已变化，旧字幕没有导入。')
        await checkAudio(audio)
        const hash = createHash('sha256')
        for await (const bytes of createReadStream(audio.path, { signal })) hash.update(bytes)
        if (hash.digest('hex') !== plan.target.audioHash)
          throw new AppError('FILE_CHANGED', '音频内容已变化，字幕没有绑定到旧版本。')
        await checkAudio(audio)
        signal.throwIfAborted()
        this.plan(request.token, request.revision)
        this.assertBaseline(plan)
        const document = validateTranscript(
          plan.document,
          plan.target.audioHash,
          this.options.store.getEpisode(plan.target.episodeId)?.durationMs ?? null,
        )
        const result = this.options.store.commitSubtitleImport({
          target: plan.target,
          baseline: plan.baseline,
          document,
          token: plan.token,
          previewRevision: plan.revision,
          commandId: request.commandId,
          source: {
            fileName: plan.file.fileName,
            format: plan.file.format,
            encoding: plan.encoding!,
            bytes: plan.file.bytes,
            sha256: plan.file.sha256,
            metadata: plan.metadata!,
            offsetMs: plan.options.offsetMs,
          },
        })
        if (!result.replayed) this.options.notify(plan.target)
        this.plans.delete(plan.token)
        this.requests.delete(plan.owner.id)
        return result
      } catch (error) {
        if (signal.aborted) throw new AppError('CONFLICT', '字幕导入已取消，原文稿保持。')
        throw error
      } finally {
        plan.busy = false
      }
    }, plan.owner)
  }
  cancel(requestId: string): Promise<void> {
    return this.track(async () => {
      const owner = this.requests.get(requestId)
      if (!owner) return
      this.drop(owner)
      await Promise.allSettled([...owner.pending])
    })
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.lifetime.abort()
    for (const owner of this.requests.values()) owner.controller.abort()
    await Promise.allSettled([...this.pending])
    this.plans.clear()
    this.requests.clear()
  }
}
