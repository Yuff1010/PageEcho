import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { AppState, Book } from '../../shared/contracts'
import type { Bookmark, SleepTimer } from '../../shared/listening'
import { player } from './player'
import { OnlinePreparationSettings } from './OnlinePreparationSettings'
import { SubtitlePreparationSettings } from './SubtitlePreparationSettings'
import { Icon } from './Icons'
import { useTranscription } from './TranscriptionControls'
import { TranscriptionActivity } from './TranscriptionActivity'
import { settingsTabIndex } from './tab-keyboard'
import './settings.css'

export type ListeningToolsSection = 'playback' | 'subtitles' | 'bookmarks'
const TOOL_TABS = [
  { id: 'playback', label: '播放与定时', icon: 'clock' },
  { id: 'subtitles', label: '字幕与缓存', icon: 'book' },
  { id: 'bookmarks', label: '查看书签', icon: 'bookmark' },
] as const
type PanelMessage = { error: string; notice: string }

function PanelMessages({ value }: { value: PanelMessage }) {
  return (
    <>
      {value.error && (
        <p className="error-message" role="alert">
          {value.error}
        </p>
      )}
      {value.notice && (
        <p className="tools-notice" role="status">
          {value.notice}
        </p>
      )}
    </>
  )
}

function BookTranscriptionActivity({ book }: { book: Book }) {
  const playback = useSyncExternalStore(player.subscribe, player.getSnapshot)
  const episode =
    playback.episode?.bookId === book.id
      ? playback.episode
      : (book.episodes.find((item) => item.id === book.currentEpisodeId) ?? book.episodes[0])
  if (!episode) return null
  return (
    <EpisodeTranscriptionActivity
      key={`${episode.id}:${episode.contentHash}`}
      episodeId={episode.id}
      audioHash={episode.contentHash}
    />
  )
}
function EpisodeTranscriptionActivity({
  episodeId,
  audioHash,
}: {
  episodeId: string
  audioHash: string
}) {
  const target = useMemo(() => ({ episodeId, audioHash }), [episodeId, audioHash])
  const control = useTranscription(target)
  return <TranscriptionActivity target={target} control={control} showCompleted showError />
}

