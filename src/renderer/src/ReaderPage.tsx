import { Fragment, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { ReadingBook } from '../../shared/reading'
import { BookTextSearch } from './OriginalSearch'
import { readingParagraphs, type ReaderAnchor } from './reader-layout'
import { READER_FONTS, useReaderPreferences, type ReaderSettings } from './reader-settings'
import { ReaderPreferences, type SettingsTab } from './ReaderPreferences'
import { readReadingBookmarks, storeReadingBookmarks } from './reader-bookmarks'
import { useEbookDocument } from './useEbookDocument'
import { useAppAppearance } from './app-appearance'
import { readerPanelAppearance } from './reader-panel'
import { EbookSpeechControls, useEbookSpeech } from './EbookSpeechControls'
import { ReaderFooter, ReaderToolbar, ReaderAction } from './ReaderToolbar'
import { updateSourceReadingSession } from './source-session'

interface ReaderNavigation {
  onBack: () => void
  onListen: (anchor?: ReaderAnchor) => void
  listeningTitle?: string
  onLink?: () => void
  linked?: boolean
  navigationNotice?: string
  onDismissNavigationNotice?: () => void
  autoRead?: boolean
  onAutoReadHandled?: () => void
}

export function ReaderPage({
  bookId,
  onBack,
  onListen,
  listeningTitle,
  onLink,
  linked,
  navigationNotice,
  onDismissNavigationNotice,
  autoRead,
  onAutoReadHandled,
}: ReaderNavigation & { bookId: string }) {
  const [book, setBook] = useState<ReadingBook | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    void window.desktop
      .getReadingBooks()
      .then((result) => {
        if (!current) return
        if (!result.ok) setError(result.error.message)
        else {
          const found = result.value.find((item) => item.id === bookId)
          if (found) setBook(found)
          else setError('这本电子书已移除，请返回书架重新选择。')
        }
      })
      .catch(() => {
        if (current) setError('无法打开电子书，请返回书架重试。')
      })
    return () => {
      current = false
    }
  }, [bookId])
  if (!book)
    return (
      <main className="ebook-reader-page reader-opening" aria-label="独立阅读页">
        <p role={error ? 'alert' : 'status'}>{error || '正在打开电子书…'}</p>
        <nav className="reader-library-navigation" aria-label="书架切换">
          <ReaderAction
            className="reader-button reader-back"
            onClick={onBack}
            label="返回阅读书架"
            icon="arrow"
          />
          <ReaderAction
            className="reader-button"
            onClick={() => onListen()}
            label={listeningTitle ? '返回听书' : '有声书书架'}
            icon="headphones"
            tooltip={
              linked ? '从此处听书' : listeningTitle ? `返回听书 · ${listeningTitle}` : '有声书书架'
            }
          />
        </nav>
      </main>
    )
  return (
    <ReadingSurface
      key={book.id}
      book={book}
      onBookUpdated={setBook}
      onBack={onBack}
      onListen={onListen}
      listeningTitle={listeningTitle}
      onLink={onLink}
      linked={linked}
      navigationNotice={navigationNotice}
      onDismissNavigationNotice={onDismissNavigationNotice}
      autoRead={autoRead}
      onAutoReadHandled={onAutoReadHandled}
    />
  )
}

