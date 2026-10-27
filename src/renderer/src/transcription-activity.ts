import type { AutomaticSubtitlesResult, TranscriptionState } from '../../shared/transcription'

export type SubtitlePreparationPhase =
  AutomaticSubtitlesResult['status'] | 'idle' | 'checking' | 'canceling'
const STAGES: Record<string, string> = {
  queued: '排队等待',
  validating: '检查音频版本',
  'checking-components': '检查字幕组件',
  decoding: '解码音频',
  loading: '加载转写模型',
  recognizing: '识别语音',
  punctuation: '整理标点',
}

export function transcriptionActivityModel(
  state: TranscriptionState | null,
  phase: SubtitlePreparationPhase = 'idle',
  message = '',
) {
  const job = state?.job
  const canceling = job?.status === 'canceling' || phase === 'canceling'
  const active = canceling || job?.status === 'queued' || job?.status === 'running'
  const checking = !active && phase === 'checking' && state?.transcript.status !== 'ready'
  const starting = !job && phase === 'started' && state?.transcript.status !== 'ready'
  const stopped = !active && !checking && (job?.status === 'canceled' || phase === 'stopped')
  const failed = !active && !checking && job?.status === 'failed'
  const unavailable = !active && !checking && ['missing-component', 'unavailable'].includes(phase)
  const completed = job?.status === 'completed' && !active && !checking
  if (!active && !checking && !starting && !stopped && !failed && !unavailable && !completed)
    return null
  const known =
    !!job &&
    job.totalChunks > 0 &&
    !['validating', 'checking-components', 'loading', 'decoding'].includes(job.stage) &&
    job.status !== 'queued'
  return {
    active: active || checking || starting,
    canceling,
    completed,
    retryable: stopped || failed,
    unavailable,
    title: canceling
      ? '正在取消字幕生成'
      : checking || starting
        ? '正在自动准备字幕'
        : active
          ? '正在转写字幕'
          : failed
            ? '字幕生成失败'
            : stopped
              ? '字幕生成已取消'
              : unavailable
                ? '字幕暂未开始'
                : '本集字幕已生成',
    stage: canceling
      ? '等待转写进程停止'
      : checking
        ? '检查字幕组件'
        : starting
          ? '启动转写任务'
          : active
            ? (STAGES[job?.stage ?? ''] ?? '准备转写')
            : completed
              ? '转写完成'
              : '',
    total: known ? job!.totalChunks : null,
    completedChunks: job?.completedChunks ?? 0,
    note:
      stopped || canceling
        ? '已生成的字幕会保留，听书可以继续。'
        : failed
          ? (job?.error ?? '转写未完成，可以重试。')
          : unavailable
            ? message || '请配置可用的字幕组件，听书可以继续。'
            : active || checking || starting
              ? job?.hasPreview && !job.autoApply
                ? '新稿完成后可预览，当前文稿会保留。'
                : job && job.completedChunks > 0
                  ? '已完成的字幕可以阅读，其余内容正在后台生成。'
                  : '首段完成后自动显示字幕，听书可以继续。'
              : '字幕已保存，可继续阅读。',
  }
}
