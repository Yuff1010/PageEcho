import { useState } from 'react'
import type { SubtitleFormat, SubtitleSource } from '../../shared/subtitles'
import { Tooltip } from './Tooltip'
import { Icon } from './Icons'

export function SubtitleExport({
  source,
  disabled = false,
  compact = false,
  iconOnly = false,
}: {
  source: SubtitleSource
  disabled?: boolean
  compact?: boolean
  iconOnly?: boolean
}) {
  const [format, setFormat] = useState<SubtitleFormat>('srt')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const label = source.source === 'original' ? '原文' : '文稿'
  async function save() {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await window.desktop.exportSubtitles({ ...source, format })
      if (!result.ok) setError(result.error.message)
      else if (!result.value.canceled)
        setMessage(
          `已导出 ${result.value.cueCount} 条字幕：${result.value.fileName}${result.value.skippedSegments ? `；${result.value.skippedSegments} 段未映射，保持空缺` : ''}`,
        )
    } catch {
      setError('字幕导出失败，请重试。')
    } finally {
      setBusy(false)
    }
  }
  const content = (
    <>
      <div className="reading-settings">
        <label>
          字幕格式{' '}
          <select
            aria-label={`${label}字幕格式`}
            value={format}
            disabled={busy}
            onChange={(event) => setFormat(event.target.value as SubtitleFormat)}
          >
            <option value="srt">SRT</option>
            <option value="vtt">WebVTT</option>
          </select>
        </label>
        <button
          className="secondary-button"
          disabled={disabled || busy}
          onClick={() => void save()}
        >
          {busy ? '正在保存字幕…' : `导出${label}字幕`}
        </button>
      </div>
      {source.source === 'original' && (
        <p className="original-hint">仅导出已映射原文，保留现有同步范围；未匹配的声音留空。</p>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
    </>
  )
  return compact ? (
    <details
      className="subtitle-export subtitle-export-menu"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && event.currentTarget.open) {
          event.preventDefault()
          event.stopPropagation()
          event.currentTarget.open = false
          event.currentTarget.querySelector('summary')?.focus()
        }
      }}
    >
      {iconOnly ? (
        <Tooltip content="字幕导出" disabled={expanded}>
          <summary className="reader-icon-button" aria-label="字幕导出" aria-expanded={expanded}>
            <Icon name="download" />
          </summary>
        </Tooltip>
      ) : (
        <summary className="secondary-button">字幕导出</summary>
      )}
      <div className="subtitle-export-options">{content}</div>
    </details>
  ) : (
    <div className="subtitle-export">{content}</div>
  )
}
