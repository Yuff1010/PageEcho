import { useEffect, useId, useRef, useState } from 'react'
import type { AppState, Result } from '../../shared/contracts'
import {
  type SourceBook,
  type SourceBookDetail,
  type SourceId,
  type SourcePage,
} from '../../shared/sources'
import type { AudioSourceInfo } from '../../shared/plugins'
import { Icon } from './Icons'
import { player } from './player'
import { SourceCenterAction, SourceCenterEmpty } from './SourceCenterUI'
import { SourceCenterText } from './SourceCenterText'
import { SourcePluginManager } from './SourcePluginManager'
import { SourceBookImage, SourceBookResult } from './SourceBookResult'
import { recentSourceView, useSourceSession } from './source-session'
import { ALL_SOURCES, aggregateSearch, type AggregateProgress } from './aggregate-search'
import { HelpTip } from './HelpTip'
import './source-center.css'

const categories = [
  { id: 'audio', label: '有声书', icon: 'headphones' },
  { id: 'text', label: '电子书', icon: 'book' },
  { id: 'personal', label: '我的书库', icon: 'folder' },
  { id: 'plugins', label: '插件', icon: 'plugin' },
] as const

type Category = (typeof categories)[number]['id']
interface AudioView {
  query: string
  resultsFor: string
  results: SourcePage<SourceBook> | null
  detail: SourceBookDetail | null
  aggregate?: AggregateProgress<SourceBook>
}
const emptyView = (): AudioView => ({ query: '', resultsFor: '', results: null, detail: null })
const bookKey = (book: SourceBook) => `${book.sourceId}:${book.id}`
function appendBooks(previous: SourceBook[], next: SourceBook[]) {
  return [...new Map([...previous, ...next].map((book) => [bookKey(book), book])).values()]
}

export function OnlineSourceBrowser({
  state,
  onLibrary,
  onReadBook,
}: {
  state: AppState | null
  onLibrary: (state: AppState) => void
  onReadBook?: (id: string) => void
}) {
  const [category, setCategory] = useSourceSession<Category>('sources.category', 'audio')
  const prefix = useId()
  return (
    <section className="online-source source-center" aria-label="来源中心">
      <div
        className="source-center-tabs"
        role="tablist"
        aria-label="来源分类"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const index = categories.findIndex((item) => item.id === category)
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? categories.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + categories.length) %
                  categories.length
          setCategory(categories[next]!.id)
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
        }}
      >
        {categories.map((item) => (
          <SourceCenterAction
            key={item.id}
            label={item.label}
            icon={item.icon}
            role="tab"
            id={`${prefix}-${item.id}`}
            aria-selected={category === item.id}
            aria-controls={`${prefix}-panel`}
            tabIndex={category === item.id ? 0 : -1}
            onClick={() => setCategory(item.id)}
          />
        ))}
      </div>
      <div role="tabpanel" id={`${prefix}-panel`} aria-labelledby={`${prefix}-${category}`}>
        {category === 'audio' ? (
          <AudioSourcePanel state={state} onLibrary={onLibrary} />
        ) : category === 'plugins' ? (
          <SourcePluginManager />
        ) : (
          <SourceCenterText
            key={category}
            personal={category === 'personal'}
            onReadBook={onReadBook}
          />
        )}
      </div>
    </section>
  )
}

