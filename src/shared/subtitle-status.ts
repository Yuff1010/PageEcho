import type { TimeRange, TranscriptState } from './transcript'
import type { TranscriptionJob } from './transcription'
import { subtitleCoverage, type SubtitlePreparationState } from './subtitle-preparation'

export interface SubtitleCoverageStats {
  coveredMs: number
  prefixMs: number
  leadMs: number
  rangeCount: number
  complete: boolean
  // A bounded preview only; all scalar metrics use the complete coverage union.
  ranges: TimeRange[]
}
export type SubtitleStatusJob = Pick<
  TranscriptionJob,
  | 'id'
  | 'status'
  | 'stage'
  | 'autoApply'
  | 'hasPreview'
  | 'processedUntilMs'
  | 'completedChunks'
  | 'totalChunks'
  | 'cacheHits'
>
export interface SubtitleStatusSnapshot {
  episodeId: string
  audioHash: string
  positionMs: number
  durationMs: number | null
  savedStatus: TranscriptState['status']
  savedCoverage: SubtitleCoverageStats
  job: (SubtitleStatusJob & { coverage: SubtitleCoverageStats | null }) | null
}
export interface SubtitleStatusTarget {
  episodeId: string
  audioHash: string
  positionMs: number
}
export interface SubtitleStatusInput extends SubtitleStatusTarget {
  durationMs: number | null
  savedStatus: TranscriptState['status']
  coverage: readonly TimeRange[]
  job: SubtitleStatusJob | null
  jobCoverage?: readonly TimeRange[] | null
}

function coverageStats(
  coverage: readonly TimeRange[],
  positionMs: number,
  durationMs: number | null,
): SubtitleCoverageStats {
  const ranges: TimeRange[] = []
  for (const range of [...coverage]
    .filter(
      (value) =>
        Number.isFinite(value.startMs) &&
        Number.isFinite(value.endMs) &&
        value.startMs >= 0 &&
        value.endMs > value.startMs,
    )
    .sort((a, b) => a.startMs - b.startMs)) {
    const endMs = durationMs === null ? range.endMs : Math.min(range.endMs, durationMs)
    if (endMs <= range.startMs) continue
    const previous = ranges.at(-1)
    if (previous && range.startMs <= previous.endMs)
      previous.endMs = Math.max(previous.endMs, endMs)
    else ranges.push({ startMs: range.startMs, endMs })
  }
  const current = ranges.find((range) => range.startMs <= positionMs && positionMs < range.endMs)
  const prefixMs = ranges[0]?.startMs === 0 ? ranges[0].endMs : 0
  return {
    coveredMs: ranges.reduce((sum, range) => sum + range.endMs - range.startMs, 0),
    prefixMs,
    leadMs: current ? current.endMs - positionMs : 0,
    rangeCount: ranges.length,
    complete: durationMs !== null && prefixMs + 1 >= durationMs,
    ranges: ranges.slice(0, 3),
  }
}

export function createSubtitleStatusSnapshot(input: SubtitleStatusInput): SubtitleStatusSnapshot {
  const durationMs =
    input.durationMs !== null && Number.isFinite(input.durationMs) && input.durationMs > 0
      ? input.durationMs
      : null
  const positionMs = Math.max(
    0,
    Math.min(Number.isFinite(input.positionMs) ? input.positionMs : 0, durationMs ?? Infinity),
  )
  return {
    episodeId: input.episodeId,
    audioHash: input.audioHash,
    positionMs,
    durationMs,
    savedStatus: input.savedStatus,
    savedCoverage: coverageStats(
      input.savedStatus === 'ready' ? input.coverage : [],
      positionMs,
      durationMs,
    ),
    job: input.job
      ? {
          ...input.job,
          coverage: input.jobCoverage
            ? coverageStats(input.jobCoverage, positionMs, durationMs)
            : null,
        }
      : null,
  }
}

