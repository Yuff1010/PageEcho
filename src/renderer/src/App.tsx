import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ImportDraft } from '../../shared/contracts'
import type { LibraryOverview, BookSummary, BookEpisodePage } from '../../shared/library'
import { APP_NAME } from '../../shared/brand'
import { player, type PlayerLibraryMutation } from './player'
import { TranscriptReader } from './TranscriptReader'
import { MaintenancePanel } from './MaintenancePanel'
import { BackupStoragePanel } from './BackupStoragePanel'
import { OfflinePreparationPanel } from './OfflinePreparationPanel'
import { ListeningTools, type ListeningToolsSection } from './ListeningTools'
import { RemoveBookConfirmation } from './RemoveBookConfirmation'
import { OnlineSourceBrowser } from './OnlineSourceBrowser'
import {
  NormalReading,
  type ReadingShelfHandle,
  type ReadingShelfImportStatus,
} from './NormalReading'
import { ShelfBookCard, ShelfPagination } from './LibraryShelf'
import { useShelfPage } from './useShelfPage'
import { ShelfHeader, ShelfControls } from './ShelfHeader'
import { visibleShelfBooks } from './library-shelf'
import { BookCover, Icon } from './Icons'
import { Popover } from './Popover'
import { Tooltip } from './Tooltip'
import { PlayerBar } from './PlayerBar'
import { AppInfo, type AppInfoPanel } from './AppInfo'
import { ReaderPage } from './ReaderPage'
import { appRouteHash, parseAppRoute, type AppRoute } from './app-navigation'
import { useAppAppearance } from './app-appearance'
import { SubtitleStatus, useSubtitleStatuses } from './UISubtitleStatus'
import { useBookConnections } from './BookConnections'

