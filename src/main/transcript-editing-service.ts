import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import type { LibraryStore, StoredAudio } from './database'
import type { RuntimeProvider, TranscriptionQueue } from './transcription-queue'
import type { TranscriptRequest } from '../shared/transcript'
import {
  MAX_RETIMED_SEGMENTS,
  REPLACEMENT_PAGE_SIZE,
  type TranscriptAlignmentRequest,
  type TranscriptAlignmentJob,
  type TranscriptAlignmentState,
  type TranscriptEditRequest,
  type TranscriptEditResult,
  type TranscriptHistoryRequest,
  type TranscriptReplacementRequest,
  type TranscriptReplacementPreview,
  type ApplyTranscriptReplacement,
  type ApplyTranscriptAlignment,
} from '../shared/transcript-editing'
import { MAX_ACOUSTIC_RANGE_MS, MAX_ACOUSTIC_TEXT_LENGTH } from '../shared/original-acoustic'
import { AppError } from '../shared/validation'
import { checkAudio } from './media'
import { lexicalCharacters, runTextAcoustic } from './original/acoustic-process'
import type { AcousticTextSnapshot } from './original/acoustic-snapshot'
import type { PreparedTranscriptReplacement } from './transcript-edit-store'
import { applyTranscriptEdit } from './transcript-edit-operations'

