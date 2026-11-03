import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import type { ReadingBookSummary } from '../../shared/library'
import type { BookLink } from '../../shared/book-links'
import { Icon } from './Icons'
import { ShelfBookCard, ShelfPagination } from './LibraryShelf'
import { useShelfPage } from './useShelfPage'
import { readingShelfPosition, visibleShelfBooks, type ShelfLayout } from './library-shelf'
import { RemoveBookConfirmation } from './RemoveBookConfirmation'

export interface ReadingShelfHandle {
  importBook(): Promise<void>
}
export interface ReadingShelfImportStatus {
  busy: boolean
  ready: boolean
}

export function NormalReading({
  visible,
  onOpenBook,
  onLinkBook,
  onReadAloud,
  onListenBook,
  links = [],
  query = '',
  sort = 'added',
  layout = 'grid',
  recentOnly = false,
  onClearFilters,
  onImportStatusChange,
  onRemoved,
  ref,
}: {
  visible: boolean
  onOpenBook: (id: string) => void
  onLinkBook?: (id: string) => void
  onReadAloud?: (id: string) => void
  onListenBook?: (id: string, position: number) => void
  links?: BookLink[]
  query?: string
  sort?: string
  layout?: ShelfLayout
  recentOnly?: boolean
  onClearFilters?: () => void
  onImportStatusChange?: (status: ReadingShelfImportStatus) => void
  onRemoved?: () => void
  ref?: Ref<ReadingShelfHandle>
}) {
  const [books, setBooks] = useState<ReadingBookSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [removing, setRemoving] = useState<ReadingBookSummary | null>(null)
  const [removeError, setRemoveError] = useState('')
  const removalTrigger = useRef<HTMLElement | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const loadKey = useMemo(
    () => Symbol(`reading-shelf:${visible}:${loadAttempt}`),
    [visible, loadAttempt],
  )
  const [loadResult, setLoadResult] = useState<{ key: symbol; error: string } | null>(null)
  const loading = visible && loadResult?.key !== loadKey
  const loadError = loadResult?.key === loadKey ? loadResult.error : ''
  const visibleBooks = useMemo(
    () => visibleShelfBooks(books, query, sort, recentOnly, (book) => book.lastReadAt),
    [books, query, sort, recentOnly],
  )
  const shelfPage = useShelfPage(visibleBooks, `${query}:${sort}:${recentOnly}`)
  const linkedIds = useMemo(() => new Set(links.map((link) => link.readingBookId)), [links])
  useEffect(() => {
    if (!visible) return
    let alive = true
    void window.desktop
      .getReadingSummaries()
      .then((result) => {
        if (!alive) return
        if (result.ok) {
          setBooks(result.value)
          setLoaded(true)
        }
        setLoadResult({ key: loadKey, error: result.ok ? '' : result.error.message })
      })
      .catch(() => {
        if (alive) setLoadResult({ key: loadKey, error: '无法读取电子书书架，请重试。' })
      })
    return () => {
      alive = false
    }
  }, [visible, loadKey])
  useEffect(() => {
    onImportStatusChange?.({ busy, ready: loaded && !loading })
  }, [busy, loaded, loading, onImportStatusChange])
  async function importBook() {
    if (busy || loading || !loaded) return
    setBusy(true)
    setError('')
    try {
      const result = await window.desktop.importReadingBook()
      if (!result.ok) setError(result.error.message)
      else if (!result.value.canceled) onOpenBook(result.value.book.id)
    } catch {
      setError('电子书导入失败，请重试。')
    } finally {
      setBusy(false)
    }
  }
  useImperativeHandle(ref, () => ({ importBook }))
  async function remove(book: ReadingBookSummary) {
    setBusy(true)
    setRemoveError('')
    try {
      const result = await window.desktop.removeReadingBook({ id: book.id })
      if (result.ok) {
        setBooks((current) => current.filter((item) => item.id !== book.id))
        setRemoving(null)
        onRemoved?.()
      } else setRemoveError(result.error.message)
    } catch {
      setRemoveError('移除失败，请重试。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="normal-reading library-section" aria-label="正常阅读">
      {loadError && (
        <div className="error-message" role="alert">
          <p>{loadError}</p>
          <button disabled={busy || loading} onClick={() => setLoadAttempt((value) => value + 1)}>
            重新加载书架
          </button>
        </div>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {query && (
        <p className="search-result-count">
          “{query}” · {visibleBooks.length} 本
        </p>
      )}
      {loading ? (
        <div className="shelf-loading" role="status">
          <span className="loading-ring" />
          正在加载阅读书架…
        </div>
      ) : !loaded ? null : !visibleBooks.length ? (
        <div className="empty-state shelf-empty ebook-empty">
          <div className="empty-icon">
            <Icon name={query ? 'search' : recentOnly ? 'clock' : 'book'} />
          </div>
          <h3>{query ? '还没找到这本书' : recentOnly ? '还没有阅读记录' : '开始读一本书'}</h3>
          <p>
            {query
              ? '换个关键词，或查看全部书籍。'
              : recentOnly
                ? '开始阅读后，这里会保留最近位置。'
                : '导入本地 TXT 或 EPUB，把喜欢的故事放进书架。'}
          </p>
          {query || recentOnly ? (
            <button className="secondary-button" onClick={onClearFilters}>
              查看全部书籍
            </button>
          ) : (
            <span className="formats">TXT · EPUB</span>
          )}
        </div>
      ) : (
        <ul
          className={`file-list bookshelf bookshelf-${layout} ebook-shelf`}
          aria-label="电子书列表"
        >
          {shelfPage.items.map((item) => {
            const linked = linkedIds.has(item.id)
            return (
              <ShelfBookCard
                key={item.id}
                id={item.id}
                title={item.title}
                coverUrl={item.coverUrl}
                kind="ebook"
                openLabel={`阅读 ${item.title}`}
                onOpen={() => onOpenBook(item.id)}
                primary={{
                  label: item.lastReadAt ? `继续阅读 ${item.title}` : `开始阅读 ${item.title}`,
                  title: `阅读 ${item.title}`,
                  icon: 'book',
                  onClick: () => onOpenBook(item.id),
                }}
                metadata={`${item.format.toUpperCase()} · ${item.chapterCount} 章`}
                position={readingShelfPosition(item)}
                availability={linked ? '已关联有声书' : '电子书 · 可朗读'}
                linked={linked}
                secondary={
                  linked && onListenBook
                    ? {
                        label: `收听有声书 ${item.title}`,
                        title: `收听《${item.title}》的有声书`,
                        icon: 'headphones',
                        onClick: () => onListenBook(item.id, item.position),
                      }
                    : undefined
                }
              >
                <button role="menuitem" onClick={() => onOpenBook(item.id)}>
                  <Icon name="book" />
                  继续阅读
                </button>
                {linked && onListenBook && (
                  <button role="menuitem" onClick={() => onListenBook(item.id, item.position)}>
                    <Icon name="headphones" />
                    收听有声书
                  </button>
                )}
                {onReadAloud && (
                  <button role="menuitem" onClick={() => onReadAloud(item.id)}>
                    <Icon name="headphones" />
                    朗读电子书
                  </button>
                )}
                {onLinkBook && (
                  <button
                    role="menuitem"
                    aria-label={`关联 ${item.title} 的有声书`}
                    onClick={() => onLinkBook(item.id)}
                  >
                    <Icon name="library" />
                    {linked ? '管理关联' : '关联有声书'}
                  </button>
                )}
                <div className="menu-divider" />
                <button
                  role="menuitem"
                  disabled={busy}
                  aria-label={`移除电子书 ${item.title}`}
                  onClick={(event) => {
                    removalTrigger.current =
                      event.currentTarget
                        .closest('.popover')
                        ?.querySelector<HTMLButtonElement>(':scope > button') ?? event.currentTarget
                    setRemoveError('')
                    setRemoving(item)
                  }}
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
        label="电子书书架分页"
      />
      {removing && (
        <RemoveBookConfirmation
          book={removing}
          busy={busy}
          error={removeError}
          onConfirm={() => void remove(removing)}
          onCancel={() => {
            setRemoving(null)
            requestAnimationFrame(() => removalTrigger.current?.focus())
          }}
        />
      )}
    </section>
  )
}
