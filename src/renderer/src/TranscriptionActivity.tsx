import { useSyncExternalStore } from 'react'
import type { TranscriptRequest } from '../../shared/transcript'
import type { useTranscription } from './TranscriptionControls'
import { transcriptionActivityModel } from './transcription-activity'
import { player } from './player'
import { Popover } from './Popover'
import { Icon } from './Icons'
import './transcription-activity.css'

export function TranscriptionActivity({
  target,
  control,
  onConfigure,
  compact = false,
  showCompleted = false,
  showError = false,
  inline = false,
}: {
  target: TranscriptRequest
  control: ReturnType<typeof useTranscription>
  onConfigure?: () => void
  compact?: boolean
  showCompleted?: boolean
  showError?: boolean
  inline?: boolean
}) {
  const playback = useSyncExternalStore(player.subscribe, player.getSnapshot)
  const current =
    playback.episode?.id === target.episodeId && playback.episode.contentHash === target.audioHash
  const model = transcriptionActivityModel(
    control.state,
    current ? playback.subtitlePreparationPhase : 'idle',
    current ? playback.subtitleNotice : '',
  )
  if (!model || (model.completed && !showCompleted)) return null
  const cancel = () => {
    if (current) void control.run(() => player.cancelSubtitleGeneration())
    else if (control.state?.job) {
      const id = control.state.job.id
      void control.run(() => window.desktop.cancelTranscription({ id }))
    }
  }
  const retry = () => {
    if (control.state?.job) {
      const id = control.state.job.id
      void control.run(() => window.desktop.retryTranscription({ id }))
    } else if (current) void player.prepareSubtitles(true).then(() => control.refresh())
  }
  if (inline)
    return (
      <section
        className="transcription-activity-inline"
        role="region"
        aria-label="字幕生成进度"
        data-state={
          model.canceling
            ? 'canceling'
            : model.active
              ? 'running'
              : model.retryable
                ? 'stopped'
                : model.unavailable
                  ? 'unavailable'
                  : 'completed'
        }
        data-job-status={
          control.state?.job?.status ?? (current ? playback.subtitlePreparationPhase : 'idle')
        }
      >
        <Popover
          label="字幕生成详情"
          icon="info"
          placement="top"
          kind="group"
          triggerText={model.active ? model.stage : model.title}
          className="transcription-inline-details"
        >
          <h3>{model.title}</h3>
          <p>{model.note}</p>
          {model.active && (
            <p>
              {model.total !== null
                ? `已完成 ${model.completedChunks} / ${model.total} 段`
                : '正在处理，进度将在首段完成后更新'}
            </p>
          )}
          {showError && control.error && (
            <p className="error-message" role="alert">
              {control.error}
            </p>
          )}
        </Popover>
        {model.active && (
          <>
            <progress
              className="transcription-inline-progress"
              aria-label="字幕生成进度条"
              max={model.total ?? 1}
              {...(model.total !== null ? { value: model.completedChunks } : {})}
            />
            {model.total !== null && (
              <span
                className="transcription-inline-count"
                aria-label={`已完成 ${model.completedChunks} / ${model.total} 段`}
              >
                {model.completedChunks}/{model.total}
              </span>
            )}
            <button
              className="reader-icon-button"
              title={model.canceling ? '正在取消…' : '取消字幕生成'}
              aria-label={model.canceling ? '正在取消…' : '取消字幕生成'}
              disabled={control.busy || model.canceling}
              onClick={cancel}
            >
              {model.canceling ? (
                <span className="transcription-spinner" aria-hidden="true" />
              ) : (
                <Icon name="close" />
              )}
            </button>
          </>
        )}
        {model.retryable && (
          <button
            className="reader-button"
            aria-label="重新生成字幕"
            disabled={control.busy || (!!control.state?.job && !control.state.configured)}
            onClick={retry}
          >
            重试
          </button>
        )}
        {model.unavailable && onConfigure && (
          <button className="reader-button" aria-label="配置字幕组件" onClick={onConfigure}>
            配置
          </button>
        )}
      </section>
    )
  return (
    <section
      className={`transcription-activity${compact ? ' transcription-activity--compact' : ''}`}
      role="region"
      aria-label="字幕生成进度"
      data-state={
        model.canceling
          ? 'canceling'
          : model.active
            ? 'running'
            : model.retryable
              ? 'stopped'
              : model.unavailable
                ? 'unavailable'
                : 'completed'
      }
      data-job-status={
        control.state?.job?.status ?? (current ? playback.subtitlePreparationPhase : 'idle')
      }
    >
      <div className="transcription-activity-heading">
        <div>
          <h3>
            {model.active && <span className="transcription-spinner" aria-hidden="true" />}
            {model.title}
          </h3>
          {model.stage && (
            <p className="transcription-activity-stage" role="status">
              {model.stage}
            </p>
          )}
        </div>
        {model.active && (
          <button
            className="secondary-button"
            disabled={control.busy || model.canceling}
            onClick={cancel}
          >
            {model.canceling ? '正在取消…' : '取消字幕生成'}
          </button>
        )}
      </div>
      {model.active && (
        <>
          <progress
            className="transcription-activity-progress"
            aria-label="字幕生成进度条"
            max={model.total ?? 1}
            {...(model.total !== null ? { value: model.completedChunks } : {})}
          />
          <p className="transcription-activity-count">
            {model.total !== null
              ? `已完成 ${model.completedChunks} / ${model.total} 段`
              : '正在处理，进度将在首段完成后更新'}
          </p>
        </>
      )}
      <p className="transcription-activity-note">{model.note}</p>
      {model.retryable && (
        <button
          className="secondary-button"
          disabled={control.busy || (!!control.state?.job && !control.state.configured)}
          onClick={retry}
        >
          重新生成字幕
        </button>
      )}
      {model.unavailable && onConfigure && (
        <button className="secondary-button" onClick={onConfigure}>
          配置字幕组件
        </button>
      )}
      {showError && control.error && (
        <p className="error-message" role="alert">
          {control.error}
        </p>
      )}
    </section>
  )
}
