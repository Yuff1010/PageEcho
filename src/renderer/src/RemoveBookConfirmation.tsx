import { useEffect, useId, useRef } from 'react'
import type { BookSummary, ReadingBookSummary } from '../../shared/library'

export function RemoveBookConfirmation({
  book,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  book: BookSummary | ReadingBookSummary
  busy: boolean
  error: string
  onCancel: () => void
  onConfirm: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const description = useId()
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    cancel.current?.focus()
    return () => element.close()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="listening-dialog"
      aria-label="确认移除书籍"
      aria-describedby={description}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onCancel()
      }}
    >
      <h2>移除《{book.title}》？</h2>
      <div id={description}>
        {'episodeCount' in book ? (
          <p>
            将删除本书 {book.episodeCount} 集的章节记录、收听进度、字幕（含人工修改）、书签、
            片段标注和相关任务记录。此操作暂不支持撤销。
          </p>
        ) : (
          <p>
            将移除本书的书架记录和阅读进度。重新导入后，本书书签与单书阅读设置可能无法恢复。
            正在用于听书伴读的原文仍会保留。此操作暂不支持撤销。
          </p>
        )}
        <p>
          {'episodeCount' in book
            ? '原音频文件仍保留在原位置。'
            : '原 TXT / EPUB 文件仍保留在原位置。'}
        </p>
      </div>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      <div className="import-actions">
        <button ref={cancel} className="secondary-button" disabled={busy} onClick={onCancel}>
          保留这本书
        </button>
        <button className="primary-button" disabled={busy} onClick={onConfirm}>
          {busy ? '正在移除…' : '确认移除记录'}
        </button>
      </div>
    </dialog>
  )
}