function formatTime(ms: number) {
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 3600)
    .toString()
    .padStart(2, '0')}:${Math.floor((seconds / 60) % 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}
function formatSize(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function readLayout(): 'grid' | 'list' {
  try {
    return localStorage.getItem('ralb:library:layout') === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

export function App({ startupNotice = '' }: { startupNotice?: string }) {
  useAppAppearance()
  const [state, setState] = useState<LibraryOverview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState(startupNotice)
  const [draft, setDraft] = useState<ImportDraft | null>(null)
  const [route, setRoute] = useState(() => parseAppRoute(window.location.hash))
  const selectedBook = route.view === 'chapters' ? route.bookId : null
  const readerId = route.view === 'reader' ? route.bookId : null
  const reading = route.view === 'reading'
  const normalReading = route.view === 'ebook'
  const sourceOpen = route.view === 'source'
  const lastShelf = useRef<'library' | 'ebook'>(normalReading || readerId ? 'ebook' : 'library')
  const [chapterPagination, setChapterPagination] = useState({ bookId: '', page: 0 })
  const [recentOnly, setRecentOnly] = useState(false)
  const [toolsTarget, setToolsTarget] = useState<{
    bookId: string
    section: ListeningToolsSection
  } | null>(null)
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState('')
  const toolsTrigger = useRef<HTMLElement | null>(null)
  const removeTrigger = useRef<HTMLElement | null>(null)
  const [maintenanceOpen, setMaintenanceOpen] = useState(false)
  const [backupOpen, setBackupOpen] = useState(false)
  const [offlineTarget, setOfflineTarget] = useState<{ bookId: string | null } | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('added')
  const [searchOpen, setSearchOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState<AppInfoPanel | null>(null)
  const [infoError, setInfoError] = useState('')
  const infoTrigger = useRef<HTMLElement | null>(null)
  const infoSession = useRef(0)
  const [layout, setLayout] = useState(readLayout)
  const [readAloudId, setReadAloudId] = useState<string | null>(null)
  const readingShelf = useRef<ReadingShelfHandle>(null)
  const shelfImportButton = useRef<HTMLButtonElement>(null)
  const [ebookFocusRequest, setEbookFocusRequest] = useState(0)
  const ebookFocusHandled = useRef(0)
  const [ebookImport, setEbookImport] = useState<ReadingShelfImportStatus>({
    busy: false,
    ready: false,
  })
  useEffect(() => {
    if (ebookFocusRequest === ebookFocusHandled.current) return
    if (!normalReading) {
      ebookFocusHandled.current = ebookFocusRequest
      return
    }
    if (ebookImport.busy || !ebookImport.ready || shelfImportButton.current?.disabled) return
    // The dialog has unmounted and the parent's enabled button is committed;
    // a child-frame callback can otherwise race the propagated busy state.
    shelfImportButton.current?.focus()
    ebookFocusHandled.current = ebookFocusRequest
  }, [ebookFocusRequest, normalReading, ebookImport.busy, ebookImport.ready])
  useEffect(() => {
    const changed = () => setRoute(parseAppRoute(window.location.hash))
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [])
  useEffect(() => {
    if (route.view === 'library' || route.view === 'ebook') lastShelf.current = route.view
  }, [route])
  const search = useRef<HTMLInputElement>(null)
  const playback = useSyncExternalStore(player.subscribe, player.getSnapshot)
  const overviewLoading = useRef<Promise<void> | null>(null)
  const overviewAgain = useRef(false)
  const progressOverlay = useRef<PlayerLibraryMutation['progress']>(undefined)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const connections = useBookConnections(
    state,
    (id) => {
      setReadAloudId(null)
      navigateTo({ view: 'reader', bookId: id })
    },
    () => navigate('reading'),
  )
  const refreshConnections = connections.refresh
  useEffect(() => {
    void Promise.resolve()
      .then(refreshConnections)
      .catch(() => {})
  }, [refreshConnections, readerId, normalReading])
  const load = useCallback((): Promise<void> => {
    if (overviewLoading.current) {
      overviewAgain.current = true
      return overviewLoading.current
    }
    const operation = (async () => {
      do {
        overviewAgain.current = false
        try {
          const result = await window.desktop.getLibraryOverview()
          if (!alive.current) return
          if (result.ok) {
            const value = result.value
            const progress = progressOverlay.current
            if (progress) {
              const book = value.books.find((item) => item.id === progress.bookId)
              if (
                !book ||
                (book.currentEpisodeId === progress.episodeId &&
                  book.resumeEpisode?.positionMs === progress.positionMs &&
                  (book.lastPlayedAt ?? '') >= progress.updatedAt)
              ) {
                progressOverlay.current = undefined
              } else {
                value.books = value.books.map((item) =>
                  item.id === progress.bookId
                    ? {
                        ...item,
                        currentEpisodeId: progress.episodeId,
                        lastPlayedAt: progress.updatedAt,
                        resumeEpisode: {
                          id: progress.episodeId,
                          title:
                            player.getSnapshot().episode?.id === progress.episodeId
                              ? player.getSnapshot().episode!.title
                              : (item.resumeEpisode?.title ?? '第一集'),
                          positionMs: progress.positionMs,
                          durationMs: progress.durationMs,
                        },
                      }
                    : item,
                )
                value.currentEpisodeId = progress.episodeId
                value.preferences = { rate: progress.rate, volume: progress.volume }
              }
            }
            setState(value)
            player.initializeOverview(result.value)
          } else setError(result.error.message)
        } catch {
          if (alive.current) setError('无法连接桌面服务，请关闭并重新打开应用。')
        }
      } while (overviewAgain.current && alive.current)
    })().finally(() => {
      overviewLoading.current = null
    })
    overviewLoading.current = operation
    return operation
  }, [])
  const [libraryRevision, setLibraryRevision] = useState(0)
  const update = useCallback(
    (mutation: PlayerLibraryMutation) => {
      if (mutation.progress) {
        const progress = mutation.progress
        progressOverlay.current = progress
        setState((value) =>
          value
            ? {
                ...value,
                currentEpisodeId: progress.episodeId,
                preferences: { rate: progress.rate, volume: progress.volume },
                books: value.books.map((book) =>
                  book.id === progress.bookId
                    ? {
                        ...book,
                        currentEpisodeId: progress.episodeId,
                        lastPlayedAt: progress.updatedAt,
                        resumeEpisode: {
                          id: progress.episodeId,
                          title:
                            player.getSnapshot().episode?.id === progress.episodeId
                              ? player.getSnapshot().episode!.title
                              : (book.resumeEpisode?.title ?? '第一集'),
                          positionMs: progress.positionMs,
                          durationMs: progress.durationMs,
                        },
                      }
                    : book,
                ),
              }
            : value,
        )
        return
      }
      if (
        progressOverlay.current &&
        [...mutation.changedBookIds, ...mutation.removedBookIds].includes(
          progressOverlay.current.bookId,
        )
      )
        progressOverlay.current = undefined
      setLibraryRevision((value) => value + 1)
      void player.refreshContext([...mutation.changedBookIds, ...mutation.removedBookIds])
      void load()
    },
    [load],
  )
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => player.subscribeLibraryMutation(update), [update])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = window.desktop.onSourceChanged(() => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        setLibraryRevision((value) => value + 1)
        void player.refreshContext()
        void load()
      }, 120)
    })
    return () => {
      clearTimeout(timer)
      stop()
    }
  }, [load])

  async function selectAudio(folder = false) {
    setBusy(true)
    setError('')
    setNotice('正在读取文件并计算内容哈希，大型音频可能需要一些时间…')
    try {
      if (folder) {
        const result = await window.desktop.selectFolder()
        if (!result.ok) setError(result.error.message)
        else if (!result.value.canceled) setDraft(result.value.draft)
      } else {
        const result = await window.desktop.selectAudio({ kind: 'audio' })
        if (!result.ok) setError(result.error.message)
        else if (!result.value.canceled) update(result.value.mutation)
      }
    } catch {
      setError('导入未完成，请重试。')
    } finally {
      setBusy(false)
      setNotice('')
    }
  }
  async function confirmImport() {
    if (!draft) return
    setBusy(true)
    setError('')
    try {
      const result = await window.desktop.confirmImport({
        id: draft.id,
        episodeIds: draft.episodes.map((episode) => episode.id),
      })
      if (result.ok) {
        update(result.value)
        setDraft(null)
        setNotice('已按确认的章节顺序加入书架。')
      } else setError(result.error.message)
    } catch {
      setError('导入未完成，请重试。')
    } finally {
      setBusy(false)
    }
  }
  async function cancelImport() {
    if (!draft) return
    try {
      await window.desktop.cancelImport({ id: draft.id })
      setDraft(null)
    } catch {
      setError('取消未完成，请重试。')
    }
  }
  function moveChapter(index: number, offset: number) {
    if (!draft) return
    const episodes = [...draft.episodes]
    const target = index + offset
    if (target < 0 || target >= episodes.length) return
    ;[episodes[index], episodes[target]] = [episodes[target]!, episodes[index]!]
    setDraft({ ...draft, episodes })
  }
  async function removeBook(id: string) {
    setBusy(true)
    setRemoveError('')
    try {
      if (playback.episode?.bookId === id) {
        await player.save()
        await player.stop()
      }
      const result = await window.desktop.removeBook({ id })
      if (result.ok) {
        update(result.value)
        setRemoveTarget(null)
        setNotice('已移除记录，原音频文件仍保留在原处。')
        requestAnimationFrame(() =>
          (search.current ?? document.querySelector<HTMLButtonElement>('.search-trigger'))?.focus(),
        )
      } else setRemoveError(result.error.message)
    } catch {
      setRemoveError('移除未完成，请重试。')
    } finally {
      setBusy(false)
    }
  }
  function persistentTrigger() {
    const focused = document.activeElement
    if (!(focused instanceof HTMLElement)) return null
    return (
      focused.closest('.popover')?.querySelector<HTMLButtonElement>(':scope > button') ?? focused
    )
  }
  function openTools(bookId: string, section: ListeningToolsSection = 'playback') {
    toolsTrigger.current = persistentTrigger()
    setToolsTarget({ bookId, section })
  }
  function closeTools() {
    setToolsTarget(null)
    requestAnimationFrame(() => toolsTrigger.current?.focus({ preventScroll: true }))
  }
  function requestRemoval(id: string) {
    removeTrigger.current = persistentTrigger()
    setRemoveError('')
    setRemoveTarget(id)
  }
  function cancelRemoval() {
    setRemoveTarget(null)
    requestAnimationFrame(() => removeTrigger.current?.focus({ preventScroll: true }))
  }
  function openInfo(panel: AppInfoPanel) {
    infoSession.current += 1
    infoTrigger.current = persistentTrigger()
    setInfoError('')
    setInfoOpen(panel)
    if (panel === 'about' && !state) void load()
  }
  function closeInfo() {
    infoSession.current += 1
    setInfoOpen(null)
    requestAnimationFrame(() => infoTrigger.current?.focus({ preventScroll: true }))
  }
  async function importRemembered(id: string) {
    const session = infoSession.current
    setBusy(true)
    setInfoError('')
    try {
      const result = await window.desktop.importRemembered({ id })
      if (result.ok) {
        update(result.value)
        if (session === infoSession.current) closeInfo()
      } else if (session === infoSession.current) setInfoError(result.error.message)
      else setError(result.error.message)
    } catch {
      if (session === infoSession.current) setInfoError('导入未完成，请重试。')
      else setError('导入未完成，请重试。')
    } finally {
      setBusy(false)
    }
  }
  const book = state?.books.find((item) => item.id === selectedBook)
  const chapterPage =
    chapterPagination.bookId === book?.id
      ? Math.min(
          chapterPagination.page,
          Math.max(0, Math.ceil((book?.episodeCount ?? 0) / 100) - 1),
        )
      : 0
  const [chapterResult, setChapterResult] = useState<{
    key: string
    result: BookEpisodePage | null
    error: string
  } | null>(null)
  const chapterKey = `${selectedBook ?? ''}:${chapterPage}:${libraryRevision}`
  useEffect(() => {
    if (!selectedBook) return
    let current = true
    void window.desktop
      .getBookEpisodes({ id: selectedBook, offset: chapterPage * 100, limit: 100 })
      .then((result) => {
        if (current)
          setChapterResult({
            key: chapterKey,
            result: result.ok ? result.value : null,
            error: result.ok ? '' : result.error.message,
          })
      })
      .catch(() => {
        if (current)
          setChapterResult({ key: chapterKey, result: null, error: '目录读取未完成，请重试。' })
      })
    return () => {
      current = false
    }
  }, [selectedBook, chapterPage, chapterKey])
  const chapterEpisodes = useMemo(
    () => (chapterResult?.key === chapterKey ? (chapterResult.result?.episodes ?? []) : []),
    [chapterResult, chapterKey],
  )
  const statusTargets = useMemo(
    () =>
      chapterEpisodes
        .filter((episode) => /^[0-9a-f]{64}$/.test(episode.contentHash))
        .map((episode) => ({
          episodeId: episode.id,
          audioHash: episode.contentHash,
          positionMs: Math.max(0, Math.round(episode.positionMs)),
        })),
    [chapterEpisodes],
  )
  const chapterStatuses = useSubtitleStatuses(statusTargets)
  const toolsBook = state?.books.find((item) => item.id === toolsTarget?.bookId)
  const removingBook = state?.books.find((item) => item.id === removeTarget)
  const libraryView = !reading && !normalReading && !sourceOpen && !book
  const pageTitle = reading
    ? '伴读阅读'
    : normalReading
      ? '我的书架'
      : sourceOpen
        ? '来源中心'
        : book
          ? '章节目录'
          : '我的书架'
  const visibleBooks = useMemo(
    () =>
      visibleShelfBooks(state?.books ?? [], query, sort, recentOnly, (item) => item.lastPlayedAt),
    [state?.books, query, sort, recentOnly],
  )
  const shelfPage = useShelfPage(visibleBooks, `${query}:${sort}:${recentOnly}`)
  const linkedBooks = useMemo(
    () => new Map(connections.links.map((link) => [link.audioBookId, link])),
    [connections.links],
  )
  function navigateTo(next: AppRoute) {
    setRoute(next)
    const hash = appRouteHash(next)
    if (window.location.hash !== hash) window.location.assign(hash)
    setQuery('')
    setSearchOpen(false)
  }
  function navigate(view: 'library' | 'recent' | 'reading' | 'ebook' | 'source') {
    navigateTo({ view: view === 'recent' ? 'library' : view })
    setRecentOnly(view === 'recent')
  }
  function changeLayout(value: 'grid' | 'list') {
    setLayout(value)
    try {
      localStorage.setItem('ralb:library:layout', value)
    } catch {
      // The view remains usable when storage is unavailable.
    }
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'k' &&
        (libraryView || normalReading) &&
        !readerId
      ) {
        event.preventDefault()
        setSearchOpen(true)
        requestAnimationFrame(() => search.current?.focus())
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [libraryView, normalReading, readerId])
  function openSearch() {
    setSearchOpen(true)
    requestAnimationFrame(() => search.current?.focus())
  }
  function openChapters(id: string) {
    navigateTo({ view: 'chapters', bookId: id })
    const context = player.getContext()
    setChapterPagination({
      bookId: id,
      page: context?.book.id === id ? Math.floor((context.episodeIndex ?? 0) / 100) : 0,
    })
  }
  function toggleBookPlayback(item: BookSummary) {
    if (playback.episode?.bookId === item.id) {
      if (playback.playing || playback.subtitleWaiting || playback.loading) player.pause()
      else if (playback.ready) void player.play()
      else if (playback.episode) void player.load(playback.episode.id)
      return
    }
    const id = item.currentEpisodeId ?? item.firstEpisodeId
    if (id) void player.load(id)
  }
  const playerHidden = normalReading && !playback.episode && !playback.loading && !playback.error
  if (readerId)
    return (
      <>
        <ReaderPage
          key={readerId}
          bookId={readerId}
          autoRead={readAloudId === readerId}
          onAutoReadHandled={() => setReadAloudId(null)}
          onBack={() => navigate('ebook')}
          onListen={(anchor) =>
            anchor
              ? void connections.listenAt(readerId, anchor.ordinal)
              : navigate(playback.episode ? 'reading' : 'library')
          }
          onLink={() => connections.link({ readingBookId: readerId })}
          linked={connections.links.some((link) => link.readingBookId === readerId)}
          navigationNotice={
            connections.notice?.bookId === readerId ? connections.notice.message : undefined
          }
          onDismissNavigationNotice={connections.dismissNotice}
          listeningTitle={
            playback.episode ? `${playback.bookTitle} · ${playback.episode.title}` : undefined
          }
        />
        {connections.dialogs}
      </>
    )
  return (
    <div
      className={`app-shell spotify-shell${reading ? ' reading companion-mode' : ''}${playerHidden ? ' player-hidden' : ''}`}
      data-page-kind={libraryView || normalReading ? 'shelf' : reading ? 'companion' : 'content'}
    >
      <aside className="sidebar" aria-label="主导航">
        <Tooltip content={`${APP_NAME} · 我的书架`}>
          <a
            className="brand"
            href="#library"
            aria-label={`${APP_NAME}首页`}
            onClick={(event) => {
              event.preventDefault()
              navigate(lastShelf.current)
            }}
          >
            <Icon name="headphones" />
          </a>
        </Tooltip>
        <nav className="view-nav" aria-label="书架导航">
          <Tooltip content="我的书架">
            <button
              className={libraryView || normalReading || !!book ? 'active' : ''}
              aria-label="我的书架"
              aria-current={libraryView || normalReading || !!book ? 'page' : undefined}
              onClick={() => navigate(lastShelf.current)}
            >
              <Icon name="library" />
            </button>
          </Tooltip>
          <Tooltip content="在线书源">
            <button
              className={sourceOpen ? 'active' : ''}
              aria-label="在线书源"
              aria-current={sourceOpen ? 'page' : undefined}
              onClick={() => navigate('source')}
            >
              <Icon name="globe" />
            </button>
          </Tooltip>
        </nav>
        <div className="sidebar-bottom">
          <Popover label="应用设置" icon="settings" placement="top">
            <button role="menuitem" onClick={() => openInfo('appearance')}>
              <Icon name="book" />
              外观设置
            </button>
            <button role="menuitem" onClick={() => setMaintenanceOpen(true)}>
              <Icon name="settings" />
              缓存与任务
            </button>
            <button role="menuitem" onClick={() => setBackupOpen(true)}>
              <Icon name="upload" />
              备份与存储
            </button>
            <button role="menuitem" onClick={() => setOfflineTarget({ bookId: null })}>
              <Icon name="folder" />
              离线准备计划
            </button>
            <button role="menuitem" onClick={() => openInfo('about')}>
              <Icon name="info" />
              应用信息
            </button>
            <div className="menu-divider" />
            <button role="menuitem" onClick={() => void window.desktop.quitApp()}>
              <Icon name="logout" />
              退出{APP_NAME}
            </button>
          </Popover>
        </div>
      </aside>
      <div className="workspace">
        {libraryView || normalReading ? (
          <ShelfHeader
            ebook={normalReading}
            searchOpen={searchOpen}
            query={query}
            searchRef={search}
            importRef={shelfImportButton}
            busy={normalReading ? ebookImport.busy : busy}
            disabled={
              normalReading ? ebookImport.busy || !ebookImport.ready : busy || !state || !!draft
            }
            onOpenSearch={openSearch}
            onQuery={setQuery}
            onCloseSearch={() => {
              setQuery('')
              setSearchOpen(false)
            }}
            onImport={() =>
              normalReading ? void readingShelf.current?.importBook() : void selectAudio()
            }
            onImportFolder={() => void selectAudio(true)}
          />
        ) : (
          <header className="topbar">
            <h1>{pageTitle}</h1>
          </header>
        )}
        <main
          id="main-content"
          className={libraryView || normalReading ? 'main-content library-content' : 'main-content'}
        >
          {error && (
            <div className="error-message" role="alert">
              <span>{error}</span>
              {!state && <button onClick={() => void load()}>重试</button>}
            </div>
          )}
          <p className="notice" role="status">
            {notice || (!state ? '正在读取本地书架…' : '')}
          </p>
          {draft && (
            <section className="import-preview" aria-label="确认章节顺序">
              <div className="section-heading">
                <h2>确认章节顺序</h2>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => setDraft({ ...draft, episodes: [...draft.episodes].reverse() })}
                >
                  反转顺序
                </button>
              </div>
              <p className="draft-title">
                {draft.title} · {draft.episodes.length} 集 · 按文件名自然排序
              </p>
              <ol className="chapter-preview">
                {draft.episodes.map((episode, index) => (
                  <li key={episode.id}>
                    <span title={episode.title}>{episode.title}</span>
                    <button
                      aria-label={`上移第 ${index + 1} 集`}
                      disabled={busy || index === 0}
                      onClick={() => moveChapter(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      aria-label={`下移第 ${index + 1} 集`}
                      disabled={busy || index === draft.episodes.length - 1}
                      onClick={() => moveChapter(index, 1)}
                    >
                      ↓
                    </button>
                  </li>
                ))}
              </ol>
              <div className="import-actions">
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() => void confirmImport()}
                >
                  确认导入
                </button>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void cancelImport()}
                >
                  取消导入
                </button>
              </div>
            </section>
          )}
          {(libraryView || normalReading) && (
            <ShelfControls
              ebook={normalReading}
              sort={recentOnly ? 'played' : sort}
              layout={layout}
              onShelf={navigate}
              onSort={(value) => {
                setRecentOnly(value === 'played')
                setSort(value === 'played' ? 'recent' : value)
              }}
              onLayout={changeLayout}
            />
          )}{' '}
          {libraryView && (
            <section className="library-section" aria-label={recentOnly ? '最近播放' : '我的书架'}>
              {query && (
                <p className="search-result-count">
                  “{query}” · {visibleBooks.length} 本
                </p>
              )}
              {!state ? (
                <div className="shelf-loading" role="status">
                  <span className="loading-ring" />
                  正在读取书架…
                </div>
              ) : !visibleBooks.length ? (
                <div className="empty-state shelf-empty">
                  <div className="empty-icon">
                    <Icon name={query ? 'search' : recentOnly ? 'clock' : 'library'} />
                  </div>
                  <h3>
                    {query
                      ? '还没找到这本书'
                      : recentOnly
                        ? '还没有播放记录'
                        : '你的故事，从这里开始'}
                  </h3>
                  <p>
                    {query
                      ? '换个关键词，或查看全部书籍。'
                      : recentOnly
                        ? '开始收听后，这里会保留最近位置。'
                        : '导入本地音频，把喜欢的故事放进书架。'}
                  </p>
                  {query ? (
                    <button className="secondary-button" onClick={() => setQuery('')}>
                      查看全部书籍
                    </button>
                  ) : recentOnly ? (
                    <button className="secondary-button" onClick={() => navigate('library')}>
                      浏览书架
                    </button>
                  ) : (
                    <span className="formats">MP3 · M4A · M4B · WAV · OGG · FLAC</span>
                  )}
                </div>
              ) : (
                <ul
                  className={`file-list bookshelf ${layout === 'grid' ? 'bookshelf-grid' : 'bookshelf-list'}`}
                >
                  {shelfPage.items.map((item) => {
                    const linked = linkedBooks.get(item.id)
                    const current = playback.episode?.bookId === item.id
                    const playing =
                      current && (playback.playing || playback.subtitleWaiting || playback.loading)
                    const episode = current ? playback.episode : item.resumeEpisode
                    const position =
                      current || item.lastPlayedAt
                        ? `${episode?.title ?? '第一集'} · ${formatTime(current ? playback.positionMs : (episode?.positionMs ?? 0))}`
                        : '尚未开始收听'
                    return (
                      <ShelfBookCard
                        key={item.id}
                        id={item.id}
                        title={item.title}
                        coverUrl={item.coverUrl}
                        kind="audio"
                        openLabel={`打开 ${item.title} 的目录`}
                        onOpen={() => openChapters(item.id)}
                        primary={{
                          label: playing ? '暂停播放' : '继续播放',
                          title: playing ? `暂停 ${item.title}` : `收听 ${item.title}`,
                          icon: playing ? 'pause' : 'play',
                          disabled: !item.episodeCount,
                          onClick: () => toggleBookPlayback(item),
                        }}
                        metadata={`${item.episodeCount} 集`}
                        source={{
                          label: item.online ? '在线音频' : '本地音频',
                          icon: item.online ? 'globe' : 'folder',
                        }}
                        position={position}
                        availability={linked ? '已关联电子书' : '尚未关联电子书'}
                        linked={!!linked}
                        secondary={
                          linked
                            ? {
                                label: `阅读电子书 ${item.title}`,
                                title: `阅读电子书《${item.title}》`,
                                icon: 'book',
                                onClick: () => {
                                  setReadAloudId(null)
                                  if (current) void connections.readAtPlayback()
                                  else navigateTo({ view: 'reader', bookId: linked.readingBookId })
                                },
                              }
                            : undefined
                        }
                      >
                        <button role="menuitem" onClick={() => openChapters(item.id)}>
                          <Icon name="list" />
                          章节目录
                        </button>
                        <button
                          role="menuitem"
                          onClick={() => connections.link({ bookId: item.id })}
                        >
                          <Icon name="book" />
                          {linked ? '管理关联' : '关联电子书'}
                        </button>
                        <button role="menuitem" onClick={() => openTools(item.id, 'bookmarks')}>
                          <Icon name="bookmark" />
                          本书设置与书签
                        </button>
                        <button
                          role="menuitem"
                          onClick={() => setOfflineTarget({ bookId: item.id })}
                        >
                          <Icon name="folder" />
                          离线准备
                        </button>
                        <div className="menu-divider" />
                        <button
                          role="menuitem"
                          disabled={busy}
                          aria-label={`移除 ${item.title} 的记录`}
                          onClick={() => requestRemoval(item.id)}
                        >
                          <Icon name="close" />
                          移除记录
                        </button>
                      </ShelfBookCard>
                    )
                  })}
                </ul>
              )}
              <ShelfPagination
                page={shelfPage.page}
                pages={shelfPage.pages}
                onPage={shelfPage.setPage}
                label="有声书书架分页"
              />
            </section>
          )}
          {book && !reading && !normalReading && !sourceOpen && (
            <section className="chapters" aria-label="章节目录">
              <button className="text-button back-link" onClick={() => navigate('library')}>
                <Icon name="arrow" />
                返回书架
              </button>
              <div className="chapter-book-heading">
                <BookCover title={book.title} id={book.id} coverUrl={book.coverUrl} small />
                <div>
                  <h2 title={book.title}>{book.title}</h2>
                  <p>
                    {book.episodeCount} 集
                    {book.online && !book.online.catalogComplete ? ' · 目录未完整加载' : ''}
                  </p>
                </div>
                <button
                  className="secondary-button"
                  onClick={() => openTools(book.id, 'bookmarks')}
                >
                  <Icon name="settings" />
                  本书设置与书签
                </button>
                <button
                  className="secondary-button"
                  onClick={() => connections.link({ bookId: book.id })}
                >
                  <Icon name="book" />
                  {connections.links.some((link) => link.audioBookId === book.id)
                    ? '管理电子书关联'
                    : '关联电子书'}
                </button>
                <button
                  className="secondary-button"
                  onClick={() => setOfflineTarget({ bookId: book.id })}
                >
                  <Icon name="folder" />
                  离线准备
                </button>
              </div>
              {chapterResult?.key === chapterKey && chapterResult.error ? (
                <p role="alert">
                  {chapterResult.error}
                  <button onClick={() => setLibraryRevision((value) => value + 1)}>重试</button>
                </p>
              ) : chapterResult?.key !== chapterKey ? (
                <p role="status">正在读取目录…</p>
              ) : null}
              <ol className="episode-list">
                {chapterEpisodes.map((episode, localIndex) => {
                  const index = chapterPage * 100 + localIndex
                  const status =
                    playback.episode?.id === episode.id &&
                    playback.subtitleStatus?.audioHash === episode.contentHash
                      ? playback.subtitleStatus
                      : chapterStatuses.get(episode.id)
                  return (
                    <li
                      key={episode.id}
                      className={playback.episode?.id === episode.id ? 'current' : ''}
                    >
                      <button
                        disabled={playback.loading && playback.episode?.id === episode.id}
                        onClick={() => {
                          if (playback.episode?.id !== episode.id || !playback.ready)
                            void player.load(episode.id)
                          else if (playback.playing || playback.subtitleWaiting) player.pause()
                          else void player.play()
                        }}
                        aria-label={`${
                          playback.episode?.id === episode.id && playback.loading
                            ? '正在加载'
                            : playback.episode?.id === episode.id && playback.subtitleWaiting
                              ? '取消等待'
                              : playback.episode?.id === episode.id && playback.playing
                                ? '暂停'
                                : '播放'
                        }第 ${index + 1} 集 ${episode.title}`}
                      >
                        <span className="episode-number">{String(index + 1).padStart(2, '0')}</span>
                        <span className="episode-title" title={episode.title}>
                          {episode.title}
                        </span>
                        {playback.episode?.id === episode.id && (
                          <span className="episode-current">
                            {playback.loading
                              ? '正在加载'
                              : playback.subtitleWaiting
                                ? '等待字幕'
                                : playback.playing
                                  ? '正在播放'
                                  : '已暂停'}
                          </span>
                        )}
                        {status?.audioHash === episode.contentHash && (
                          <SubtitleStatus
                            snapshot={status}
                            rate={playback.episode?.id === episode.id ? playback.rate : 1}
                            variant="badge"
                          />
                        )}
                        <span className="episode-duration">
                          {episode.online && !episode.online.cached
                            ? '在线播放'
                            : episode.durationMs
                              ? formatTime(episode.durationMs)
                              : formatSize(episode.sizeBytes)}
                        </span>
                        <Icon
                          name={
                            (playback.playing || playback.subtitleWaiting) &&
                            playback.episode?.id === episode.id
                              ? 'pause'
                              : 'play'
                          }
                        />
                      </button>
                    </li>
                  )
                })}
              </ol>
              {book.episodeCount > 100 && (
                <nav className="subtitle-status-pages" aria-label="章节分页">
                  <button
                    className="text-button"
                    disabled={chapterPage === 0}
                    onClick={() => setChapterPagination({ bookId: book.id, page: chapterPage - 1 })}
                  >
                    上一页章节
                  </button>
                  <span>
                    {chapterPage + 1} / {Math.ceil(book.episodeCount / 100)}
                  </span>
                  <button
                    className="text-button"
                    disabled={(chapterPage + 1) * 100 >= book.episodeCount}
                    onClick={() => setChapterPagination({ bookId: book.id, page: chapterPage + 1 })}
                  >
                    下一页章节
                  </button>
                </nav>
              )}
            </section>
          )}
          {sourceOpen && (
            <OnlineSourceBrowser
              state={state}
              onLibrary={update}
              onReadBook={(id) => navigateTo({ view: 'reader', bookId: id })}
            />
          )}
          <div className="reading-view" hidden={!reading}>
            <TranscriptReader
              episode={playback.episode}
              book={state?.books.find((item) => item.id === playback.episode?.bookId)}
              visible={reading}
              onLinkBook={() =>
                playback.episode && connections.link({ bookId: playback.episode.bookId })
              }
              onOpenLinkedReading={() => void connections.readAtPlayback()}
              onUpdated={update}
              onOpenLibrary={() => navigate('library')}
              onOpenSubtitleSettings={() =>
                playback.episode && openTools(playback.episode.bookId, 'subtitles')
              }
            />
          </div>
          <div className="normal-reading-view" hidden={!normalReading}>
            <NormalReading
              ref={readingShelf}
              visible={normalReading}
              query={query}
              sort={sort}
              layout={layout}
              recentOnly={recentOnly}
              onClearFilters={() => {
                setQuery('')
                setRecentOnly(false)
              }}
              onImportStatusChange={setEbookImport}
              onRemoved={() => setEbookFocusRequest((request) => request + 1)}
              onLinkBook={(id) => connections.link({ readingBookId: id })}
              onOpenBook={(id) => {
                setReadAloudId(null)
                navigateTo({ view: 'reader', bookId: id })
              }}
              onReadAloud={(id) => {
                setReadAloudId(id)
                navigateTo({ view: 'reader', bookId: id })
              }}
              onListenBook={(id, position) => void connections.listenAt(id, position)}
              links={connections.links}
            />
          </div>
        </main>
      </div>
      <PlayerBar
        reading={reading}
        playback={playback}
        hidden={playerHidden}
        onRead={() => navigate('reading')}
        onTools={openTools}
        onChapters={openChapters}
      />
      {connections.dialogs}
      {toolsBook && (
        <ListeningTools
          key={toolsBook.id}
          book={toolsBook}
          initialSection={toolsTarget?.section}
          onUpdated={update}
          onClose={closeTools}
        />
      )}
      {removingBook && (
        <RemoveBookConfirmation
          book={removingBook}
          busy={busy}
          error={removeError}
          onCancel={cancelRemoval}
          onConfirm={() => void removeBook(removingBook.id)}
        />
      )}
      {maintenanceOpen && (
        <MaintenancePanel
          onClose={() => setMaintenanceOpen(false)}
          onOpenOffline={() => {
            setMaintenanceOpen(false)
            setOfflineTarget({ bookId: null })
          }}
        />
      )}
      {backupOpen && (
        <BackupStoragePanel
          onClose={() => {
            setBackupOpen(false)
            requestAnimationFrame(() =>
              document.querySelector<HTMLButtonElement>('button[aria-label="应用设置"]')?.focus(),
            )
          }}
        />
      )}
      {offlineTarget && state && (
        <OfflinePreparationPanel
          books={state.books}
          initialBookId={offlineTarget.bookId}
          onUpdated={update}
          onClose={() => setOfflineTarget(null)}
        />
      )}
      {infoOpen && (
        <AppInfo
          state={state}
          panel={infoOpen}
          busy={busy || !!draft}
          error={infoError || (!state ? error : '')}
          onImport={(id) => void importRemembered(id)}
          onRetry={() => void load()}
          onClose={closeInfo}
        />
      )}
    </div>
  )
}
