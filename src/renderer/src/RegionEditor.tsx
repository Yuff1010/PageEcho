import { useEffect, useRef, useState } from 'react'
import type { TranscriptRequest, TimeRange } from '../../shared/transcript'
import {
  REGION_LABELS,
  regionKey,
  type RegionKind,
  type RegionUpdate,
  type TranscriptRegions,
  type TranscriptRegion,
} from '../../shared/regions'

export function useTranscriptRegions(target: TranscriptRequest) {
  const [data, setData] = useState<TranscriptRegions | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void window.desktop
      .getTranscriptRegions(target)
      .then((result) => {
        if (!active) return
        if (result.ok)
          setData((previous) =>
            !previous || result.value.revision >= previous.revision ? result.value : previous,
          )
        else setError(result.error.message)
      })
      .catch(() => {
        if (active) setError('片段标注加载失败，请重新打开这一集后重试。')
      })
    return () => {
      active = false
    }
  }, [target])
  async function save(change: Omit<RegionUpdate, 'episodeId' | 'audioHash'>): Promise<boolean> {
    setError('')
    try {
      const result = await window.desktop.markTranscriptRegion({ ...target, ...change })
      if (result.ok) {
        setData(result.value)
        return true
      }
      setError(result.error.message)
      if (result.error.code === 'CONFLICT') {
        const current = await window.desktop.getTranscriptRegions(target)
        if (current.ok) setData(current.value)
      }
    } catch {
      setError('片段标注未保存，请检查用户数据目录后重试。')
    }
    return false
  }
  return { data, error, save, clearError: () => setError('') }
}

export interface RegionDraft {
  startMs: number
  endMs: number
  kind: RegionKind | null
  revision: number
  previous?: TimeRange
}
export function RegionEditor({
  draft,
  durationMs,
  save,
  close,
  serverError,
}: {
  draft: RegionDraft
  durationMs: number | null
  save: (change: RegionDraft) => Promise<boolean>
  close: () => void
  serverError: string
}) {
  const [kind, setKind] = useState<RegionKind | ''>(draft.kind ?? '')
  const [start, setStart] = useState(String(draft.startMs / 1000))
  const [end, setEnd] = useState(String(draft.endMs / 1000))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="region-dialog"
      aria-label="编辑片段标注"
      onCancel={(event) => {
        event.preventDefault()
        if (!saving) close()
      }}
    >
      <form
        className="region-editor"
        aria-label="片段标注"
        onSubmit={(event) => {
          event.preventDefault()
          const startMs = Math.round(Number(start) * 1000),
            endMs = Math.round(Number(end) * 1000)
          if (
            !Number.isFinite(startMs) ||
            !Number.isFinite(endMs) ||
            startMs < 0 ||
            endMs <= startMs
          ) {
            setError('结束时间必须晚于开始时间。')
            return
          }
          setError('')
          setSaving(true)
          void save({
            startMs,
            endMs,
            kind: kind || null,
            revision: draft.revision,
            ...(draft.previous ? { previous: draft.previous } : {}),
          })
            .then((saved) => {
              if (saved) close()
            })
            .finally(() => setSaving(false))
        }}
      >
        <div className="region-fields">
          <label>
            类型
            <select
              aria-label="片段类型"
              value={kind}
              onChange={(event) => setKind(event.target.value as RegionKind | '')}
            >
              <option value="">
                {draft.previous ? '正文（移除此标注）' : '正文（移除此范围的标注）'}
              </option>
              {Object.entries(REGION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            开始秒
            <input
              aria-label="标注开始秒"
              type="number"
              required
              min="0"
              max={(durationMs ?? 3.6e10) / 1000}
              step="0.001"
              value={start}
              onChange={(event) => setStart(event.target.value)}
            />
          </label>
          <label>
            结束秒
            <input
              aria-label="标注结束秒"
              type="number"
              required
              min="0.001"
              max={(durationMs ?? 3.6e10) / 1000}
              step="0.001"
              value={end}
              onChange={(event) => setEnd(event.target.value)}
            />
          </label>
        </div>
        <p>
          {draft.previous
            ? '保存后替换原标注范围；选择正文将移除此标注。'
            : '按原音频秒数标注，可调整为连续多句的范围。'}
          只折叠文字，播放照常继续。
        </p>
        {(error || serverError) && <p role="alert">{error || serverError}</p>}
        <button className="secondary-button" type="submit" disabled={saving}>
          保存片段标注
        </button>
        <button className="text-button" type="button" disabled={saving} onClick={close}>
          取消标注
        </button>
      </form>
    </dialog>
  )
}

export function RegionManager({
  data,
  activeKey,
  edit,
  add,
  seek,
}: {
  data: TranscriptRegions | null
  activeKey: string
  edit: (region: TranscriptRegion) => void
  add: () => void
  seek: (startMs: number) => void
}) {
  const [page, setPage] = useState(0)
  const pages = Math.max(1, Math.ceil((data?.regions.length ?? 0) / 20)),
    current = Math.min(page, pages - 1)
  return (
    <details className="region-manager">
      <summary>片段标注 · {data?.regions.length ?? 0} 处</summary>
      <div className="region-manager-body">
        <p>手动标注广告、片头或前情回顾。没有识别文字的时间范围也会保留。</p>
        <button className="secondary-button" disabled={!data} onClick={add}>
          按时间新增标注
        </button>
        <ul aria-label="已标注时间范围">
          {data?.regions.slice(current * 20, current * 20 + 20).map((region) => {
            const key = regionKey(region)
            return (
              <li key={key}>
                <span aria-current={activeKey === key ? 'true' : undefined}>
                  {REGION_LABELS[region.kind]} · {region.startMs / 1000}–{region.endMs / 1000} 秒
                </span>
                <button className="text-button" onClick={() => seek(region.startMs)}>
                  定位范围
                </button>
                <button className="text-button" onClick={() => edit(region)}>
                  修改标注
                </button>
              </li>
            )
          })}
        </ul>
        {pages > 1 && (
          <div className="region-pagination">
            <button
              className="text-button"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              上一页标注
            </button>
            <span>
              {current + 1} / {pages} 页
            </span>
            <button
              className="text-button"
              disabled={current + 1 === pages}
              onClick={() => setPage(current + 1)}
            >
              下一页标注
            </button>
          </div>
        )}
      </div>
    </details>
  )
}
