import { useEffect, useRef, useState } from 'react'
import type { Book, Result } from '../../shared/contracts'
import {
  MAX_REPLACEMENT_EPISODES,
  REPLACEMENT_PAGE_SIZE,
  isTranscriptReplacementLiteral,
  type TranscriptEditTarget,
  type TranscriptEditResult,
  type TranscriptReplacementPreview,
} from '../../shared/transcript-editing'

export type TranscriptEditorAction = <T>(
  label: string,
  action: () => Promise<Result<T>>,
  accept?: (value: T) => void,
) => Promise<T | undefined>

export function TranscriptReplacementEditor({
  target,
  book,
  locked,
  execute,
  saved,
  bookLoading = false,
  bookError = '',
  retryBook,
}: {
  target: TranscriptEditTarget
  book: Book | undefined
  locked: boolean
  execute: TranscriptEditorAction
  saved: (result: TranscriptEditResult) => void
  bookLoading?: boolean
  bookError?: string
  retryBook?: () => void
}) {
  const [scope, setScope] = useState<'episode' | 'book'>('episode'),
    [find, setFind] = useState(''),
    [replacement, setReplacement] = useState(''),
    [selected, setSelected] = useState(new Set([target.episodeId])),
    [page, setPage] = useState(0),
    [preview, setPreview] = useState<TranscriptReplacementPreview | null>(null),
    [error, setError] = useState(''),
    [canceling, setCanceling] = useState(false),
    [previewPending, setPreviewPending] = useState(false)
  const mounted = useRef(false),
    serial = useRef(Symbol()),
    request = useRef<string | null>(null),
    current = useRef<TranscriptReplacementPreview | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      serial.current = Symbol()
      const id = request.current
      request.current = null
      if (id) void window.desktop.cancelTranscriptReplacement({ requestId: id }).catch(() => {})
    }
  }, [])
  function adopt(value: TranscriptReplacementPreview | null) {
    current.current = value
    setPreview(value)
  }
  function invalidate() {
    serial.current = Symbol()
    adopt(null)
    setError('')
    const id = request.current
    request.current = null
    if (id) void window.desktop.cancelTranscriptReplacement({ requestId: id }).catch(() => {})
  }
  async function cancel() {
    const id = request.current
    serial.current = Symbol()
    request.current = null
    adopt(null)
    if (!id) return
    setCanceling(true)
    try {
      const result = await window.desktop.cancelTranscriptReplacement({ requestId: id })
      if (mounted.current && !result.ok) setError(result.error.message)
    } catch {
      if (mounted.current) setError('取消替换预览未完成，请重试。')
    } finally {
      if (mounted.current) {
        setCanceling(false)
        setPreviewPending(false)
      }
    }
  }
  async function prepare() {
    if (locked || canceling) return
    invalidate()
    if (!isTranscriptReplacementLiteral(find) || !isTranscriptReplacementLiteral(replacement)) {
      setError('查找和替换文字各需 1–100 个 Unicode 字符，不能含控制字符或不完整字符。')
      return
    }
    if (scope === 'book' && (!book || !selected.size || selected.size > MAX_REPLACEMENT_EPISODES)) {
      setError(`请选择 1–${MAX_REPLACEMENT_EPISODES} 集。`)
      return
    }
    const id = crypto.randomUUID(),
      sequence = Symbol()
    request.current = id
    serial.current = sequence
    setPreviewPending(true)
    await execute(
      '正在预览名称替换…',
      () =>
        window.desktop.previewTranscriptReplacement({
          ...target,
          requestId: id,
          find,
          replacement,
          scope:
            scope === 'episode'
              ? { kind: 'episode' }
              : { kind: 'book', bookId: book!.id, episodeIds: [...selected] },
        }),
      (value) => {
        if (mounted.current && serial.current === sequence) adopt(value)
      },
    )
    if (mounted.current && serial.current === sequence) setPreviewPending(false)
  }
  async function previewPage(page: number) {
    const before = current.current
    if (!before) return
    const sequence = Symbol()
    serial.current = sequence
    await execute(
      '正在读取替换预览…',
      () => window.desktop.getTranscriptReplacementPreview({ token: before.token, page }),
      (value) => {
        if (
          mounted.current &&
          serial.current === sequence &&
          current.current?.token === before.token
        )
          adopt(value)
      },
    )
  }
  const pageEpisodes = book?.episodes.slice(page * 100, (page + 1) * 100) ?? []
  return (
    <section aria-label="名称批量纠错">
      <h3>查找与替换（专名纠错）</h3>
      <p className="tools-hint">
        按每句原文字面匹配，不跨句、不自动转换繁简体。先预览全部计数，再明确应用；时间与句子 ID
        保留。
      </p>
      {bookLoading && <p role="status">正在读取完整目录，整书纠错就绪后可选。</p>}
      {bookError && (
        <p className="error-message" role="alert">
          {bookError}
          {retryBook && (
            <button className="text-button" onClick={retryBook}>
              重试读取目录
            </button>
          )}
        </p>
      )}
      <fieldset disabled={locked || canceling}>
        <div className="tools-form">
          <label>
            范围
            <select
              aria-label="名称替换范围"
              value={scope}
              onChange={(event) => {
                invalidate()
                setScope(event.target.value as typeof scope)
              }}
            >
              <option value="episode">本集</option>
              <option value="book" disabled={!book}>
                本书勾选集
              </option>
            </select>
          </label>
          <label>
            查找
            <input
              aria-label="查找名称"
              value={find}
              maxLength={200}
              onChange={(event) => {
                invalidate()
                setFind(event.target.value)
              }}
            />
          </label>
          <label>
            替换为
            <input
              aria-label="替换名称"
              value={replacement}
              maxLength={200}
              onChange={(event) => {
                invalidate()
                setReplacement(event.target.value)
              }}
            />
          </label>
        </div>
        {scope === 'book' && book && (
          <div>
            <p>
              已勾选 {selected.size} / {book.episodes.length} 集，每次最多{' '}
              {MAX_REPLACEMENT_EPISODES.toLocaleString()} 集。
            </p>
            {book.online && !book.online.catalogComplete && (
              <p className="tools-hint">
                当前只列出已保存的在线目录；未载入的分集不在本次范围，可先补全离线准备目录。
              </p>
            )}
            <div className="tools-form">
              <button
                className="text-button"
                disabled={book.episodes.length > MAX_REPLACEMENT_EPISODES}
                onClick={() => {
                  invalidate()
                  setSelected(new Set(book.episodes.map((episode) => episode.id)))
                }}
              >
                勾选本书全部已保存分集
              </button>
              <button
                className="text-button"
                onClick={() => {
                  invalidate()
                  setSelected(new Set())
                }}
              >
                清空分集勾选
              </button>
            </div>
            <ul className="transcript-edit-book-choices">
              {pageEpisodes.map((episode, index) => (
                <li key={episode.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(episode.id)}
                      disabled={
                        !selected.has(episode.id) && selected.size >= MAX_REPLACEMENT_EPISODES
                      }
                      onChange={(event) => {
                        invalidate()
                        setSelected((before) => {
                          const next = new Set(before)
                          if (event.target.checked) next.add(episode.id)
                          else next.delete(episode.id)
                          return next
                        })
                      }}
                    />
                    第 {page * 100 + index + 1} 集 · {episode.title}
                  </label>
                </li>
              ))}
            </ul>
            {book.episodes.length > 100 && (
              <nav className="tools-form" aria-label="名称纠错分集分页">
                <button className="text-button" disabled={!page} onClick={() => setPage(page - 1)}>
                  上一页分集
                </button>
                <span>
                  {page + 1} / {Math.ceil(book.episodes.length / 100)}
                </span>
                <button
                  className="text-button"
                  disabled={(page + 1) * 100 >= book.episodes.length}
                  onClick={() => setPage(page + 1)}
                >
                  下一页分集
                </button>
              </nav>
            )}
          </div>
        )}
        <p className="tools-hint">
          无正式稿、未知或过期音频版本将跳过并计数。单次扫描上限 64 MiB、修改差量 2
          MiB，超限请分批；本次不会改小说原文或人工听审参考。
        </p>
        <button
          className="secondary-button"
          disabled={!find.trim() || !replacement.trim()}
          onClick={() => void prepare()}
        >
          预览名称替换
        </button>
      </fieldset>
      {previewPending && locked && (
        <button className="text-button" disabled={canceling} onClick={() => void cancel()}>
          {canceling ? '正在取消预览…' : '取消名称预览'}
        </button>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {preview && (
        <section className="transcript-edit-preview" aria-label="名称替换预览">
          <h4>
            预览 {preview.occurrences} 处替换 · {preview.segments} 句 · {preview.episodes} 集
          </h4>
          <p>
            跳过 {preview.skippedEpisodes} 集。每页最多 {REPLACEMENT_PAGE_SIZE}{' '}
            个改句样例；应用会处理本次范围内全部 {preview.occurrences} 处。
          </p>
          <ol className="transcript-replacement-changes">
            {preview.changes.map((change) => (
              <li key={`${change.episodeId}:${change.segmentId}`}>
                <strong>
                  {change.episodeTitle} · {change.occurrences} 处
                </strong>
                <details>
                  <summary>
                    {change.before.slice(0, 120)} → {change.after.slice(0, 120)}
                  </summary>
                  <p>修改前：{change.before}</p>
                  <p>修改后：{change.after}</p>
                </details>
              </li>
            ))}
          </ol>
          {preview.pages > 1 && (
            <nav className="tools-form" aria-label="名称替换预览分页">
              <button
                className="text-button"
                disabled={locked || !preview.page}
                onClick={() => void previewPage(preview.page - 1)}
              >
                上一页样例
              </button>
              <span>
                {preview.page + 1} / {preview.pages}
              </span>
              <button
                className="text-button"
                disabled={locked || preview.page + 1 >= preview.pages}
                onClick={() => void previewPage(preview.page + 1)}
              >
                下一页样例
              </button>
            </nav>
          )}
          <button
            className="primary-button"
            disabled={locked || !preview.occurrences}
            onClick={() => {
              if (preview.expiresAt <= Date.now()) {
                invalidate()
                setError('替换预览已过期，请重新预览。')
                return
              }
              void execute(
                '正在应用名称替换…',
                () =>
                  window.desktop.applyTranscriptReplacement({
                    token: preview.token,
                    commandId: crypto.randomUUID(),
                  }),
                (result) => {
                  adopt(null)
                  saved(result)
                },
              )
            }}
          >
            应用全部名称替换
          </button>
        </section>
      )}
    </section>
  )
}
