import { useCallback, useEffect, useRef, useState } from 'react'
import type { Result } from '../../shared/contracts'
import type { OriginalMatch, OriginalState, OriginalTarget } from '../../shared/original'
import type {
  AcousticRange,
  OriginalAcousticRequest,
  OriginalAcousticState,
} from '../../shared/original-acoustic'
import { player } from './player'
import './original-acoustic-alignment.css'

function boundaryTime(ms: number) {
  return `${(ms / 1000).toFixed(3)} 秒`
}

function boundaryMovement(previous: number, next: number) {
  const movement = next - previous
  return `${movement > 0 ? '+' : ''}${(movement / 1000).toFixed(3)} 秒`
}

export function OriginalAcousticComparison({
  before,
  after,
}: {
  before: AcousticRange
  after: AcousticRange | null
}) {
  return (
    <div className="original-acoustic-comparison">
      <table aria-label="声音对齐边界比较">
        <thead>
          <tr>
            <th scope="col">原媒体位置</th>
            <th scope="col">起始</th>
            <th scope="col">结束</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">当前人工同步点</th>
            <td>{boundaryTime(before.startMs)}</td>
            <td>{boundaryTime(before.endMs)}</td>
          </tr>
          {after && (
            <>
              <tr>
                <th scope="row">声音对齐建议</th>
                <td>{boundaryTime(after.startMs)}</td>
                <td>{boundaryTime(after.endMs)}</td>
              </tr>
              <tr>
                <th scope="row">移动量</th>
                <td>{boundaryMovement(before.startMs, after.startMs)}</td>
                <td>{boundaryMovement(before.endMs, after.endMs)}</td>
              </tr>
            </>
          )}
        </tbody>
      </table>
    </div>
  )
}

export function useOriginalAcoustic(target: OriginalTarget) {
  const [state, setState] = useState<OriginalAcousticState | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [dismissed, setDismissed] = useState('')
  const mounted = useRef(false),
    reading = useRef(false),
    acting = useRef(false),
    dirty = useRef(false),
    serial = useRef(0),
    current = useRef<OriginalAcousticState | null>(null)
  const audition = useBoundaryAudition(target)
  const update = useCallback((value: OriginalAcousticState) => {
    current.current = value
    setState(value)
  }, [])
  const refresh = useCallback(async () => {
    if (!mounted.current) return
    dirty.current = true
    if (reading.current || acting.current) return
    reading.current = true
    try {
      do {
        dirty.current = false
        const request = serial.current,
          result = await window.desktop.getOriginalAcousticState(target)
        if (!mounted.current) return
        if (request !== serial.current || acting.current) continue
        if (result.ok) update(result.value)
        else setError(result.error.message)
      } while (dirty.current && mounted.current && !acting.current)
    } catch {
      if (mounted.current) setError('无法读取声音对齐任务，请重试。')
    } finally {
      reading.current = false
    }
  }, [target, update])
  useEffect(() => {
    mounted.current = true
    serial.current++
    void Promise.resolve().then(refresh)
    const stop = window.desktop.onOriginalAcousticChanged((change) => {
        if (change.episodeId === target.episodeId && change.audioHash === target.audioHash)
          void refresh()
      }),
      stopComponents = window.desktop.onComponentChanged(() => void refresh())
    return () => {
      mounted.current = false
      stop()
      stopComponents()
      const job = current.current?.job
      if (job?.status === 'running')
        void window.desktop.cancelOriginalAcousticAlignment({ id: job.id }).catch(() => {})
    }
  }, [target, refresh])
  async function run<T>(action: () => Promise<Result<T>>, apply?: (value: T) => void) {
    if (acting.current) return
    acting.current = true
    serial.current++
    setBusy(true)
    setError('')
    try {
      const result = await action()
      if (!mounted.current) return result
      if (result.ok) apply?.(result.value)
      else setError(result.error.message)
      return result
    } catch {
      if (mounted.current) setError('声音对齐操作未完成，请重试。')
    } finally {
      acting.current = false
      if (mounted.current) {
        setBusy(false)
        void refresh()
      }
    }
  }
  async function start(request: OriginalAcousticRequest) {
    setDismissed('')
    const result = await run(() => window.desktop.startOriginalAcousticAlignment(request), update)
    // A start response can arrive after its episode has unmounted. Its worker
    // still belongs to the old view and must not continue unnoticed.
    if (!mounted.current && result?.ok && result.value.job?.status === 'running')
      void window.desktop
        .cancelOriginalAcousticAlignment({ id: result.value.job.id })
        .catch(() => {})
  }
  function cancel() {
    const job = current.current?.job
    if (job) void run(() => window.desktop.cancelOriginalAcousticAlignment({ id: job.id }))
  }
  function discard(id: string) {
    setDismissed(id)
  }
  return { state, busy, error, dismissed, start, cancel, discard, run, audition }
}