const TTL_MS = 300_000
interface Options {
  store: LibraryStore
  component: RuntimeProvider
  queue: Pick<TranscriptionQueue, 'withModelLease' | 'maintaining'>
  notify: (target: TranscriptRequest, saved: boolean) => void
  log: (error: unknown) => void
  runner?: typeof runTextAcoustic
  checkRuntime?: (
    runtime: Parameters<typeof runTextAcoustic>[0],
    signal: AbortSignal,
  ) => Promise<void>
  now?: () => number
}
interface AlignmentRun {
  job: TranscriptAlignmentJob
  snapshot: AcousticTextSnapshot
  signature: string
  controller: AbortController
  done?: Promise<void>
  commandId?: string
}
function key(target: TranscriptRequest) {
  return `${target.episodeId}:${target.audioHash}`
}
function sha(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

/** Edits publish through the same protected store; model work only produces suggestions. */
export class TranscriptEditingService {
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly replacements = new Map<
    string,
    {
      requestId: string
      expiresAt: number
      plan: PreparedTranscriptReplacement
      commandId?: string
    }
  >()
  private readonly replacementRequests = new Map<
    string,
    { controller: AbortController; done: Promise<TranscriptReplacementPreview> }
  >()
  private readonly alignments = new Map<string, AlignmentRun>()
  private active: AlignmentRun | undefined
  private closed = false
  constructor(private readonly options: Options) {}
  private now() {
    return this.options.now?.() ?? Date.now()
  }
  private open(): void {
    if (this.closed) throw new AppError('BUSY', '应用正在退出，未保存新的字幕修改。')
  }
  private track<T>(action: () => Promise<T>): Promise<T> {
    try {
      this.open()
      const done = action().finally(() => this.pending.delete(done))
      this.pending.add(done)
      return done
    } catch (error) {
      return Promise.reject(error)
    }
  }
  private publish(result: TranscriptEditResult): TranscriptEditResult {
    for (const target of result.changed) this.options.notify(target, true)
    return result
  }
  state(target: TranscriptRequest) {
    this.open()
    return this.options.store.transcriptEditingState(target)
  }
  change(request: TranscriptEditRequest) {
    this.open()
    return this.publish(this.options.store.performTranscriptEdit(request))
  }
  undo(request: TranscriptHistoryRequest) {
    this.open()
    return this.publish(this.options.store.undoTranscriptEdit(request))
  }
  redo(request: TranscriptHistoryRequest) {
    this.open()
    return this.publish(this.options.store.redoTranscriptEdit(request))
  }
  previewReplacement(request: TranscriptReplacementRequest): Promise<TranscriptReplacementPreview> {
    return this.track(async () => {
      if (this.replacementRequests.has(request.requestId) || this.replacementRequests.size >= 2)
        throw new AppError('BUSY', '已有批量纠错预览正在进行，请先取消或等待完成。')
      const controller = new AbortController(),
        signal = AbortSignal.any([controller.signal, this.lifetime.signal])
      const done = (async () => {
        await setImmediate(undefined, { signal })
        const plan = this.options.store.prepareTranscriptReplacement(structuredClone(request))
        signal.throwIfAborted()
        this.open()
        for (const [token, value] of this.replacements)
          if (value.expiresAt <= this.now()) this.replacements.delete(token)
        while (this.replacements.size >= 2)
          this.replacements.delete(this.replacements.keys().next().value!)
        const token = randomUUID()
        this.replacements.set(token, {
          requestId: request.requestId,
          expiresAt: this.now() + TTL_MS,
          plan,
        })
        return this.replacementPage({ token, page: 0 })
      })().finally(() => this.replacementRequests.delete(request.requestId))
      this.replacementRequests.set(request.requestId, { controller, done })
      return done
    })
  }
  replacementPage(request: { token: string; page: number }): TranscriptReplacementPreview {
    this.open()
    const value = this.replacements.get(request.token)
    if (!value || value.expiresAt <= this.now())
      throw new AppError('CONFLICT', '批量纠错预览已失效，请重新预览。')
    const plan = value.plan,
      pages = Math.max(1, Math.ceil(plan.changes.length / REPLACEMENT_PAGE_SIZE))
    if (!Number.isSafeInteger(request.page) || request.page < 0 || request.page >= pages)
      throw new AppError('INVALID_REQUEST', '批量纠错预览页码无效。')
    return {
      token: request.token,
      expiresAt: value.expiresAt,
      find: plan.find,
      replacement: plan.replacement,
      episodes: plan.episodes,
      segments: plan.segments,
      occurrences: plan.occurrences,
      skippedEpisodes: plan.skippedEpisodes,
      page: request.page,
      pages,
      changes: structuredClone(
        plan.changes.slice(
          request.page * REPLACEMENT_PAGE_SIZE,
          (request.page + 1) * REPLACEMENT_PAGE_SIZE,
        ),
      ),
    }
  }
  applyReplacement(request: ApplyTranscriptReplacement): TranscriptEditResult {
    this.open()
    const value = this.replacements.get(request.token)
    if (
      !value ||
      value.expiresAt <= this.now() ||
      (value.commandId && value.commandId !== request.commandId)
    )
      throw new AppError('CONFLICT', '批量纠错预览已失效或已被采用，请重新预览。')
    const result = this.options.store.commitTranscriptReplacement(value.plan, request.commandId)
    value.commandId = request.commandId
    return this.publish(result)
  }
  cancelReplacement(requestId: string): Promise<void> {
    return this.track(async () => {
      const request = this.replacementRequests.get(requestId)
      request?.controller.abort()
      await request?.done.catch(() => undefined)
      for (const [token, value] of this.replacements)
        if (value.requestId === requestId) this.replacements.delete(token)
    })
  }
  private async audio(
    target: TranscriptRequest,
    signal: AbortSignal,
    full = false,
  ): Promise<StoredAudio> {
    signal.throwIfAborted()
    const audio = this.options.store.getAudio(target.episodeId)
    if (!audio || audio.contentHash !== target.audioHash)
      throw new AppError('FILE_CHANGED', '音频版本已变化，请重新打开这一集。')
    await checkAudio(audio)
    if (full) {
      const hash = createHash('sha256')
      for await (const bytes of createReadStream(audio.path, { signal })) hash.update(bytes)
      if (hash.digest('hex') !== target.audioHash)
        throw new AppError('FILE_CHANGED', '音频内容已变化，旧时间建议没有采用。')
      await checkAudio(audio)
    }
    signal.throwIfAborted()
    return audio
  }
  private snapshot(request: TranscriptAlignmentRequest) {
    const audio = this.options.store.getAudio(request.episodeId)
    const stored = this.options.store.getTranscript(request.episodeId, request.audioHash)
    if (!audio || audio.contentHash !== request.audioHash)
      throw new AppError('FILE_CHANGED', '音频版本已变化。')
    if (stored.status !== 'ready' || stored.transcript.revision !== request.revision)
      throw new AppError('CONFLICT', '文稿已更新，旧的声音校准选择已失效。')
    const document = stored.transcript.document,
      indices = request.segmentIds
        .map((id) => document.segments.findIndex((segment) => segment.id === id))
        .sort((a, b) => a - b)
    if (
      !indices.length ||
      indices.length > MAX_RETIMED_SEGMENTS ||
      indices[0]! < 0 ||
      new Set(indices).size !== indices.length ||
      indices.some((value, index) => index > 0 && value !== indices[index - 1]! + 1)
    )
      throw new AppError('INVALID_REQUEST', '声音校准需要选择 1–20 个连续句子。')
    const segments = indices.map((index) => document.segments[index]!),
      first = segments[0]!,
      last = segments.at(-1)!
    const coverage = document.coverage.find(
      (range) => range.startMs <= first.startMs && range.endMs >= last.endMs,
    )
    if (!coverage || last.endMs - first.startMs > MAX_ACOUSTIC_RANGE_MS)
      throw new AppError('INVALID_REQUEST', '声音校准不能跨越未覆盖区间，每次最多 60 秒。')
    if (segments.some((segment) => !lexicalCharacters(segment.text).length))
      throw new AppError(
        'INVALID_REQUEST',
        '纯标点或空白句不能生成声音时间，请先选择有文字的句子。',
      )
    let offset = 0
    const sentences = segments.map((segment, ordinal) => {
        const value = { ordinal, textStart: offset, textEnd: offset + segment.text.length }
        offset = value.textEnd + 1
        return value
      }),
      originalText = segments.map((segment) => segment.text).join('\n')
    if (Array.from(originalText).length > MAX_ACOUSTIC_TEXT_LENGTH)
      throw new AppError('INVALID_REQUEST', '一次声音校准最多 1,000 字，请缩小选择范围。')
    const previous = document.segments[indices[0]! - 1],
      next = document.segments[indices.at(-1)! + 1]
    let startMs = Math.max(coverage.startMs, previous?.endMs ?? 0, first.startMs - 1000),
      endMs = Math.min(coverage.endMs, next?.startMs ?? Infinity, last.endMs + 1000)
    if (endMs - startMs > MAX_ACOUSTIC_RANGE_MS) {
      startMs = first.startMs
      endMs = last.endMs
    }
    const snapshot: AcousticTextSnapshot = {
      audioHash: request.audioHash,
      device: request.device,
      originalText,
      textHash: sha(originalText),
      range: { startMs, endMs },
      sentences,
    }
    const signature = sha(
      JSON.stringify({
        id: stored.transcript.id,
        revision: request.revision,
        coverage: document.coverage,
        segments,
        previous,
        next,
      }),
    )
    return {
      snapshot,
      signature,
      segments: structuredClone(segments),
      transcriptId: stored.transcript.id,
      document,
    }
  }
  alignmentState(target: TranscriptRequest): TranscriptAlignmentState {
    this.open()
    return {
      configured: this.options.component.configured,
      job: this.alignments.get(key(target))?.job ?? null,
    }
  }
  startAlignment(request: TranscriptAlignmentRequest): TranscriptAlignmentState {
    this.open()
    if (this.options.store.processingResources().paused)
      throw new AppError('BUSY', '处理已暂停，请先恢复处理再校准。')
    if (this.active || this.options.queue.maintaining)
      throw new AppError('BUSY', '模型正在处理其他任务，请稍后重试。')
    if (
      this.options.store.activeJobs().some((job) => {
        const owner = this.options.store.offlineJobOwnership(job.id)
        return !owner.planned || owner.manual || owner.runnable
      })
    )
      throw new AppError('BUSY', '请先暂停或完成当前转写任务，再按声音重对齐。')
    const prepared = this.snapshot(request),
      runtime = {
        ...this.options.component.runtime('paraformer', request.device),
        ...this.options.store.processingResources().policy,
      }
    const run: AlignmentRun = {
      snapshot: prepared.snapshot,
      signature: prepared.signature,
      controller: new AbortController(),
      job: {
        id: randomUUID(),
        episodeId: request.episodeId,
        audioHash: request.audioHash,
        revision: request.revision,
        transcriptId: prepared.transcriptId,
        device: request.device,
        segments: prepared.segments,
        status: 'running',
        stage: 'checking-components',
        createdAt: new Date().toISOString(),
        result: null,
        ranges: [],
        error: null,
      },
    }
    this.active = run
    this.alignments.set(key(request), run)
    while (this.alignments.size > 8) this.alignments.delete(this.alignments.keys().next().value!)
    this.options.notify(request, false)
    run.done = this.executeAlignment(run, runtime)
    return this.alignmentState(request)
  }
  private async executeAlignment(
    run: AlignmentRun,
    runtime: Parameters<typeof runTextAcoustic>[0],
  ): Promise<void> {
    try {
      await this.options.queue.withModelLease(async (leaseSignal) => {
        const signal = AbortSignal.any([leaseSignal, run.controller.signal, this.lifetime.signal])
        const audio = await this.audio(run.job, signal)
        await this.options.checkRuntime?.(runtime, signal)
        signal.throwIfAborted()
        run.job.stage = 'aligning'
        if (!this.closed) this.options.notify(run.job, false)
        const result = await (this.options.runner ?? runTextAcoustic)(
          runtime,
          run.snapshot,
          audio.path,
          run.job.id,
          signal,
        )
        await this.audio(run.job, signal, true)
        this.open()
        const current = this.snapshot({
          ...run.job,
          requestId: run.job.id,
          segmentIds: run.job.segments.map((segment) => segment.id),
        })
        if (current.signature !== run.signature)
          throw new AppError('CONFLICT', '文稿或时间已经修改，旧的声音建议已忽略。')
        const ranges =
          result.status === 'accepted'
            ? result.sentenceTimes.map((time, index) => {
                if (time.ordinal !== index)
                  throw new AppError('INTERNAL', '声音建议未完整对应所选句子。')
                return {
                  segmentId: run.job.segments[index]!.id,
                  startMs: time.startMs,
                  endMs: time.endMs,
                }
              })
            : []
        if (result.status === 'accepted') {
          if (ranges.length !== run.job.segments.length)
            throw new AppError('INTERNAL', '声音建议缺少所选句子的时间，原字幕保持。')
          applyTranscriptEdit(
            current.document,
            { kind: 'timing', ranges },
            this.options.store.getEpisode(run.job.episodeId)?.durationMs ?? null,
          )
        }
        signal.throwIfAborted()
        run.job.result = result
        run.job.ranges = ranges
        run.job.status = result.status === 'accepted' ? 'ready' : 'rejected'
      })
    } catch (error) {
      if (
        run.controller.signal.aborted ||
        this.closed ||
        (error instanceof Error && error.name === 'AbortError')
      )
        run.job.status = 'canceled'
      else {
        run.job.status = 'failed'
        run.job.error = error instanceof AppError ? error.message : '声音校准未完成，原字幕保持。'
        this.options.log(error)
      }
    } finally {
      run.job.stage = 'done'
      if (this.active === run) this.active = undefined
      if (!this.closed) this.options.notify(run.job, false)
    }
  }
  cancelAlignment(id: string): Promise<void> {
    return this.track(async () => {
      const run = [...this.alignments.values()].find((value) => value.job.id === id)
      if (!run || run.job.status === 'applied') return
      run.controller.abort()
      await run.done
      run.job.status = 'canceled'
      if (!this.closed) this.options.notify(run.job, false)
    })
  }
  applyAlignment(request: ApplyTranscriptAlignment): Promise<TranscriptEditResult> {
    return this.track(async () => {
      const run = [...this.alignments.values()].find((value) => value.job.id === request.id)
      if (
        !run ||
        !['ready', 'applied'].includes(run.job.status) ||
        (run.commandId && run.commandId !== request.commandId) ||
        request.revision !== run.job.revision
      )
        throw new AppError('CONFLICT', '声音建议已失效，请重新生成。')
      if (run.commandId)
        return this.publish(
          this.options.store.performTranscriptEdit(
            {
              episodeId: run.job.episodeId,
              audioHash: run.job.audioHash,
              revision: run.job.revision,
              commandId: request.commandId,
              operation: { kind: 'timing', ranges: run.job.ranges },
            },
            '采用声音重对齐',
          ),
        )
      await this.audio(run.job, this.lifetime.signal, true)
      this.open()
      if (run.job.status !== 'ready') throw new AppError('CONFLICT', '声音建议已取消，原字幕保持。')
      const current = this.snapshot({
        ...run.job,
        requestId: run.job.id,
        segmentIds: run.job.segments.map((segment) => segment.id),
      })
      if (current.signature !== run.signature)
        throw new AppError('CONFLICT', '文稿已修改，旧的声音建议没有采用。')
      const result = this.options.store.performTranscriptEdit(
        {
          episodeId: run.job.episodeId,
          audioHash: run.job.audioHash,
          revision: run.job.revision,
          commandId: request.commandId,
          operation: { kind: 'timing', ranges: run.job.ranges },
        },
        '采用声音重对齐',
      )
      run.commandId = request.commandId
      run.job.status = 'applied'
      return this.publish(result)
    })
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.lifetime.abort()
    this.active?.controller.abort()
    for (const request of this.replacementRequests.values()) request.controller.abort()
    await this.active?.done
    await Promise.allSettled([...this.pending])
    this.replacements.clear()
    this.alignments.clear()
  }
}
