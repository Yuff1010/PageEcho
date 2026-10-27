import type { TranscriptionState, TranscriptionSummaryState } from './transcription'
import { ACTIVE_JOB_STATUSES, SUBTITLE_LEAD_MS } from './transcription'

export type SubtitleBufferState = { ready: boolean; waiting: boolean; message: string }
export interface SubtitleBufferOptions {
  rate?: number
  chunkTurnaroundMs?: number
  audioMsPerWallMs?: number
}
export type SubtitlePreparationState = TranscriptionState | TranscriptionSummaryState

export function subtitleCoverage(state: SubtitlePreparationState) {
  if ('transcriptHeader' in state)
    return state.transcriptHeader.status === 'ready'
      ? state.transcriptHeader.transcript.coverage
      : []
  return state.transcript.status === 'ready' ? state.transcript.transcript.document.coverage : []
}

export function subtitleLeadMs(options: SubtitleBufferOptions = {}): number {
  const rate = Number.isFinite(options.rate) ? Math.max(0.5, Math.min(4, options.rate!)) : 1
  const turnaround = Number.isFinite(options.chunkTurnaroundMs)
    ? Math.max(0, options.chunkTurnaroundMs!)
    : 0
  return Math.round(
    Math.min(180000, Math.max(SUBTITLE_LEAD_MS, rate * Math.max(SUBTITLE_LEAD_MS, turnaround * 2))),
  )
}

export function subtitleCoveredUntil(state: SubtitlePreparationState, positionMs: number): number {
  let coveredUntil = positionMs
  for (const range of subtitleCoverage(state)) {
    if (range.endMs < coveredUntil) continue
    if (range.startMs > coveredUntil + 1) break
    coveredUntil = Math.max(coveredUntil, range.endMs)
  }
  return coveredUntil
}

// Measurements use completed inference work only. Cached replay, new attempts,
// repeated progress messages and unchanged coverage never count as model speed.
export class SubtitleThroughput {
  private previous?: {
    id: string
    attempt: number
    completed: number
    hits: number
    covered: number
    at: number
  }
  private estimate: SubtitleBufferOptions = {}
  reset() {
    this.previous = undefined
    this.estimate = {}
  }
  observe(state: SubtitlePreparationState, at: number): SubtitleBufferOptions {
    const job = state.job
    if (!job || !job.autoApply || !Number.isFinite(at)) return { ...this.estimate }
    const covered = subtitleCoverage(state).reduce(
      (sum, range) => sum + range.endMs - range.startMs,
      0,
    )
    const next = {
      id: job.id,
      attempt: job.attempt,
      completed: job.completedChunks,
      hits: job.cacheHits,
      covered,
      at,
    }
    const previous = this.previous
    if (
      previous?.id === next.id &&
      (next.attempt < previous.attempt ||
        (next.attempt === previous.attempt && next.completed < previous.completed))
    )
      return { ...this.estimate }
    if (!previous || previous.id !== next.id || previous.attempt !== next.attempt) {
      this.estimate = {}
      this.previous = next
    } else if (next.completed > previous.completed || next.hits !== previous.hits) {
      if (next.hits === previous.hits && next.covered > previous.covered && next.at > previous.at) {
        const elapsed = next.at - previous.at
        const turnaround = elapsed / (next.completed - previous.completed)
        const throughput = (next.covered - previous.covered) / elapsed
        const smooth = (old: number | undefined, sample: number) =>
          old === undefined ? sample : old * 0.75 + sample * 0.25
        this.estimate = {
          chunkTurnaroundMs: smooth(this.estimate.chunkTurnaroundMs, turnaround),
          audioMsPerWallMs: smooth(this.estimate.audioMsPerWallMs, throughput),
        }
      }
      this.previous = next
    }
    return { ...this.estimate }
  }
}

export function subtitleBufferState(
  state: SubtitlePreparationState,
  positionMs: number,
  durationMs: number,
  options: SubtitleBufferOptions = {},
): SubtitleBufferState {
  const end = Math.min(positionMs + subtitleLeadMs(options), durationMs)
  const coveredUntil = subtitleCoveredUntil(state, positionMs)
  if (
    ('transcriptHeader' in state ? state.transcriptHeader : state.transcript).status === 'ready'
  ) {
    if (coveredUntil + 1 >= end)
      return {
        ready: true,
        waiting: false,
        message:
          state.job?.autoApply && ['queued', 'running'].includes(state.job.status)
            ? '当前一段字幕已就绪，其余内容继续在后台准备。'
            : '当前位置字幕已就绪。',
      }
  }
  if (!state.configured)
    return { ready: false, waiting: false, message: '尚未配置转写组件，已继续普通播放。' }
  const job = state.job
  if (job?.autoApply && ACTIVE_JOB_STATUSES.includes(job.status) && job.status !== 'canceling')
    return {
      ready: false,
      waiting: true,
      message: `正在提前准备当前位置起约 ${Math.ceil((end - positionMs) / 1000)} 秒音频的字幕，完成后自动播放；其余内容在后台继续。${
        options.audioMsPerWallMs !== undefined && options.audioMsPerWallMs < (options.rate ?? 1)
          ? '按目前处理速度，字幕可能落后于播放，可降低倍速或继续等待。'
          : ''
      }`,
    }
  return {
    ready: false,
    waiting: false,
    message: job?.error
      ? `字幕准备未完成：${job.error} 普通播放继续。`
      : job && !job.autoApply
        ? '保留当前文稿，新生成稿可在伴读中预览。'
        : '当前位置字幕尚未就绪，已继续普通播放；可在伴读中查看或重试任务。',
  }
}
