import { createHash } from 'node:crypto'
import {
  AsrWorkerProcess,
  type AsrRuntime,
  type AsrEvent,
  type AsrOutcome,
  type AsrSubmission,
} from './asr-process'
import type { LibraryStore, StoredTranscriptionJob, UnsavedJobTerminal } from './database'
import type { TaskPage, TaskQuery } from '../shared/maintenance'
import type {
  StartTranscription,
  TranscriptionChange,
  TranscriptionPreview,
  TranscriptionState,
  TranscriptionSyncState,
  TranscriptionSummaryState,
} from '../shared/transcription'
import type { TranscriptRequest, TranscriptVersion } from '../shared/transcript'
import { AppError } from '../shared/validation'
import { checkAudio } from './media'
import type { SubtitleStatusTarget } from '../shared/subtitle-status'
import type {
  ProcessingResources,
  SavedProcessingResources,
  UpdateProcessingPolicy,
  PauseProcessing,
} from '../shared/processing-resources'

export interface TranscriptionWorker {
  readonly ready: Promise<void>
  readonly configuration: Record<string, unknown> | undefined
  readonly diagnosticLog: string
  submit(submission: AsrSubmission, onEvent: (event: AsrEvent) => void): Promise<AsrOutcome>
  cancel(id: string, attempt: number): void
  prioritize?(id: string, attempt: number, positionMs: number): void
  close(): Promise<void>
  setLowPriority?(low: boolean): void
  resources?(): ProcessingResources['worker']
}
export interface ResourceScheduler {
  idleSeconds?: () => number
  now?: () => number
  notify?: () => void
  pollMs?: number
  idleReleaseMs?: number
}
export interface RuntimeProvider {
  readonly configured: boolean
  runtime(engine: AsrRuntime['engine'], device: AsrRuntime['device']): AsrRuntime
}
export interface OfflineJobContext {
  planRevision: number
  attempt: number
}
function configurationHash(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical)
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => [key, canonical(value)]),
      )
    return item
  }
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}

export const EPISODE_SWITCHED = '已切换章节，完成片段可在重试时复用。'

interface ActiveRun {
  job: StoredTranscriptionJob
  controller: AbortController
  worker?: TranscriptionWorker
  submitted: boolean
  done?: Promise<void>
}
export class TranscriptionQueue {
  private stopped = false
  private enabled = false
  private active?: ActiveRun
  private worker?: TranscriptionWorker
  private profile = ''
  private maintenance = false
  private maintenanceDone?: Promise<unknown>
  private modelLease?: { controller: AbortController; done?: Promise<unknown> }
  private unsavedTerminal?: UnsavedJobTerminal
  private resumeAfterCancel = new Map<string, boolean>()
  private stoppedPreparations = new Map<string, TranscriptRequest>()
  private priorities = new Map<string, { audioHash: string; positionMs: number }>()
  private resourceSettings: SavedProcessingResources
  private resourceTimer?: NodeJS.Timeout
  private releasing?: Promise<void>
  private lastWorkerUse = 0
  private resourceFingerprint = ''
  private currentEpisodeId?: string

  private runnable(job: StoredTranscriptionJob): boolean {
    const owner = this.store.offlineJobOwnership(job.id)
    return !owner.planned || owner.manual || owner.runnable
  }

