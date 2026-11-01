import { AppError } from '../../shared/validation'
import type { OriginalMatch, OriginalTarget, ParsedOriginal } from '../../shared/original'
import type { OriginalStore } from './store'
import type { OriginalIncrementalBatch } from './incremental'

interface AutomaticRunner {
  runAutomatic(
    originalId: string,
    original: ParsedOriginal,
    batches: OriginalIncrementalBatch[],
  ): Promise<OriginalMatch[]>
  cancelAutomatic(): Promise<void>
  attachAutomatic(close: () => Promise<void>): void
}
/** Coalesce snapshots; bounded work never participates in the audio transaction. */
export class AutomaticOriginals {
  private closed = false
  private pending = new Map<string, OriginalTarget>()
  private timer?: ReturnType<typeof setTimeout>
  private running?: Promise<void>
  private unsubscribe: () => void
  private suspended = new Set<string>()
  private activeKey?: string
  private progressing = new Set<string>()
  private blocked = new Map<string, string>()
  private bookTargets = new Map<string, OriginalTarget>()
  private bookBacklog = new Map<string, OriginalTarget>()
  constructor(
    private readonly store: OriginalStore,
    private readonly runner: AutomaticRunner,
    private readonly notify: (target: OriginalTarget) => void,
    private readonly log: (error: unknown) => void = () => {},
  ) {
    this.unsubscribe = store.onTranscriptChanged((target) => this.request(target))
    runner.attachAutomatic(() => this.close())
    for (const target of store.automaticTargets()) this.request(target)
  }
  request(target: OriginalTarget) {
    if (this.closed) return
    const key = `${target.episodeId}:${target.audioHash}`
    if (this.suspended.has(key)) return
    this.bookBacklog.delete(key)
    // Current-page requests take precedence over background book preparation.
    this.pending.delete(key)
    this.pending = new Map([[key, target], ...this.pending])
    const activeSlot = this.activeKey && !this.pending.has(this.activeKey) ? 1 : 0
    if (this.pending.size + activeSlot > 8) {
      const keys = [...this.pending.keys()].reverse()
      const oldest =
        keys.find(
          (value) => value !== key && value !== this.activeKey && !this.progressing.has(value),
        ) ??
        keys.find(
          (value) => value !== key && value !== this.activeKey && this.bookTargets.has(value),
        ) ??
        keys.find((value) => value !== this.activeKey && !this.progressing.has(value))
      if (oldest) {
        this.pending.delete(oldest)
        const promised = this.bookTargets.get(oldest)
        if (promised) {
          this.bookBacklog.set(oldest, promised)
          this.progressing.delete(oldest)
        }
      }
    }
    this.schedule()
  }

  /** Preflight before committing a link so a full queue never half-applies it. */
  checkBookRequest(targets: OriginalTarget[]) {
    if (this.closed) throw new AppError('BUSY', '应用正在退出，原文处理已停止。')
    const keys = new Set(this.bookTargets.keys())
    for (const target of targets) keys.add(`${target.episodeId}:${target.audioHash}`)
    if (keys.size > 10000)
      throw new AppError('BUSY', '正在准备的原文集数已达 10,000 集，请稍后再关联。')
  }

  /** Explicitly admitted book work survives the eight-target foreground window. */
  requestBook(targets: OriginalTarget[]) {
    this.checkBookRequest(targets)
    for (const target of targets) {
      const key = `${target.episodeId}:${target.audioHash}`
      this.bookTargets.set(key, target)
      if (!this.pending.has(key) && this.activeKey !== key) this.bookBacklog.set(key, target)
    }
    this.admitBookTargets()
    this.schedule()
  }

  /** An unlinked book has no background preparation contract left to complete. */
  forgetBook(targets: OriginalTarget[]) {
    for (const target of targets) {
      const key = `${target.episodeId}:${target.audioHash}`
      this.bookTargets.delete(key)
      this.bookBacklog.delete(key)
      this.pending.delete(key)
      this.progressing.delete(key)
      this.blocked.delete(key)
    }
  }

