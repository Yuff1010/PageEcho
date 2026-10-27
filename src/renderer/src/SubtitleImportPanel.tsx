import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Result } from '../../shared/contracts'
import type { TranscriptRequest, TranscriptState } from '../../shared/transcript'
import type {
  SubtitleImportEncoding,
  SubtitleImportPreview,
  TimedSubtitleWarning,
} from '../../shared/subtitle-import'
import { useTranscriptAudition } from './transcript-editing-audition'
import { player } from './player'
import './subtitle-import.css'

const ENCODINGS: Record<SubtitleImportEncoding, string> = {
  auto: '自动（UTF-8 / BOM）',
  'utf-8': 'UTF-8',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
  gb18030: 'GB18030（简体中文）',
  big5: 'Big5（繁体中文）',
}
const WARNINGS: Record<string, string> = {
  'overlap-flattened': '重叠字幕已按同时出现的文字分段，原时间边界保留',
  multiline: '多行字幕已保留在同一段文字中',
  'markup-removed': '字幕样式已转换为纯文字，不保留字体与颜色',
  'inline-timestamps-removed': '行内时间已移除，使用整段字幕时间，不生成逐字高亮',
  'notes-ignored': '注释没有作为字幕文字导入',
  'styles-ignored': '样式表没有作为字幕文字导入',
  'regions-ignored': '视频字幕区域布局没有用于伴读排版',
  'settings-ignored': '视频字幕位置和排版设置没有用于伴读排版',
  'unknown-entity-literal': '无法识别的实体已按原文字面保留，请核对',
  'unsupported-markup-literal': '无法识别的标记已按原文字面保留，请核对',
  'srt-dot-timestamp': 'SRT 点号毫秒已按兼容写法读取',
  'srt-index-missing': '部分 SRT 字幕没有编号，已按来源顺序记录',
  'srt-index-nonstandard': '部分 SRT 编号不连续或不标准，已保留来源信息',
  'duplicate-cue-id': '重复的字幕标识已保留为来源信息，不用作伴读句子 ID',
  'srt-order-normalized': 'SRT 字幕已按原时间稳定排序，请核对顺序',
  'empty-cue': '空白字幕未生成伴读句子，源文件仍保留',
  'header-metadata-ignored': '文件头附加信息没有作为字幕文字导入',
  'ruby-annotation-expanded': '注音已保留为括号文字，请核对',
  'encoding-converted': '字幕已按所选编码转换为 Unicode 文字',
  'time-offset': '字幕时间已按所选固定偏移调整',
}
function warningText(warning: TimedSubtitleWarning) {
  return `${WARNINGS[warning.code] ?? '存在格式转换，请核对预览文字'} · ${warning.count} 处${warning.firstLine === null ? '' : `（首见第 ${warning.firstLine} 行）`}`
}
function time(ms: number) {
  const hours = Math.floor(ms / 3_600_000),
    minutes = Math.floor(ms / 60_000) % 60,
    seconds = Math.floor(ms / 1000) % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`
}
function bytes(size: number) {
  return size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KiB`
      : `${(size / 1024 / 1024).toFixed(2)} MiB`
}
async function unwrap<T>(value: Promise<Result<T>>): Promise<T> {
  const result = await value
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
function identity(state: TranscriptState) {
  return state.status === 'ready'
    ? { id: state.transcript.id, revision: state.transcript.revision }
    : { id: null, revision: null }
}

export function SubtitleImportPanel({
  target: input,
  episodeTitle,
  onSaved,
  onClose,
}: {
  target: TranscriptRequest
  episodeTitle: string
  onSaved: () => Promise<void>
  onClose: () => void
}) {
  const target = useMemo(
      () => ({ episodeId: input.episodeId, audioHash: input.audioHash }),
      [input.episodeId, input.audioHash],
    ),
    dialog = useRef<HTMLDialogElement>(null),
    audition = useTranscriptAudition(target),
    auditionStop = useRef(audition.stop)
  const [preview, setPreview] = useState<SubtitleImportPreview | null>(null),
    [encoding, setEncoding] = useState<SubtitleImportEncoding>('auto'),
    [offset, setOffset] = useState('0'),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [stale, setStale] = useState(''),
    [targetCanceled, setTargetCanceled] = useState(false),
    [expired, setExpired] = useState(false)
  const mounted = useRef(false),
    action = useRef<symbol | null>(null),
    read = useRef(Symbol()),
    request = useRef<string | null>(null),
    current = useRef<SubtitleImportPreview | null>(null),
    baseline = useRef<{ id: string | null; revision: number | null } | null>(null),
    session = useRef(player.getSessionId()),
    invalidTarget = useRef(false),
    checkRef = useRef<() => Promise<void>>(async () => {})
  const offsetMs = Number(offset),
    validOffset = !!offset.trim() && Number.isSafeInteger(offsetMs),
    dirty =
      !!preview &&
      (preview.options.encoding !== encoding ||
        !validOffset ||
        preview.options.offsetMs !== offsetMs),
    canApply =
      !!preview &&
      preview.status === 'ready' &&
      !preview.errors.length &&
      !busy &&
      !dirty &&
      !stale &&
      !expired
  useEffect(() => {
    auditionStop.current = audition.stop
  }, [audition.stop])
  function adopt(value: SubtitleImportPreview | null) {
    current.current = value
    setPreview(value)
    setExpired(!!value && value.expiresAt <= Date.now())
  }
  const checkCurrent = useCallback(async () => {
    if (!mounted.current || action.current || invalidTarget.current) return
    const serial = Symbol()
    read.current = serial
    try {
      const value = identity(await unwrap(window.desktop.getTranscript(target)))
      if (!mounted.current || action.current || read.current !== serial || invalidTarget.current)
        return
      const before = baseline.current
      if (!current.current) {
        baseline.current = value
        return
      }
      if (
        before &&
        (before.revision !== value.revision || (before.id !== null && before.id !== value.id))
      ) {
        auditionStop.current()
        setStale('正式文稿已变化，当前预览和选项保留。本次预览不能覆盖新修订，请重新选择字幕文件。')
      } else {
        baseline.current = value
        setStale('')
      }
    } catch (error) {
      if (mounted.current && read.current === serial && !action.current) {
        setError(error instanceof Error ? error.message : '无法核对当前文稿，请重试。')
        setStale('当前文稿版本尚未核对，暂不能导入；预览和选项已保留。')
      }
    }
  }, [target])
  useEffect(() => {
    checkRef.current = checkCurrent
  }, [checkCurrent])
  useEffect(() => {
    mounted.current = true
    const element = dialog.current!
    element.showModal()
    void Promise.resolve().then(checkCurrent)
    let timer: ReturnType<typeof setTimeout> | undefined
    const changed = (value: TranscriptRequest) => {
      if (value.episodeId !== target.episodeId || value.audioHash !== target.audioHash) return
      clearTimeout(timer)
      timer = setTimeout(() => void checkCurrent(), 50)
    }
    const cancelTarget = () => {
      invalidTarget.current = true
      setTargetCanceled(true)
      read.current = Symbol()
      action.current = null
      auditionStop.current()
      setBusy('')
      setStale('收听章节或播放会话已变化，本次导入已取消。请关闭后在当前集重新导入。')
      if (request.current)
        void window.desktop.cancelSubtitleImport({ requestId: request.current }).catch(() => {})
    }
    const stopTranscript = window.desktop.onTranscriptionChanged(changed),
      stopEditing = window.desktop.onTranscriptEditingChanged(changed),
      stopPlayer = player.subscribe(() => {
        const episode = player.getSnapshot().episode
        if (
          !invalidTarget.current &&
          (episode?.id !== target.episodeId ||
            episode.contentHash !== target.audioHash ||
            player.getSessionId() !== session.current)
        )
          cancelTarget()
      }),
      stopFlush = window.desktop.onFlush(cancelTarget)
    return () => {
      mounted.current = false
      action.current = null
      read.current = Symbol()
      clearTimeout(timer)
      stopTranscript()
      stopEditing()
      stopPlayer()
      stopFlush()
      auditionStop.current()
      const id = request.current
      request.current = null
      if (id) void window.desktop.cancelSubtitleImport({ requestId: id }).catch(() => {})
      element.close()
    }
  }, [target, checkCurrent])
  useEffect(() => {
    if (!preview) return
    const timer = setTimeout(() => setExpired(true), Math.max(0, preview.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [preview])
  async function perform<T>(
    label: string,
    work: () => Promise<Result<T>>,
    accept: (value: T) => void,
  ) {
    if (action.current || invalidTarget.current) return
    const serial = Symbol()
    action.current = serial
    read.current = Symbol()
    audition.stop()
    setBusy(label)
    setError('')
    try {
      const value = await unwrap(work())
      if (mounted.current && action.current === serial && !invalidTarget.current) accept(value)
    } catch (error) {
      if (mounted.current && action.current === serial)
        setError(error instanceof Error ? error.message : '字幕导入操作未完成，请重试。')
    } finally {
      if (mounted.current && action.current === serial) {
        action.current = null
        setBusy('')
        void checkRef.current()
      }
    }
  }
  async function choose() {
    if (!validOffset) {
      setError('时间偏移需要原媒体的整数毫秒，可填 0。')
      return
    }
    if (action.current || invalidTarget.current) return
    const old = request.current,
      id = crypto.randomUUID()
    request.current = id
    adopt(null)
    setStale('')
    baseline.current = null
    await perform(
      '正在选择并预览字幕…',
      async () => {
        if (old) await unwrap(window.desktop.cancelSubtitleImport({ requestId: old }))
        if (!mounted.current || invalidTarget.current || request.current !== id)
          throw new Error('本次字幕选择已取消。')
        const before = identity(await unwrap(window.desktop.getTranscript(target)))
        if (!mounted.current || invalidTarget.current || request.current !== id)
          throw new Error('本次字幕选择已取消。')
        baseline.current = before
        return window.desktop.previewSubtitleImport({
          ...target,
          requestId: id,
          encoding,
          offsetMs,
        })
      },
      (value) => {
        if (value.canceled) {
          request.current = null
          return
        }
        const valuePreview = value.preview
        if (baseline.current?.revision !== valuePreview.previousRevision)
          baseline.current = { id: null, revision: valuePreview.previousRevision }
        adopt(valuePreview)
      },
    )
  }
  async function update() {
    const before = current.current
    if (!before || !validOffset) {
      setError('时间偏移需要原媒体的整数毫秒，可填 0。')
      return
    }
    await perform(
      '正在重新预览字幕…',
      () =>
        window.desktop.updateSubtitleImportPreview({
          token: before.token,
          revision: before.revision,
          encoding,
          offsetMs,
        }),
      (value) => {
        if (current.current?.token === before.token && current.current.revision === before.revision)
          adopt(value)
      },
    )
  }
  async function page(value: number) {
    const before = current.current
    if (!before) return
    await perform(
      '正在读取字幕预览页…',
      () =>
        window.desktop.getSubtitleImportPreview({
          token: before.token,
          revision: before.revision,
          page: value,
        }),
      (value) => {
        if (current.current?.token === before.token && current.current.revision === before.revision)
          adopt(value)
      },
    )
  }
  async function apply() {
    const before = current.current
    if (!canApply || !before) return
    if (before.expiresAt <= Date.now()) {
      setExpired(true)
      return
    }
    await perform(
      '正在导入字幕…',
      () =>
        window.desktop.applySubtitleImport({
          token: before.token,
          revision: before.revision,
          commandId: crypto.randomUUID(),
        }),
      () => {
        audition.stop()
        void onSaved().catch(() => {})
        onClose()
      },
    )
  }
  return (
    <dialog
      ref={dialog}
      className="listening-dialog subtitle-import-dialog"
      aria-label="导入 SRT/WebVTT 字幕"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="section-heading">
        <h2>导入 SRT / WebVTT 字幕</h2>
        <button className="text-button" aria-label="关闭字幕导入" onClick={onClose}>
          关闭
        </button>
      </div>
      <p>
        绑定目标：<strong>{preview?.episodeTitle ?? episodeTitle}</strong>
      </p>
      <p className="tools-hint">
        SRT / WebVTT
        不含本应用的音频哈希，无法据此核验字幕来源是否属于本集。请核对文字和时间，明确导入后才会绑定当前音频；预览不会替换正式稿。
      </p>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {busy && <p role="status">{busy}</p>}
      {stale && (
        <div className="subtitle-import-warning" role="status">
          <p>{stale}</p>
          {!targetCanceled && (
            <button className="text-button" disabled={!!busy} onClick={() => void checkCurrent()}>
              重新核对文稿版本
            </button>
          )}
        </div>
      )}
      {expired && (
        <p className="subtitle-import-warning" role="status">
          预览已过期，请重新选择文件生成预览，原文稿未被替换。
        </p>
      )}
      <div className="tools-form">
        <label>
          字幕编码
          <select
            aria-label="导入字幕编码"
            value={encoding}
            disabled={targetCanceled || busy === '正在导入字幕…'}
            onChange={(event) => setEncoding(event.target.value as SubtitleImportEncoding)}
          >
            {(Object.entries(ENCODINGS) as [SubtitleImportEncoding, string][]).map(
              ([value, label]) => (
                <option
                  key={value}
                  value={value}
                  disabled={preview?.format === 'vtt' && value !== 'auto' && value !== 'utf-8'}
                >
                  {label}
                </option>
              ),
            )}
          </select>
        </label>
        <label>
          固定时间偏移（毫秒）
          <input
            aria-label="导入字幕时间偏移毫秒"
            type="number"
            step={1}
            value={offset}
            disabled={targetCanceled || busy === '正在导入字幕…'}
            onChange={(event) => setOffset(event.target.value)}
          />
        </label>
      </div>
      <p className="tools-hint">
        默认 0，不自动平移或裁剪时间。SRT 可显式选择中文编码；WebVTT 必须为
        UTF-8。修改选项后需要重新预览。
      </p>
      <div className="tools-form">
        <button
          className="secondary-button"
          disabled={!!busy || targetCanceled}
          onClick={() => void choose()}
        >
          {preview ? '重新选择字幕文件' : '选择字幕文件'}
        </button>
        {preview && (
          <button
            className="secondary-button"
            disabled={!!busy || !!stale || expired || targetCanceled}
            onClick={() => void update()}
          >
            重新预览字幕
          </button>
        )}
      </div>
      {preview && (
        <section aria-label="字幕导入预览" className="subtitle-import-preview">
          <h3>
            {preview.fileName} · {preview.format === 'vtt' ? 'WebVTT' : 'SRT'}
          </h3>
          <p>
            {bytes(preview.sourceBytes)} · 读取编码：
            {preview.encoding ? ENCODINGS[preview.encoding] : '等待选择'}
          </p>
          {preview.status === 'encoding-required' && (
            <p role="status">尚未成功解码，请选择文件实际使用的编码后重新预览。</p>
          )}
          {preview.status === 'invalid' && (
            <p role="status">此文件目前不能导入，请核对以下问题；原文稿保留。</p>
          )}
          {preview.errors.length > 0 && (
            <ul className="error-message" aria-label="字幕导入问题">
              {preview.errors.map((message, index) => (
                <li key={index}>{message}</li>
              ))}
            </ul>
          )}
          {preview.metadata && (
            <>
              <p>
                来源 {preview.metadata.cueCount.toLocaleString()} 条字幕 →{' '}
                {preview.metadata.outputSegments.toLocaleString()} 段伴读文字；每页最多 50 段。
              </p>
              {preview.metadata.overlappingCues > 0 && (
                <p className="subtitle-import-warning">
                  {preview.metadata.overlappingCues}{' '}
                  条字幕存在重叠，已按同时出现的文字分段，原时间边界保留；请核对重叠处。
                </p>
              )}
              {preview.metadata.warnings.length > 0 && (
                <ul className="subtitle-import-warnings" aria-label="字幕格式转换提示">
                  {preview.metadata.warnings.map((warning, index) => (
                    <li key={index}>{warningText(warning)}</li>
                  ))}
                </ul>
              )}
            </>
          )}
          {preview.options.offsetMs !== 0 && (
            <p className="subtitle-import-warning">
              本次全部字幕时间{preview.options.offsetMs > 0 ? '延后' : '提前'}{' '}
              {Math.abs(preview.options.offsetMs)} 毫秒；请先核对预览时间。
            </p>
          )}
          {preview.coverage && (
            <p>
              覆盖 {preview.coverage.ranges} 个区间，共{' '}
              {(preview.coverage.coveredMs / 1000).toFixed(3)} 秒；时间跨度{' '}
              {time(preview.coverage.firstMs)}–{time(preview.coverage.lastMs)}
              。空档不自动视为已备字幕或静音。
            </p>
          )}
          <p>
            当前音频时长：
            {preview.durationMs === null
              ? '尚未核定，不依据字幕结尾推算时长'
              : time(Math.round(preview.durationMs))}
          </p>
          {dirty && (
            <p className="subtitle-import-warning" role="status">
              选项已修改，下面仍是上次预览；重新预览后才能导入。
            </p>
          )}
          {preview.rows.length > 0 && (
            <ol className="subtitle-import-rows" start={preview.page * 50 + 1}>
              {preview.rows.map((row) => (
                <li key={row.id}>
                  <p>
                    {time(row.startMs)}–{time(row.endMs)}
                  </p>
                  <p className="subtitle-import-text">{row.text}</p>
                  <button
                    className="text-button"
                    disabled={!!busy || !!stale || dirty || expired}
                    onClick={() => void audition.listen(row.startMs, row.endMs, '字幕导入预览')}
                  >
                    试听此段
                  </button>
                </li>
              ))}
            </ol>
          )}
          {audition.playing && (
            <div className="tools-form">
              <span role="status">正在试听：{audition.playing}</span>
              <button className="text-button" onClick={audition.stop}>
                停止导入试听
              </button>
            </div>
          )}
          {preview.pages > 1 && (
            <nav className="tools-form" aria-label="字幕导入预览分页">
              <button
                className="text-button"
                disabled={!!busy || dirty || !!stale || expired || preview.page === 0}
                onClick={() => void page(preview.page - 1)}
              >
                上一页字幕预览
              </button>
              <span>
                {preview.page + 1} / {preview.pages}
              </span>
              <button
                className="text-button"
                disabled={
                  !!busy || dirty || !!stale || expired || preview.page + 1 >= preview.pages
                }
                onClick={() => void page(preview.page + 1)}
              >
                下一页字幕预览
              </button>
            </nav>
          )}
          {preview.previousRevision !== null && (
            <p className="subtitle-import-warning">
              将替换正式稿版本 {preview.previousRevision}
              ，并建立新的导入基线；已有编辑撤销不能跨过本次导入。小说原文保留，旧匹配与听审按原版本保留并需重新核对。
            </p>
          )}
          <details className="subtitle-import-source">
            <summary>来源快照</summary>
            <p>SHA-256：{preview.sourceSha256}</p>
            <p>此校验值用于标识所选字幕文件，不是音频校验值，也不能证明字幕正确率。</p>
          </details>
          <button className="primary-button" disabled={!canApply} onClick={() => void apply()}>
            {preview.previousRevision === null
              ? '绑定当前集并导入'
              : `替换当前版本 ${preview.previousRevision} 并导入`}
          </button>
        </section>
      )}
      <button className="text-button" onClick={onClose}>
        取消字幕导入
      </button>
    </dialog>
  )
}
