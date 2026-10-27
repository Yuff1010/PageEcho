import { randomUUID } from 'node:crypto'
import type { LibraryStore } from '../database'
import type { RuntimeProvider, TranscriptionQueue } from '../transcription-queue'
import { checkAudio } from '../media'
import { AppError } from '../../shared/validation'
import type { OriginalTarget } from '../../shared/original'
import type {
  ApplyOriginalAcousticRequest,
  OriginalAcousticJob,
  OriginalAcousticRequest,
  OriginalAcousticState,
  RestoreOriginalAcousticRequest,
} from '../../shared/original-acoustic'
import { runOriginalAcoustic } from './acoustic-process'
import type { OriginalAcousticSnapshot } from './acoustic-snapshot'

interface Run {
  job: OriginalAcousticJob
  snapshot: OriginalAcousticSnapshot
  controller: AbortController
  done?: Promise<void>
}
function key(target: OriginalTarget) {
  return `${target.episodeId}:${target.audioHash}`
}
export class OriginalAcousticService {
  private active?: Run
  private previews = new Map<string, Run>()
  private closed = false
  constructor(
    private store: LibraryStore,
    private component: RuntimeProvider,
    private queue: Pick<TranscriptionQueue, 'withModelLease' | 'maintaining'>,
    private notify: (target: OriginalTarget, saved: boolean) => void,
    private log: (error: unknown) => void,
    private runner = runOriginalAcoustic,
  ) {}
  private changed(run: Run, saved = false) {
    if (!this.closed)
      this.notify({ episodeId: run.job.episodeId, audioHash: run.job.audioHash }, saved)
  }
  private audio(target: OriginalTarget) {
    const audio = this.store.getAudio(target.episodeId)
    if (!audio || audio.contentHash !== target.audioHash)
      throw new AppError('FILE_CHANGED', '音频版本已变化，请重新打开章节。')
    return audio
  }
  state(target: OriginalTarget): OriginalAcousticState {
    this.audio(target)
    return {
      configured: this.component.configured,
      job: this.previews.get(key(target))?.job ?? null,
    }
  }
  start(request: OriginalAcousticRequest): OriginalAcousticState {
    if (this.store.processingResources().paused)
      throw new AppError('BUSY', '处理已暂停，请先在处理资源中恢复。')
    const runnable = this.store.activeJobs().some((job) => {
      const owner = this.store.offlineJobOwnership(job.id)
      return !owner.planned || owner.manual || owner.runnable
    })
    if (this.closed || this.active || this.queue.maintaining || runnable)
      throw new AppError('BUSY', '请先取消或完成当前生成任务，再进行原文声音对齐。')
    const snapshot = this.store.originals.acousticSnapshot(request)
    const audio = this.audio(request)
    // Only the pinned Chinese alignment model is used by the fixed child script.
    const runtime = {
      ...this.component.runtime('paraformer', request.device),
      ...this.store.processingResources().policy,
    }
    const run: Run = {
      snapshot,
      controller: new AbortController(),
      job: {
        id: randomUUID(),
        episodeId: request.episodeId,
        audioHash: request.audioHash,
        originalId: request.originalId,
        alignmentRevision: request.revision,
        transcriptId: snapshot.transcriptId,
        transcriptRevision: snapshot.transcriptRevision,
        segmentId: request.segmentId,
        device: request.device,
        originalText: snapshot.originalText,
        selection: { ...snapshot.selection },
        oldRange: { ...snapshot.oldRange },
        status: 'running',
        stage: 'checking-components',
        createdAt: new Date().toISOString(),
        result: null,
        error: null,
      },
    }
    this.active = run
    this.previews.delete(key(request))
    this.previews.set(key(request), run)
    while (this.previews.size > 8) this.previews.delete(this.previews.keys().next().value!)
    this.changed(run)
    run.done = this.execute(run, runtime, audio)
    return this.state(request)
  }
  private async execute(
    run: Run,
    runtime: Parameters<typeof runOriginalAcoustic>[0],
    audio: NonNullable<ReturnType<LibraryStore['getAudio']>>,
  ) {
    try {
      await this.queue.withModelLease(async (leaseSignal) => {
        const signal = AbortSignal.any([run.controller.signal, leaseSignal])
        signal.throwIfAborted()
        await checkAudio(audio)
        signal.throwIfAborted()
        run.job.stage = 'aligning'
        this.changed(run)
        const result = await this.runner(runtime, run.snapshot, audio.path, run.job.id, signal)
        signal.throwIfAborted()
        await checkAudio(this.audio(run.job))
        signal.throwIfAborted()
        const current = this.store.originals.acousticSnapshot(run.snapshot)
        if (JSON.stringify(current) !== JSON.stringify(run.snapshot))
          throw new AppError('CONFLICT', '原文、文稿或人工同步点已更新，旧对齐建议已忽略。')
        run.job.result = result
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
        run.job.error =
          error instanceof AppError ? error.message : '原文声音对齐未完成，原人工同步点保留。'
        this.log(error)
      }
    } finally {
      run.job.stage = 'done'
      if (this.active === run) this.active = undefined
      this.changed(run)
    }
  }
  cancel(id: string): void {
    if (this.active?.job.id !== id) return
    this.active.job.status = 'canceled'
    this.active.controller.abort()
    this.changed(this.active)
  }
  async apply(request: ApplyOriginalAcousticRequest) {
    const run = [...this.previews.values()].find((entry) => entry.job.id === request.id)
    if (!run || run.job.status !== 'ready' || !run.job.result)
      throw new AppError('CONFLICT', '对齐建议已变化，请重新打开或生成预览。')
    await checkAudio(this.audio(run.job))
    if (this.closed || run.job.status !== 'ready')
      throw new AppError('CONFLICT', '对齐建议已变化，未采用旧预览。')
    const state = this.store.originals.applyAcoustic(
      run.snapshot,
      run.job.id,
      run.job.result,
      request.revision,
    )
    run.job.status = 'applied'
    this.changed(run, true)
    return state
  }
  async restore(request: RestoreOriginalAcousticRequest) {
    await checkAudio(this.audio(request))
    if (this.closed) throw new AppError('BUSY', '应用正在退出，请稍后重试。')
    const result = this.store.originals.restoreAcoustic(request)
    this.notify({ episodeId: request.episodeId, audioHash: request.audioHash }, true)
    return result
  }
  async close(): Promise<void> {
    this.closed = true
    const run = this.active
    run?.controller.abort()
    await run?.done
    this.previews.clear()
  }
}
