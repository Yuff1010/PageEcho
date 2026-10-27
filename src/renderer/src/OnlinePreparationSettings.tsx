import { useEffect, useState } from 'react'
import type { AppState, Book } from '../../shared/contracts'
import type { SourcePreparationStatus } from '../../shared/sources'
import './settings-disclosure.css'

export function OnlinePreparationSettings({
  book,
  onUpdated,
}: {
  book: Book
  onUpdated: (state: AppState) => void
}) {
  const [settings, setSettings] = useState(book.online!.preparation)
  const [status, setStatus] = useState<SourcePreparationStatus | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  useEffect(() => {
    let mounted = true
    const read = () => {
      void window.desktop.getSourcePreparationState().then((result) => {
        if (mounted && result.ok) setStatus(result.value)
      })
    }
    const stop = window.desktop.onSourceChanged(read)
    read()
    return () => {
      mounted = false
      stop()
    }
  }, [])
  return (
    <section className="settings-select-scope" aria-label="在线预处理">
      <h3>
        在线音频缓存
        <span className="settings-section-status">
          {settings.cacheNext ? '自动缓存已开启' : '自动缓存已关闭'}
        </span>
      </h3>
      <form
        className="source-preparation-form"
        onSubmit={(event) => {
          event.preventDefault()
          setBusy(true)
          setError('')
          setNotice('')
          void window.desktop
            .setSourcePreparation({ id: book.id, settings })
            .then((result) => {
              if (result.ok) {
                onUpdated(result.value)
                setNotice('预处理设置已保存。')
              } else setError(result.error.message)
            })
            .catch(() => setError('设置未保存，请重试。'))
            .finally(() => setBusy(false))
        }}
      >
        <label>
          <input
            type="checkbox"
            checked={settings.cacheNext}
            onChange={(event) => setSettings({ ...settings, cacheNext: event.target.checked })}
          />
          自动缓存下一集
        </label>
        <button className="secondary-button" disabled={busy} type="submit">
          保存预处理设置
        </button>
      </form>
      <p className="tools-hint">
        字幕方案、引擎与下一集字幕统一在上方“字幕与伴读”中设置。这里仅控制在线音频缓存。
      </p>
      {status?.episodeId && book.episodes.some((e) => e.id === status.episodeId) && (
        <p role="status">{status.message}</p>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
