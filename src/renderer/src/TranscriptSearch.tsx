import { useEffect, useRef, useState } from 'react'
import type { StoredTranscript } from '../../shared/transcript'
import {
  TRANSCRIPT_SEARCH_PAGE_SIZE,
  type TranscriptSearchHit,
  type TranscriptSearchInput,
  type TranscriptSearchOutput,
  type TranscriptSearchPage,
} from '../../shared/transcript-search'

export function TranscriptSearch({
  stored,
  browse,
  locate,
}: {
  stored: StoredTranscript
  browse: () => void
  locate: (hit: TranscriptSearchHit) => void
}) {
  // The parent keys this component by document ID/revision; each worker sees one snapshot.
  const [segments] = useState(() => stored.document.segments)
  const [started, setStarted] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState<TranscriptSearchPage | null>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const worker = useRef<Worker | null>(null)
  const serial = useRef(0)
  const deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const details = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (!started) return
    let alive = true
    const fail = () => {
      if (!alive) return
      clearTimeout(deadline.current)
      worker.current?.terminate()
      worker.current = null
      setReady(false)
      setBusy(false)
      setError('文稿搜索进程未完成，请重试。')
    }
    let engine: Worker
    try {
      engine = new Worker(new URL('./transcript-search-worker.ts', import.meta.url), {
        type: 'module',
      })
      worker.current = engine
      engine.onmessage = (event: MessageEvent<TranscriptSearchOutput>) => {
        if (!alive) return
        const result = event.data
        if (result.type !== 'ready' && result.id !== undefined && result.id !== serial.current)
          return
        clearTimeout(deadline.current)
        if (result.type === 'ready') setReady(true)
        else if (result.type === 'result') {
          setPage(result.page)
          setBusy(false)
        } else {
          setError(result.error)
          setBusy(false)
        }
      }
      engine.onerror = (event) => {
        event.preventDefault()
        fail()
      }
      deadline.current = setTimeout(fail, 30_000)
      const request: TranscriptSearchInput = { type: 'init', segments }
      engine.postMessage(request)
    } catch {
      queueMicrotask(fail)
    }
    return () => {
      alive = false
      clearTimeout(deadline.current)
      engine?.terminate()
      worker.current = null
    }
  }, [started, attempt, segments])
  function restart(message = '') {
    serial.current++
    worker.current?.terminate()
    clearTimeout(deadline.current)
    setReady(false)
    setBusy(false)
    setPage(null)
    setError('')
    setNotice(message)
    setAttempt((value) => value + 1)
  }
  function search(text: string, offset: number) {
    if (!ready || !worker.current) return
    setBusy(true)
    setError('')
    setNotice('')
    const request: TranscriptSearchInput = {
      type: 'find',
      id: ++serial.current,
      query: text,
      offset,
    }
    deadline.current = setTimeout(() => {
      worker.current?.terminate()
      worker.current = null
      setReady(false)
      setBusy(false)
      setError('文稿搜索超过 30 秒，请重试。')
    }, 30_000)
    worker.current.postMessage(request)
  }
  return (
    <details
      className="transcript-search"
      ref={details}
      onToggle={(event) => {
        if (event.currentTarget.open) {
          setStarted(true)
          browse()
        }
      }}
    >
      <summary>搜索当前集文稿</summary>
      <form
        className="reading-settings"
        onFocusCapture={browse}
        onSubmit={(event) => {
          event.preventDefault()
          search(query, 0)
        }}
      >
        <label>
          搜索文字{' '}
          <input
            aria-label="文稿搜索文字"
            maxLength={100}
            value={query}
            disabled={busy}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          className="secondary-button"
          type="submit"
          disabled={!ready || busy || query.trim().length < 2}
        >
          {busy ? '正在搜索…' : '搜索文稿'}
        </button>
        {busy && (
          <button
            className="text-button"
            type="button"
            onClick={() => restart('搜索已取消，可重新搜索。')}
          >
            取消文稿搜索
          </button>
        )}
        {error && !ready && (
          <button className="secondary-button" type="button" onClick={() => restart()}>
            重试文稿搜索
          </button>
        )}
      </form>
      <p className="original-hint">
        搜索当前显示的整集文稿，可跨相邻片段，忽略大小写、全半角、空白和标点。定位只浏览文字；文稿更新后清空搜索。
      </p>
      {started && !ready && !error && <p role="status">正在准备文稿搜索…</p>}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {page && (
        <>
          <p role="status">
            “{page.query}”共 {page.total} 处结果
            {page.total
              ? ` · 第 ${Math.floor(page.offset / TRANSCRIPT_SEARCH_PAGE_SIZE) + 1} / ${Math.ceil(page.total / TRANSCRIPT_SEARCH_PAGE_SIZE)} 页`
              : ''}
          </p>
          <ol
            className="transcript-search-results"
            aria-label="文稿搜索结果"
            start={page.offset + 1}
          >
            {page.results.map((hit) => (
              <li key={`${hit.first}:${hit.last}`}>
                <button
                  className="original-text"
                  disabled={busy}
                  onClick={() => {
                    locate(hit)
                    if (details.current) details.current.open = false
                  }}
                >
                  <span>
                    第 {hit.first + 1}
                    {hit.last === hit.first ? '' : `–${hit.last + 1}`} 句 ·{' '}
                    {(hit.startMs / 1000).toFixed(3)}–{(hit.endMs / 1000).toFixed(3)} 秒
                  </span>
                  <span>{hit.excerpt}</span>
                </button>
              </li>
            ))}
          </ol>
          <div className="reading-settings">
            <button
              className="secondary-button"
              disabled={busy || !ready || page.offset === 0}
              onClick={() =>
                search(page.query, Math.max(0, page.offset - TRANSCRIPT_SEARCH_PAGE_SIZE))
              }
            >
              文稿搜索上一页
            </button>
            <button
              className="secondary-button"
              disabled={busy || !ready || page.offset + TRANSCRIPT_SEARCH_PAGE_SIZE >= page.total}
              onClick={() => search(page.query, page.offset + TRANSCRIPT_SEARCH_PAGE_SIZE)}
            >
              文稿搜索下一页
            </button>
            <button
              className="secondary-button"
              disabled={busy || !ready || page.offset + TRANSCRIPT_SEARCH_PAGE_SIZE >= page.total}
              onClick={() =>
                search(
                  page.query,
                  Math.floor((page.total - 1) / TRANSCRIPT_SEARCH_PAGE_SIZE) *
                    TRANSCRIPT_SEARCH_PAGE_SIZE,
                )
              }
            >
              文稿搜索末页
            </button>
          </div>
        </>
      )}
    </details>
  )
}
