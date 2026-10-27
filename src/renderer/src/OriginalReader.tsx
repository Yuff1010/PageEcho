import { Fragment, useEffect, useMemo, useState, useSyncExternalStore, useRef } from 'react'
import type { Episode, Result } from '../../shared/contracts'
import {
  ORIGINAL_PAGE_SIZE,
  type OriginalCandidate,
  type OriginalCorrection,
  type OriginalMatch,
  type OriginalPage,
  type OriginalState,
  type OriginalTarget,
} from '../../shared/original'
import { player } from './player'
import { OriginalSearch } from './OriginalSearch'
import { SubtitleExport } from './SubtitleExport'
import { OriginalAcousticAlignment, useOriginalAcoustic } from './OriginalAcousticAlignment'
import { Icon } from './Icons'
import { readingParagraphs } from './reader-layout'
import { ReaderFooter, ReaderAction } from './ReaderToolbar'
import { ReaderDockSlot } from './ReaderDock'
import { CompanionReadingViewport } from './CompanionReadingViewport'
import { useCompanionPagination } from './useCompanionPagination'
import type { ReaderSettings } from './reader-settings'
import './companion-original.css'
import { locateTranscript, type StoredTranscript } from '../../shared/transcript'

type OriginalPanel = 'tools' | 'search' | 'contents' | null
type OriginalTool = 'source' | 'matching' | 'export'

interface OriginalReaderProps {
  episode: Episode
  visible: boolean
  settings: ReaderSettings
  transcriptRevision: number
  hasTranscript?: boolean
  searchRequest?: number
  toolsRequest?: number
  contentsRequest?: number
  focused?: boolean
  onLinkBook?: () => void
  fallbackTranscript?: StoredTranscript | null
  onShowTranscript?: () => void
}

export function OriginalReader(props: OriginalReaderProps) {
  return (
    <OriginalReaderForEpisode key={`${props.episode.id}:${props.episode.contentHash}`} {...props} />
  )
}