  resources(): ProcessingResources {
    const current = this.active && this.current(this.active)
    return {
      ...this.resourceSettings,
      policy: { ...this.resourceSettings.policy },
      status: this.resourceSettings.paused
        ? 'paused'
        : this.modelLease
          ? 'model-lease'
          : current
            ? 'running'
            : this.releasing || this.active
              ? 'releasing'
              : this.waitingForIdle()
                ? 'waiting-idle'
                : 'ready',
      active: current
        ? { jobId: current.id, episodeId: current.episodeId, cpuThreads: current.cpuThreads ?? 4 }
        : null,
      worker: this.worker?.resources?.() ?? null,
    }
  }
  private emitResources(): void {
    if (this.stopped) return
    const fingerprint = JSON.stringify(this.resources())
    if (fingerprint !== this.resourceFingerprint) {
      this.resourceFingerprint = fingerprint
      this.scheduler.notify?.()
    }
  }
  private idle(): boolean {
    try {
      return (this.scheduler.idleSeconds?.() ?? 0) >= 60
    } catch {
      return false
    }
  }
  private waitingForIdle(): boolean {
    const jobs = this.store.activeJobs().filter((job) => this.runnable(job))
    return (
      !!jobs.length &&
      this.resourceSettings.policy.backgroundIdleOnly &&
      !this.idle() &&
      jobs.every((job) => job.background)
    )
  }
  private interruptActive(): void {
    const active = this.active
    if (!active || active.controller.signal.aborted) return
    try {
      this.store.interruptJob(active.job.id, active.job.attempt)
    } catch (error) {
      this.rememberUnsaved(active.job, error)
    }
    active.controller.abort()
    if (active.submitted) active.worker?.cancel(active.job.id, active.job.attempt)
    else if (active.worker) void active.worker.close().catch(this.log)
    this.changed(active.job)
  }
  updateResources(request: UpdateProcessingPolicy): ProcessingResources {
    this.resourceSettings = this.store.setProcessingPolicy(request)
    let failed = false
    try {
      this.worker?.setLowPriority?.(request.policy.lowPriority)
    } catch (error) {
      this.log(error)
      failed = true
    }
    this.refreshResourceSchedule()
    if (failed)
      throw new AppError(
        'RUNTIME_UNAVAILABLE',
        '设置已保存，但当前字幕进程的优先级未改变，请核对实际状态或暂停后恢复。',
      )
    return this.resources()
  }
  pauseProcessing(request: PauseProcessing): ProcessingResources {
    this.resourceSettings = this.store.setProcessingPaused(request)
    if (request.paused) {
      this.modelLease?.controller.abort()
      this.interruptActive()
    }
    this.refreshResourceSchedule()
    return this.resources()
  }
  refreshResourceSchedule(): void {
    if (this.stopped) return
    const active = this.active && this.current(this.active)
    if (active?.background && this.resourceSettings.policy.backgroundIdleOnly && !this.idle())
      this.interruptActive()
    if (
      !this.active &&
      !this.modelLease &&
      !this.maintenance &&
      !this.releasing &&
      this.worker &&
      (this.resourceSettings.paused ||
        this.waitingForIdle() ||
        (this.scheduler.now?.() ?? Date.now()) - this.lastWorkerUse >=
          (this.scheduler.idleReleaseMs ?? 30_000))
    ) {
      const worker = this.worker
      this.worker = undefined
      this.profile = ''
      this.releasing = worker
        .close()
        .catch(this.log)
        .finally(() => {
          this.releasing = undefined
          this.emitResources()
          this.pump()
        })
    }
    this.emitResources()
    this.pump()
  }

  private visibleJob<T extends StoredTranscriptionJob | null>(job: T): T {
    const pending = this.unsavedTerminal
    return (
      job && pending?.id === job.id && pending.attempt === job.attempt
        ? { ...job, ...pending, stage: pending.status }
        : job
    ) as T
  }
  tasks(query: TaskQuery): TaskPage {
    return this.store.listJobs(query, this.unsavedTerminal)
  }
  subtitleStatuses(targets: SubtitleStatusTarget[]) {
    return this.store.subtitleStatuses(targets, this.unsavedTerminal)
  }
  private flushTerminal(): void {
    const pending = this.unsavedTerminal
    if (!pending) return
    try {
      this.store.setJobStatus(pending.id, pending.attempt, pending.status, pending.error)
      this.unsavedTerminal = undefined
    } catch {
      throw new AppError(
        'INTERNAL',
        '任务状态仍无法保存，请先释放用户数据磁盘空间并检查写入权限，再重试。',
      )
    }
  }

