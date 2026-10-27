import { useEffect, useRef, useState } from 'react'
import type { AppState, Result } from '../../shared/contracts'
import type { SourceBook, SourceBookDetail, SourcePage } from '../../shared/sources'
import { player } from './player'

function appendBooks(previous: SourceBook[], next: SourceBook[]) {
  return [...new Map([...previous, ...next].map((book) => [book.id, book])).values()]
}

export function OnlineSourceBrowser({
  state,
  onLibrary,
}: {
  state: AppState | null
  onLibrary: (state: AppState) => void
}) {
  const [query, setQuery] = useState('')
  const [resultsFor, setResultsFor] = useState('')
  const [results, setResults] = useState<SourcePage<SourceBook> | null>(null)
  const [detail, setDetail] = useState<SourceBookDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const active = useRef<string | null>(null)
  const openingEpisode = useRef<string | null>(null)
  useEffect(
    () => () => {
      const id = active.current
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
    const id = crypto.randomUUID()
    active.current = id
    setBusy(true)
    setError('')
    setStatus(message)
    try {
      const result = await action(id)
      if (active.current !== id) return
      if (result.ok) {
        apply(result.value)
        setStatus('')
      } else {
        setError(result.error.message)
        setStatus('')
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
  function cancel() {
    const id = active.current
    active.current = null
    setBusy(false)
    setStatus('已取消读取，可以重新搜索或打开书籍。')
    if (id) void window.desktop.cancelSourceRequest({ id }).catch(() => undefined)
    if (openingEpisode.current) void player.stop()
  }
  function search() {
    const text = query.trim()
    if (!text) return
    void run(
      `正在搜索「${text}」…`,
      (id) => window.desktop.searchSource({ id, sourceId: 'ting13', query: text, cursor: null }),
      (value) => {
        setDetail(null)
        setResultsFor(text)
        setResults(value)
      },
    )
  }
  function moreSearch() {
    if (!results?.nextCursor) return
    const cursor = results.nextCursor
    void run(
      '正在读取更多搜索结果…',
      (id) => window.desktop.searchSource({ id, sourceId: 'ting13', query: resultsFor, cursor }),
      (value) => {
        setResults((current) => ({
          ...value,
          items: appendBooks(current?.items ?? [], value.items),
        }))
      },
    )
  }
  function open(book: SourceBook) {
    void run(
      `正在读取《${book.title}》的详情与目录…`,
      (id) => window.desktop.getSourceBook({ id, sourceId: 'ting13', bookId: book.id }),
      setDetail,
    )
  }
  function moreEpisodes() {
    if (!detail?.episodes.nextCursor) return
    const cursor = detail.episodes.nextCursor,
      bookId = detail.book.id
    void run(
      '正在读取后续分集…',
      (id) => window.desktop.getSourceEpisodes({ id, sourceId: 'ting13', bookId, cursor }),
      (value) => {
        setDetail((current) =>
          current?.book.id === bookId
            ? {
                ...current,
                episodes: {
                  ...value,
                  items: [
                    ...new Map(
                      [...current.episodes.items, ...value.items].map((episode) => [
                        episode.id,
                        episode,
                      ]),
                    ).values(),
                  ],
                },
              }
            : current,
        )
      },
    )
  }
  function add(episodeId?: string) {
    if (!detail) return
    const bookId = detail.book.id
    void run(
      episodeId ? '正在缓存本集，完成后开始播放…' : '正在保存书籍与已读取目录…',
      async (id) => {
        const result = await window.desktop.addSourceBook({ id, sourceId: 'ting13', bookId })
        if (!result.ok) return result
        onLibrary(result.value)
        if (episodeId) {
          const episode = result.value.books
            .find((book) => book.online?.bookId === bookId)
            ?.episodes.find((episode) => episode.online?.episodeId === episodeId)
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
      onLibrary,
    )
  }
  const added = !!state?.books.some((book) => book.online?.bookId === detail?.book.id)
  return (
    <section className="online-source" aria-label="在线书源">
      <div className="section-heading">
        <div>
          <h2>13 听书网</h2>
          <p>搜索书名、演播或作者，查看书籍与分集。</p>
        </div>
      </div>
      <form
        className="source-search"
        onSubmit={(event) => {
          event.preventDefault()
          search()
        }}
      >
        <label htmlFor="source-query">搜索书籍</label>
        <input
          id="source-query"
          type="search"
          value={query}
          maxLength={20}
          placeholder="输入书名、演播或作者"
          onChange={(event) => setQuery(event.target.value)}
        />
        <button className="primary-button" type="submit" disabled={!query.trim()}>
          搜索
        </button>
        {busy && (
          <button className="secondary-button" type="button" onClick={cancel}>
            取消读取
          </button>
        )}
      </form>
      <p role="status" className="source-status">
        {status}
      </p>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {detail ? (
        <div className="source-detail">
          <button
            className="text-button"
            onClick={() => {
              cancel()
              setDetail(null)
              setStatus('')
            }}
          >
            返回搜索结果
          </button>
          <h2>{detail.book.title}</h2>
          <p className="source-credit">
            作者：{detail.book.authors.join('、') || '未提供'} · 演播：
            {detail.book.narrators.join('、') || '未提供'}
          </p>
          <p className="source-description">{detail.book.description}</p>
          <button className="primary-button" disabled={busy} onClick={() => add()}>
            {added ? '更新书架目录' : '加入书架'}
          </button>
          <p className="source-status">
            点击分集后先缓存本集，再开始播放。已缓存的音频可离线续听。
          </p>
          <div className="section-heading">
            <h3>播放目录</h3>
            <span>
              已读取 {detail.episodes.items.length} 集
              {detail.episodes.nextCursor ? ' · 还有后续分集' : ''}
            </span>
          </div>
          <ol className="source-episodes">
            {detail.episodes.items.map((episode) => (
              <li key={episode.id}>
                <span className="episode-number">{episode.order}</span>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => add(episode.id)}
                  aria-label={`缓存并播放 ${episode.title}`}
                >
                  {episode.title}
                </button>
              </li>
            ))}
          </ol>
          {detail.episodes.nextCursor && (
            <button className="secondary-button" disabled={busy} onClick={moreEpisodes}>
              加载更多分集
            </button>
          )}
        </div>
      ) : results ? (
        <div className="source-results">
          <h3>「{resultsFor}」的搜索结果</h3>
          {results.items.length ? (
            <ul className="source-book-grid">
              {results.items.map((book) => (
                <li key={book.id}>
                  <h3>{book.title}</h3>
                  <p className="source-credit">演播：{book.narrators.join('、') || '未提供'}</p>
                  {!!book.authors.length && (
                    <p className="source-credit">作者：{book.authors.join('、')}</p>
                  )}
                  <p className="source-description">{book.description}</p>
                  <button
                    className="secondary-button"
                    aria-label={`查看 ${book.title} 的详情`}
                    onClick={() => open(book)}
                  >
                    查看目录
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="source-status">没有找到相关书籍，请换一个书名、演播或作者。</p>
          )}
          {results.nextCursor && (
            <button className="secondary-button" disabled={busy} onClick={moreSearch}>
              加载更多搜索结果
            </button>
          )}
        </div>
      ) : (
        !busy && <p className="source-status">从书名开始寻找下一段故事。</p>
      )}
    </section>
  )
}