  private admitBookTargets() {
    if (this.closed) return
    for (const [key, target] of this.bookBacklog) {
      const activeSlot = this.activeKey && !this.pending.has(this.activeKey) ? 1 : 0
      if (this.pending.size + activeSlot >= 8) break
      if (this.suspended.has(key)) continue
      this.bookBacklog.delete(key)
      if (this.activeKey !== key && !this.pending.has(key)) this.pending.set(key, target)
    }
  }
  private schedule(delay = 75) {
    if (!this.running && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.running = this.drain().finally(() => {
          this.running = undefined
          this.admitBookTargets()
          if (this.pending.size && !this.closed) this.schedule(150)
        })
      }, delay)
      this.timer.unref?.()
    }
  }
  async manual<T>(target: OriginalTarget, action: () => Promise<T>): Promise<T> {
    const key = `${target.episodeId}:${target.audioHash}`
    this.suspended.add(key)
    this.pending.delete(key)
    this.progressing.delete(key)
    try {
      if (this.activeKey === key) await this.runner.cancelAutomatic()
      return await action()
    } finally {
      this.suspended.delete(key)
      this.request(target)
    }
  }
  private async drain() {
    this.admitBookTargets()
    const conflicts = new Map<string, number>()
    for (let rounds = 0; rounds < 16 && this.pending.size && !this.closed; rounds++) {
      const [key, target] = this.pending.entries().next().value!
      this.pending.delete(key)
      if (this.suspended.has(key)) continue
      this.activeKey = key
      let stamp = ''
      try {
        const plan = this.store.prepareIncremental(target)
        if (!plan) continue
        stamp = `${plan.originalId}:${plan.originalHash}:${plan.transcriptId}:${plan.transcriptRevision}:${plan.alignmentRevision}`
        if (this.blocked.get(key) === stamp) continue
        const matches = plan.batches.length
          ? await this.runner.runAutomatic(
              plan.originalId,
              this.store.document(target, plan.originalId),
              plan.batches,
            )
          : []
        if (this.closed || this.suspended.has(key)) continue
        const result = this.store.saveIncremental(plan, matches)
        this.blocked.delete(key)
        if (result.alignment?.pendingSegments) {
          // Keep admitted work through the yielded round, even under new-target pressure.
          this.progressing.add(key)
          this.pending.set(key, target)
        }
        if (result.alignment?.revision !== plan.alignmentRevision) this.notify(target)
      } catch (error) {
        if (this.closed) return
        if (this.suspended.has(key)) continue
        if (
          error instanceof AppError &&
          error.code === 'CONFLICT' &&
          (conflicts.get(key) ?? 0) < 2
        ) {
          conflicts.set(key, (conflicts.get(key) ?? 0) + 1)
          this.pending.set(key, target)
        } else if (error instanceof AppError && error.code === 'CONFLICT') {
          this.pending.delete(key)
          this.blocked.set(key, stamp)
        } else if (!(
          error instanceof AppError && ['FILE_CHANGED', 'CONFLICT'].includes(error.code)
        )) {
          this.pending.delete(key)
          this.blocked.set(key, stamp)
          this.log(error)
        }
        if (this.blocked.size > 16) this.blocked.delete(this.blocked.keys().next().value!)
      } finally {
        this.activeKey = undefined
        if (!this.pending.has(key)) {
          this.progressing.delete(key)
          if (!this.bookBacklog.has(key) && !this.suspended.has(key)) this.bookTargets.delete(key)
        }
        this.admitBookTargets()
      }
    }
    // Successful backlog continues after yielding; failed unchanged snapshots
    // are blocked instead of entering an unbounded retry loop.
  }
  async close() {
    if (this.closed) return
    this.closed = true
    this.unsubscribe()
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pending.clear()
    this.bookBacklog.clear()
    this.bookTargets.clear()
    this.progressing.clear()
    this.blocked.clear()
    await this.runner.cancelAutomatic()
    await this.running
  }
}