type ReaderPanel = 'contents' | 'bookmarks' | 'search' | 'settings' | null
function ReadingSurface({
  book,
  onBookUpdated,
  onBack,
  onListen,
  listeningTitle,
  onLink,
  linked,
  navigationNotice,
  onDismissNavigationNotice,
  autoRead,
  onAutoReadHandled,
}: ReaderNavigation & { book: ReadingBook; onBookUpdated: (book: ReadingBook) => void }) {
  const preferences = useReaderPreferences(book.id),
    settings = preferences.settings
  const { resolvedTheme } = useAppAppearance()
  const panelAppearance = readerPanelAppearance(
    settings.backgroundColor,
    resolvedTheme,
    settings.panelTransparency,
  )
  const [chrome, setChrome] = useState(true)
  const [panel, setPanel] = useState<ReaderPanel>(null)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('layout')
  const [focused, setFocused] = useState(false)
  const [tocQuery, setTocQuery] = useState('')
  const [bookmarks, setBookmarks] = useState(() => readReadingBookmarks(book))
  const [bookmarkNotice, setBookmarkNotice] = useState('')
  const [hit, setHit] = useState<{ first: number; last: number } | null>(null)
  const [progressDraft, setProgressDraft] = useState<number | null>(null)
  const [fullscreen, setFullscreen] = useState(!!document.fullscreenElement)
  const [uiError, setUiError] = useState('')
  const [continuing, setContinuing] = useState(false)
  const [continueNotice, setContinueNotice] = useState('')
  const continueRequest = useRef<string | null>(null)
  const continueCanceled = useRef(false)
  useEffect(
    () => () => {
      const requestId = continueRequest.current
      continueRequest.current = null
      if (requestId) void window.desktop.textCancel({ requestId })
    },
    [],
  )
  const backButton = useRef<HTMLButtonElement>(null),
    panelElement = useRef<HTMLElement>(null)
  const hideTimer = useRef<number | undefined>(undefined)
  const touch = useRef<{ x: number; y: number } | null>(null)
  const pageClick = useRef<{ x: number; y: number; moved: boolean; selected: boolean } | null>(null)
  const leaving = useRef(false)
  const { viewport, ...reader } = useEbookDocument(book, settings)
  const narration = useEbookSpeech(book.id, (anchor) => reader.followAnchor(anchor))
  async function continueReading() {
    if (continueRequest.current) {
      continueCanceled.current = true
      await window.desktop.textCancel({ requestId: continueRequest.current })
      return
    }
    const requestId = crypto.randomUUID()
    continueCanceled.current = false
    continueRequest.current = requestId
    setContinuing(true)
    setContinueNotice('正在获取下一章…')
    setUiError('')
    try {
      await reader.flush()
      if (continueCanceled.current) {
        setContinueNotice('已取消获取，已下载内容已保留。')
        return
      }
      const result = await window.desktop.textContinue({ requestId, readingBookId: book.id })
      if (continueRequest.current !== requestId) return
      if (!result.ok) {
        setContinueNotice('')
        if (continueCanceled.current) setContinueNotice('已取消获取，已下载内容已保留。')
        else setUiError(result.error.message)
      } else {
        updateSourceReadingSession(result.value)
        onBookUpdated(result.value.book)
        setContinueNotice(result.value.message)
      }
    } catch {
      if (continueRequest.current === requestId) {
        setContinueNotice('')
        setUiError('获取下一章失败，请重试。已下载内容已保留。')
      }
    } finally {
      if (continueRequest.current === requestId) {
        continueRequest.current = null
        setContinuing(false)
      }
    }
  }
  const automaticRead = useRef(false)
  useEffect(() => {
    if (!autoRead || reader.busy || automaticRead.current) return
    automaticRead.current = true
    onAutoReadHandled?.()
    void Promise.resolve().then(() => narration.start(reader.location))
  }, [autoRead, reader.busy, reader.location, narration, onAutoReadHandled])
  const visible = !focused && (chrome || panel !== null)
  const chapters = book.chapters.filter((item) => item.count > 0)
  const chapterIndex = chapters.findIndex(
    (item) =>
      reader.location.ordinal >= item.first && reader.location.ordinal < item.first + item.count,
  )
  const chapter = chapters[chapterIndex]
  const sentences = reader.pages.flatMap((page) => page.sentences),
    groups = readingParagraphs(sentences)
  const progress = Math.round(
    ((progressDraft ?? reader.location.ordinal) / Math.max(1, book.sentenceCount - 1)) * 100,
  )
  const style = {
    '--reading-bg': settings.backgroundColor,
    '--reading-text': settings.textColor,
    '--reading-width': `${settings.contentWidth}px`,
    '--reading-size': `${settings.fontSize}px`,
    '--reading-leading': settings.lineHeight,
    '--reading-font': READER_FONTS[settings.fontFamily].family,
    '--reading-weight': settings.fontWeight,
    '--reading-tracking': `${settings.letterSpacing}px`,
    '--reading-paragraph-gap': `${settings.paragraphSpacing}em`,
    '--reading-indent': settings.indent ? '2em' : '0',
    '--reader-panel-opacity': `${100 - settings.panelTransparency}%`,
  } as CSSProperties
  function hideLater() {
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      if (!document.activeElement?.closest('.reader-chrome')) setChrome(false)
    }, 1200)
  }
  function reveal() {
    if (!focused) {
      window.clearTimeout(hideTimer.current)
      setChrome(true)
    }
  }
  async function leave(destination: () => void) {
    if (leaving.current) return
    leaving.current = true
    try {
      // flush saves the local text anchor before waiting for desktop persistence.
      await reader.flush()
      destination()
      leaving.current = false
    } catch {
      leaving.current = false
      setUiError('阅读位置保存失败，请重试。')
    }
  }
  useEffect(() => {
    hideTimer.current = window.setTimeout(() => setChrome(false), 2200)
    const changed = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', changed)
    return () => {
      window.clearTimeout(hideTimer.current)
      document.removeEventListener('fullscreenchange', changed)
    }
  }, [])
  useEffect(() => {
    if (!reader.busy) viewport.current?.focus({ preventScroll: true })
  }, [reader.busy, viewport])
  useEffect(() => {
    if (panel === 'contents' || panel === 'search')
      panelElement.current?.querySelector('input')?.focus({ preventScroll: true })
  }, [panel])
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const zoom = (event: WheelEvent) => {
      if (!event.ctrlKey || !event.deltaY) return
      event.preventDefault()
      reader.rememberLayout()
      preferences.change({
        fontSize: Math.max(14, Math.min(36, settings.fontSize + (event.deltaY < 0 ? 1 : -1))),
      })
    }
    element.addEventListener('wheel', zoom, { passive: false })
    return () => element.removeEventListener('wheel', zoom)
  }, [preferences, reader, settings.fontSize, viewport])
  function openPanel(value: ReaderPanel) {
    setFocused(false)
    setPanel(value)
    setChrome(true)
  }
  function closePanel() {
    setPanel(null)
    hideLater()
    viewport.current?.focus({ preventScroll: true })
  }
  function changeSettings(change: Partial<ReaderSettings>) {
    reader.rememberLayout()
    preferences.change(change)
  }
  function turn(direction: number) {
    narration.speech.pause('翻阅时已暂停朗读，可从当前位置继续。')
    setHit(null)
    reader.turn(direction)
  }
  function jump(anchor: ReaderAnchor) {
    narration.speech.pause('已选择新的阅读位置，可从此处继续朗读。')
    reader.goAnchor(anchor)
    closePanel()
  }
  function changeChapter(direction: number) {
    const next = chapters[chapterIndex + direction]
    if (next) {
      setHit(null)
      jump({ ordinal: next.first, offset: 0 })
    }
  }
  function setFocus(value: boolean) {
    reader.rememberLayout()
    setFocused(value)
    setPanel(null)
    setChrome(!value)
    requestAnimationFrame(() => viewport.current?.focus({ preventScroll: true }))
  }
  function addBookmark() {
    if (bookmarks.length >= 500) {
      setBookmarkNotice('本书最多保存 500 个书签。')
      return
    }
    if (
      bookmarks.some(
        (item) =>
          item.anchor.ordinal === reader.location.ordinal &&
          item.anchor.offset === reader.location.offset,
      )
    ) {
      setBookmarkNotice('当前位置已经有书签。')
      return
    }
    const sentence = sentences.find((item) => item.ordinal === reader.location.ordinal)
    const next = [
      ...bookmarks,
      {
        id: crypto.randomUUID(),
        anchor: { ...reader.location },
        chapter: chapter?.title ?? book.title,
        excerpt:
          sentence?.text.slice(reader.location.offset, reader.location.offset + 120) ||
          sentence?.text.slice(0, 120) ||
          chapter?.title ||
          book.title,
        createdAt: new Date().toISOString(),
      },
    ].sort((a, b) => a.anchor.ordinal - b.anchor.ordinal || a.anchor.offset - b.anchor.offset)
    setBookmarks(next)
    setBookmarkNotice(
      storeReadingBookmarks(book.id, next) ? '书签已保存。' : '书签保存失败，请检查本地存储。',
    )
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
    } catch {
      setUiError('无法切换全屏，请稍后重试。')
    }
  }
  function commitProgress(value: string) {
    narration.speech.pause('已选择新的阅读位置，可从此处继续朗读。')
    setProgressDraft(null)
    setHit(null)
    reader.go(Number(value))
  }
  return (
    <main
      className="ebook-reader-page"
      data-reader-design="book"
      aria-label="独立阅读页"
      style={style}
      data-theme={settings.theme}
      data-mode={settings.mode}
      data-page-layout={settings.pageLayout}
      data-font={settings.fontSize}
      data-leading={settings.lineHeight}
      data-font-family={settings.fontFamily}
      data-focus={focused}
      data-settings-open={!focused && panel === 'settings'}
      data-reduce-motion={settings.reduceMotion}
      data-speech-status={narration.state.status}
      data-speech-active={narration.state.status !== 'idle'}
      onWheelCapture={(event) => {
        if (!event.ctrlKey && (event.target as HTMLElement).closest('.book-viewport'))
          narration.speech.pause('翻阅时已暂停朗读，可从当前位置继续。')
      }}
      onPointerMove={(event) => {
        if (focused) return
        const bounds = event.currentTarget.getBoundingClientRect(),
          target = event.target as Element
        if (
          event.clientY < bounds.top + 64 ||
          event.clientY > bounds.bottom - 64 ||
          target.closest('.reader-chrome, .reader-panel-drawer')
        )
          reveal()
        else hideLater()
      }}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement
        if (event.key === 'Escape' && target.closest('select:open')) return
        if (event.key === 'Escape') {
          if (focused) setFocus(false)
          else if (panel) closePanel()
          else {
            setChrome(false)
            viewport.current?.focus({ preventScroll: true })
          }
          return
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
          event.preventDefault()
          openPanel('search')
          return
        }
        if (event.key === 'F11') {
          event.preventDefault()
          void toggleFullscreen()
          return
        }
        if (
          target.closest(
            'input, select, textarea, button, [contenteditable="true"], .reader-panel-drawer',
          )
        )
          return
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
          event.preventDefault()
          addBookmark()
          return
        }
        if (event.key === 'Tab' && !visible && !focused) {
          event.preventDefault()
          reveal()
          requestAnimationFrame(() => backButton.current?.focus())
          return
        }
        if ((event.ctrlKey || event.metaKey) && (event.key === 'Home' || event.key === 'End')) {
          event.preventDefault()
          jump({ ordinal: event.key === 'Home' ? 0 : book.sentenceCount - 1, offset: 0 })
          return
        }
        if (
          ['ArrowRight', 'PageDown'].includes(event.key) ||
          (event.key === ' ' && !event.shiftKey)
        ) {
          event.preventDefault()
          turn(1)
        }
        if (['ArrowLeft', 'PageUp'].includes(event.key) || (event.key === ' ' && event.shiftKey)) {
          event.preventDefault()
          turn(-1)
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (settings.mode === 'pages') {
            event.preventDefault()
            turn(event.key === 'ArrowDown' ? 1 : -1)
          } else reader.userScroll()
        }
      }}
    >
      <div className="reader-running-title" aria-hidden="true">
        {book.title}
        <span> / {chapter?.title}</span>
      </div>
      {focused && (
        <ReaderAction
          className="reader-button reader-focus-exit"
          onClick={() => setFocus(false)}
          label="退出专注"
          icon="focus"
          tooltip="退出专注 · Esc"
        />
      )}
      <div className="reader-edge-top" onPointerEnter={reveal} onPointerLeave={hideLater} />
      <ReaderToolbar
        className="reader-chrome reader-toolbar"
        data-visible={visible}
        inert={!visible}
        aria-label="阅读工具栏"
        onFocusCapture={reveal}
        onBlurCapture={hideLater}
      >
        <nav className="reader-library-navigation" aria-label="书架切换">
          <ReaderAction
            ref={backButton}
            className="reader-button reader-back"
            onClick={() => void leave(onBack)}
            label="返回阅读书架"
            icon="arrow"
          />
          <ReaderAction
            className="reader-button reader-listen"
            onClick={() => void leave(() => onListen(linked ? reader.location : undefined))}
            label={linked ? '从此处听书' : listeningTitle ? '返回听书' : '有声书书架'}
            icon="headphones"
            tooltip={
              linked ? '从此处听书' : listeningTitle ? `返回听书 · ${listeningTitle}` : '有声书书架'
            }
          />
          {onLink && (
            <ReaderAction
              className="reader-icon-button"
              onClick={onLink}
              label={linked ? '管理有声书关联' : '关联有声书'}
              icon="link"
              tooltip={linked ? '管理有声书关联' : '关联有声书'}
            />
          )}
          <ReaderAction
            className="reader-icon-button"
            onClick={() =>
              narration.state.status === 'playing' || narration.state.status === 'loading'
                ? narration.speech.pause()
                : narration.start(reader.location)
            }
            label={
              narration.state.status === 'playing' || narration.state.status === 'loading'
                ? '暂停电子书朗读'
                : '朗读电子书'
            }
            icon={
              narration.state.status === 'playing' || narration.state.status === 'loading'
                ? 'pause'
                : 'play'
            }
            tooltip={
              narration.state.status === 'playing' || narration.state.status === 'loading'
                ? '暂停电子书朗读'
                : '从当前位置朗读电子书'
            }
          />
        </nav>
        <span className="reader-toolbar-title" title={book.title}>
          {book.title}
        </span>
        <div className="reader-toolbar-actions">
          <ReaderAction
            className="reader-icon-button"
            aria-expanded={panel === 'contents'}
            onClick={() => (panel === 'contents' ? closePanel() : openPanel('contents'))}
            label="打开目录"
            icon="list"
            tooltip="目录"
          />
          <ReaderAction
            className="reader-icon-button"
            aria-expanded={panel === 'search'}
            onClick={() => (panel === 'search' ? closePanel() : openPanel('search'))}
            label="搜索书内文字"
            icon="search"
            tooltip="全文搜索 · Ctrl+F"
          />
          <ReaderAction
            className="reader-icon-button"
            aria-expanded={panel === 'bookmarks'}
            onClick={() => (panel === 'bookmarks' ? closePanel() : openPanel('bookmarks'))}
            label="阅读书签"
            icon="bookmark"
            tooltip="书签 · Ctrl+D 添加"
          />
          <ReaderAction
            className="reader-icon-button reader-settings-button"
            aria-expanded={panel === 'settings'}
            onClick={() => (panel === 'settings' ? closePanel() : openPanel('settings'))}
            label="阅读设置"
            icon="settings"
            tooltip="阅读设置"
          />
          <ReaderAction
            className="reader-icon-button"
            onClick={() => setFocus(true)}
            label="专注阅读"
            icon="focus"
            tooltip="专注阅读"
          />
          <ReaderAction
            className="reader-icon-button"
            onClick={() => void toggleFullscreen()}
            label={fullscreen ? '退出全屏' : '全屏阅读'}
            icon="fullscreen"
            tooltip={fullscreen ? '退出全屏 · F11' : '全屏阅读 · F11'}
          />
        </div>
      </ReaderToolbar>
      {navigationNotice && (
        <div className="reader-switch-notice" role="status">
          <span>{navigationNotice}</span>
          <ReaderAction
            className="reader-icon-button"
            onClick={onDismissNavigationNotice}
            label="关闭阅读提示"
            icon="close"
          />
        </div>
      )}
      <div
        className="reader-stage"
        onPointerDownCapture={(event) => {
          pageClick.current =
            event.pointerType === 'mouse' && event.button === 0
              ? {
                  x: event.clientX,
                  y: event.clientY,
                  moved: false,
                  selected: !window.getSelection()?.isCollapsed,
                }
              : null
        }}
        onPointerMove={(event) => {
          const start = pageClick.current
          if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6)
            start.moved = true
        }}
        onPointerCancel={() => {
          pageClick.current = null
        }}
        onClick={(event) => {
          const start = pageClick.current
          pageClick.current = null
          if (
            settings.mode !== 'pages' ||
            panel ||
            reader.busy ||
            !start ||
            start.moved ||
            start.selected ||
            !window.getSelection()?.isCollapsed ||
            event.detail > 1 ||
            (event.target as HTMLElement).closest(
              'button, a, input, select, textarea, [contenteditable="true"]',
            )
          )
            return
          const bounds = event.currentTarget.getBoundingClientRect()
          turn(event.clientX < bounds.left + bounds.width / 2 ? -1 : 1)
        }}
      >
        <div className="reader-content-frame">
          <div
            className="book-viewport"
            ref={viewport}
            tabIndex={0}
            role="region"
            aria-label="电子书正文"
            aria-busy={reader.busy}
            data-first={reader.pages[0]?.start}
            data-last={sentences.at(-1)?.ordinal}
            onScroll={reader.scrolled}
            onPointerDown={(event) => {
              reader.userScroll()
              if (event.pointerType === 'touch')
                touch.current = { x: event.clientX, y: event.clientY }
            }}
            onPointerUp={(event) => {
              if (event.pointerType !== 'touch' || !touch.current) return
              const dx = event.clientX - touch.current.x,
                dy = event.clientY - touch.current.y
              if (settings.mode === 'pages' && Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy))
                turn(dx < 0 ? 1 : -1)
              else if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && !focused)
                setChrome((value) => !value)
              touch.current = null
            }}
            onClick={() => {
              if (panel && !window.getSelection()?.toString()) closePanel()
            }}
          >
            <article className="ebook-text">
              {groups.map((group) => {
                const first = group[0]!,
                  section = book.chapters[first.chapter]!
                return (
                  <Fragment key={`${first.chapter}:${first.paragraph}`}>
                    {first.ordinal === section.first && (
                      <h2 className="ebook-chapter-title">{section.title}</h2>
                    )}
                    <p>
                      {group.map((sentence) => (
                        <span
                          key={sentence.ordinal}
                          data-sentence={sentence.ordinal}
                          data-speech-current={
                            narration.state.status === 'playing' &&
                            narration.state.anchor?.ordinal === sentence.ordinal
                              ? 'true'
                              : undefined
                          }
                          data-reader-hit={
                            hit && sentence.ordinal >= hit.first && sentence.ordinal <= hit.last
                              ? 'true'
                              : undefined
                          }
                        >
                          {sentence.text}
                        </span>
                      ))}
                    </p>
                  </Fragment>
                )
              })}
            </article>
          </div>
          {reader.busy && (
            <p className="reader-load-state" role="status">
              正在排版正文…
            </p>
          )}
        </div>
        {settings.mode === 'pages' && (
          <>
            <ReaderAction
              className="reader-page-turn reader-page-previous"
              disabled={reader.busy || !reader.canPrevious}
              onClick={() => turn(-1)}
              label="上一屏"
              icon="chevron"
            />
            <ReaderAction
              className="reader-page-turn reader-page-next"
              disabled={reader.busy || !reader.canNext}
              onClick={() => turn(1)}
              label="下一屏"
              icon="chevron"
            />
          </>
        )}
      </div>
      <div className="reader-idle-progress" aria-hidden="true">
        {progress}%
      </div>
      <div className="reader-edge-bottom" onPointerEnter={reveal} onPointerLeave={hideLater} />
      <ReaderFooter
        className="reader-chrome reader-bottom-bar"
        data-visible={visible || narration.state.status !== 'idle'}
        inert={!visible && narration.state.status === 'idle'}
        aria-label="阅读进度工具"
        onFocusCapture={reveal}
        onBlurCapture={hideLater}
      >
        <EbookSpeechControls value={narration} anchor={reader.location} />
        <div className="reader-bottom-heading">
          <span title={chapter?.title}>{chapter?.title}</span>
          <span className="reader-save-status" role="status">
            {continueNotice || (reader.saved ? '位置已保存' : '正在保存…')}
          </span>
        </div>
        <div className="reader-progress-controls">
          {book.source && (
            <ReaderAction
              className="reader-button"
              disabled={!continuing && reader.busy}
              onClick={() => void continueReading()}
              label={continuing ? '取消获取下一章' : '获取下一章'}
              icon={continuing ? 'stop' : 'refresh'}
              aria-busy={continuing}
            />
          )}
          <ReaderAction
            className="reader-action-previous reader-button"
            disabled={
              reader.busy || (settings.mode === 'pages' ? !reader.canPrevious : chapterIndex <= 0)
            }
            onClick={() => (settings.mode === 'pages' ? turn(-1) : changeChapter(-1))}
            label={settings.mode === 'pages' ? '上一页' : '上一章'}
            icon={settings.mode === 'pages' ? 'chevron' : 'previous'}
          />
          <input
            type="range"
            aria-label="阅读进度"
            min="0"
            max={Math.max(1, book.sentenceCount - 1)}
            step="1"
            value={progressDraft ?? reader.location.ordinal}
            disabled={reader.busy || book.sentenceCount <= 1}
            onChange={(event) => setProgressDraft(Number(event.target.value))}
            onPointerUp={(event) => commitProgress(event.currentTarget.value)}
            onKeyUp={(event) => {
              if (
                ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)
              )
                commitProgress(event.currentTarget.value)
            }}
            onBlur={(event) => {
              if (progressDraft !== null) commitProgress(event.currentTarget.value)
            }}
          />
          <span
            className="reader-progress-label"
            data-position={reader.location.ordinal}
            data-offset={reader.location.offset}
          >
            {progress}%
          </span>
          <ReaderAction
            className="reader-button"
            disabled={
              reader.busy ||
              (settings.mode === 'pages' ? !reader.canNext : chapterIndex >= chapters.length - 1)
            }
            onClick={() => (settings.mode === 'pages' ? turn(1) : changeChapter(1))}
            label={settings.mode === 'pages' ? '下一页' : '下一章'}
            icon={settings.mode === 'pages' ? 'chevron' : 'next'}
          />
        </div>
      </ReaderFooter>
      {panel && !focused && (
        <>
          <button
            className="reader-panel-scrim"
            aria-label="收起阅读面板"
            tabIndex={-1}
            onClick={closePanel}
          />
          <aside
            ref={panelElement}
            style={
              { ...panelAppearance.variables, colorScheme: panelAppearance.tone } as CSSProperties
            }
            data-panel-tone={panelAppearance.tone}
            className={`reader-panel-drawer reader-${panel}-panel`}
            role="region"
            aria-label={
              panel === 'settings'
                ? '电子书阅读设置'
                : panel === 'contents'
                  ? '电子书目录'
                  : panel === 'bookmarks'
                    ? '电子书书签'
                    : '书内搜索'
            }
          >
            <div className="reader-panel-heading">
              <h2>
                {panel === 'settings'
                  ? '阅读设置'
                  : panel === 'contents'
                    ? '目录'
                    : panel === 'bookmarks'
                      ? '书签'
                      : '全文搜索'}
              </h2>
              <ReaderAction
                className="reader-icon-button"
                onClick={closePanel}
                label="关闭阅读面板"
                icon="close"
              />
            </div>
            {(panel === 'contents' || panel === 'bookmarks') && (
              <nav
                className="reader-navigation-tabs"
                role="tablist"
                aria-label="书籍导航"
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                  event.preventDefault()
                  const next =
                    event.key === 'Home'
                      ? 'contents'
                      : event.key === 'End'
                        ? 'bookmarks'
                        : panel === 'contents'
                          ? 'bookmarks'
                          : 'contents'
                  setPanel(next)
                  event.currentTarget
                    .querySelector<HTMLButtonElement>(`[id="reader-navigation-${next}"]`)
                    ?.focus()
                }}
              >
                <button
                  id="reader-navigation-contents"
                  role="tab"
                  aria-selected={panel === 'contents'}
                  aria-controls="reader-navigation-panel"
                  tabIndex={panel === 'contents' ? 0 : -1}
                  aria-current={panel === 'contents' ? 'page' : undefined}
                  onClick={() => openPanel('contents')}
                >
                  目录
                </button>
                <button
                  id="reader-navigation-bookmarks"
                  role="tab"
                  aria-selected={panel === 'bookmarks'}
                  aria-controls="reader-navigation-panel"
                  tabIndex={panel === 'bookmarks' ? 0 : -1}
                  aria-current={panel === 'bookmarks' ? 'page' : undefined}
                  onClick={() => openPanel('bookmarks')}
                >
                  书签 · {bookmarks.length}
                </button>
              </nav>
            )}
            {(panel === 'contents' || panel === 'bookmarks') && (
              <div
                className="reader-navigation-panel"
                id="reader-navigation-panel"
                role="tabpanel"
                aria-labelledby={`reader-navigation-${panel}`}
              >
                {panel === 'contents' && (
                  <>
                    <input
                      className="reader-toc-filter"
                      aria-label="筛选目录"
                      placeholder="查找章节…"
                      value={tocQuery}
                      onChange={(event) => setTocQuery(event.target.value)}
                    />
                    <ol className="reader-toc-list">
                      {chapters
                        .filter((item) => item.title.includes(tocQuery.trim()))
                        .map((item) => (
                          <li key={item.index}>
                            <button
                              aria-current={chapter?.index === item.index ? 'location' : undefined}
                              onClick={() => {
                                setHit(null)
                                jump({ ordinal: item.first, offset: 0 })
                              }}
                            >
                              {item.title}
                            </button>
                          </li>
                        ))}
                    </ol>
                    {!chapters.some((item) => item.title.includes(tocQuery.trim())) && (
                      <p className="reader-hint">没有找到这个章节。</p>
                    )}
                  </>
                )}
                {panel === 'bookmarks' && (
                  <>
                    <ReaderAction
                      className="reader-button reader-add-bookmark"
                      onClick={addBookmark}
                      label="添加当前位置书签"
                      icon="plus"
                    />
                    <p className="reader-hint" role="status">
                      {bookmarkNotice || '书签记住当前文字位置；调整排版后也能返回。'}
                    </p>
                    {!bookmarks.length && (
                      <p className="reader-hint">尚无书签。阅读时也可以按 Ctrl+D 添加。</p>
                    )}
                    <ul className="reader-bookmark-list">
                      {bookmarks.map((item) => (
                        <li key={item.id}>
                          <button
                            className="reader-bookmark-jump"
                            aria-label={`跳转书签 ${item.chapter} ${item.excerpt}`}
                            onClick={() => jump(item.anchor)}
                          >
                            <strong>{item.chapter}</strong>
                            <span>{item.excerpt}</span>
                          </button>
                          <button
                            className="reader-button"
                            aria-label={`删除书签 ${item.excerpt}`}
                            onClick={() => {
                              const next = bookmarks.filter((value) => value.id !== item.id)
                              setBookmarks(next)
                              setBookmarkNotice(
                                storeReadingBookmarks(book.id, next)
                                  ? '书签已删除。'
                                  : '书签删除未能保存。',
                              )
                            }}
                          >
                            删除
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
            {panel === 'search' && (
              <BookTextSearch
                expanded
                find={(query, offset) =>
                  window.desktop.findReadingBook({ id: book.id, query, offset })
                }
                disabled={reader.busy}
                locate={(first, last) => {
                  setHit({ first, last })
                  jump({ ordinal: first, offset: 0 })
                }}
                hint="支持繁简体，点击结果跳转到正文。"
              />
            )}
            {panel === 'settings' && (
              <ReaderPreferences
                settings={settings}
                change={changeSettings}
                scope={preferences.scope}
                selectScope={(scope) => {
                  reader.rememberLayout()
                  preferences.selectScope(scope)
                }}
                reset={() => {
                  reader.rememberLayout()
                  preferences.reset()
                }}
                tab={settingsTab}
                setTab={setSettingsTab}
                storageError={preferences.storageError}
              />
            )}
          </aside>
        </>
      )}
      {(reader.error || uiError) && (
        <div className="reader-error" role="alert">
          <span>{reader.error || uiError}</span>
          <ReaderAction
            className="reader-button"
            onClick={() => {
              setUiError('')
              reader.retry()
            }}
            label="重试"
            icon="follow"
          />
        </div>
      )}
    </main>
  )
}
