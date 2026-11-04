import { useCallback, useEffect, useRef, useState } from 'react'
import type { Episode, Result } from '../../shared/contracts'
import { locateTranscript, type StoredTranscript } from '../../shared/transcript'
import {
  emptyListeningReviewEntry,
  LISTENING_REVIEW_TEXT_LIMITS,
  type ListeningReviewEntry,
  type ListeningReviewState,
} from '../../shared/listening-review'
import { player } from './player'
import { ReaderAction } from './ReaderToolbar'
import './listening-review.css'

function time(ms: number) {
  return `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`
}

export function ListeningReview({
  episode,
  transcript,
  iconOnly = false,
}: {
  episode: Episode
  transcript: StoredTranscript
  iconOnly?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      {iconOnly ? (
        <ReaderAction
          label="试听校对"
          icon="headphones"
          onClick={() => {
            player.pause()
            setOpen(true)
          }}
        />
      ) : (
        <button
          className="secondary-button"
          onClick={() => {
            player.pause()
            setOpen(true)
          }}
        >
          试听校对
        </button>
      )}
      {open && (
        <ReviewDialog episode={episode} transcript={transcript} close={() => setOpen(false)} />
      )}
    </>
  )
}

function ReviewDialog({
  episode,
  transcript,
  close,
}: {
  episode: Episode
  transcript: StoredTranscript
  close: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const audio = useRef<HTMLAudioElement>(null)
  const [state, setState] = useState<ListeningReviewState | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [draft, setDraft] = useState<ListeningReviewEntry>(emptyListeningReviewEntry)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [audioError, setAudioError] = useState('')
  const [notice, setNotice] = useState('')
  const [showMachine, setShowMachine] = useState(false)
  const mounted = useRef(false)
  const sequence = useRef<symbol>(Symbol())
  const currentState = useRef<ListeningReviewState | null>(null)
  const actionInFlight = useRef(false)
  const pendingRefresh = useRef(false)
  const refreshCurrent = useRef<(() => Promise<void>) | null>(null)
  const review = state?.review
  const selected = review?.samples.find((sample) => sample.id === selectedId) ?? review?.samples[0]
  const readonly = state?.status !== 'ready'
  const target = { episodeId: episode.id, audioHash: episode.contentHash }
  const updateState = useCallback((value: ListeningReviewState) => {
    currentState.current = value
    setState(value)
  }, [])
  const apply = useCallback(
    (value: ListeningReviewState, preferredId?: string) => {
      updateState(value)
      const sample =
        value.review?.samples.find((item) => item.id === preferredId) ?? value.review?.samples[0]
      setSelectedId(sample?.id ?? '')
      setDraft(sample?.entry ?? emptyListeningReviewEntry())
      setShowMachine(false)
      setAudioError('')
    },
    [updateState],
  )
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    player.pause()
    return () => {
      element.close()
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    async function refresh(initial = false) {
      if (actionInFlight.current) {
        pendingRefresh.current = true
        return
      }
      const serial = Symbol()
      sequence.current = serial
      const reviewId = currentState.current?.review?.id
      try {
        const result = await window.desktop.getListeningReview({
          episodeId: episode.id,
          audioHash: episode.contentHash,
          ...(reviewId ? { reviewId } : {}),
        })
        if (!mounted.current || serial !== sequence.current) return
        if (!result.ok) throw new Error(result.error.message)
        const current = currentState.current
        const before = current?.review,
          after = result.value.review
        const sameFrozen =
          before &&
          after &&
          before.id === after.id &&
          before.audioHash === after.audioHash &&
          before.transcriptId === after.transcriptId &&
          before.transcriptRevision === after.transcriptRevision
        if (initial || !sameFrozen) {
          if (current) audio.current?.pause()
          apply(result.value)
        } else {
          if (result.value.status !== 'ready') audio.current?.pause()
          // Background job progress must preserve the selected sample and dirty
          // human input. Keep its CAS revision if another reviewer saved meanwhile.
          if (before.revision !== after.revision) {
            audio.current?.pause()
            updateState({
              ...current,
              status: 'stale',
              reason: '校对记录已在其他窗口更新，请重新读取后继续。',
            })
          } else updateState(result.value)
        }
      } catch (error) {
        if (!mounted.current || serial !== sequence.current) return
        audio.current?.pause()
        setError(error instanceof Error ? error.message : '无法复核试听校对版本，请重新读取。')
        const current = currentState.current
        if (current)
          updateState({
            ...current,
            status: 'stale',
            reason: '无法确认冻结版本，请重新读取后继续。',
          })
      }
    }
    refreshCurrent.current = () => refresh()
    void refresh(true)
    const stop = window.desktop.onTranscriptionChanged((change) => {
      if (change.episodeId !== episode.id || change.audioHash !== episode.contentHash) return
      void refresh()
    })
    const stopFlush = window.desktop.onFlush(() => audio.current?.pause())
    const stopPlayback = player.subscribe(() => {
      const current = player.getSnapshot()
      if (
        current.playing ||
        current.episode?.id !== episode.id ||
        current.episode.contentHash !== episode.contentHash
      )
        audio.current?.pause()
    })
    return () => {
      mounted.current = false
      sequence.current = Symbol()
      refreshCurrent.current = null
      stop()
      stopFlush()
      stopPlayback()
    }
  }, [episode.id, episode.contentHash, apply, updateState])
  useEffect(() => {
    const element = audio.current
    return () => {
      element?.pause()
    }
  }, [selected?.id, review?.id])

  async function perform(
    action: () => Promise<Result<ListeningReviewState>>,
    success = '',
    preferredId?: string,
    preferredSegment?: string,
  ) {
    const serial = Symbol()
    sequence.current = serial
    actionInFlight.current = true
    setBusy(true)
    setError('')
    setNotice('')
    audio.current?.pause()
    try {
      const result = await action()
      if (!mounted.current || serial !== sequence.current) return
      if (!result.ok) throw new Error(result.error.message)
      apply(
        result.value,
        preferredId ??
          result.value.review?.samples.find((sample) => sample.segmentId === preferredSegment)?.id,
      )
      setNotice(success)
    } catch (error) {
      if (mounted.current && serial === sequence.current)
        setError(error instanceof Error ? error.message : '试听校对未保存。')
    } finally {
      actionInFlight.current = false
      if (mounted.current) {
        setBusy(false)
        if (pendingRefresh.current) {
          pendingRefresh.current = false
          void refreshCurrent.current?.()
        }
      }
    }
  }
  function change(value: Partial<ListeningReviewEntry>) {
    setDraft((entry) => ({ ...entry, ...value }))
    setNotice('')
  }
  function addCurrent() {
    if (!review) return
    const playback = player.getSnapshot()
    const location = locateTranscript(
      transcript.document,
      player.getPosition(),
      episode.durationMs ?? playback.durationMs,
    )
    if (
      playback.episode?.id !== episode.id ||
      playback.episode.contentHash !== episode.contentHash ||
      location.status !== 'sentence'
    ) {
      setError('请先关闭试听校对，在文稿中点击要追加的句子，再打开校对。')
      return
    }
    const segment = transcript.document.segments[location.index]!
    void perform(
      () =>
        window.desktop.saveListeningReview({
          ...target,
          reviewId: review.id,
          revision: review.revision,
          action: 'add-sample',
          segmentId: segment.id,
        }),
      '当前句已保留在样本中，固定样本数量不变。',
      review.samples.find((sample) => sample.segmentId === segment.id)?.id,
      segment.id,
    )
  }
  function clampAudio() {
    if (!audio.current || !selected) return
    const position = audio.current.currentTime * 1000
    if (position < selected.clipStartMs - 1) audio.current.currentTime = selected.clipStartMs / 1000
    else if (position > selected.clipEndMs + 1)
      audio.current.currentTime = selected.clipEndMs / 1000
  }
  const summary = state?.summary
  const dirty = selected && JSON.stringify(draft) !== JSON.stringify(selected.entry)
  return (
    <dialog
      ref={dialog}
      className="listening-review-dialog"
      aria-label="本集试听校对"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <div className="section-heading">
        <h2>本集试听校对</h2>
        <button className="text-button" aria-label="关闭试听校对" onClick={close}>
          关闭
        </button>
      </div>
      <p>{episode.title}</p>
      <p className="tools-hint">
        先实际试听，再独立填写目标范围中听到的内容。人工参考不会从机器文字或小说原文自动填入。保存后重启可恢复，未保存的修改会丢失。
      </p>
      <p className="tools-hint">
        首次按句子序号的 15%、50%、85%
        固定取样，短文稿的重合点合并。可追加当前句，已有样本保留。这是本集的抽样校对，不能代替整集或其他书籍的质量验收，也不代表本书准确率或最终引擎推荐。
      </p>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      <p role="status" className="tools-notice">
        {notice}
      </p>
      {!state && !error && <p role="status">正在读取校对记录…</p>}
      {state && (
        <div className="review-navigation">
          {state.history.length > 0 && (
            <label>
              已保存的版本
              <select
                aria-label="试听校对版本"
                value={review?.id ?? ''}
                disabled={busy}
                onChange={(event) =>
                  void perform(() =>
                    window.desktop.getListeningReview({ ...target, reviewId: event.target.value }),
                  )
                }
              >
                {state.history.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    文稿修订 {entry.transcriptRevision} ·{' '}
                    {entry.createdAt.slice(0, 16).replace('T', ' ')} · {entry.sampleCount} 样本
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() =>
              void perform(
                () => window.desktop.getListeningReview(target),
                '已重新读取当前版本。',
                selectedId,
              )
            }
          >
            重新读取
          </button>
          {state.status !== 'ready' && (
            <button
              className="primary-button"
              disabled={busy}
              onClick={() =>
                void perform(
                  () =>
                    window.desktop.prepareListeningReview({
                      ...target,
                      transcriptRevision: transcript.revision,
                    }),
                  '本集固定试听样本已建立。',
                )
              }
            >
              {busy ? '正在建立…' : '建立本集固定试听样本'}
            </button>
          )}
        </div>
      )}
      {state?.reason && (
        <p className="review-warning" role="status">
          {state.reason} 历史记录保留冻结来源，无法编辑。
        </p>
      )}
      {review && summary && (
        <>
          <section aria-label="听审完成情况" className="review-summary">
            <p>
              固定 {summary.fixedSamples} 段 + 追加 {summary.additionalSamples} 段 · 已听{' '}
              {summary.listenedSamples}/{summary.totalSamples} · 有人工参考{' '}
              {summary.referenceSamples}/{summary.totalSamples} · 参考未知{' '}
              {summary.unknownReferenceSamples}
            </p>
            <p>
              专名已核对 {summary.namesCheckedSamples}/{summary.totalSamples} · 同步已判断{' '}
              {summary.syncJudgedSamples}/{summary.totalSamples} · 人工起止均已标{' '}
              {summary.pairedBoundaries}/{summary.totalSamples}
            </p>
            <strong>
              {summary.reviewStatus === 'review-data-complete'
                ? '校对字段已填写完整；质量验收尚未进行。'
                : '校对尚未完整；未知和缺失样本不会计为通过。'}
            </strong>
            <p className="tools-hint">
              冻结文稿修订 {review.transcriptRevision} · 音频 {review.audioHash.slice(0, 12)} ·{' '}
              {review.sourceProfile
                ? `${review.sourceProfile.engine} / ${review.sourceProfile.device} · 任务 ${review.sourceProfile.jobId.slice(0, 8)} 第 ${review.sourceProfile.attempt} 次`
                : '引擎来源未确认（导入或后续修订）'}{' '}
              · 校对修订 {review.revision}
            </p>
          </section>
          <div className="review-samples" aria-label="试听样本">
            {review.samples.map((sample, index) => (
              <button
                key={sample.id}
                className="secondary-button"
                aria-pressed={sample.id === selected?.id}
                disabled={busy}
                onClick={() => {
                  audio.current?.pause()
                  setSelectedId(sample.id)
                  setDraft(sample.entry)
                  setShowMachine(false)
                  setAudioError('')
                  setNotice('')
                }}
              >
                {sample.kind === 'fixed' ? '固定' : '追加'} {index + 1} ·{' '}
                {time(sample.targetStartMs)}
                {sample.entry.listened ? ' · 已听' : ''}
              </button>
            ))}
            <button className="secondary-button" disabled={busy || readonly} onClick={addCurrent}>
              添加当前播放句为额外样本
            </button>
          </div>
          {selected && (
            <section aria-label="当前试听样本" className="review-editor" key={selected.id}>
              <p>
                <strong>
                  目标范围 {time(selected.targetStartMs)}–{time(selected.targetEndMs)}
                </strong>
                ；试听包含前后各至多 1.5 秒上下文。
              </p>
              <audio
                key={`${review.id}:${selected.id}`}
                ref={audio}
                aria-label="试听片段音频"
                controls
                preload="metadata"
                src={review.mediaUrl}
                onLoadedMetadata={() => {
                  if (audio.current) audio.current.currentTime = selected.clipStartMs / 1000
                }}
                onSeeking={clampAudio}
                onPlay={() => {
                  player.pause()
                  if (audio.current && audio.current.currentTime * 1000 >= selected.clipEndMs - 1)
                    audio.current.currentTime = selected.clipStartMs / 1000
                }}
                onTimeUpdate={() => {
                  if (audio.current && audio.current.currentTime * 1000 >= selected.clipEndMs) {
                    audio.current.pause()
                    audio.current.currentTime = selected.clipEndMs / 1000
                  }
                }}
                onError={() =>
                  setAudioError('试听音频无法读取或版本已变化。请重新读取；未听到的样本保持未知。')
                }
              />
              {audioError && (
                <p className="error-message" role="alert">
                  {audioError}
                </p>
              )}
              <button className="text-button" onClick={() => setShowMachine(!showMachine)}>
                {showMachine ? '隐藏冻结机器文字' : '显示冻结机器文字'}
              </button>
              {showMachine && <p className="review-machine">{selected.machineText}</p>}
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  void perform(
                    () =>
                      window.desktop.saveListeningReview({
                        ...target,
                        reviewId: review.id,
                        revision: review.revision,
                        action: 'feedback',
                        sampleId: selected.id,
                        entry: draft,
                      }),
                    '本片段校对已保存。',
                    selected.id,
                  )
                }}
              >
                <fieldset disabled={busy || readonly}>
                  <label className="review-check">
                    <input
                      type="checkbox"
                      checked={draft.listened}
                      onChange={(event) =>
                        setDraft(
                          event.target.checked
                            ? { ...draft, listened: true }
                            : { ...emptyListeningReviewEntry(), notes: draft.notes },
                        )
                      }
                    />
                    我已实际听过这个片段
                  </label>
                  <label>
                    实际听到的内容
                    <select
                      aria-label="实际听到的内容"
                      disabled={!draft.listened}
                      value={draft.speech}
                      onChange={(event) => {
                        const speech = event.target.value as ListeningReviewEntry['speech']
                        change({
                          speech,
                          spokenText: speech === 'unknown' ? null : '',
                          sync: speech === 'silence' ? 'not-applicable' : 'unknown',
                          humanStartMs: null,
                          humanEndMs: null,
                        })
                      }}
                    >
                      <option value="unknown">未知／还不能确认</option>
                      <option value="speech">有语音，填写人工参考</option>
                      <option value="silence">确认目标范围没有语音</option>
                    </select>
                  </label>
                  {draft.speech === 'speech' && (
                    <label>
                      目标范围的人工参考文字
                      <textarea
                        aria-label="人工参考文字"
                        maxLength={LISTENING_REVIEW_TEXT_LIMITS.spokenText}
                        value={draft.spokenText ?? ''}
                        onChange={(event) => change({ spokenText: event.target.value })}
                        placeholder="只写实际听清的目标内容；无法确认请选未知。"
                      />
                    </label>
                  )}
                  <label className="review-check">
                    <input
                      type="checkbox"
                      disabled={!draft.listened}
                      checked={draft.namesChecked}
                      onChange={(event) =>
                        change({
                          namesChecked: event.target.checked,
                          properNames: event.target.checked ? '' : null,
                        })
                      }
                    />
                    我已核对目标范围的专名（包括确认没有专名）
                  </label>
                  {draft.namesChecked && (
                    <label>
                      听到的专名与写法（没有则留空）
                      <textarea
                        aria-label="专名记录"
                        maxLength={LISTENING_REVIEW_TEXT_LIMITS.properNames}
                        value={draft.properNames ?? ''}
                        onChange={(event) => change({ properNames: event.target.value })}
                      />
                    </label>
                  )}
                  <label>
                    字幕同步判断
                    <select
                      aria-label="字幕同步判断"
                      disabled={!draft.listened || draft.speech === 'silence'}
                      value={draft.sync}
                      onChange={(event) =>
                        change({ sync: event.target.value as ListeningReviewEntry['sync'] })
                      }
                    >
                      <option value="unknown">未知／尚未判断</option>
                      <option value="aligned">目标句与声音基本同步</option>
                      <option value="early">字幕偏早</option>
                      <option value="late">字幕偏晚</option>
                      <option value="mixed">起止不一或混合问题</option>
                      {draft.speech === 'silence' && (
                        <option value="not-applicable">无语音，不适用</option>
                      )}
                    </select>
                  </label>
                  <p className="tools-hint">
                    可选：手工记录目标声音的原媒体起止秒数。未知时留空；不会使用机器时间充当人工边界。
                  </p>
                  <div className="review-boundaries">
                    {(['humanStartMs', 'humanEndMs'] as const).map((key) => (
                      <label key={key}>
                        {key === 'humanStartMs' ? '人工声音起点（秒）' : '人工声音终点（秒）'}
                        <input
                          aria-label={
                            key === 'humanStartMs' ? '人工声音起点（秒）' : '人工声音终点（秒）'
                          }
                          type="number"
                          step="0.001"
                          min={selected.clipStartMs / 1000}
                          max={selected.clipEndMs / 1000}
                          disabled={!draft.listened || draft.speech === 'silence'}
                          value={draft[key] === null ? '' : draft[key] / 1000}
                          onChange={(event) =>
                            change({
                              [key]:
                                event.target.value === ''
                                  ? null
                                  : Math.round(Number(event.target.value) * 1000),
                            })
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <label>
                    校对备注
                    <textarea
                      aria-label="校对备注"
                      maxLength={LISTENING_REVIEW_TEXT_LIMITS.notes}
                      value={draft.notes ?? ''}
                      onChange={(event) => change({ notes: event.target.value || null })}
                    />
                  </label>
                  <button type="submit" className="primary-button">
                    {busy ? '正在保存…' : '保存本片段校对'}
                  </button>
                  {dirty && <span className="tools-hint"> 有未保存修改</span>}
                </fieldset>
              </form>
            </section>
          )}
        </>
      )}
    </dialog>
  )
}
