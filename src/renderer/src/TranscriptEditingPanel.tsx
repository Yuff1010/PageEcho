import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Book, Episode, Result } from '../../shared/contracts'
import type { StoredTranscript, TranscriptRequest } from '../../shared/transcript'
import {
  MAX_RETIMED_SEGMENTS,
  type TranscriptAlignmentState,
  type TranscriptEditOperation,
  type TranscriptEditResult,
  type TranscriptEditingState,
} from '../../shared/transcript-editing'
import { ProcessingPauseNotice } from './ProcessingResourcesPanel'
import {
  TranscriptReplacementEditor,
  type TranscriptEditorAction,
} from './TranscriptReplacementEditor'
import { useTranscriptAudition } from './transcript-editing-audition'
import { player } from './player'
import './transcript-editing.css'

type Tab = 'text' | 'split' | 'merge' | 'timing' | 'replace' | 'alignment'
const TABS: Record<Tab, string> = {
  text: '文字纠错',
  split: '拆句',
  merge: '合句',
  timing: '调整时间',
  replace: '名称批量纠错',
  alignment: '按声音重对齐',
}
function shownTime(ms: number) {
  return `${(ms / 1000).toFixed(3)} 秒`
}
function timingDraft(stored: StoredTranscript, first: number, count: number) {
  return stored.document.segments.slice(first, first + count).map((segment) => ({
    segmentId: segment.id,
    start: String(segment.startMs),
    end: String(segment.endMs),
  }))
}
async function unwrap<T>(result: Promise<Result<T>>): Promise<T> {
  const value = await result
  if (!value.ok) throw new Error(value.error.message)
  return value.value
}

