import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Book, Episode, Result } from '../../shared/contracts'
import type { LibraryMutation } from '../../shared/library'
import type { TranscriptRequest, TranscriptState } from '../../shared/transcript'
import {
  ACTIVE_JOB_STATUSES,
  type TranscriptionPreview,
  type TranscriptionState,
  type SubtitlePreparation,
} from '../../shared/transcription'
import { ComponentSetup, componentCapability, useComponentSetup } from './ComponentSetup'
import { effectiveSubtitleProfile, subtitleProfileLabel } from './subtitle-profile'
import { player } from './player'
import { SubtitleStatus } from './UISubtitleStatus'
import { subtitleStatusFromTranscription } from '../../shared/subtitle-status'
import { SubtitlePreparationForm } from './SubtitlePreparationSettings'
import { ProcessingPauseNotice } from './ProcessingResourcesPanel'
import { transcriptionStateClient } from './transcription-state-client'
import { availableSubtitleProfile } from './subtitle-onboarding'
import { TranscriptionActivity } from './TranscriptionActivity'
import { SettingsDisclosureSummary } from './SettingsDisclosure'
import { ReaderAction } from './ReaderToolbar'
import { HelpTip } from './HelpTip'

export function useTranscription(target: TranscriptRequest) {
  const [state, setState] = useState<TranscriptionState | null>(null)
  const [preview, setPreview] = useState<TranscriptionPreview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const mounted = useRef(false),
    sequence = useRef(0),
    previewing = useRef(false)
  const previewCache = useRef<{ key: string; value: TranscriptionPreview } | null>(null)
  const refresh = useCallback(async () => {
    const serial = ++sequence.current
    try {
      const result = await transcriptionStateClient.read(target)
      if (!mounted.current || serial !== sequence.current) return
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      setState(result.value)
      if (previewing.current && result.value.job?.hasPreview) {
        const job = result.value.job
        const key = `${job.id}:${job.attempt}:${job.previewRevision}`
        if (previewCache.current?.key === key) setPreview(previewCache.current.value)
        else {
          const next = await window.desktop.previewTranscription({ id: job.id })
          if (mounted.current && serial === sequence.current && previewing.current && next.ok) {
            const observed = next.value.job
            previewCache.current = {
              key: `${observed.id}:${observed.attempt}:${observed.previewRevision}`,
              value: next.value,
            }
            setPreview(next.value)
          }
        }
      } else {
        previewCache.current = null
        setPreview(null)
      }
    } catch {
      if (mounted.current && serial === sequence.current) setError('无法读取转写状态，请重试。')
    }
  }, [target])
  useEffect(() => {
    mounted.current = true
    void Promise.resolve().then(refresh)
    const stop = window.desktop.onTranscriptionChanged((change) => {
      if (change.episodeId === target.episodeId && change.audioHash === target.audioHash) {
        transcriptionStateClient.invalidate(target)
        void refresh()
      }
    })
    const stopComponent = window.desktop.onComponentChanged(() => {
      transcriptionStateClient.invalidate(target)
      void refresh()
    })
    return () => {
      mounted.current = false
      stop()
      stopComponent()
    }
  }, [refresh, target])
  async function run<T>(action: () => Promise<Result<T>>): Promise<T | undefined> {
    setBusy(true)
    setError('')
    try {
      const result = await action()
      if (!mounted.current) return
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      transcriptionStateClient.invalidate(target)
      await refresh()
      return result.value
    } catch {
      if (mounted.current) setError('操作未完成，请重试。')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  async function showPreview() {
    previewing.current = true
    await refresh()
  }
  function hidePreview() {
    previewing.current = false
    previewCache.current = null
    setPreview(null)
  }
  const resource: TranscriptState | null = preview
    ? {
        status: 'ready',
        transcript: {
          id: `preview-${preview.job.id}`,
          episodeId: target.episodeId,
          importedAt: preview.job.updatedAt,
          revision: preview.job.previewRevision,
          document: preview.document,
        },
      }
    : (state?.transcript ?? null)
  return { state, resource, preview, error, busy, run, refresh, showPreview, hidePreview }
}

export function TranscriptionControls({
  target,
  control,
  book,
  openRequest,
  onUpdated,
  showPauseNotice = true,
}: {
  target: TranscriptRequest
  control: ReturnType<typeof useTranscription>
  book: Omit<Book, 'episodes'> | undefined
  openRequest: number
  onOpenSettings: () => void
  onUpdated: (mutation: LibraryMutation) => void
  showPauseNotice?: boolean
}) {
  const details = useRef<HTMLDetailsElement>(null)
  const component = useComponentSetup()
  const { state, busy, run, preview } = control
  const job = state?.job
  const hasDocument = control.resource?.status === 'ready'
  const active = !!job && ACTIVE_JOB_STATUSES.includes(job.status)
  const profile = book ? effectiveSubtitleProfile(book) : null
  const [editing, setEditing] = useState(false)
  const [quickStarting, setQuickStarting] = useState(false)
  const [quickError, setQuickError] = useState('')
  const quickProfile = availableSubtitleProfile(component.state)
  const quickSetup = !!book && !!component.state?.configured && !profile && !hasDocument && !editing
  const setupVisible = editing || !profile
  const mounted = useRef(false)
  const submission = useRef<symbol | null>(null)
  const capability = profile
    ? componentCapability(component.state, profile.engine, profile.device)
    : null
  const playback = useSyncExternalStore(player.subscribe, player.getSnapshot)
  const current =
    playback.episode?.id === target.episodeId && playback.episode.contentHash === target.audioHash
  const [savedEpisode, setSavedEpisode] = useState<Episode | null>(null)
  useEffect(() => {
    let alive = true
    if (current) return
    void window.desktop
      .getPlaybackContext({ episodeId: target.episodeId })
      .then((result) => {
        if (alive) setSavedEpisode(result.ok ? (result.value?.episode ?? null) : null)
      })
      .catch(() => {
        if (alive) setSavedEpisode(null)
      })
    return () => {
      alive = false
    }
  }, [current, target.episodeId])
  const episode = current
    ? playback.episode
    : savedEpisode?.id === target.episodeId && savedEpisode.contentHash === target.audioHash
      ? savedEpisode
      : null
  const subtitleStatus = state
    ? subtitleStatusFromTranscription(state, {
        ...target,
        positionMs: current ? playback.positionMs : (episode?.positionMs ?? 0),
        durationMs: current
          ? playback.durationMs || episode?.durationMs || null
          : (episode?.durationMs ?? null),
      })
    : null
  useEffect(() => {
    mounted.current = true
    const stop = player.subscribe(() => {
      const current = player.getSnapshot().episode
      if (current?.id !== target.episodeId || current.contentHash !== target.audioHash)
        submission.current = null
    })
    return () => {
      mounted.current = false
      submission.current = null
      stop()
    }
  }, [target.episodeId, target.audioHash])
  function cancelSetup() {
    submission.current = null
    setEditing(false)
    if (details.current) details.current.open = false
  }
  async function saveAndGenerate(settings: SubtitlePreparation): Promise<void> {
    const sessionId = player.getSessionId()
    if (!sessionId) throw new Error('请先打开本集音频，再生成字幕。')
    const ticket = Symbol()
    submission.current = ticket
    const valid = () =>
      mounted.current &&
      submission.current === ticket &&
      details.current?.open &&
      player.getSessionId() === sessionId &&
      player.getSnapshot().episode?.id === target.episodeId &&
      player.getSnapshot().episode?.contentHash === target.audioHash
    const result = await window.desktop.prepareAndStartTranscription({
      ...target,
      sessionId,
      settings,
    })
    if (!valid()) {
      if (result.ok && result.value.createdJob && result.value.transcription.job)
        await window.desktop.cancelTranscription({ id: result.value.transcription.job.id })
      return
    }
    if (!result.ok) throw new Error(result.error.message)
    onUpdated(result.value.mutation)
    await control.refresh()
    if (!valid()) return
    submission.current = null
    setEditing(false)
    if (details.current) details.current.open = false
  }
  useEffect(() => {
    if (!openRequest || !details.current) return
    details.current.open = true
    details.current.scrollIntoView({ block: 'nearest' })
  }, [openRequest])
  return (
    <div className="transcription-controls" aria-label="转写任务" data-has-document={hasDocument}>
      {showPauseNotice && <ProcessingPauseNotice />}
      <details
        className="settings-disclosure"
        ref={details}
        onToggle={() => {
          if (!details.current?.open) submission.current = null
        }}
      >
        <SettingsDisclosureSummary title="字幕设置" />
        <div className="subtitle-generation-body">
          {hasDocument && (
            <SubtitleStatus snapshot={subtitleStatus} rate={current ? playback.rate : 1} />
          )}
          <div className="transcription-options">
            <p aria-label="本集字幕配置">
              {profile
                ? subtitleProfileLabel(profile)
                : quickSetup
                  ? '检查本机组件后即可生成。'
                  : '选择组件与生成方案。'}
            </p>
            {!setupVisible && (
              <ReaderAction
                className="reader-icon-button"
                icon="settings"
                label="调整字幕方案"
                disabled={busy || active}
                onClick={() => setEditing(true)}
              />
            )}
            {!setupVisible && (
              <>
                <ReaderAction
                  className="reader-icon-button subtitle-generate-action"
                  icon="transcript"
                  label="生成转写稿"
                  disabled={
                    busy ||
                    component.busy ||
                    active ||
                    !profile ||
                    !state?.configured ||
                    capability?.available === false
                  }
                  onClick={() => {
                    if (!profile) return
                    void run(() =>
                      window.desktop.startTranscription({
                        ...target,
                        engine: profile.engine,
                        device: profile.device,
                      }),
                    ).then((value) => {
                      if (value && details.current) details.current.open = false
                    })
                  }}
                />
              </>
            )}
          </div>
          {quickSetup && (
            <section className="subtitle-quick-start" aria-label="快速准备字幕">
              <h3>准备字幕</h3>
              {quickProfile ? (
                <>
                  <p>{subtitleProfileLabel(quickProfile)}</p>
                  <button
                    className="primary-button"
                    disabled={busy || component.busy || active || quickStarting}
                    onClick={() => {
                      setQuickStarting(true)
                      setQuickError('')
                      void saveAndGenerate(quickProfile)
                        .catch((reason: unknown) => {
                          if (mounted.current)
                            setQuickError(
                              reason instanceof Error ? reason.message : '字幕准备未开始，请重试。',
                            )
                        })
                        .finally(() => {
                          if (mounted.current) setQuickStarting(false)
                        })
                    }}
                  >
                    {quickStarting ? '正在准备字幕…' : '使用可用配置开始生成'}
                  </button>
                </>
              ) : (
                <>
                  <p role="status">
                    {component.state?.check
                      ? '未找到可用方案，请检查组件或手动设置。'
                      : '检查本机组件，选择可用方案。'}
                  </p>
                  {!!component.state?.check?.issues.length && (
                    <ul>
                      {component.state.check.issues.map((issue, index) => (
                        <li key={index}>{issue}</li>
                      ))}
                    </ul>
                  )}
                  <button
                    className="primary-button"
                    disabled={busy || component.busy || active || quickStarting}
                    onClick={() =>
                      void component.run(() => window.desktop.checkTranscriptionComponent())
                    }
                  >
                    {component.busy
                      ? '正在检查可用配置…'
                      : component.state?.check
                        ? '重新检查可用配置'
                        : '检查可用配置'}
                  </button>
                </>
              )}
              <button
                className="text-button"
                disabled={quickStarting}
                onClick={() => setEditing(true)}
              >
                手动选择引擎和设备
              </button>
              {component.error && <p role="alert">{component.error}</p>}
              {quickError && <p role="alert">{quickError}</p>}
            </section>
          )}
          {setupVisible && book && !quickSetup && (
            <SubtitlePreparationForm
              key={`generation-settings:${book.id}`}
              book={book}
              component={component}
              disabled={busy || active}
              componentDisabled={busy || (active && job?.status !== 'queued')}
              requireComponent
              compact
              submitLabel="保存并生成本集"
              pendingLabel="正在保存并生成…"
              onSubmit={saveAndGenerate}
              onCancel={cancelSetup}
            />
          )}
          {capability?.available === false && (
            <p role="status">{capability.message} 请调整方案或重新配置组件。</p>
          )}
          {!setupVisible && (
            <ComponentSetup
              compact
              control={component}
              disabled={busy || (active && job?.status !== 'queued')}
            />
          )}
          <HelpTip label="字幕生成说明">
            已有文稿会保留，新稿可先预览再选择使用。优先准备当前位置，其余内容在后台生成；首次加载模型可能较慢。
          </HelpTip>
        </div>
      </details>
      {!hasDocument && (job || state?.transcript.status === 'ready') && (
        <SubtitleStatus snapshot={subtitleStatus} rate={current ? playback.rate : 1} />
      )}
      <TranscriptionActivity target={target} control={control} compact />
      {job && (
        <div className="transcription-status">
          {job.hasPreview && !job.autoApply && (
            <button
              className="text-button"
              disabled={busy}
              onClick={() =>
                void control.showPreview().then(() => {
                  if (details.current) details.current.open = false
                })
              }
            >
              预览生成稿
            </button>
          )}
          {preview && (
            <>
              <button className="text-button" onClick={control.hidePreview}>
                返回当前文稿
              </button>
              <button
                className="secondary-button"
                disabled={busy || active}
                onClick={() => {
                  const revision =
                    state?.transcript.status === 'ready' ? state.transcript.transcript.revision : 0
                  void run(() => window.desktop.applyTranscription({ id: job.id, revision })).then(
                    (value) => {
                      if (value) control.hidePreview()
                    },
                  )
                }}
              >
                使用生成稿
              </button>
            </>
          )}
          {job.issueCount > 0 && (
            <p className="transcription-note">
              有 {job.issueCount} 处边界或标点待校对，文字已保留。
            </p>
          )}
        </div>
      )}
    </div>
  )
}