function useBoundaryAudition(target: OriginalTarget) {
  const [playing, setPlaying] = useState(''),
    audition = useRef<(AcousticRange & { label: string; lastMs: number }) | null>(null),
    mounted = useRef(false),
    sequence = useRef(0)
  useEffect(() => {
    mounted.current = true
    sequence.current++
    const check = () => {
      const current = audition.current
      if (!current) return
      const playback = player.getSnapshot(),
        position = player.getPosition()
      if (
        playback.episode?.id !== target.episodeId ||
        playback.episode.contentHash !== target.audioHash ||
        !playback.playing ||
        position < current.startMs - 50 ||
        Math.abs(position - current.lastMs) > 1000
      ) {
        audition.current = null
        setPlaying('')
        return
      }
      current.lastMs = position
      if (position >= current.endMs) {
        audition.current = null
        setPlaying('')
        player.pause()
      }
    }
    const stopClock = player.subscribeClock(check),
      stopPlayer = player.subscribe(check)
    return () => {
      mounted.current = false
      const owned = audition.current,
        playback = player.getSnapshot()
      audition.current = null
      stopClock()
      stopPlayer()
      if (
        owned &&
        !playback.loading &&
        playback.episode?.id === target.episodeId &&
        playback.episode.contentHash === target.audioHash
      )
        player.pause()
    }
  }, [target])
  async function listen(range: AcousticRange, label: string) {
    const request = ++sequence.current
    const playback = player.getSnapshot()
    if (
      !playback.ready ||
      playback.episode?.id !== target.episodeId ||
      playback.episode.contentHash !== target.audioHash
    )
      return
    audition.current = null
    player.pause()
    player.seek(range.startMs)
    await player.play(true)
    const current = player.getSnapshot()
    if (
      mounted.current &&
      request === sequence.current &&
      current.episode?.id === target.episodeId &&
      current.episode.contentHash === target.audioHash &&
      current.playing
    ) {
      audition.current = { ...range, label, lastMs: player.getPosition() }
      setPlaying(label)
    }
  }
  function stop() {
    sequence.current++
    if (!audition.current) return
    audition.current = null
    setPlaying('')
    player.pause()
  }
  return { playing, listen, stop }
}

