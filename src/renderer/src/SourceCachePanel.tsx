import { useEffect, useState } from 'react'
import type { SourceCacheUsage, SourceCachePreview } from '../../shared/sources'

const size = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`
export function SourceCachePanel() {
  const [usage, setUsage] = useState<SourceCacheUsage | null>(null)
  const [preview, setPreview] = useState<SourceCachePreview | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  useEffect(() => {
    let mounted = true
    const read = () => {
      void window.desktop
        .getSourceCacheState()
        .then((result) => {
          if (!mounted) return
          if (result.ok) setUsage(result.value)
          else setError(result.error.message)
        })
        .catch(() => {
          if (mounted) setError('在线缓存统计未完成。')
        })
    }
    const stop = window.desktop.onSourceChanged(() => {
      if (mounted) {
        setPreview(null)
        read()
      }
    })
    read()
    return () => {
      mounted = false
      stop()
    }
  }, [])
  return (
    <section aria-label="在线音频缓存">
      <h3>在线音频缓存</h3>
      {usage && (
        <p>
          临时缓存 {usage.files} 个文件 · {size(usage.bytes)} / {size(usage.limitBytes)} ·{' '}
          {usage.protectedFiles} 个文件正在使用
        </p>
      )}
      {!!usage?.offlineFiles && (
        <p>
          离线保留 {usage.offlineFiles} 个文件 · {size(usage.offlineBytes ?? 0)}
          （独立于临时缓存配额）
        </p>
      )}
      <p className="tools-hint">
        超出临时配额时清理较久未用的音频；当前集、活动转写和计划离线保留的文件会保留。清理后重听需要联网，文稿、书签和进度仍保留。
      </p>
      {!!usage?.retained && (
        <p className="tools-hint">{usage.retained} 项无法确认归属，保留原文件。</p>
      )}
      <button
        className="secondary-button"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setError('')
          void window.desktop
            .previewSourceCacheClear()
            .then((result) => {
              if (result.ok) setPreview(result.value)
              else setError(result.error.message)
            })
            .catch(() => setError('清理预览未完成。'))
            .finally(() => setBusy(false))
        }}
      >
        预览清理在线音频
      </button>
      {preview && (
        <div className="cache-confirm" role="group" aria-label="确认清理在线音频">
          <p>
            将清理 {preview.clearFiles} 个文件，{size(preview.clearBytes)}；保留正在使用的文件。
          </p>
          <button
            className="secondary-button"
            disabled={busy || !preview.clearFiles}
            onClick={() => {
              setBusy(true)
              setError('')
              void window.desktop
                .clearSourceCache({ token: preview.token })
                .then((result) => {
                  if (result.ok) setUsage(result.value)
                  else setError(result.error.message)
                })
                .catch(() => setError('清理未完成，请重新预览。'))
                .finally(() => {
                  setPreview(null)
                  setBusy(false)
                })
            }}
          >
            确认清理在线音频
          </button>
          <button className="text-button" disabled={busy} onClick={() => setPreview(null)}>
            保留在线音频
          </button>
        </div>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