function OriginalReaderForEpisode({
  episode,
  visible,
  settings,
  transcriptRevision,
  hasTranscript = transcriptRevision > 0,
  searchRequest = 0,
  toolsRequest = 0,
  contentsRequest = 0,
  focused = false,
  onLinkBook,
  fallbackTranscript,
  onShowTranscript,
}: OriginalReaderProps) {
  const target = useMemo(
    () => ({ episodeId: episode.id, audioHash: episode.contentHash }),
    [episode.id, episode.contentHash],
  )
  const acoustic = useOriginalAcoustic(target)
  const [state, setState] = useState<OriginalState | null>(null)
  const [page, setPage] = useState<OriginalPage | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [following, setFollowing] = useState(true)
  const [browsed, setBrowsed] = useState(0)
  const [reviewPage, setReviewPage] = useState(0)
  const [reviewFilter, setReviewFilter] = useState('all')
  const [editing, setEditing] = useState<string | null>(null)
  const [searchHit, setSearchHit] = useState<{ first: number; last: number } | null>(null)
  const [panel, setPanel] = useState<OriginalPanel>(null)
  const [tool, setTool] = useState<OriginalTool>('source')
  const [chapterQuery, setChapterQuery] = useState('')
  const drawer = useRef<HTMLElement>(null)
  const panelTrigger = useRef<HTMLElement | null>(null)
  const identity = `${episode.id}:${episode.contentHash}`
  const currentIdentity = useRef(identity)
  const mounted = useRef(true)
  const refreshSerial = useRef(0)
  const actionSerial = useRef(0)
  const acting = useRef(false)
  const refreshCurrent = useRef<() => void>(() => {})
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const activeKey = useSyncExternalStore(player.subscribeClock, () => {
    const current = player.getSnapshot().episode
    if (
      !state?.alignment ||
      state.stale ||
      current?.id !== episode.id ||
      current.contentHash !== episode.contentHash
    )
      return ''
    const position = player.getPosition(),
      matches = state.alignment.matches
    let low = 0,
      high = matches.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (matches[mid]!.startMs <= position) low = mid + 1
      else high = mid
    }
    const index = low - 1,
      match = matches[index]
    if (!match || position >= match.endMs) return ''
    if (match.acoustic) {
      const sentence = match.acoustic.sentenceTimes.find(
        (time) => time.startMs <= position && position < time.endMs,
      )
      return sentence ? `${index}:${sentence.ordinal}` : ''
    }
    return `${index}:all`
  })
  const activeIndex = activeKey ? Number(activeKey.split(':')[0]) : -1
  const fallbackIndex = useSyncExternalStore(player.subscribeClock, () => {
    const current = player.getSnapshot()
    if (
      !fallbackTranscript ||
      current.episode?.id !== episode.id ||
      current.episode.contentHash !== episode.contentHash
    )
      return -1
    const located = locateTranscript(
      fallbackTranscript.document,
      player.getPosition(),
      current.durationMs,
    )
    return located.status === 'sentence' ? located.index : -1
  })
  const fallbackText = fallbackTranscript?.document.segments[fallbackIndex]?.text
  const activeMatch = activeIndex >= 0 ? state?.alignment?.matches[activeIndex] : undefined
  const active = useMemo(() => {
    if (!activeMatch?.selected) return undefined
    const ordinal = activeKey.split(':')[1]
    return ordinal === 'all'
      ? activeMatch.selected
      : { first: Number(ordinal), last: Number(ordinal) }
  }, [activeMatch, activeKey])
  const start =
    following && active
      ? Math.floor(active.first / ORIGINAL_PAGE_SIZE) * ORIGINAL_PAGE_SIZE
      : browsed
  const pending = page?.info.id === state?.info?.id && page?.start === start ? page : null
  const pagination = useCompanionPagination({
    settings,
    visible,
    contentKey: `${state?.info?.id ?? ''}:${start}:${pending?.start ?? 'loading'}:${pending?.sentences.length ?? 0}`,
    firstOrdinal: start,
    lastOrdinal: start + (pending?.sentences.length ?? 0) - 1,
    total: state?.info?.sentenceCount ?? 0,
    onManualBrowse: pauseFollowing,
    onBoundary: (ordinal) => browse(Math.floor(ordinal / ORIGINAL_PAGE_SIZE) * ORIGINAL_PAGE_SIZE),
  })
  const { viewport, reveal } = pagination
  function pauseFollowing() {
    setBrowsed(start)
    setFollowing(false)
  }
  function closePanel(returnToText = false) {
    setPanel(null)
    requestAnimationFrame(() =>
      (returnToText ? viewport.current : (panelTrigger.current ?? viewport.current))?.focus({
        preventScroll: true,
      }),
    )
  }
  useEffect(() => {
    if (!searchRequest) return
    const frame = requestAnimationFrame(() => {
      panelTrigger.current = document.activeElement as HTMLElement | null
      setPanel('search')
    })
    return () => cancelAnimationFrame(frame)
  }, [searchRequest])
  useEffect(() => {
    if (!toolsRequest) return
    const frame = requestAnimationFrame(() => {
      panelTrigger.current = document.activeElement as HTMLElement | null
      setTool('source')
      setPanel('tools')
    })
    return () => cancelAnimationFrame(frame)
  }, [toolsRequest])
  useEffect(() => {
    if (!contentsRequest) return
    const frame = requestAnimationFrame(() => {
      panelTrigger.current = document.activeElement as HTMLElement | null
      setPanel('contents')
    })
    return () => cancelAnimationFrame(frame)
  }, [contentsRequest])
  useEffect(() => {
    if (visible && !focused) return
    const frame = requestAnimationFrame(() => setPanel(null))
    return () => cancelAnimationFrame(frame)
  }, [visible, focused])
  useEffect(() => {
    if (!panel || !visible) return
    const frame = requestAnimationFrame(() => {
      const input = drawer.current?.querySelector<HTMLElement>(
        panel === 'search' ? '.original-search input' : panel === 'contents' ? 'input' : 'button',
      )
      input?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [panel, visible])
  useEffect(() => {
    let canceled = false
    const refresh = async () => {
      if (acting.current) return
      const request = ++refreshSerial.current
      try {
        const result = await window.desktop.getOriginalState(target)
        if (
          canceled ||
          identity !== currentIdentity.current ||
          request !== refreshSerial.current ||
          acting.current
        )
          return
        if (result.ok) setState(result.value)
        else setError((current) => current || result.error.message)
      } catch {
        if (
          !canceled &&
          identity === currentIdentity.current &&
          request === refreshSerial.current &&
          !acting.current
        )
          setError((current) => current || '无法读取原文匹配状态，请重试。')
      }
    }
    refreshCurrent.current = () => {
      void refresh()
    }
    void refresh()
    const stop = window.desktop.onTranscriptionChanged((change) => {
      if (change.episodeId === target.episodeId && change.audioHash === target.audioHash)
        void refresh()
    })
    return () => {
      canceled = true
      stop()
    }
  }, [target, transcriptRevision, identity])
  useEffect(() => {
    if (!state?.info) return
    let canceled = false
    void window.desktop
      .getOriginalPage({ ...target, originalId: state.info.id, start })
      .then((result) => {
        if (canceled) return
        if (result.ok) setPage(result.value)
        else setError(result.error.message)
      })
      .catch(() => {
        if (!canceled) setError('原文正文读取失败，请重新打开章节或重试。')
      })
    return () => {
      canceled = true
    }
  }, [target, state?.info, start])
  useEffect(() => {
    if (following && visible && active && pending) reveal(active.first)
  }, [following, visible, activeKey, active, pending, settings, reveal])
  useEffect(() => {
    if (!following || !active) return
    const frame = requestAnimationFrame(() =>
      setBrowsed(Math.floor(active.first / ORIGINAL_PAGE_SIZE) * ORIGINAL_PAGE_SIZE),
    )
    return () => cancelAnimationFrame(frame)
  }, [following, active])
  useEffect(() => {
    if (!following && visible && searchHit && pending) reveal(searchHit.first, true)
  }, [following, visible, searchHit, pending, settings, reveal])
  async function run(action: () => Promise<Result<OriginalState>>) {
    const requestIdentity = identity,
      serial = ++actionSerial.current
    const current = () =>
      mounted.current &&
      requestIdentity === currentIdentity.current &&
      serial === actionSerial.current
    acting.current = true
    refreshSerial.current++
    setBusy(true)
    setError('')
    try {
      const result = await action()
      if (!current()) return
      if (result.ok) {
        setState(result.value)
        setEditing(null)
        setSearchHit(null)
      } else setError(result.error.message)
    } catch {
      if (current()) setError('原文操作失败，请重试。')
    } finally {
      if (current()) {
        acting.current = false
        setBusy(false)
        refreshCurrent.current()
      }
    }
  }
  async function importOriginal() {
    const requestIdentity = identity,
      serial = ++actionSerial.current
    const current = () =>
      mounted.current &&
      requestIdentity === currentIdentity.current &&
      serial === actionSerial.current
    acting.current = true
    refreshSerial.current++
    setBusy(true)
    setError('')
    try {
      const result = await window.desktop.importOriginal(target)
      if (!current()) return
      if (!result.ok) setError(result.error.message)
      else if (!result.value.canceled) {
        setState(result.value.state)
        setBrowsed(0)
        setFollowing(false)
        setPage(null)
        setEditing(null)
        setSearchHit(null)
        setPanel(null)
        requestAnimationFrame(() => viewport.current?.focus({ preventScroll: true }))
      }
    } catch {
      if (current()) setError('原文导入失败，请重试。')
    } finally {
      if (current()) {
        acting.current = false
        setBusy(false)
        refreshCurrent.current()
      }
    }
  }
  const info = state?.info,
    alignment = state?.alignment
  const matches = alignment?.matches ?? []
  const reviewMatches = matches.filter((match) =>
    reviewFilter === 'unmatched'
      ? !match.selected
      : reviewFilter === 'reviewed'
        ? match.reviewed
        : true,
  )
  const reviewStart = Math.min(
    reviewPage * 20,
    Math.max(0, Math.floor((reviewMatches.length - 1) / 20) * 20),
  )
  function browse(value: number) {
    setFollowing(false)
    setBrowsed(Math.max(0, Math.min(value, Math.max(0, (info?.sentenceCount ?? 1) - 1))))
  }
  const chapter =
    info?.chapters.find(
      (value) =>
        pagination.location.ordinal >= value.first &&
        pagination.location.ordinal < value.first + value.count,
    ) ?? info?.chapters[pending?.sentences[0]?.chapter ?? 0]
  const groups = readingParagraphs(pending?.sentences ?? [])
  function sentenceTimes(ordinal: number) {
    if (state?.stale) return []
    return matches.flatMap((match) => {
      if (!match.selected || ordinal < match.selected.first || ordinal > match.selected.last)
        return []
      if (!match.acoustic) return [{ startMs: match.startMs, endMs: match.endMs }]
      const time = match.acoustic.sentenceTimes.find((value) => value.ordinal === ordinal)
      return time ? [time] : []
    })
  }
  const focusOrdinal =
    active && pending?.sentences.some((sentence) => sentence.ordinal === active.first)
      ? active.first
      : pending?.sentences.find((sentence) => sentenceTimes(sentence.ordinal).length)?.ordinal
  function seekSentence(ordinal: number) {
    const nearest = sentenceTimes(ordinal).sort(
      (a, b) =>
        Math.abs(a.startMs - player.getPosition()) - Math.abs(b.startMs - player.getPosition()),
    )[0]
    if (!nearest) return
    player.seek(nearest.startMs)
    setFollowing(true)
    setSearchHit(null)
  }
  return (
    <section className="original-reader companion-original-reader" aria-label="小说原文">
      <div
        className="original-reading-surface"
        inert={!!panel}
        aria-hidden={panel ? true : undefined}
      >
        {info && following && !active && fallbackText && (
          <aside className="original-transcript-fallback" aria-label="当前声音的转写字幕">
            <div>
              <strong>当前声音尚未匹配原文 · 转写字幕</strong>
              {onShowTranscript && (
                <ReaderAction
                  className="reader-button"
                  onClick={onShowTranscript}
                  label="查看转写字幕"
                  icon="transcript"
                />
              )}
            </div>
            <p>{fallbackText}</p>
          </aside>
        )}
        {!state ? (
          <div className="original-empty" role="status">
            正在打开小说原文…
          </div>
        ) : !info ? (
          <div className="original-empty">
            <Icon name="book" />
            <h2>用小说原文伴读</h2>
            <p>为这本有声书选择同一作品的 TXT 或 EPUB，阅读时可跟随已匹配的声音。</p>
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => void importOriginal()}
            >
              导入 TXT / EPUB 原文
            </button>
            {onLinkBook && (
              <button className="secondary-button" onClick={onLinkBook}>
                从电子书书架选择原文
              </button>
            )}
            <p className="original-hint">想独立阅读电子书，可从书架的“电子书”分类打开。</p>
          </div>
        ) : (
          <>
            <CompanionReadingViewport
              pagination={pagination}
              settings={settings}
              label="原文阅读区"
              className="original-viewport"
              busy={!pending}
            >
              {!pending ? (
                <p role="status">正在读取原文…</p>
              ) : (
                <article className="original-prose companion-flow-prose">
                  {groups.map((group) => {
                    const first = group[0]!
                    return (
                      <Fragment key={`${first.chapter}:${first.paragraph}`}>
                        {first.ordinal === info.chapters[first.chapter]?.first && (
                          <h3 className="original-chapter-heading ebook-chapter-title">
                            {info.chapters[first.chapter]?.title}
                          </h3>
                        )}
                        <p>
                          {group.map((sentence) => {
                            const mapped = sentenceTimes(sentence.ordinal).length > 0
                            const current =
                              !!active &&
                              sentence.ordinal >= active.first &&
                              sentence.ordinal <= active.last
                            return (
                              <span
                                className={`original-sentence${mapped ? ' original-text' : ''}${current ? ' current' : ''}`}
                                key={sentence.ordinal}
                                data-ordinal={sentence.ordinal}
                                data-sentence={sentence.ordinal}
                                data-search-hit={
                                  searchHit &&
                                  sentence.ordinal >= searchHit.first &&
                                  sentence.ordinal <= searchHit.last
                                    ? 'true'
                                    : undefined
                                }
                                aria-current={current ? 'true' : undefined}
                                role={mapped ? 'button' : undefined}
                                tabIndex={
                                  mapped ? (sentence.ordinal === focusOrdinal ? 0 : -1) : undefined
                                }
                                onClick={
                                  mapped
                                    ? (event) => {
                                        if (event.detail > 1 || !window.getSelection()?.isCollapsed)
                                          return
                                        seekSentence(sentence.ordinal)
                                      }
                                    : undefined
                                }
                                onKeyDown={
                                  mapped
                                    ? (event) => {
                                        if (event.key !== 'Enter' && event.key !== ' ') return
                                        event.preventDefault()
                                        event.stopPropagation()
                                        seekSentence(sentence.ordinal)
                                      }
                                    : undefined
                                }
                              >
                                {sentence.text}
                              </span>
                            )
                          })}
                        </p>
                      </Fragment>
                    )
                  })}
                </article>
              )}
            </CompanionReadingViewport>
            <ReaderDockSlot name="navigation" active={visible}>
              <ReaderFooter className="original-reading-footer" aria-label="原文翻页">
                <div className="original-follow-controls">
                  <span className="original-current-chapter" title={chapter?.title}>
                    {chapter?.title}
                  </span>
                  <span className="original-reading-status" role="status">
                    {!following
                      ? '自由阅读'
                      : state?.stale
                        ? '字幕已更新，等待重新匹配'
                        : active
                          ? '跟随播放 · 已定位原文'
                          : '当前声音未匹配原文'}
                  </span>
                  <ReaderAction
                    className="reader-button"
                    onClick={() => {
                      setFollowing(true)
                      setSearchHit(null)
                      viewport.current?.focus({ preventScroll: true })
                    }}
                    label="跟随原文播放位置"
                    icon="follow"
                    tooltip="仅跟随已匹配的原文，不改变播放位置"
                  />
                </div>
                <nav className="original-pagination" aria-label="原文分页">
                  <ReaderAction
                    className="reader-action-previous reader-button"
                    disabled={!pagination.canPrevious}
                    onClick={() => pagination.turn(-1)}
                    label="原文上一页"
                    icon="chevron"
                  />
                  {settings.mode === 'pages' && (
                    <span title="当前加载内容的实际屏数，随窗口和排版变化。">
                      {pagination.metrics.column + 1} / {pagination.metrics.columns}
                    </span>
                  )}
                  <span
                    className="reader-window-position"
                    data-position={pagination.location.ordinal}
                  >
                    {Math.round(
                      ((pagination.location.ordinal + 1) / Math.max(1, info.sentenceCount)) * 100,
                    )}
                    %
                  </span>
                  <ReaderAction
                    className="reader-button"
                    disabled={!pagination.canNext}
                    onClick={() => pagination.turn(1)}
                    label="原文下一页"
                    icon="chevron"
                  />
                </nav>
              </ReaderFooter>
            </ReaderDockSlot>
          </>
        )}
      </div>
      {error && (
        <div className="original-error" role="alert">
          <span>{error}</span>
          <ReaderAction
            className="reader-button"
            onClick={() => {
              setError('')
              refreshCurrent.current()
            }}
            label="重试读取原文"
            icon="follow"
          />
        </div>
      )}
      {panel && (
        <button
          className="original-panel-scrim"
          aria-label="收起原文面板"
          tabIndex={-1}
          onClick={() => closePanel()}
        />
      )}
      <aside
        className="original-panel-drawer"
        data-panel={panel ?? undefined}
        role="dialog"
        aria-modal="true"
        aria-label={
          panel === 'search' ? '搜索小说原文' : panel === 'contents' ? '原文目录' : '原文工具'
        }
        ref={drawer}
        hidden={!panel}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            if (document.querySelector('select:open, dialog[open]')) return
            event.preventDefault()
            event.stopPropagation()
            closePanel()
          } else if (event.key === 'Tab') {
            const controls = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
              ),
            ).filter((node) => node.getClientRects().length)
            const first = controls[0],
              last = controls.at(-1)
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault()
              last?.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault()
              first?.focus()
            }
          }
        }}
      >
        <header className="original-panel-heading">
          <h2>
            {panel === 'search' ? '搜索小说原文' : panel === 'contents' ? '原文目录' : '原文工具'}
          </h2>
          <ReaderAction
            className="reader-icon-button"
            onClick={() => closePanel()}
            label="关闭原文面板"
            icon="close"
          />
        </header>
        <div hidden={panel !== 'contents'}>
          <input
            aria-label="筛选原文章节"
            placeholder="查找章节…"
            value={chapterQuery}
            onChange={(event) => setChapterQuery(event.target.value)}
          />
          <label>
            原文章节
            <select
              aria-label="原文章节"
              value={chapter?.index ?? 0}
              onChange={(event) => {
                const next = info?.chapters[Number(event.target.value)]
                if (next) {
                  browse(next.first)
                  closePanel(true)
                }
              }}
            >
              {info?.chapters
                .filter((item) => item.count > 0)
                .map((item) => (
                  <option key={item.index} value={item.index}>
                    {item.title}
                  </option>
                ))}
            </select>
          </label>
          <ol className="original-contents-list">
            {info?.chapters
              .filter((item) => item.count > 0 && item.title.includes(chapterQuery.trim()))
              .map((item) => (
                <li key={item.index}>
                  <button
                    aria-current={item.index === chapter?.index ? 'location' : undefined}
                    onClick={() => {
                      browse(item.first)
                      setSearchHit(null)
                      closePanel(true)
                    }}
                  >
                    {item.title}
                  </button>
                </li>
              ))}
          </ol>
        </div>
        <div hidden={panel !== 'search'}>
          {info ? (
            <OriginalSearch
              key={info.id}
              target={target}
              originalId={info.id}
              disabled={busy}
              expanded
              locate={(first, last) => {
                browse(Math.floor(first / ORIGINAL_PAGE_SIZE) * ORIGINAL_PAGE_SIZE)
                setSearchHit({ first, last })
                closePanel(true)
              }}
            />
          ) : (
            <p>先为当前有声书导入小说原文，再搜索整本书。</p>
          )}
        </div>
        <div hidden={panel !== 'tools'}>
          <div
            className="original-tool-tabs"
            role="tablist"
            aria-label="原文工具分类"
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const items = ['source', 'matching', 'export'] as const
              const index = items.indexOf(tool)
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? 2
                    : (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length
              setTool(items[next]!)
              event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
            }}
          >
            {(
              [
                ['source', '原文来源'],
                ['matching', '匹配与校正'],
                ['export', '字幕导出'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                id={`original-tab-${value}`}
                role="tab"
                aria-selected={tool === value}
                aria-controls={`original-tool-${value}`}
                tabIndex={tool === value ? 0 : -1}
                onClick={() => setTool(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div
            className="original-source-panel"
            id="original-tool-source"
            role="tabpanel"
            aria-labelledby="original-tab-source"
            hidden={tool !== 'source'}
          >
            <h3>当前有声书的原文</h3>
            {onLinkBook && (
              <button className="secondary-button" onClick={onLinkBook}>
                从电子书书架选择原文
              </button>
            )}
            <p>原文绑定整本有声书，各集共用。电子书书架中的独立阅读进度另行保存。</p>
            {info && (
              <>
                <p className="original-summary">
                  {info.title} · {info.format.toUpperCase()} / {info.encoding} ·{' '}
                  {info.chapters.length.toLocaleString()} 个原文分区 ·{' '}
                  {info.sentenceCount.toLocaleString()} 句
                </p>
                {info.warnings.map((warning) => (
                  <p key={warning} className="original-hint">
                    {warning}
                  </p>
                ))}
              </>
            )}
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => void importOriginal()}
            >
              {info ? '更换 TXT / EPUB 原文' : '导入 TXT / EPUB 原文'}
            </button>
          </div>
          <div
            className="original-matching-panel"
            id="original-tool-matching"
            role="tabpanel"
            aria-labelledby="original-tab-matching"
            hidden={tool !== 'matching'}
          >
            <h3>匹配本集字幕</h3>
            <p>
              {!info
                ? '先在“原文来源”导入同一作品的小说。'
                : !hasTranscript
                  ? '先生成或导入本集字幕，再匹配小说原文。'
                  : '字幕更新后会自动匹配已绑定的原文，也可手动重新匹配本集。未匹配的声音保留空缺。'}
            </p>
            {state?.stale && (
              <p role="status">字幕或匹配规则已变化，旧同步位置暂不使用，请重新匹配。</p>
            )}
            <button
              className="secondary-button"
              disabled={busy || !info || !hasTranscript}
              onClick={() => void run(() => window.desktop.matchOriginal(target))}
            >
              {alignment ? '重新匹配这一集' : '匹配这一集转写稿'}
            </button>
            {info && alignment && (
              <details className="original-review">
                <summary>
                  匹配与人工校正 · {matches.filter((match) => match.selected).length} /{' '}
                  {matches.length} 段已映射
                </summary>
                <label className="original-review-filter">
                  显示片段
                  <select
                    aria-label="筛选原文校正片段"
                    value={reviewFilter}
                    onChange={(event) => {
                      setReviewFilter(event.target.value)
                      setReviewPage(0)
                    }}
                  >
                    <option value="all">全部片段</option>
                    <option value="unmatched">只看未匹配</option>
                    <option value="reviewed">只看已人工校正</option>
                  </select>
                </label>
                <p>相似度表示文字接近程度。重复、插话和缺失可保留空缺；校正不修改转写稿或声音。</p>
                {acoustic.state?.job?.status === 'running' && (
                  <div className="original-acoustic-actions" role="status">
                    <span>声音对齐在后台进行，普通播放可继续。</span>
                    <button
                      className="secondary-button"
                      disabled={acoustic.busy}
                      onClick={acoustic.cancel}
                    >
                      取消声音对齐任务
                    </button>
                  </div>
                )}
                {reviewMatches.slice(reviewStart, reviewStart + 20).map((match) => (
                  <article key={match.segmentId}>
                    <p>
                      <button
                        className="secondary-button"
                        onClick={() => player.seek(match.startMs)}
                      >
                        {(match.startMs / 1000).toFixed(2)} 秒
                      </button>{' '}
                      {match.asrText}
                    </p>
                    <p>
                      {match.selected
                        ? `${match.reviewed || match.selected.method === 'manual' ? '人工' : '自动'}映射到原文第 ${match.selected.first + 1}–${match.selected.last + 1} 句`
                        : match.reviewed
                          ? '人工保留空缺'
                          : '尚未确定映射'}
                    </p>
                    {match.sourceState === 'legacy' && (
                      <p className="original-hint">
                        已保留旧人工校正，旧记录未保存识别来源；可继续人工核对。
                      </p>
                    )}
                    {match.sourceState === 'retained' && (
                      <p className="original-hint">
                        识别片段已变化，现保留此前人工校正；请核对原文与同步点。
                      </p>
                    )}
                    <button
                      className="secondary-button"
                      disabled={busy || state?.stale}
                      onClick={() =>
                        setEditing(editing === match.segmentId ? null : match.segmentId)
                      }
                    >
                      校正原文与同步点
                    </button>
                    {editing === match.segmentId && (
                      <MatchEditor
                        key={`${alignment.originalId}:${match.segmentId}`}
                        target={target}
                        originalId={info.id}
                        revision={alignment.revision}
                        match={match}
                        disabled={busy}
                        save={(correction) => run(() => window.desktop.correctOriginal(correction))}
                      />
                    )}
                    {match.reviewed && match.selected && (
                      <OriginalAcousticAlignment
                        key={`acoustic:${alignment.originalId}:${match.segmentId}`}
                        target={target}
                        originalId={info.id}
                        revision={alignment.revision}
                        match={match}
                        disabled={busy || !!state?.stale}
                        control={acoustic}
                        changed={(value) => {
                          refreshSerial.current++
                          setState(value)
                          refreshCurrent.current()
                        }}
                      />
                    )}
                  </article>
                ))}
                <div className="reading-settings">
                  <button
                    className="secondary-button"
                    disabled={reviewPage <= 0}
                    onClick={() => setReviewPage(Math.max(0, reviewPage - 1))}
                  >
                    校正上一页
                  </button>
                  <span>
                    {Math.floor(reviewStart / 20) + 1} /{' '}
                    {Math.max(1, Math.ceil(reviewMatches.length / 20))}
                  </span>
                  <button
                    className="secondary-button"
                    disabled={reviewStart + 20 >= reviewMatches.length}
                    onClick={() => setReviewPage(reviewPage + 1)}
                  >
                    校正下一页
                  </button>
                </div>
              </details>
            )}
          </div>
          <div
            className="original-export-panel"
            id="original-tool-export"
            role="tabpanel"
            aria-labelledby="original-tab-export"
            hidden={tool !== 'export'}
          >
            <h3>导出已匹配的原文字幕</h3>
            <p>仅导出本集已匹配的小说原文及时间，未匹配的声音不会补入邻句。</p>
            {info && alignment && !state?.stale ? (
              <SubtitleExport
                key={`original:${info.id}`}
                compact
                source={{
                  ...target,
                  source: 'original',
                  originalId: info.id,
                  alignmentRevision: alignment.revision,
                  transcriptId: alignment.transcriptId,
                  transcriptRevision: alignment.transcriptRevision,
                }}
                disabled={busy || !matches.some((match) => match.selected)}
              />
            ) : (
              <p>完成本集匹配后，可导出 SRT 或 WebVTT。</p>
            )}
          </div>
        </div>
        {busy && (
          <div role="status" className="original-processing">
            <p>正在处理小说原文…</p>
            <button
              className="secondary-button"
              onClick={() => void window.desktop.cancelOriginal()}
            >
              取消原文处理
            </button>
          </div>
        )}
      </aside>
    </section>
  )
}

function MatchEditor({
  target,
  originalId,
  revision,
  match,
  disabled,
  save,
}: {
  target: OriginalTarget
  originalId: string
  revision: number
  match: OriginalMatch
  disabled: boolean
  save: (correction: OriginalCorrection) => Promise<void>
}) {
  const [first, setFirst] = useState((match.selected?.first ?? match.candidates[0]?.first ?? 0) + 1)
  const [last, setLast] = useState((match.selected?.last ?? match.candidates[0]?.last ?? 0) + 1)
  const [startMs, setStart] = useState(match.startMs / 1000),
    [endMs, setEnd] = useState(match.endMs / 1000)
  const [query, setQuery] = useState(''),
    [results, setResults] = useState<OriginalCandidate[]>([]),
    [error, setError] = useState('')
  function choose(candidate: OriginalCandidate) {
    setFirst(candidate.first + 1)
    setLast(candidate.last + 1)
  }
  const correction = (selection: OriginalCorrection['selection']): OriginalCorrection => ({
    ...target,
    originalId,
    revision,
    segmentId: match.segmentId,
    selection,
    startMs: Math.round(startMs * 1000),
    endMs: Math.round(endMs * 1000),
  })
  return (
    <div className="original-editor">
      {match.candidates.map((candidate) => (
        <p key={`${candidate.first}:${candidate.last}`}>
          <button className="secondary-button" onClick={() => choose(candidate)}>
            选取第 {candidate.first + 1}–{candidate.last + 1} 句
            {candidate.basis === 'context'
              ? ' · 邻句上下文'
              : candidate.basis === 'anchors'
                ? ' · 前后已定位文字'
                : ''}{' '}
            · 相似度 {Math.round(candidate.score * 100)}%
          </button>{' '}
          {candidate.chapter}：{candidate.excerpt}
        </p>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void window.desktop
            .searchOriginal({ ...target, originalId, query })
            .then((result) => {
              if (result.ok) {
                setResults(result.value)
                setError(result.value.length ? '' : '没有找到该文字。')
              } else setError(result.error.message)
            })
            .catch(() => setError('查找原文失败，请重试。'))
        }}
      >
        <label>
          查找原文{' '}
          <input
            value={query}
            minLength={2}
            maxLength={100}
            required
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button className="secondary-button">查找</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {results.map((result) => (
        <p key={result.first}>
          <button className="secondary-button" onClick={() => choose(result)}>
            选取第 {result.first + 1} 句
          </button>{' '}
          {result.chapter}：{result.excerpt}
        </p>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void save(correction({ first: first - 1, last: last - 1 }))
        }}
      >
        <label>
          原文起句{' '}
          <input
            type="number"
            min={1}
            step={1}
            required
            value={first}
            onChange={(event) => setFirst(Number(event.target.value))}
          />
        </label>
        <label>
          原文止句{' '}
          <input
            type="number"
            min={first}
            max={first + 19}
            step={1}
            required
            value={last}
            onChange={(event) => setLast(Number(event.target.value))}
          />
        </label>
        <label>
          起始秒{' '}
          <input
            type="number"
            min={0}
            step="0.001"
            required
            value={startMs}
            onChange={(event) => setStart(Number(event.target.value))}
          />
        </label>
        <label>
          结束秒{' '}
          <input
            type="number"
            min={startMs + 0.001}
            step="0.001"
            required
            value={endMs}
            onChange={(event) => setEnd(Number(event.target.value))}
          />
        </label>
        <button className="secondary-button" disabled={disabled}>
          保存原文校正
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={disabled}
          onClick={() => void save(correction(null))}
        >
          保留空缺
        </button>
      </form>
    </div>
  )
}