export function TranscriptEditingPanel({
  episode,
  book,
  transcript,
  initialSegmentId,
  editable,
  onSaved,
  onClose,
}: {
  episode: Episode
  book: Omit<Book, 'episodes'> | undefined
  transcript: StoredTranscript
  initialSegmentId: string | null
  editable: boolean
  onSaved: () => Promise<void>
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const target = useMemo<TranscriptRequest>(
    () => ({ episodeId: episode.id, audioHash: episode.contentHash }),
    [episode.id, episode.contentHash],
  )
  const initialIndex = Math.max(
    0,
    transcript.document.segments.findIndex((segment) => segment.id === initialSegmentId),
  )
  const [base, setBase] = useState(transcript),
    baseRef = useRef(transcript)
  const [history, setHistory] = useState<TranscriptEditingState | null>(null),
    [alignment, setAlignment] = useState<TranscriptAlignmentState | null>(null),
    alignmentRef = useRef<TranscriptAlignmentState | null>(null)
  const [tab, setTab] = useState<Tab>('text'),
    [first, setFirst] = useState(String(initialIndex + 1)),
    [count, setCount] = useState('1'),
    [text, setText] = useState(transcript.document.segments[initialIndex]?.text ?? ''),
    [offset, setOffset] = useState(''),
    [atMs, setAtMs] = useState(''),
    [separator, setSeparator] = useState<'' | ' '>(''),
    [times, setTimes] = useState(() => timingDraft(transcript, initialIndex, 1)),
    [device, setDevice] = useState<'cpu' | 'cuda'>(book?.subtitlePreparation?.device ?? 'cpu'),
    [dismissedJob, setDismissedJob] = useState('')
  const [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [stale, setStale] = useState('')
  const [proposal, setProposal] = useState<{
    operation: TranscriptEditOperation
    description: string
  } | null>(null)
  const mounted = useRef(false),
    acting = useRef(false),
    queued = useRef(false),
    readSerial = useRef(Symbol()),
    ownedAlignment = useRef<string | null>(null),
    refreshRef = useRef<() => Promise<void>>(async () => {})
  const bookEpisodeIds = useRef(new Set([episode.id]))
  const [completeBook, setCompleteBook] = useState<Book | null>(null)
  const [bookReadError, setBookReadError] = useState('')
  const [bookReadRevision, setBookReadRevision] = useState(0)
  const detailBookId = book?.id ?? episode.bookId
  useEffect(() => {
    let current = true
    void Promise.resolve().then(async () => {
      if (!current) return
      bookEpisodeIds.current = new Set([episode.id])
      setCompleteBook(null)
      setBookReadError('')
      try {
        const result = await window.desktop.getBookDetail({ id: detailBookId })
        if (!current) return
        if (!result.ok) throw new Error(result.error.message)
        if (!result.value || result.value.id !== detailBookId)
          throw new Error('本书已移除，暂时不能使用整书纠错。')
        setCompleteBook(result.value)
        bookEpisodeIds.current = new Set(result.value.episodes.map((value) => value.id))
        void refreshRef.current()
      } catch (error) {
        if (current)
          setBookReadError(error instanceof Error ? error.message : '无法读取完整目录，请重试。')
      }
    })
    return () => {
      current = false
    }
  }, [detailBookId, episode.id, bookReadRevision])
  const audition = useTranscriptAudition(target),
    auditionStop = useRef(audition.stop)
  useEffect(() => {
    auditionStop.current = audition.stop
  }, [audition.stop])
  const firstIndex = Number(first) - 1,
    selectedCount = Number(count)
  const validSelection =
    !!first.trim() &&
    !!count.trim() &&
    Number.isSafeInteger(firstIndex) &&
    firstIndex >= 0 &&
    Number.isSafeInteger(selectedCount) &&
    selectedCount >= 1 &&
    selectedCount <= MAX_RETIMED_SEGMENTS &&
    firstIndex + selectedCount <= base.document.segments.length
  const selected = validSelection
    ? base.document.segments.slice(firstIndex, firstIndex + selectedCount)
    : []
  const job = alignment?.job?.id === dismissedJob ? null : alignment?.job,
    running = alignment?.job?.status === 'running',
    locked = !!busy || !!stale || !editable || running
  const alignOutdated = !!job && (job.revision !== base.revision || job.transcriptId !== base.id)
  function adoptAlignment(value: TranscriptAlignmentState) {
    alignmentRef.current = value
    setAlignment(value)
  }
  function resetSelection(stored: StoredTranscript, from: number, size: number) {
    const index = Math.max(0, Math.min(from, stored.document.segments.length - 1)),
      length = Math.max(
        1,
        Math.min(size, MAX_RETIMED_SEGMENTS, stored.document.segments.length - index),
      )
    setFirst(String(index + 1))
    setCount(String(length))
    setText(stored.document.segments[index]?.text ?? '')
    setOffset('')
    setAtMs('')
    setTimes(timingDraft(stored, index, length))
    setProposal(null)
  }
  const refresh = useCallback(async () => {
    if (!mounted.current) return
    if (acting.current) {
      queued.current = true
      return
    }
    const serial = Symbol()
    readSerial.current = serial
    try {
      const [current, editing, acoustic] = await Promise.all([
        unwrap(window.desktop.getTranscript(target)),
        unwrap(window.desktop.getTranscriptEditingState(target)),
        unwrap(window.desktop.getTranscriptAlignment(target)),
      ])
      if (!mounted.current || readSerial.current !== serial || acting.current) return
      setHistory(editing)
      adoptAlignment(acoustic)
      const before = baseRef.current
      if (
        current.status !== 'ready' ||
        current.transcript.id !== before.id ||
        current.transcript.revision !== before.revision
      ) {
        auditionStop.current()
        if (ownedAlignment.current === acoustic.job?.id && acoustic.job?.status === 'running')
          void window.desktop.cancelTranscriptAlignment({ id: acoustic.job.id }).catch(() => {})
        setStale('正式文稿已变化，当前草稿保留。请核对并载入当前修订后继续。')
      } else setStale('')
    } catch (error) {
      if (mounted.current && readSerial.current === serial) {
        setError(error instanceof Error ? error.message : '无法核对字幕编辑状态，请重试。')
        setStale('当前修订尚未核对，草稿保留。')
      }
    }
  }, [target])
  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])
  useEffect(() => {
    mounted.current = true
    const element = dialog.current!
    element.showModal()
    void Promise.resolve().then(refresh)
    const changed = (value: TranscriptRequest) => {
      if (value.episodeId === target.episodeId && value.audioHash === target.audioHash)
        void refresh()
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const stopEditing = window.desktop.onTranscriptEditingChanged((value) => {
        // A group undo can become blocked when a different episode is edited.
        // Coalesce a multi-episode commit into one read without touching drafts.
        if (!bookEpisodeIds.current.has(value.episodeId)) return
        clearTimeout(timer)
        timer = setTimeout(() => void refresh(), 75)
      }),
      stopTranscript = window.desktop.onTranscriptionChanged(changed),
      stopFlush = window.desktop.onFlush(() => auditionStop.current())
    return () => {
      mounted.current = false
      readSerial.current = Symbol()
      stopEditing()
      clearTimeout(timer)
      stopTranscript()
      stopFlush()
      auditionStop.current()
      const id = ownedAlignment.current
      if (id && alignmentRef.current?.job?.status !== 'applied')
        void window.desktop.cancelTranscriptAlignment({ id }).catch(() => {})
      element.close()
    }
  }, [target, refresh])
  useEffect(() => {
    if (transcript.id !== baseRef.current.id || transcript.revision !== baseRef.current.revision)
      void refreshRef.current()
  }, [transcript.id, transcript.revision])
  const execute: TranscriptEditorAction = async (label, action, accept) => {
    if (acting.current) return
    acting.current = true
    readSerial.current = Symbol()
    audition.stop()
    setBusy(label)
    setError('')
    setNotice('')
    try {
      const value = await unwrap(action())
      if (mounted.current) accept?.(value)
      return value
    } catch (error) {
      if (mounted.current)
        setError(error instanceof Error ? error.message : '字幕编辑操作未完成，请重试。')
      return
    } finally {
      acting.current = false
      if (mounted.current) {
        setBusy('')
        queued.current = false
        void refreshRef.current()
      }
    }
  }
  function saved(result: TranscriptEditResult) {
    setHistory(result.history)
    setProposal(null)
    setStale('')
    if (result.transcript.status === 'ready') {
      baseRef.current = result.transcript.transcript
      setBase(result.transcript.transcript)
      resetSelection(result.transcript.transcript, Math.max(0, firstIndex), selectedCount || 1)
    }
    setNotice(
      result.replayed ? '此前的编辑已保存，本次返回同一结果。' : '字幕修改已保存，可在本面板撤销。',
    )
    void onSaved()
  }
  function selectRange(nextFirst: string, nextCount: string) {
    audition.stop()
    setDismissedJob(alignment?.job?.id ?? '')
    setProposal(null)
    setError('')
    setNotice('')
    setFirst(nextFirst)
    setCount(nextCount)
    const index = Number(nextFirst) - 1,
      size = Number(nextCount)
    if (
      Number.isSafeInteger(index) &&
      index >= 0 &&
      Number.isSafeInteger(size) &&
      size > 0 &&
      size <= MAX_RETIMED_SEGMENTS
    ) {
      setText(base.document.segments[index]?.text ?? '')
      setTimes(timingDraft(base, index, size))
    }
    setOffset('')
    setAtMs('')
  }
  function prepareChange() {
    setError('')
    setProposal(null)
    if (!validSelection) {
      setError('请选择文稿中相邻的 1–20 句。')
      return
    }
    const segment = selected[0]!
    if (tab === 'text') {
      if (selected.length !== 1 || !text.trim()) {
        setError('文字纠错每次选择一句，并填写非空文字。')
        return
      }
      setProposal({
        operation: { kind: 'text', segmentId: segment.id, text },
        description: `修改前：${segment.text}\n修改后：${text}\n时间保持 ${shownTime(segment.startMs)}–${shownTime(segment.endMs)}。`,
      })
    } else if (tab === 'split') {
      const at = Number(atMs),
        split = Number(offset),
        characters = Array.from(segment.text)
      if (
        selected.length !== 1 ||
        !offset.trim() ||
        !atMs.trim() ||
        !Number.isSafeInteger(split) ||
        split <= 0 ||
        split >= characters.length ||
        !Number.isSafeInteger(at) ||
        at <= segment.startMs ||
        at >= segment.endMs
      ) {
        setError('选择一句，填写句内字符切点及明确的原音频分割毫秒。')
        return
      }
      setProposal({
        operation: { kind: 'split', segmentId: segment.id, offset: split, atMs: at },
        description: `前句：${characters.slice(0, split).join('')}\n${shownTime(segment.startMs)}–${shownTime(at)}\n后句：${characters.slice(split).join('')}\n${shownTime(at)}–${shownTime(segment.endMs)}`,
      })
    } else if (tab === 'merge') {
      if (selected.length !== 2) {
        setError('合句每次选择相邻两句。')
        return
      }
      const next = selected[1]!
      setProposal({
        operation: { kind: 'merge', firstId: segment.id, secondId: next.id, separator },
        description: `合并文字：${segment.text}${separator}${next.text}\n原音频范围：${shownTime(segment.startMs)}–${shownTime(next.endMs)}；句间停顿 ${shownTime(Math.max(0, next.startMs - segment.endMs))} 会包含在字幕显示范围内。`,
      })
    } else if (tab === 'timing') {
      if (
        times.length !== selected.length ||
        times.some(
          (range) =>
            !range.start.trim() ||
            !range.end.trim() ||
            !Number.isSafeInteger(Number(range.start)) ||
            !Number.isSafeInteger(Number(range.end)) ||
            Number(range.start) < 0 ||
            Number(range.end) <= Number(range.start),
        )
      ) {
        setError('各句起止时间需要有效的原媒体整数毫秒。')
        return
      }
      setProposal({
        operation: {
          kind: 'timing',
          ranges: times.map((range) => ({
            segmentId: range.segmentId,
            startMs: Number(range.start),
            endMs: Number(range.end),
          })),
        },
        description: times
          .map(
            (range, index) => `第 ${firstIndex + index + 1} 句：${range.start}–${range.end} 毫秒`,
          )
          .join('\n'),
      })
    }
  }
  async function startAlignment() {
    if (!validSelection) {
      setError('请选择相邻的 1–20 句。')
      return
    }
    setDismissedJob('')
    const result = await execute(
      '正在启动字幕重对齐…',
      () =>
        window.desktop.startTranscriptAlignment({
          ...target,
          revision: base.revision,
          requestId: crypto.randomUUID(),
          segmentIds: selected.map((segment) => segment.id),
          device,
        }),
      (value) => {
        adoptAlignment(value)
        ownedAlignment.current = value.job?.id ?? null
      },
    )
    if (!mounted.current && result?.job)
      void window.desktop.cancelTranscriptAlignment({ id: result.job.id }).catch(() => {})
  }
  const alignmentRange = job?.ranges.length
    ? { startMs: job.ranges[0]!.startMs, endMs: job.ranges.at(-1)!.endMs }
    : null
  return (
    <dialog
      ref={dialog}
      className="listening-dialog transcript-editing-dialog"
      aria-label="字幕编辑"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="section-heading">
        <h2>字幕编辑</h2>
        <button className="text-button" aria-label="关闭字幕编辑" onClick={onClose}>
          关闭
        </button>
      </div>
      <p>
        {episode.title} · 正式文稿版本 {base.revision}
      </p>
      <p className="tools-hint">
        修改前先预览。字幕时间、人工原文同步点和音频播放位置分别保存；编辑不修改声音、书签或片段标注。
      </p>
      <ProcessingPauseNotice />
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="tools-notice" role="status">
          {notice}
        </p>
      )}
      {busy && <p role="status">{busy}</p>}
      {!editable && (
        <p role="status">当前为生成稿预览或自动分块仍在写入，请先结束自动写入后编辑正式稿。</p>
      )}
      {stale && (
        <div className="transcript-edit-stale" role="status">
          <p>{stale}</p>
          <div className="tools-form">
            <button className="secondary-button" disabled={!!busy} onClick={() => void refresh()}>
              重新核对修订
            </button>
            <button
              className="text-button"
              disabled={!!busy}
              onClick={() =>
                void execute(
                  '正在载入当前修订…',
                  () => window.desktop.getTranscript(target),
                  (value) => {
                    if (value.status !== 'ready') {
                      setError('当前没有可编辑的正式稿。')
                      return
                    }
                    baseRef.current = value.transcript
                    setBase(value.transcript)
                    resetSelection(value.transcript, Math.max(0, firstIndex), 1)
                    setStale('')
                    setNotice('已载入当前修订，旧面板草稿已清空。')
                  },
                )
              }
            >
              载入当前修订并清空草稿
            </button>
          </div>
        </div>
      )}
      <section className="transcript-edit-history" aria-label="字幕编辑历史">
        <button
          className="secondary-button"
          disabled={locked || !history?.undo || !!history.undoBlocked}
          onClick={() => {
            if (history?.undo)
              void execute(
                '正在撤销字幕修改…',
                () =>
                  window.desktop.undoTranscriptEdit({
                    ...target,
                    revision: base.revision,
                    historyId: history.undo!.id,
                    commandId: crypto.randomUUID(),
                  }),
                saved,
              )
          }}
        >
          撤销字幕修改
        </button>
        <button
          className="secondary-button"
          disabled={locked || !history?.redo || !!history.redoBlocked}
          onClick={() => {
            if (history?.redo)
              void execute(
                '正在重做字幕修改…',
                () =>
                  window.desktop.redoTranscriptEdit({
                    ...target,
                    revision: base.revision,
                    historyId: history.redo!.id,
                    commandId: crypto.randomUUID(),
                  }),
                saved,
              )
          }}
        >
          重做字幕修改
        </button>
        <p className="tools-hint">
          已保留 {history?.historyCount ?? 0} / {history?.historyLimit ?? 20} 步，重启后仍可撤销。
          {history?.undo &&
            `下一步撤销：${history.undo.label} · ${history.undo.episodes} 集 / ${history.undo.segments} 句；多集修改会整组撤销。`}
        </p>
        {history?.undoBlocked && <p role="status">无法撤销：{history.undoBlocked}</p>}
        {history?.redoBlocked && <p role="status">无法重做：{history.redoBlocked}</p>}
      </section>
      <nav className="maintenance-tabs transcript-edit-tabs" aria-label="字幕编辑操作">
        {(Object.keys(TABS) as Tab[]).map((value) => (
          <button
            key={value}
            disabled={!!busy || running}
            aria-pressed={tab === value}
            onClick={() => {
              audition.stop()
              setProposal(null)
              setTab(value)
              if (value === 'merge' && firstIndex + 1 < base.document.segments.length) {
                setCount('2')
                setTimes(timingDraft(base, firstIndex, 2))
                setDismissedJob(alignment?.job?.id ?? '')
              }
            }}
          >
            {TABS[value]}
          </button>
        ))}
      </nav>
      {tab === 'replace' ? (
        <TranscriptReplacementEditor
          key={`${base.id}:${base.revision}`}
          target={{ ...target, revision: base.revision }}
          book={completeBook?.id === detailBookId ? completeBook : undefined}
          bookLoading={!completeBook && !bookReadError}
          bookError={bookReadError}
          retryBook={() => setBookReadRevision((value) => value + 1)}
          locked={locked}
          execute={execute}
          saved={saved}
        />
      ) : (
        <section aria-label="所选字幕编辑">
          <fieldset disabled={locked || running}>
            <div className="tools-form">
              <label>
                起始句
                <input
                  aria-label="编辑起始句"
                  type="number"
                  min={1}
                  max={base.document.segments.length}
                  step={1}
                  value={first}
                  onChange={(event) => selectRange(event.target.value, count)}
                />
              </label>
              <label>
                连续句数
                <input
                  aria-label="连续编辑句数"
                  type="number"
                  min={1}
                  max={MAX_RETIMED_SEGMENTS}
                  step={1}
                  value={count}
                  onChange={(event) => selectRange(first, event.target.value)}
                />
              </label>
              <span>最多相邻 {MAX_RETIMED_SEGMENTS} 句</span>
            </div>
            <ol className="transcript-edit-selection">
              {selected.map((segment, index) => (
                <li key={segment.id}>
                  第 {firstIndex + index + 1} 句 · {shownTime(segment.startMs)}–
                  {shownTime(segment.endMs)}
                  <p>{segment.text}</p>
                </li>
              ))}
            </ol>
            {!validSelection && <p className="error-message">请选择文稿中有效的相邻句范围。</p>}
            {tab === 'text' && (
              <label>
                文字纠错
                <textarea
                  aria-label="字幕编辑文字"
                  maxLength={10000}
                  value={text}
                  onChange={(event) => {
                    setProposal(null)
                    setText(event.target.value)
                  }}
                />
                <p className="tools-hint">单句小范围纠错保留时间；大幅修改请分步核对并重对齐。</p>
              </label>
            )}
            {tab === 'split' && (
              <div>
                <p>
                  按 Unicode 码点填写切点；当前首句共 {Array.from(selected[0]?.text ?? '').length}{' '}
                  字符。分割时间需要试听确认，不会按字数自动均分。
                </p>
                <div className="tools-form">
                  <label>
                    第几个字符后
                    <input
                      aria-label="拆句字符切点"
                      type="number"
                      min={1}
                      step={1}
                      value={offset}
                      onChange={(event) => {
                        setProposal(null)
                        setOffset(event.target.value)
                      }}
                    />
                  </label>
                  <label>
                    原音频分割毫秒
                    <input
                      aria-label="拆句分割毫秒"
                      type="number"
                      min={0}
                      step={1}
                      value={atMs}
                      onChange={(event) => {
                        setProposal(null)
                        setAtMs(event.target.value)
                      }}
                    />
                  </label>
                  <button
                    className="text-button"
                    onClick={() => {
                      setProposal(null)
                      setAtMs(String(Math.round(player.getPosition())))
                    }}
                  >
                    使用当前播放毫秒
                  </button>
                </div>
              </div>
            )}
            {tab === 'merge' && (
              <div>
                <p>每次合并相邻两句，只能位于同一已覆盖区间；未覆盖空洞不能跨过。</p>
                <label>
                  拼接方式
                  <select
                    aria-label="合句拼接方式"
                    value={separator}
                    onChange={(event) => {
                      setProposal(null)
                      setSeparator(event.target.value as '' | ' ')
                    }}
                  >
                    <option value="">直接拼接</option>
                    <option value=" ">加一个空格</option>
                  </select>
                </label>
              </div>
            )}
            {tab === 'timing' && (
              <div className="transcript-timing-rows">
                {times.map((range, index) => (
                  <div key={range.segmentId}>
                    <p>第 {firstIndex + index + 1} 句</p>
                    <div className="tools-form">
                      <label>
                        起始毫秒
                        <input
                          aria-label={`第 ${firstIndex + index + 1} 句起始毫秒`}
                          type="number"
                          min={0}
                          step={1}
                          value={range.start}
                          onChange={(event) => {
                            setProposal(null)
                            setTimes((before) =>
                              before.map((value, i) =>
                                i === index ? { ...value, start: event.target.value } : value,
                              ),
                            )
                          }}
                        />
                      </label>
                      <label>
                        结束毫秒
                        <input
                          aria-label={`第 ${firstIndex + index + 1} 句结束毫秒`}
                          type="number"
                          min={0}
                          step={1}
                          value={range.end}
                          onChange={(event) => {
                            setProposal(null)
                            setTimes((before) =>
                              before.map((value, i) =>
                                i === index ? { ...value, end: event.target.value } : value,
                              ),
                            )
                          }}
                        />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {tab !== 'alignment' && (
              <button className="secondary-button" onClick={prepareChange}>
                预览字幕修改
              </button>
            )}
            {tab === 'alignment' && (
              <div>
                <p>
                  实验性声音建议：最多 60 秒、1,000
                  字。启动前检查离线对齐模型和明确选择的设备；完整字符证据通过后仍需试听、明确采用。
                </p>
                <div className="tools-form">
                  <label>
                    对齐设备
                    <select
                      aria-label="字幕重对齐设备"
                      value={device}
                      onChange={(event) => {
                        setDismissedJob(alignment?.job?.id ?? '')
                        setDevice(event.target.value as typeof device)
                      }}
                    >
                      <option value="cpu">CPU</option>
                      <option value="cuda">NVIDIA GPU</option>
                    </select>
                  </label>
                  <button
                    className="secondary-button"
                    disabled={!alignment?.configured || !validSelection}
                    onClick={() => void startAlignment()}
                  >
                    生成字幕时间建议
                  </button>
                </div>
                {alignment && !alignment.configured && <p>请先在“字幕与伴读”中选择本地组件。</p>}
              </div>
            )}
          </fieldset>
          {selected.length > 0 && (
            <div className="tools-form">
              <button
                className="text-button"
                disabled={!!busy || !!stale}
                onClick={() =>
                  void audition.listen(selected[0]!.startMs, selected.at(-1)!.endMs, '当前字幕范围')
                }
              >
                试听当前字幕范围
              </button>
              {audition.playing && (
                <>
                  <span role="status">正在试听：{audition.playing}</span>
                  <button className="text-button" onClick={audition.stop}>
                    停止字幕试听
                  </button>
                </>
              )}
            </div>
          )}
          {proposal && (
            <div className="transcript-edit-preview" aria-label="字幕修改预览">
              <h3>修改预览</h3>
              <p style={{ whiteSpace: 'pre-wrap' }}>{proposal.description}</p>
              <p className="tools-hint">主进程会重新检查修订、完整时间范围及邻句；应用后可撤销。</p>
              <button
                className="primary-button"
                disabled={locked}
                onClick={() =>
                  void execute(
                    '正在应用字幕修改…',
                    () =>
                      window.desktop.changeTranscript({
                        ...target,
                        revision: base.revision,
                        operation: proposal.operation,
                        commandId: crypto.randomUUID(),
                      }),
                    saved,
                  )
                }
              >
                应用字幕修改
              </button>
            </div>
          )}
          {tab === 'alignment' && job && (
            <section className="transcript-edit-preview" aria-label="字幕时间建议">
              <h3>字幕时间建议</h3>
              <p>
                {job.status === 'running'
                  ? job.stage === 'checking-components'
                    ? '正在检查模型和设备…'
                    : '正在按声音对齐…'
                  : job.status === 'ready'
                    ? '建议已生成，尚未修改正式字幕。'
                    : job.status === 'rejected'
                      ? '声音证据未通过，当前时间保留。'
                      : job.status === 'applied'
                        ? '该建议已采用，可撤销字幕修改。'
                        : job.status === 'canceled'
                          ? '本次重对齐已取消。'
                          : '重对齐未完成。'}
              </p>
              {job.error && <p className="error-message">{job.error}</p>}
              {alignOutdated && <p role="status">正式文稿版本已变化，旧建议不能采用。</p>}
              {job.result?.reasons.map((reason, index) => (
                <p key={index}>{reason.message}</p>
              ))}
              {job.ranges.length > 0 && (
                <ol className="transcript-edit-selection">
                  {job.ranges.map((range) => {
                    const before = job.segments.find((segment) => segment.id === range.segmentId)
                    return (
                      <li key={range.segmentId}>
                        <p>{before?.text}</p>
                        <p>
                          当前：
                          {before && `${shownTime(before.startMs)}–${shownTime(before.endMs)}`}
                          <br />
                          建议：{shownTime(range.startMs)}–{shownTime(range.endMs)}
                        </p>
                      </li>
                    )
                  })}
                </ol>
              )}
              <div className="tools-form">
                {job.status === 'running' && (
                  <button
                    className="text-button"
                    disabled={!!busy}
                    onClick={() =>
                      void execute('正在取消字幕重对齐…', () =>
                        window.desktop.cancelTranscriptAlignment({ id: job.id }),
                      )
                    }
                  >
                    取消字幕重对齐
                  </button>
                )}
                {job.status === 'ready' && alignmentRange && (
                  <>
                    <button
                      className="secondary-button"
                      disabled={locked || alignOutdated}
                      onClick={() =>
                        void audition.listen(
                          alignmentRange.startMs,
                          alignmentRange.endMs,
                          '重对齐建议范围',
                        )
                      }
                    >
                      试听建议范围
                    </button>
                    <button
                      className="primary-button"
                      disabled={locked || alignOutdated || job.result?.status !== 'accepted'}
                      onClick={() =>
                        void execute(
                          '正在采用字幕时间建议…',
                          () =>
                            window.desktop.applyTranscriptAlignment({
                              id: job.id,
                              revision: base.revision,
                              commandId: crypto.randomUUID(),
                            }),
                          saved,
                        )
                      }
                    >
                      采用字幕时间建议
                    </button>
                  </>
                )}
              </div>
            </section>
          )}
        </section>
      )}
    </dialog>
  )
}