export function subtitleStatusFromTranscription(
  state: SubtitlePreparationState,
  target: SubtitleStatusTarget & { durationMs: number | null },
): SubtitleStatusSnapshot {
  const snapshot = createSubtitleStatusSnapshot({
    ...target,
    savedStatus: ('transcriptHeader' in state ? state.transcriptHeader : state.transcript).status,
    coverage: subtitleCoverage(state),
    job: state.job,
  })
  const metadata = state.subtitleStatus?.job
  if (
    snapshot.job &&
    metadata?.id === snapshot.job.id &&
    metadata.completedChunks === snapshot.job.completedChunks
  )
    snapshot.job.coverage = metadata.coverage
  return snapshot
}

export function subtitleTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000)),
    minutes = Math.floor(seconds / 60)
  return `${minutes >= 60 ? `${Math.floor(minutes / 60)}:` : ''}${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

export function subtitleStatusText(snapshot: SubtitleStatusSnapshot, rate = 1) {
  const saved = snapshot.savedCoverage,
    speed = Number.isFinite(rate) && rate > 0 ? rate : 1,
    leadSeconds = Math.floor(saved.leadMs / 1000),
    listeningSeconds = Math.floor(saved.leadMs / speed / 1000),
    title =
      snapshot.savedStatus === 'stale'
        ? '字幕音频版本不符'
        : snapshot.savedStatus !== 'ready' || !saved.coveredMs
          ? '字幕未准备'
          : saved.complete
            ? '整集字幕已备'
            : '字幕部分已备',
    amount = `${subtitleTime(saved.coveredMs)}${snapshot.durationMs === null ? '' : ` / ${subtitleTime(snapshot.durationMs)}`}`,
    lead = `当前位置连续领先 ${leadSeconds} 秒音频，${speed}×可听约 ${listeningSeconds} 秒`,
    coverage = saved.rangeCount
      ? `覆盖 ${saved.ranges.map((range) => `${subtitleTime(range.startMs)}–${subtitleTime(range.endMs)}`).join('、')}${saved.rangeCount > saved.ranges.length ? ` 等 ${saved.rangeCount} 段` : ''}；从头连续 ${subtitleTime(saved.prefixMs)}`
      : '当前没有可用字幕覆盖',
    job = snapshot.job
  const preview = !!job?.hasPreview && !job.autoApply
  const jobState = job
    ? (
        {
          queued: '任务排队中',
          running: '任务进行中',
          canceling: '任务取消中',
          completed: '任务已完成',
          failed: '任务失败',
          canceled: '任务已取消',
        } as const
      )[job.status]
    : ''
  const jobText = job
    ? `${preview ? (job.status === 'completed' ? '新稿已完成，待采用' : '新稿部分待采用') : jobState} · ${job.completedChunks}/${job.totalChunks || '…'} 块${job.coverage ? ` · 本次已处理 ${subtitleTime(job.coverage.coveredMs)}` : ` · 处理位置 ${subtitleTime(job.processedUntilMs)}`}`
    : ''
  const jobCoverageText = job?.coverage?.rangeCount
    ? `本次覆盖 ${job.coverage.ranges.map((range) => `${subtitleTime(range.startMs)}–${subtitleTime(range.endMs)}`).join('、')}${job.coverage.rangeCount > job.coverage.ranges.length ? ` 等 ${job.coverage.rangeCount} 段` : ''}；从头连续 ${subtitleTime(job.coverage.prefixMs)}`
    : ''
  return {
    title,
    amount,
    lead,
    coverage,
    jobText,
    jobCoverageText,
    preview,
    compact: `${title}${saved.leadMs > 0 ? ` · 领先${leadSeconds}秒 / 可听${listeningSeconds}秒` : ''}${preview ? ' · 新稿待采用' : ''}`,
    details: [
      `${title} · 已备 ${amount}`,
      coverage,
      lead,
      ...(jobText ? [jobText] : []),
      ...(jobCoverageText ? [jobCoverageText] : []),
    ],
  }
}