  get maintaining(): boolean {
    return this.maintenance || !!this.modelLease || !!this.releasing
  }
  async withModelLease<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (
      this.stopped ||
      this.maintenance ||
      this.modelLease ||
      this.releasing ||
      this.active ||
      this.store.activeJobs().some((job) => this.runnable(job))
    )
      throw new AppError('BUSY', '请先取消或完成字幕生成，再进行原文声音对齐。')
    const lease = { controller: new AbortController(), done: undefined as Promise<T> | undefined }
    this.modelLease = lease
    this.emitResources()
    lease.done = (async () => {
      const worker = this.worker
      this.worker = undefined
      this.profile = ''
      await worker?.close()
      lease.controller.signal.throwIfAborted()
      return action(lease.controller.signal)
    })()
    try {
      return await lease.done
    } finally {
      if (this.modelLease === lease) this.modelLease = undefined
      this.emitResources()
      this.pump()
    }
  }
  async withMaintenance<T>(action: () => Promise<T>, mediaOnly = false): Promise<T> {
    if (
      this.stopped ||
      this.maintenance ||
      this.modelLease ||
      this.releasing ||
      (!mediaOnly && (this.active || this.store.activeJobs().some((job) => this.runnable(job))))
    )
      throw new AppError('BUSY', '后台处理正在使用组件，请先完成或取消相关任务，再重试此操作。')
    this.maintenance = true
    const operation = (async () => {
      try {
        if (!mediaOnly) {
          await this.worker?.close()
          this.worker = undefined
        }
        return await action()
      } finally {
        this.maintenance = false
        this.pump()
      }
    })()
    this.maintenanceDone = operation
    try {
      return await operation
    } finally {
      if (this.maintenanceDone === operation) this.maintenanceDone = undefined
    }
  }

  constructor(
    private readonly store: LibraryStore,
    private readonly component: RuntimeProvider,
    private readonly notify: (change: TranscriptionChange) => void,
    private readonly log: (error: unknown) => void,
    private readonly factory: (runtime: AsrRuntime) => TranscriptionWorker = (runtime) =>
      new AsrWorkerProcess(runtime),
    private readonly checkRuntime: (
      runtime: AsrRuntime,
      signal: AbortSignal,
    ) => Promise<void> = async () => {},
    private readonly scheduler: ResourceScheduler = {},
  ) {
    this.store.recoverJobs()
    this.resourceSettings = this.store.processingResources()
    if ((scheduler.pollMs ?? 2000) > 0) {
      this.resourceTimer = setInterval(() => {
        try {
          this.refreshResourceSchedule()
        } catch (error) {
          this.log(error)
        }
      }, scheduler.pollMs ?? 2000)
      this.resourceTimer.unref()
    }
  }
  start(): void {
    this.enabled = true
    this.pump()
  }
  state(episodeId: string, audioHash: string): TranscriptionState {
    this.checkAsset(episodeId, audioHash)
    return {
      configured: this.component.configured,
      job: this.visibleJob(this.store.latestJob(episodeId, audioHash)),
      transcript: this.store.getTranscript(episodeId, audioHash),
    }
  }
  sync(episodeId: string, audioHash: string, known?: TranscriptVersion): TranscriptionSyncState {
    this.checkAsset(episodeId, audioHash)
    return {
      configured: this.component.configured,
      job: this.visibleJob(this.store.latestJob(episodeId, audioHash)),
      transcript: this.store.getTranscriptIfChanged(episodeId, audioHash, known),
    }
  }
  summary(episodeId: string, audioHash: string): TranscriptionSummaryState {
    this.checkAsset(episodeId, audioHash)
    return {
      configured: this.component.configured,
      job: this.visibleJob(this.store.latestJob(episodeId, audioHash)),
      transcriptHeader: this.store.getTranscriptHeader(episodeId, audioHash),
    }
  }
  generate(request: StartTranscription): TranscriptionState {
    if (this.stopped || this.maintenance || this.modelLease)
      throw new AppError('BUSY', '应用正在退出或清理缓存，请稍候。')
    this.flushTerminal()
    this.component.runtime(request.engine, request.device)
    const job = this.store.createJob(request)
    this.resumePreparation(request)
    this.store.claimJobForManual(job.id)
    this.enabled = true
    this.changed(job)
    this.preemptBackground(job.id)
    this.pump()
    return this.state(request.episodeId, request.audioHash)
  }
  retry(id: string): void {
    if (this.stopped || this.maintenance || this.modelLease)
      throw new AppError('BUSY', '应用正在退出或清理缓存，请稍候。')
    this.flushTerminal()
    const job = this.store.getJob(id)
    if (!job) throw new AppError('INVALID_REQUEST', '转写任务不存在。')
    this.component.runtime(job.engine, job.device)
    this.changed(this.store.retryJob(id))
    this.resumePreparation(job)
    this.store.claimJobForManual(id)
    this.enabled = true
    this.store.promoteJob(id)
    this.preemptBackground(id)
    this.pump()
  }
  cancel(id: string, reason: string | null = null): void {
    this.resumeAfterCancel.delete(id)
    const job = this.store.getJob(id)
    if (job && reason === null) this.rememberStoppedPreparation(job)
    if (!job || !['queued', 'running', 'canceling'].includes(job.status)) return
    // A later chapter switch must not replace an explicit cancellation with the
    // resumable switch reason while an inference call is still winding down.
    if (job.status === 'canceling' && reason === EPISODE_SWITCHED && job.error !== EPISODE_SWITCHED)
      return
    if (this.unsavedTerminal?.id === id && this.unsavedTerminal.attempt === job.attempt) {
      this.unsavedTerminal = {
        id,
        attempt: job.attempt,
        status: 'canceled',
        error: reason ?? '任务已停止；状态暂未写入磁盘，请恢复空间或写入权限后重试。',
      }
      try {
        this.flushTerminal()
      } catch (error) {
        this.log(error)
      }
      this.changed(job)
      this.pump()
      return
    }
    if (job.status === 'queued') this.store.setJobStatus(id, job.attempt, 'canceled', reason)
    else {
      this.store.setJobStatus(id, job.attempt, 'canceling', reason)
      const active = this.active
      if (active?.job.id === id) {
        active.controller.abort()
        if (active.submitted) active.worker?.cancel(id, job.attempt)
        else if (active.worker) void active.worker.close().catch(this.log)
      }
    }
    this.changed(job)
  }
  private preparationKey(target: TranscriptRequest): string {
    return `${target.episodeId}:${target.audioHash}`
  }
  private rememberStoppedPreparation(target: TranscriptRequest): void {
    const key = this.preparationKey(target)
    this.stoppedPreparations.delete(key)
    if (this.stoppedPreparations.size >= 10000)
      for (const [oldKey, old] of this.stoppedPreparations)
        if (this.store.getAudio(old.episodeId)?.contentHash !== old.audioHash)
          this.stoppedPreparations.delete(oldKey)
    this.stoppedPreparations.set(key, {
      episodeId: target.episodeId,
      audioHash: target.audioHash,
    })
    // Jobs retain their durable canceled state independently of this bounded
    // cache. The cache also covers checks canceled before a job existed.
    while (this.stoppedPreparations.size > 10000)
      this.stoppedPreparations.delete(this.stoppedPreparations.keys().next().value!)
  }
  preparationStopped(target: TranscriptRequest): boolean {
    return this.stoppedPreparations.has(this.preparationKey(target))
  }
  resumePreparation(target: TranscriptRequest): void {
    this.stoppedPreparations.delete(this.preparationKey(target))
  }
  stopPreparation(target: TranscriptRequest): TranscriptionState {
    this.checkAsset(target.episodeId, target.audioHash)
    this.rememberStoppedPreparation(target)
    const job = this.store.latestJob(target.episodeId, target.audioHash)
    if (job) this.cancel(job.id)
    return this.state(target.episodeId, target.audioHash)
  }
  get protectedEpisodeIds(): string[] {
    return [
      ...new Set([
        ...this.store
          .activeJobs()
          .filter((job) => this.runnable(job))
          .map((job) => job.episodeId),
        ...(this.active ? [this.active.job.episodeId] : []),
      ]),
    ]
  }
  generateBackground(request: StartTranscription): void {
    this.prepare(request, true)
  }
  startForOffline(
    itemId: string,
    request: StartTranscription,
    context?: OfflineJobContext,
  ): StoredTranscriptionJob {
    if (this.stopped || this.maintenance || this.modelLease)
      throw new AppError('BUSY', '任务正在维护，请稍后继续离线准备。')
    this.flushTerminal()
    this.checkAsset(request.episodeId, request.audioHash)
    if (this.preparationStopped(request))
      throw new AppError('CONFLICT', '本集字幕准备已停止，请在字幕工具明确重试或重新生成。')
    this.component.runtime(request.engine, request.device)
    const { job } = this.store.createOrAttachOfflineJob(itemId, request, context)
    this.enabled = true
    this.changed(job)
    this.pump()
    return this.store.getJob(job.id)!
  }
  async interruptOffline(jobIds: readonly string[]): Promise<void> {
    const pending: Promise<void>[] = []
    for (const id of new Set(jobIds)) {
      const owner = this.store.offlineJobOwnership(id),
        job = this.store.getJob(id)
      // The coordinator changes plan/item state before this call. Other plans
      // and explicit foreground ownership remain authoritative during cleanup.
      if (!job || !owner.planned || owner.manual || owner.runnable) continue
      this.store.demoteJob(id)
      const active = this.active
      if (active?.job.id === id) {
        if (this.current(active)?.status === 'running') this.interruptActive()
        if (active.done) pending.push(active.done)
      }
      this.changed(job)
    }
    await Promise.all(pending)
    this.refreshResourceSchedule()
  }
  reconcileOffline(): void {
    for (const job of this.store.activeJobs()) {
      const owner = this.store.offlineJobOwnership(job.id)
      if (!owner.planned || owner.manual) continue
      if (job.episodeId !== this.currentEpisodeId) this.store.demoteJob(job.id)
      if (!owner.runnable && this.active?.job.id === job.id) this.interruptActive()
    }
    this.refreshResourceSchedule()
  }
  prioritize(episodeId: string, audioHash: string, positionMs: number): void {
    this.checkAsset(episodeId, audioHash)
    if (!Number.isSafeInteger(positionMs) || positionMs < 0 || positionMs > 3.6e10)
      throw new AppError('INVALID_REQUEST', '字幕优先位置无效。')
    this.priorities.set(episodeId, { audioHash, positionMs })
    const active = this.active
    if (
      active?.job.episodeId === episodeId &&
      active.job.audioHash === audioHash &&
      active.submitted &&
      this.current(active)?.status === 'running'
    )
      active.worker?.prioritize?.(active.job.id, active.job.attempt, positionMs)
  }
  prepare(request: StartTranscription, background = false): TranscriptionState {
    const state = this.state(request.episodeId, request.audioHash)
    if (this.preparationStopped(request)) return state
    const job = this.store.latestJob(request.episodeId, request.audioHash)
    if (this.stopped || this.maintenance || this.modelLease)
      throw new AppError('BUSY', '任务正在维护，请稍后重试预处理。')
    if (job) {
      if (job.status === 'completed' || job.status === 'failed') return state
      if (job.status === 'canceled' && job.error !== EPISODE_SWITCHED) return state
      if (job.engine !== request.engine || job.device !== request.device)
        throw new AppError('BUSY', '这一集已有不同引擎或设备的转写任务，请先完成或取消。')
      if (job.status === 'canceling') {
        if (job.error === EPISODE_SWITCHED)
          this.resumeAfterCancel.set(
            job.id,
            this.resumeAfterCancel.get(job.id) === false ? false : background,
          )
        return state
      }
      this.flushTerminal()
      if (job.status === 'canceled') {
        this.component.runtime(job.engine, job.device)
        this.store.retryJob(job.id)
        if (background) this.store.demoteJob(job.id)
        this.changed(this.store.getJob(job.id)!)
      }
      if (!background) {
        this.store.claimJobForManual(job.id)
        this.store.promoteJob(job.id)
        this.preemptBackground(job.id)
      }
      this.enabled = true
      this.pump()
      return this.state(request.episodeId, request.audioHash)
    }
    // A saved document without a job may have been imported or corrected by the user.
    if (state.transcript.status === 'ready') return state
    this.flushTerminal()
    this.component.runtime(request.engine, request.device)
    const created = this.store.createJob(request, background)
    if (!background) this.store.claimJobForManual(created.id)
    this.enabled = true
    this.changed(created)
    if (!background) this.preemptBackground(created.id)
    this.pump()
    return this.state(request.episodeId, request.audioHash)
  }
  private preemptBackground(currentJobId: string): void {
    const active = this.active
    if (active && active.job.id !== currentJobId && this.current(active)?.background) {
      this.store.interruptJob(active.job.id, active.job.attempt)
      active.controller.abort()
      if (active.submitted) active.worker?.cancel(active.job.id, active.job.attempt)
      else if (active.worker) void active.worker.close().catch(this.log)
      this.changed(active.job)
    }
  }
  onEpisodeOpened(id: string, nextId?: string): void {
    this.currentEpisodeId = id
    for (const episodeId of this.priorities.keys())
      if (episodeId !== id && episodeId !== nextId) this.priorities.delete(episodeId)
    for (const pending of this.resumeAfterCancel.keys()) {
      const job = this.store.getJob(pending)
      if (job?.episodeId !== id && job?.episodeId !== nextId) this.resumeAfterCancel.delete(pending)
    }
    for (const job of this.store.activeJobs()) {
      const owner = this.store.offlineJobOwnership(job.id)
      if (owner.planned && !owner.manual) {
        if (job.episodeId === id && owner.runnable) this.store.promoteJob(job.id)
        else this.store.demoteJob(job.id)
      } else if (job.episodeId === id) this.store.promoteJob(job.id)
      else if (!job.background || job.episodeId !== nextId) this.cancel(job.id, EPISODE_SWITCHED)
    }
    const current = this.store
      .activeJobs()
      .find((job) => job.episodeId === id && job.status === 'queued' && this.runnable(job))
    if (current) this.preemptBackground(current.id)
  }
  cancelEpisodes(ids: string[]): void {
    for (const job of this.store.activeJobs())
      if (ids.includes(job.episodeId)) this.cancel(job.id, '音频已移除或重新导入。')
  }
  reconcile(): void {
    for (const job of this.store.activeJobs())
      if (this.store.getAudio(job.episodeId)?.contentHash !== job.audioHash)
        this.cancel(job.id, '音频版本已变化。')
  }
  changed(change: TranscriptionChange): void {
    if (!this.stopped) this.notify({ episodeId: change.episodeId, audioHash: change.audioHash })
    this.emitResources()
  }
  preview(id: string): TranscriptionPreview {
    const job = this.store.getJob(id),
      document = this.store.jobDocument(id)
    if (!job || !document) throw new AppError('INVALID_REQUEST', '还没有可预览的生成片段。')
    this.checkAsset(job.episodeId, job.audioHash)
    return { job: this.visibleJob(job), document }
  }
  private checkAsset(id: string, hash: string): void {
    if (this.store.getAudio(id)?.contentHash !== hash)
      throw new AppError('FILE_CHANGED', '音频版本已变化或章节已移除。')
  }
  private pump(): void {
    if (
      !this.enabled ||
      this.stopped ||
      this.maintenance ||
      this.modelLease ||
      this.releasing ||
      this.resourceSettings.paused ||
      this.active ||
      this.unsavedTerminal ||
      !this.component.configured
    )
      return
    const job = this.store
      .activeJobs()
      .find(
        (job) =>
          job.status === 'queued' &&
          this.runnable(job) &&
          (!job.background || !this.resourceSettings.policy.backgroundIdleOnly || this.idle()),
      )
    if (!job) return
    try {
      this.store.setJobStatus(job.id, job.attempt, 'running')
    } catch (error) {
      this.rememberUnsaved(job, error)
      return
    }
    const active: ActiveRun = {
      job: this.store.getJob(job.id)!,
      submitted: false,
      controller: new AbortController(),
    }
    this.active = active
    this.changed(job)
    active.done = this.run(active)
  }
  private current(active: ActiveRun): StoredTranscriptionJob | undefined {
    if (this.active !== active || this.stopped) return undefined
    const job = this.store.getJob(active.job.id)
    return job?.attempt === active.job.attempt ? job : undefined
  }
  private rememberUnsaved(job: StoredTranscriptionJob, error: unknown): void {
    this.log(error)
    this.unsavedTerminal = {
      id: job.id,
      attempt: job.attempt,
      status: 'failed',
      error:
        '任务状态无法保存，转写队列已暂停。请释放用户数据磁盘空间并检查写入权限，再点击重试；此前保存的文稿和进度保留。',
    }
    this.changed(job)
  }
  private async run(active: ActiveRun): Promise<void> {
    const { job } = active
    let outcome: AsrOutcome | undefined
    let failure: unknown
    try {
      const audio = this.store.getAudio(job.episodeId)
      if (!audio || audio.contentHash !== job.audioHash)
        throw new AppError('FILE_CHANGED', '音频版本已变化。')
      await checkAudio(audio)
      if (this.current(active)?.status !== 'running') return
      const runtime = {
        ...this.component.runtime(job.engine, job.device),
        cpuThreads: job.cpuThreads ?? 4,
        lowPriority: this.resourceSettings.policy.lowPriority,
      }
      this.store.jobProgress(job.id, job.attempt, 'checking-components')
      this.changed(job)
      await this.checkRuntime(runtime, active.controller.signal)
      if (active.controller.signal.aborted || this.current(active)?.status !== 'running') return
      const profile = configurationHash({ ...runtime, lowPriority: undefined })
      if (this.worker && this.profile !== profile) {
        await this.worker.close()
        this.worker = undefined
      }
      if (this.current(active)?.status !== 'running') return
      if (!this.worker) {
        this.worker = this.factory(runtime)
        this.profile = profile
      }
      this.lastWorkerUse = this.scheduler.now?.() ?? Date.now()
      active.worker = this.worker
      await active.worker.ready
      if (this.current(active)?.status !== 'running') return
      active.worker.setLowPriority?.(this.resourceSettings.policy.lowPriority)
      this.store.bindJobConfiguration(
        job.id,
        job.attempt,
        configurationHash(active.worker.configuration ?? {}),
      )
      active.submitted = true
      const priority = this.priorities.get(job.episodeId)
      outcome = await active.worker.submit(
        {
          jobId: job.id,
          attempt: job.attempt,
          audioHash: job.audioHash,
          audioPath: audio.path,
          range: { startMs: 0, endMs: job.rangeEndMs },
          priorityMs:
            priority?.audioHash === job.audioHash
              ? priority.positionMs
              : this.current(active)?.background
                ? 0
                : Math.round(this.store.getEpisode(job.episodeId)?.positionMs ?? 0),
        },
        (event) => {
          if (this.current(active)?.status !== 'running') return
          this.checkAsset(job.episodeId, job.audioHash)
          if (event.type === 'partial')
            this.store.acceptJobSnapshot(job.id, job.attempt, event, event.completedChunks, false)
          else this.store.jobProgress(job.id, job.attempt, event.stage)
          this.changed(job)
        },
      )
      if (this.current(active)?.status === 'running' && outcome.status === 'completed') {
        await checkAudio(audio)
        const accepted = this.store.acceptJobSnapshot(
          job.id,
          job.attempt,
          outcome,
          outcome.totalChunks,
          true,
          outcome.durationMs,
        )
        if (!accepted && this.current(active)?.status === 'running')
          throw new AppError('CONFLICT', '生成结果已过期，已有文稿保留。')
      }
    } catch (error) {
      failure = error
    } finally {
      const latest = this.current(active)
      if (!latest || latest.status === 'canceling' || outcome?.status === 'canceled' || failure) {
        if (active.worker) {
          if (failure && active.worker.diagnosticLog)
            this.log(new Error(active.worker.diagnosticLog))
          await active.worker.close().catch(this.log)
          if (this.worker === active.worker) this.worker = undefined
        }
      }
      const final = this.current(active)
      try {
        if (final) {
          if (final.status === 'canceling' || outcome?.status === 'canceled')
            this.store.setJobStatus(job.id, job.attempt, 'canceled', final.error)
          else if (failure) {
            this.log(failure)
            this.store.setJobStatus(
              job.id,
              job.attempt,
              'failed',
              failure instanceof Error && (Number(Reflect.get(failure, 'errcode')) & 255) === 13
                ? '用户数据磁盘空间不足，请释放空间后重试；此前保存的文稿和进度已保留。'
                : failure instanceof Error
                  ? failure.message
                  : '转写未完成，可以重试。',
            )
          }
          this.changed(job)
        }
      } catch (error) {
        this.rememberUnsaved(job, error)
      }
      if (this.active === active) {
        this.active = undefined
        this.lastWorkerUse = this.scheduler.now?.() ?? Date.now()
        const background = this.resumeAfterCancel.get(job.id)
        this.resumeAfterCancel.delete(job.id)
        if (background !== undefined && !this.stopped) {
          try {
            this.prepare(
              {
                episodeId: job.episodeId,
                audioHash: job.audioHash,
                engine: job.engine,
                device: job.device,
              },
              background,
            )
          } catch (error) {
            this.log(error)
          }
        }
        this.pump()
        this.refreshResourceSchedule()
      }
    }
  }
  async close(): Promise<void> {
    this.stopped = true
    clearInterval(this.resourceTimer)
    const lease = this.modelLease
    lease?.controller.abort()
    this.resumeAfterCancel.clear()
    this.stoppedPreparations.clear()
    this.priorities.clear()
    const active = this.active
    if (active) {
      active.controller.abort()
      try {
        this.store.interruptJob(active.job.id, active.job.attempt)
      } catch (error) {
        // Storage failure must not prevent owned inference processes from closing.
        this.log(error)
      }
    }
    this.active = undefined
    await this.worker?.close()
    await active?.done
    await this.maintenanceDone?.catch(this.log)
    await this.releasing
    await lease?.done?.catch((error: unknown) => {
      if (!lease.controller.signal.aborted) this.log(error)
    })
    this.worker = undefined
  }
}