export function listeningTime(ms: number) {
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 3600)
    .toString()
    .padStart(2, '0')}:${Math.floor((seconds / 60) % 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

export function sleepText(timer: SleepTimer, remainingMs: number) {
  return timer?.mode === 'chapter'
    ? '本集结束后停止'
    : timer?.mode === 'minutes'
      ? `${Math.ceil(remainingMs / 60000)} 分钟后停止`
      : ''
}

export async function addCurrentBookmark() {
  const state = player.getSnapshot()
  if (!state.ready || !state.episode) throw new Error('请先打开音频。')
  const result = await window.desktop.saveBookmark({
    episodeId: state.episode.id,
    audioHash: state.episode.contentHash,
    positionMs: Math.round(player.getPosition()),
    note: '',
  })
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

export function ListeningTools({
  book,
  initialSection = 'playback',
  onUpdated,
  onClose,
}: {
  book: Book
  initialSection?: ListeningToolsSection
  onUpdated: (state: AppState) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const tabsId = useId()
  const tabButtons = useRef<Partial<Record<ListeningToolsSection, HTMLButtonElement | null>>>({})
  const panels = useRef<Partial<Record<ListeningToolsSection, HTMLDivElement | null>>>({})
  const scrollPositions = useRef<Partial<Record<ListeningToolsSection, number>>>({})
  const [selection, setSelection] = useState({
    requested: initialSection,
    selected: initialSection,
  })
  if (selection.requested !== initialSection)
    setSelection({ requested: initialSection, selected: initialSection })
  const activeSection = selection.selected
  const playback = useSyncExternalStore(player.subscribe, player.getSnapshot)
  const [intro, setIntro] = useState(String(book.introMs / 1000))
  const [outro, setOutro] = useState(String(book.outroMs / 1000))
  const [minutes, setMinutes] = useState('30')
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [page, setPage] = useState(0)
  const [editing, setEditing] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState({ playback: false, bookmarks: false })
  const [messages, setMessages] = useState<Record<ListeningToolsSection, PanelMessage>>({
    playback: { error: '', notice: '' },
    subtitles: { error: '', notice: '' },
    bookmarks: { error: '', notice: '' },
  })
  const refresh = useCallback(async () => {
    const result = await window.desktop.getBookmarks({ id: book.id })
    if (!result.ok) throw new Error(result.error.message)
    setBookmarks(result.value)
    setPage((page) => Math.min(page, Math.max(0, Math.ceil(result.value.length / 20) - 1)))
  }, [book.id])
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    tabButtons.current[initialSection]?.focus({ preventScroll: true })
    return () => element.close()
  }, [initialSection])
  useLayoutEffect(() => {
    const panel = panels.current[activeSection]
    if (panel) panel.scrollTop = scrollPositions.current[activeSection] ?? 0
    tabButtons.current[activeSection]?.focus({ preventScroll: true })
  }, [activeSection])
  useEffect(() => {
    void Promise.resolve()
      .then(refresh)
      .catch((error) =>
        setMessages((previous) => ({
          ...previous,
          bookmarks: {
            error: error instanceof Error ? error.message : '书签读取失败。',
            notice: '',
          },
        })),
      )
  }, [refresh])
  function selectSection(section: ListeningToolsSection) {
    scrollPositions.current[activeSection] = panels.current[activeSection]?.scrollTop ?? 0
    setSelection({ requested: initialSection, selected: section })
  }
  async function perform(
    section: 'playback' | 'bookmarks',
    action: () => Promise<void>,
    notice = '',
  ) {
    setBusy((previous) => ({ ...previous, [section]: true }))
    setMessages((previous) => ({ ...previous, [section]: { error: '', notice: '' } }))
    try {
      await action()
      if (notice) setMessages((previous) => ({ ...previous, [section]: { error: '', notice } }))
    } catch (error) {
      setMessages((previous) => ({
        ...previous,
        [section]: {
          error: error instanceof Error ? error.message : '操作未完成，请重试。',
          notice: '',
        },
      }))
    } finally {
      setBusy((previous) => ({ ...previous, [section]: false }))
    }
  }
  return (
    <dialog
      className="listening-dialog listening-tools-dialog settings-select-scope"
      ref={dialog}
      aria-label="收听工具"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="section-heading listening-tools-heading">
        <div>
          <h2>收听工具</h2>
          <p className="tools-book-title" title={book.title}>
            {book.title}
          </p>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="关闭收听工具">
          <Icon name="close" />
        </button>
      </div>
      <div
        className="listening-tools-nav"
        role="tablist"
        aria-label="本书设置导航"
        aria-orientation="horizontal"
      >
        {TOOL_TABS.map((tab, index) => (
          <button
            key={tab.id}
            ref={(element) => {
              tabButtons.current[tab.id] = element
            }}
            type="button"
            className="listening-tools-tab"
            role="tab"
            id={`${tabsId}-${tab.id}-tab`}
            aria-controls={`${tabsId}-${tab.id}-panel`}
            aria-selected={activeSection === tab.id}
            tabIndex={activeSection === tab.id ? 0 : -1}
            onClick={() => selectSection(tab.id)}
            onKeyDown={(event) => {
              const next = settingsTabIndex(event, index, TOOL_TABS.length)
              if (next === null) return
              selectSection(TOOL_TABS[next]!.id)
            }}
          >
            <Icon name={tab.icon} /> {tab.label}
          </button>
        ))}
      </div>
      <div className="listening-tools-content">
        <div
          className="listening-tools-panel listening-tools-group"
          role="tabpanel"
          id={`${tabsId}-playback-panel`}
          aria-labelledby={`${tabsId}-playback-tab`}
          hidden={activeSection !== 'playback'}
          ref={(element) => {
            panels.current.playback = element
          }}
          tabIndex={0}
        >
          <PanelMessages value={messages.playback} />
          <h3 className="tools-group-title">播放与定时</h3>
          <section aria-label="定时停止">
            <h3>定时停止</h3>
            <form
              className="tools-form"
              onSubmit={(event) => {
                event.preventDefault()
                player.setSleepTimer(Number(minutes))
              }}
            >
              <label>
                分钟{' '}
                <input
                  aria-label="定时分钟"
                  type="number"
                  min="1"
                  max="180"
                  step="1"
                  required
                  value={minutes}
                  onChange={(event) => setMinutes(event.target.value)}
                />
              </label>
              <button className="secondary-button" type="submit">
                启动定时
              </button>
              <button
                className="text-button"
                type="button"
                disabled={!playback.episode}
                onClick={() => player.setSleepTimer('chapter')}
              >
                本集结束时停止
              </button>
              {playback.sleepTimer && (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => player.setSleepTimer(null)}
                >
                  取消定时
                </button>
              )}
            </form>
            <p role="status">
              {sleepText(playback.sleepTimer, playback.sleepRemainingMs) ||
                playback.timerNotice ||
                '尚未设置定时'}
            </p>
            <p className="tools-hint">
              分钟定时按实际经过时间计算，暂停时也计时；仅本次运行有效。到点停止，不自动进入下一集。
            </p>
          </section>
          <section aria-label="片头片尾设置">
            <h3>本书片头片尾</h3>
            <form
              className="tools-form"
              onSubmit={(event) => {
                event.preventDefault()
                void perform(
                  'playback',
                  async () => {
                    const result = await window.desktop.setBookSkips({
                      id: book.id,
                      introMs: Number(intro) * 1000,
                      outroMs: Number(outro) * 1000,
                    })
                    if (!result.ok) throw new Error(result.error.message)
                    onUpdated(result.value)
                  },
                  '本书跳过设置已保存。',
                )
              }}
            >
              <label>
                片头（秒）
                <input
                  aria-label="跳过片头秒数"
                  type="number"
                  min="0"
                  max="3600"
                  step="1"
                  required
                  value={intro}
                  onChange={(event) => setIntro(event.target.value)}
                />
              </label>
              <label>
                片尾（秒）
                <input
                  aria-label="跳过片尾秒数"
                  type="number"
                  min="0"
                  max="3600"
                  step="1"
                  required
                  value={outro}
                  onChange={(event) => setOutro(event.target.value)}
                />
              </label>
              <button className="secondary-button" type="submit" disabled={busy.playback}>
                保存跳过设置
              </button>
            </form>
            <p className="tools-hint">
              片头在打开章节时跳过；播放到片尾起点时进入下一集。短于跳过总时长的单集完整播放。进度、书签及文稿均保留原媒体时间。
            </p>
          </section>
        </div>
        <div
          className="listening-tools-panel listening-tools-group"
          role="tabpanel"
          id={`${tabsId}-subtitles-panel`}
          aria-labelledby={`${tabsId}-subtitles-tab`}
          hidden={activeSection !== 'subtitles'}
          ref={(element) => {
            panels.current.subtitles = element
          }}
          tabIndex={0}
        >
          <h3 className="tools-group-title">字幕与缓存</h3>
          <BookTranscriptionActivity book={book} />
          <SubtitlePreparationSettings
            key={`subtitles-${book.id}`}
            book={book}
            onUpdated={onUpdated}
          />
          {book.online && (
            <OnlinePreparationSettings key={book.id} book={book} onUpdated={onUpdated} />
          )}
        </div>
        <div
          className="listening-tools-panel"
          role="tabpanel"
          id={`${tabsId}-bookmarks-panel`}
          aria-labelledby={`${tabsId}-bookmarks-tab`}
          hidden={activeSection !== 'bookmarks'}
          ref={(element) => {
            panels.current.bookmarks = element
          }}
          tabIndex={0}
        >
          <PanelMessages value={messages.bookmarks} />
          <section aria-label="本书书签" className="listening-tools-bookmarks">
            <div className="section-heading">
              <h3>书签 · {bookmarks.length}</h3>
              <button
                className="text-button"
                disabled={busy.bookmarks || !playback.ready || playback.episode?.bookId !== book.id}
                onClick={() =>
                  void perform(
                    'bookmarks',
                    async () => {
                      await addCurrentBookmark()
                      await refresh()
                    },
                    '已保存当前播放位置。',
                  )
                }
              >
                添加当前书签
              </button>
            </div>
            {!bookmarks.length && (
              <p className="tools-hint">收听时点击“添加书签”，记下想回来的位置。</p>
            )}
            <ol className="bookmark-list">
              {bookmarks.slice(page * 20, page * 20 + 20).map((mark) => (
                <li key={mark.id}>
                  <div className="bookmark-heading">
                    <button
                      className="bookmark-jump"
                      disabled={mark.stale}
                      onClick={() => {
                        void player.openBookmark(mark)
                        onClose()
                      }}
                      aria-label={`跳转书签 ${listeningTime(mark.positionMs)} ${mark.episodeTitle}`}
                    >
                      <time>{listeningTime(mark.positionMs)}</time>
                      <span>{mark.episodeTitle}</span>
                    </button>
                    <button
                      className="text-button"
                      disabled={busy.bookmarks}
                      onClick={() => {
                        setEditing(mark.id)
                        setNote(mark.note)
                      }}
                    >
                      备注
                    </button>
                    <button
                      className="text-button"
                      disabled={busy.bookmarks}
                      aria-label={`删除书签 ${listeningTime(mark.positionMs)} ${mark.episodeTitle}`}
                      onClick={() =>
                        void perform('bookmarks', async () => {
                          const result = await window.desktop.removeBookmark({ id: mark.id })
                          if (!result.ok) throw new Error(result.error.message)
                          await refresh()
                          if (editing === mark.id) setEditing(null)
                        })
                      }
                    >
                      删除
                    </button>
                  </div>
                  {mark.stale && (
                    <p className="tools-hint">旧音频版本，无法跳转；备注仍可保留或删除。</p>
                  )}
                  {editing === mark.id ? (
                    <form
                      className="tools-form"
                      onSubmit={(event) => {
                        event.preventDefault()
                        void perform(
                          'bookmarks',
                          async () => {
                            const result = await window.desktop.editBookmark({ id: mark.id, note })
                            if (!result.ok) throw new Error(result.error.message)
                            await refresh()
                            setEditing(null)
                          },
                          '书签备注已保存。',
                        )
                      }}
                    >
                      <input
                        className="bookmark-note"
                        aria-label="书签备注"
                        value={note}
                        maxLength={1000}
                        onChange={(event) => setNote(event.target.value)}
                      />
                      <button className="text-button" disabled={busy.bookmarks} type="submit">
                        保存备注
                      </button>
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => setEditing(null)}
                      >
                        取消备注
                      </button>
                    </form>
                  ) : (
                    mark.note && <p className="bookmark-note-text">{mark.note}</p>
                  )}
                </li>
              ))}
            </ol>
            {bookmarks.length > 20 && (
              <div className="tools-form">
                <button disabled={page === 0} onClick={() => setPage(page - 1)}>
                  上一页书签
                </button>
                <span>
                  {page + 1} / {Math.ceil(bookmarks.length / 20)}
                </span>
                <button
                  disabled={(page + 1) * 20 >= bookmarks.length}
                  onClick={() => setPage(page + 1)}
                >
                  下一页书签
                </button>
              </div>
            )}
          </section>
        </div>
      </div>
    </dialog>
  )
}
