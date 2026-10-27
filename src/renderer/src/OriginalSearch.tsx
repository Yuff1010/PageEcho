import { useEffect, useRef, useState } from 'react'
import type { Result } from '../../shared/contracts'
import {
  ORIGINAL_SEARCH_PAGE_SIZE,
  type OriginalSearchPage,
  type OriginalTarget,
} from '../../shared/original'

export function OriginalSearch({
  target,
  originalId,
  disabled,
  locate,
  expanded = false,
}: {
  target: OriginalTarget
  originalId: string
  disabled: boolean
  locate: (first: number, last: number) => void
  expanded?: boolean
}) {
  return (
    <BookTextSearch
      expanded={expanded}
      find={(query, offset) =>
        window.desktop.findOriginal({ ...target, originalId, query, offset })
      }
      disabled={disabled}
      locate={locate}
      hint="兼容繁简体，忽略大小写、空白及标点。定位结果进入自由阅读，播放位置保持不变。"
    />
  )
}

export function BookTextSearch({
  find,
  disabled,
  locate,
  hint,
  expanded = false,
}: {
  find: (query: string, offset: number) => Promise<Result<OriginalSearchPage>>
  disabled: boolean
  locate: (first: number, last: number) => void
  hint: string
  expanded?: boolean
}) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState<OriginalSearchPage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  const details = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  async function search(text: string, offset: number) {
    setBusy(true)
    setError('')
    try {
      const result = await find(text, offset)
      if (!alive.current) return
      if (result.ok) setPage(result.value)
      else setError(result.error.message)
    } catch {
      if (alive.current) setError('原文搜索失败，请重试。')
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  return (
    <details
      className={expanded ? 'original-search search-inline' : 'original-search'}
      ref={details}
      open={expanded || undefined}
    >
      {!expanded && <summary>搜索整本原文</summary>}
      <form
        className="reading-settings"
        onSubmit={(event) => {
          event.preventDefault()
          void search(query, 0)
        }}
      >
        <label>
          搜索文字{' '}
          <input
            aria-label="全文搜索文字"
            maxLength={100}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          className="secondary-button"
          type="submit"
          disabled={busy || disabled || query.trim().length < 2}
        >
          {busy ? '正在搜索…' : '搜索原文'}
        </button>
        {busy && (
          <button
            className="secondary-button"
            type="button"
            onClick={() => void window.desktop.cancelOriginal()}
          >
            取消搜索
          </button>
        )}
      </form>
      <p className="original-hint">{hint}</p>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {page && (
        <>
          <p role="status">
            “{page.query}”共 {page.total} 处结果
            {page.total
              ? ` · 第 ${Math.floor(page.offset / ORIGINAL_SEARCH_PAGE_SIZE) + 1} / ${Math.ceil(page.total / ORIGINAL_SEARCH_PAGE_SIZE)} 页`
              : ''}
          </p>
          <ol className="original-search-results" aria-label="全文搜索结果" start={page.offset + 1}>
            {page.results.map((result) => (
              <li key={`${result.first}:${result.last}`}>
                <button
                  className="original-text"
                  onClick={() => {
                    locate(result.first, result.last)
                    if (details.current && !expanded) details.current.open = false
                  }}
                >
                  <span>
                    {result.chapter} · 第 {result.first + 1}
                    {result.last !== result.first ? `–${result.last + 1}` : ''} 句
                  </span>
                  <span>{result.excerpt}</span>
                </button>
              </li>
            ))}
          </ol>
          <div className="reading-settings">
            <button
              className="secondary-button"
              disabled={busy || disabled || page.offset === 0}
              onClick={() =>
                void search(page.query, Math.max(0, page.offset - ORIGINAL_SEARCH_PAGE_SIZE))
              }
            >
              搜索上一页
            </button>
            <button
              className="secondary-button"
              disabled={busy || disabled || page.offset + ORIGINAL_SEARCH_PAGE_SIZE >= page.total}
              onClick={() => void search(page.query, page.offset + ORIGINAL_SEARCH_PAGE_SIZE)}
            >
              搜索下一页
            </button>
          </div>
        </>
      )}
    </details>
  )
}