function AudioSourcePanel({
  state,
  onLibrary,
}: {
  state: AppState | null
  onLibrary: (state: AppState) => void
}) {
  const [sourceId, setSourceId] = useSourceSession<SourceId | typeof ALL_SOURCES>(
    'sources.audio.selected',
    'ting13',
  )
  const [sourceCatalog, setSourceCatalog] = useState<AudioSourceInfo[]>([])
  const [views, setViews] = useSourceSession<Record<string, AudioView>>('sources.audio.views', {})
  const view = views[sourceId] ?? emptyView()
  const { query, resultsFor, results, detail } = view
  const update = (patch: Partial<AudioView>) =>
    setViews((current) =>
      recentSourceView(current, sourceId, { ...(current[sourceId] ?? emptyView()), ...patch }),
    )
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const active = useRef<string | null>(null)
  const openingEpisode = useRef<string | null>(null)
  const retry = useRef<(() => void) | null>(null)
  const aggregated = useRef<AbortController | null>(null)
  useEffect(() => {
    let live = true
    void window.desktop
      .pluginSourceCatalog()
      .then((result) => {
        if (!live) return
        if (result.ok) {
          setSourceCatalog(result.value)
          setSourceId((current) =>
            current === ALL_SOURCES || result.value.some((source) => source.id === current)
              ? current
              : (result.value[0]?.id ?? 'ting13'),
          )
        } else setError(result.error.message)
      })
      .catch(() => {
        if (live) setError('无法读取有声书来源，请重新进入来源中心。')
      })
    return () => {
      live = false
    }
  }, [setSourceId])
  useEffect(
    () => () => {
      const id = active.current
      aggregated.current?.abort()
      aggregated.current = null
      active.current = null
      if (id) void window.desktop.cancelSourceRequest({ id }).catch(() => undefined)
    },
    [],
  )

  async function run<T>(
    message: string,
    action: (id: string) => Promise<Result<T>>,
    apply: (value: T) => void,
  ) {
    const previous = active.current
    if (previous) void window.desktop.cancelSourceRequest({ id: previous }).catch(() => undefined)
    const id = crypto.randomUUID()
    active.current = id
    setBusy(true)
    setError('')
    setStatus(message)
    try {
      const result = await action(id)
      if (active.current !== id) return
      setStatus('')
      if (result.ok) {
        apply(result.value)
      } else {
        setError(result.error.message)
      }
    } catch {
      if (active.current === id) {
        setError('书源请求未完成，请检查网络后重试。')
        setStatus('')
      }
    } finally {
      if (active.current === id) {
        active.current = null
        setBusy(false)
      }
    }
  }
  function cancel(showMessage = true) {
    aggregated.current?.abort()
    aggregated.current = null
    const id = active.current
    active.current = null
    setBusy(false)
    setStatus(showMessage ? '已取消读取。' : '')
    if (id) void window.desktop.cancelSourceRequest({ id }).catch(() => undefined)
    if (openingEpisode.current) void player.stop()
  }
  function search() {
    const text = query.trim()
    if (!text) return
    retry.current = search
    if (sourceId === ALL_SOURCES) {
      cancel(false)
      const controller = new AbortController()
      aggregated.current = controller
      setBusy(true)
      update({ detail: null, resultsFor: text, results: { items: [], nextCursor: null } })
      void aggregateSearch({
        sources: sourceCatalog,
        signal: controller.signal,
        key: bookKey,
        request: async (id, requestId) => {
          const result = await window.desktop.searchSource({
            id: requestId,
            sourceId: id as SourceId,
            query: text,
            cursor: null,
          })
          return result.ok ? { ok: true as const, value: result.value.items } : result
        },
        cancel: (id) => window.desktop.cancelSourceRequest({ id }),
        onProgress: (progress) => {
          if (aggregated.current !== controller) return
          update({ results: { items: progress.items, nextCursor: null }, aggregate: progress })
          setStatus(`已检索 ${progress.completed} / ${progress.total} 个来源`)
        },
      }).finally(() => {
        if (aggregated.current === controller) {
          aggregated.current = null
          setBusy(false)
          setStatus('')
        }
      })
      return
    }
    void run(
      `正在搜索「${text}」…`,
      (id) => window.desktop.searchSource({ id, sourceId, query: text, cursor: null }),
      (value) => update({ detail: null, resultsFor: text, results: value }),
    )
  }
  function moreSearch() {
    if (sourceId === ALL_SOURCES) return
    if (!results?.nextCursor) return
    const cursor = results.nextCursor
    retry.current = moreSearch
    void run(
      '正在读取更多搜索结果…',
      (id) => window.desktop.searchSource({ id, sourceId, query: resultsFor, cursor }),
      (value) => update({ results: { ...value, items: appendBooks(results.items, value.items) } }),
    )
  }
  function open(book: SourceBook) {
    if (aggregated.current) cancel(false)
    retry.current = () => open(book)
    void run(
      `正在读取《${book.title}》的详情与目录…`,
      (id) => window.desktop.getSourceBook({ id, sourceId: book.sourceId, bookId: book.id }),
      (value) => update({ detail: value }),
    )
  }
  function moreEpisodes() {
    if (!detail?.episodes.nextCursor) return
    const cursor = detail.episodes.nextCursor
    const book = detail.book
    retry.current = moreEpisodes
    void run(
      '正在读取后续分集…',
      (id) =>
        window.desktop.getSourceEpisodes({ id, sourceId: book.sourceId, bookId: book.id, cursor }),
      (value) =>
        update({
          detail: {
            ...detail,
            episodes: {
              ...value,
              items: [
                ...new Map(
                  [...detail.episodes.items, ...value.items].map((episode) => [
                    `${episode.sourceId}:${episode.bookId}:${episode.id}`,
                    episode,
                  ]),
                ).values(),
              ],
            },
          },
        }),
    )
  }
  function add(episodeId?: string) {
    if (!detail) return
    const book = detail.book
    retry.current = () => add(episodeId)
    void run(
      episodeId ? '正在缓存本集，完成后开始播放…' : '正在保存书籍与已读取目录…',
      async (id) => {
        const result = await window.desktop.addSourceBook({
          id,
          sourceId: book.sourceId,
          bookId: book.id,
        })
        if (!result.ok) return result
        onLibrary(result.value)
        if (episodeId && active.current === id) {
          const episode = result.value.books
            .find(
              (item) => item.online?.sourceId === book.sourceId && item.online.bookId === book.id,
            )
            ?.episodes.find(
              (item) =>
                item.online?.sourceId === book.sourceId && item.online.episodeId === episodeId,
            )
          if (!episode)
            return {
              ok: false as const,
              error: {
                code: 'SOURCE_CHANGED' as const,
                message: '该集尚未加入书架，请重新读取目录。',
              },
            }
          openingEpisode.current = episode.id
          try {
            await player.load(episode.id)
          } finally {
            openingEpisode.current = null
          }
          return window.desktop.getState()
        }
        return result
      },
      (value) => {
        onLibrary(value)
        setStatus(episodeId ? '' : '已保存到有声书架。')
      },
    )
  }
  const added =
    !!detail &&
    !!state?.books.some(
      (book) =>
        book.online?.sourceId === detail.book.sourceId && book.online.bookId === detail.book.id,
    )
  const source = sourceCatalog.find((item) => item.id === sourceId)
  return (
    <div className="source-center-panel" aria-busy={busy}>
      <form
        className="source-center-search"
        onSubmit={(event) => {
          event.preventDefault()
          search()
        }}
      >
        <select
          aria-label="有声书来源"
          value={sourceId}
          onChange={(event) => {
            cancel(false)
            setError('')
            retry.current = null
            setSourceId(event.target.value as SourceId | typeof ALL_SOURCES)
          }}
        >
          {sourceCatalog.length > 1 && <option value={ALL_SOURCES}>全部来源</option>}
          {sourceCatalog.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <input
          aria-label="搜索书籍"
          type="search"
          value={query}
          maxLength={source?.maxQueryLength ?? 200}
          placeholder="书名、演播或作者"
          onChange={(event) => update({ query: event.target.value })}
        />
        <SourceCenterAction
          label="搜索"
          icon="search"
          type="submit"
          disabled={busy || !query.trim()}
        />
        {busy && <SourceCenterAction label="取消读取" icon="close" onClick={() => cancel()} />}
      </form>
      {sourceId === ALL_SOURCES && view.aggregate && (
        <div className="source-center-aggregate">
          <span>
            {view.aggregate.items.length} 本 · 已检索 {view.aggregate.completed} /{' '}
            {view.aggregate.total} 个来源
          </span>
          <HelpTip label="全部来源搜索">
            同时最多读取三个来源的首批搜索结果，最多显示300本；缩小关键词或选择单个来源可继续翻页。
          </HelpTip>
          {view.aggregate.truncated && <span>结果较多，请缩小关键词。</span>}
          {!!view.aggregate.errors.length && (
            <details>
              <summary>{view.aggregate.errors.length} 个来源未完成</summary>
              {view.aggregate.errors.map((error, i) => (
                <p key={i}>
                  {error.source}：{error.message}
                </p>
              ))}
            </details>
          )}
        </div>
      )}
      {status && (
        <p role="status" className="source-center-status">
          <span className={busy ? 'source-center-spinner' : ''} aria-hidden="true" />
          {status}
        </p>
      )}
      {error && (
        <div className="source-center-error" role="alert">
          <p>{error}</p>
          <SourceCenterAction
            label="重试当前来源"
            icon="refresh"
            onClick={() => retry.current?.()}
          />
        </div>
      )}
      {detail ? (
        <div className="source-detail source-center-detail">
          <div className="source-center-detail-heading">
            <SourceCenterAction
              label="返回搜索结果"
              icon="arrow"
              className="source-center-back"
              onClick={() => {
                cancel(false)
                update({ detail: null })
                setError('')
              }}
            />
            <SourceBookImage
              id={bookKey(detail.book)}
              title={detail.book.title}
              coverUrl={detail.book.coverUrl}
            />
            <div>
              <h2>{detail.book.title}</h2>
              <p className="source-credit">
                {[detail.book.authors.join('、'), detail.book.narrators.join('、')]
                  .filter(Boolean)
                  .join(' · ') || source?.name}
              </p>
            </div>
            <SourceCenterAction
              label={added ? '更新书架目录' : '加入书架'}
              icon={added ? 'check' : 'plus'}
              disabled={busy}
              onClick={() => add()}
            />
          </div>
          {!!detail.book.description && (
            <p className="source-description">{detail.book.description}</p>
          )}
          <div className="source-center-list-heading">
            <h3>播放目录</h3>
            <span>
              已读取 {detail.episodes.items.length} 集{detail.episodes.nextCursor ? ' · 未完' : ''}
            </span>
          </div>
          <ol className="source-episodes">
            {detail.episodes.items.map((episode) => (
              <li key={`${episode.sourceId}:${episode.bookId}:${episode.id}`}>
                <span className="episode-number">{episode.order}</span>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => add(episode.id)}
                  aria-label={`缓存并播放 ${episode.title}`}
                >
                  {episode.title}
                </button>
                <Icon name="play" />
              </li>
            ))}
          </ol>
          {detail.episodes.nextCursor && (
            <button
              className="secondary-button source-center-more"
              disabled={busy}
              onClick={moreEpisodes}
            >
              加载更多分集
            </button>
          )}
        </div>
      ) : results ? (
        <div className="source-results">
          <div className="source-center-list-heading">
            <h3>「{resultsFor}」的搜索结果</h3>
            <span>{source?.name}</span>
          </div>
          {results.items.length ? (
            <ul className="source-book-grid">
              {results.items.map((book) => (
                <SourceBookResult
                  key={bookKey(book)}
                  id={bookKey(book)}
                  title={book.title}
                  coverUrl={book.coverUrl}
                  credit={
                    [
                      book.narrators.join('、'),
                      book.authors.join('、'),
                      sourceId === ALL_SOURCES
                        ? sourceCatalog.find((source) => source.id === book.sourceId)?.name
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || source?.name
                  }
                  description={book.description}
                  label={`查看 ${book.title} 的详情`}
                  disabled={busy && sourceId !== ALL_SOURCES}
                  onOpen={() => open(book)}
                />
              ))}
            </ul>
          ) : (
            <SourceCenterEmpty icon="search">
              没有找到相关书籍，试试其他关键词或来源。
            </SourceCenterEmpty>
          )}
          {results.nextCursor && (
            <button
              className="secondary-button source-center-more"
              disabled={busy}
              onClick={moreSearch}
            >
              加载更多搜索结果
            </button>
          )}
        </div>
      ) : (
        !busy && (
          <SourceCenterEmpty icon="headphones">
            {source?.description || '搜索书名，发现下一段故事。'}
          </SourceCenterEmpty>
        )
      )}
    </div>
  )
}