export function OriginalAcousticAlignment({
  target,
  originalId,
  revision,
  match,
  disabled,
  control,
  changed,
}: {
  target: OriginalTarget
  originalId: string
  revision: number
  match: OriginalMatch
  disabled: boolean
  control: ReturnType<typeof useOriginalAcoustic>
  changed: (state: OriginalState) => void
}) {
  const [device, setDevice] = useState<'cpu' | 'cuda'>('cpu')
  const { audition } = control
  const job =
      control.state?.job?.segmentId === match.segmentId &&
      control.state.job.originalId === originalId
        ? control.state.job
        : null,
    visibleJob = job?.id !== control.dismissed ? job : null,
    result = visibleJob?.result,
    proposal =
      result && result.startMs !== null && result.endMs !== null
        ? { startMs: result.startMs, endMs: result.endMs }
        : null,
    running = control.state?.job?.status === 'running',
    outdated = !!job && job.alignmentRevision !== revision,
    locked = disabled || control.busy,
    canApply = visibleJob?.status === 'ready' && result?.status === 'accepted' && !outdated
  return (
    <details className="original-acoustic-alignment">
      <summary>按声音校准已确认原文</summary>
      <p>
        仅校准已人工确认的原文。启动前检查离线对齐模型和所选设备；结果先试听，采用后才更新同步点。
        实验性建议可能遗漏改读或漏字，请逐句试听后再采用。
      </p>
      {!control.state?.configured && <p>请先在“字幕与伴读”中选择本地组件。</p>}
      <div className="original-acoustic-actions">
        <label>
          声音对齐设备
          <select
            value={device}
            disabled={locked || running}
            onChange={(event) => setDevice(event.target.value as 'cpu' | 'cuda')}
          >
            <option value="cpu">CPU</option>
            <option value="cuda">NVIDIA GPU（CUDA）</option>
          </select>
        </label>
        <button
          className="secondary-button"
          disabled={locked || running || !control.state?.configured}
          onClick={() =>
            void control.start({
              ...target,
              originalId,
              revision,
              segmentId: match.segmentId,
              device,
            })
          }
        >
          生成声音对齐建议
        </button>
        {visibleJob?.status === 'running' && (
          <button className="secondary-button" disabled={control.busy} onClick={control.cancel}>
            取消声音对齐
          </button>
        )}
      </div>
      {control.error && <p role="alert">{control.error}</p>}
      {visibleJob && (
        <div className="original-acoustic-result" aria-label="声音对齐结果">
          <p role="status">
            {visibleJob.status === 'running'
              ? visibleJob.stage === 'checking-components'
                ? '正在检查离线对齐模型和设备…'
                : visibleJob.stage === 'loading'
                  ? '正在加载离线对齐模型…'
                  : '正在对齐原文与声音…'
              : visibleJob.status === 'ready'
                ? '声音对齐建议待试听，尚未更改同步点。'
                : visibleJob.status === 'rejected'
                  ? '声音对齐被拒绝，保留当前人工同步点。'
                  : visibleJob.status === 'failed'
                    ? '声音对齐未完成，保留当前人工同步点。'
                    : visibleJob.status === 'canceled'
                      ? '声音对齐已取消，保留当前人工同步点。'
                      : '已采用声音对齐同步点。'}
          </p>
          {visibleJob.error && <p role="alert">{visibleJob.error}</p>}
          <p className="original-acoustic-reference">{visibleJob.originalText}</p>
          {result && (
            <>
              <OriginalAcousticComparison before={visibleJob.oldRange} after={proposal} />
              {result.reasons.map((reason, index) => (
                <p key={`${reason.code}:${index}`}>{reason.message}</p>
              ))}
              {result.status === 'accepted' && !!result.sentenceTimes.length && (
                <ol className="original-acoustic-sentences" aria-label="逐句声音边界">
                  {result.sentenceTimes.map((sentence) => (
                    <li key={sentence.ordinal}>
                      <button
                        className="secondary-button"
                        onClick={() =>
                          void audition.listen(sentence, `第 ${sentence.ordinal + 1} 句`)
                        }
                      >
                        试听原文第 {sentence.ordinal + 1} 句的新边界
                      </button>{' '}
                      {boundaryTime(sentence.startMs)}–{boundaryTime(sentence.endMs)}
                    </li>
                  ))}
                </ol>
              )}
              {outdated && visibleJob.status !== 'applied' && (
                <p role="status">原文匹配或人工同步点已变化，请重新生成建议。</p>
              )}
              <div className="original-acoustic-actions">
                <button
                  className="secondary-button"
                  onClick={() => void audition.listen(visibleJob.oldRange, '旧同步点')}
                >
                  试听旧同步点
                </button>
                {proposal && (
                  <button
                    className="secondary-button"
                    onClick={() => void audition.listen(proposal, '新边界')}
                  >
                    试听新边界
                  </button>
                )}
                {audition.playing && (
                  <button className="secondary-button" onClick={audition.stop}>
                    停止试听{audition.playing}
                  </button>
                )}
                {visibleJob.status === 'ready' && (
                  <>
                    <button
                      className="secondary-button"
                      disabled={locked || !canApply}
                      onClick={() =>
                        void control.run(
                          () =>
                            window.desktop.applyOriginalAcousticAlignment({
                              id: visibleJob.id,
                              revision,
                            }),
                          changed,
                        )
                      }
                    >
                      采用新同步点
                    </button>
                    <button
                      className="secondary-button"
                      disabled={locked}
                      onClick={() => {
                        audition.stop()
                        control.discard(visibleJob.id)
                      }}
                    >
                      拒绝此建议
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {match.acoustic && (
        <div className="original-acoustic-history">
          <p>当前已采用逐句声音同步；此前人工同步点仍可恢复。</p>
          <OriginalAcousticComparison before={match.acoustic.manualRange} after={match} />
          <button
            className="secondary-button"
            disabled={locked || running}
            onClick={() =>
              void control.run(
                () =>
                  window.desktop.restoreOriginalAcousticAlignment({
                    ...target,
                    originalId,
                    revision,
                    segmentId: match.segmentId,
                    historyId: match.acoustic!.id,
                  }),
                changed,
              )
            }
          >
            恢复此前人工同步点
          </button>
        </div>
      )}
    </details>
  )
}
