import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { SubtitleStatusSnapshot, SubtitleStatusTarget } from '../../shared/subtitle-status'
import { subtitleStatusText, subtitleTime } from '../../shared/subtitle-status'
import { Icon } from './Icons'
import { Tooltip } from './Tooltip'
import './subtitle-status.css'

function PlayerSubtitleStatus({
  summary,
  title,
  children,
  iconOnly = false,
  busy = false,
}: {
  summary: ReactNode
  title: string
  children: ReactNode
  iconOnly?: boolean
  busy?: boolean
}) {
  const root = useRef<HTMLDetailsElement>(null),
    popup = useRef<HTMLDivElement>(null)
  const [collapsedForSpace, setCollapsedForSpace] = useState(false)
  useEffect(() => {
    const details = root.current,
      panel = popup.current
    if (!details || !panel) return
    let frame = 0
    const collapse = () => {
      details.open = false
      if (details.contains(document.activeElement)) details.querySelector('summary')?.focus()
    }
    const position = () => {
      frame = 0
      if (!details.open) return
      const margin = 12,
        gap = 10,
        width = document.documentElement.clientWidth,
        playerTop = details.closest('.player-panel')?.getBoundingClientRect().top,
        bottom = Math.min(innerHeight - margin, (playerTop ?? innerHeight) - gap)
      panel.style.maxHeight = `${Math.max(0, bottom - margin)}px`
      const bounds = panel.getBoundingClientRect()
      let top = bottom - bounds.height
      const anchor = details.querySelector('summary')!.getBoundingClientRect()
      const left = Math.max(
        margin,
        Math.min(iconOnly ? anchor.right - bounds.width : 24, width - bounds.width - margin),
      )
      // Protect the visible part of the active sentence, including folded regions.
      // This runs on opening, sentence changes and layout events, never timeupdate.
      const current = [
        ...document.querySelectorAll<HTMLElement>('[aria-label="同步伴读"] [aria-current="true"]'),
      ].find((element) => element.getClientRects().length > 0)
      if (current) {
        const sentence = current.getBoundingClientRect(),
          viewport = current
            .closest('.transcript-viewport, .original-viewport')
            ?.getBoundingClientRect(),
          protectedTop = Math.max(margin, sentence.top, viewport?.top ?? margin),
          protectedBottom = Math.min(bottom, sentence.bottom, viewport?.bottom ?? bottom),
          protectedLeft = Math.max(0, sentence.left, viewport?.left ?? 0),
          protectedRight = Math.min(width, sentence.right, viewport?.right ?? width)
        if (
          protectedBottom > protectedTop &&
          protectedRight > left &&
          protectedLeft < left + bounds.width &&
          top < protectedBottom &&
          top + bounds.height > protectedTop
        ) {
          const above = protectedTop - gap - margin,
            below = bottom - protectedBottom - gap,
            useAbove = above >= bounds.height || above >= below,
            available = useAbove ? above : below
          if (available < 80) {
            setCollapsedForSpace(true)
            collapse()
            return
          }
          panel.style.maxHeight = `${available}px`
          top = useAbove
            ? protectedTop - gap - panel.getBoundingClientRect().height
            : protectedBottom + gap
        }
      }
      panel.style.left = `${left}px`
      panel.style.top = `${Math.max(margin, top)}px`
      panel.dataset.positioned = 'true'
    }
    const schedule = () => {
      if (details.open && !frame) frame = requestAnimationFrame(position)
    }
    const toggle = () => {
      if (details.open) {
        setCollapsedForSpace(false)
        schedule()
      } else delete panel.dataset.positioned
    }
    const close = (event: PointerEvent) => {
      if (!details.contains(event.target as Node)) details.open = false
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && details.open) {
        collapse()
        details.querySelector('summary')?.focus()
      }
    }
    const activeSelector = '[aria-label="同步伴读"], [aria-current="true"]',
      changes = new MutationObserver((records) => {
        if (
          records.some(
            (record) =>
              record.type === 'attributes' ||
              [...record.addedNodes, ...record.removedNodes].some(
                (node) =>
                  node instanceof Element &&
                  (node.matches(activeSelector) || node.querySelector(activeSelector)),
              ),
          )
        )
          schedule()
      }),
      resize = new ResizeObserver(schedule)
    changes.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-current', 'hidden'],
    })
    resize.observe(panel)
    details.addEventListener('toggle', toggle)
    window.addEventListener('resize', schedule)
    document.addEventListener('scrollend', schedule, true)
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      changes.disconnect()
      resize.disconnect()
      details.removeEventListener('toggle', toggle)
      window.removeEventListener('resize', schedule)
      document.removeEventListener('scrollend', schedule, true)
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [iconOnly])
  return (
    <details
      className={`subtitle-status-player${iconOnly ? ' subtitle-status-icon' : ''}`}
      ref={root}
    >
      <Tooltip content={`${title}${collapsedForSpace ? '；阅读空间不足，详情已收起' : ''}`}>
        <summary
          aria-label={`字幕状态：${title}${collapsedForSpace ? '；阅读空间不足，详情已收起' : ''}`}
          aria-busy={busy || undefined}
        >
          {summary}
          {collapsedForSpace && !iconOnly && <Icon name="info" />}
        </summary>
      </Tooltip>
      <div className="subtitle-status-popup" ref={popup}>
        <div className="subtitle-status-popup-heading">
          <strong>字幕状态</strong>
          <Tooltip content="收起字幕状态">
            <button
              className="icon-button"
              aria-label="收起字幕状态"
              onClick={() => {
                if (root.current) root.current.open = false
              }}
            >
              <Icon name="close" />
            </button>
          </Tooltip>
        </div>
        <div className="subtitle-status-popup-body">{children}</div>
      </div>
    </details>
  )
}

export function useSubtitleStatuses(targets: readonly SubtitleStatusTarget[]) {
  const [snapshots, setSnapshots] = useState<SubtitleStatusSnapshot[]>([])
  useEffect(() => {
    if (!targets.length) return
    let mounted = true,
      reading = false,
      dirty = false,
      timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      dirty = true
      if (reading) return
      reading = true
      try {
        do {
          dirty = false
          const result = await window.desktop.getSubtitleStatuses({ episodes: [...targets] })
          if (mounted && result.ok) setSnapshots(result.value)
        } while (mounted && dirty)
      } catch {
        // A directory status read never prevents opening or playing an episode.
      } finally {
        reading = false
      }
    }
    void refresh()
    const stop = window.desktop.onTranscriptionChanged((change) => {
      if (
        !targets.some(
          (target) =>
            target.episodeId === change.episodeId && target.audioHash === change.audioHash,
        )
      )
        return
      if (timer === undefined)
        timer = setTimeout(() => {
          timer = undefined
          void refresh()
        }, 80)
    })
    return () => {
      mounted = false
      stop()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [targets])
  return new Map(snapshots.map((snapshot) => [snapshot.episodeId, snapshot]))
}

export function SubtitleStatus({
  snapshot,
  rate = 1,
  variant = 'detail',
  checkingNotice,
}: {
  snapshot: SubtitleStatusSnapshot | null
  rate?: number
  variant?: 'player' | 'icon' | 'badge' | 'detail'
  checkingNotice?: string
}) {
  const checking = variant === 'icon' && !!checkingNotice
  if (!snapshot)
    return variant === 'player' || variant === 'icon' ? (
      <Tooltip content={checking ? checkingNotice : '正在读取字幕状态…'}>
        <span
          className={`subtitle-status-loading${variant === 'icon' ? ' subtitle-status-loading-icon' : ''}`}
          aria-label={checking ? checkingNotice : '正在读取字幕状态…'}
          aria-busy={checking || undefined}
          data-state={checking ? 'checking' : undefined}
          tabIndex={0}
        >
          {checking ? (
            <span className="subtitle-status-spinner" aria-hidden="true" />
          ) : (
            <Icon name="clock" />
          )}
        </span>
      </Tooltip>
    ) : null
  const text = subtitleStatusText(snapshot, rate)
  if (variant === 'badge')
    return (
      <span
        className="subtitle-status-badge"
        data-subtitle-status={snapshot.savedStatus}
        title={text.details.join('\n')}
      >
        {text.title}
        {snapshot.savedCoverage.coveredMs > 0
          ? ` · ${subtitleTime(snapshot.savedCoverage.coveredMs)}`
          : ''}
        {text.preview ? ' · 新稿待采用' : ''}
      </span>
    )
  const body = (
    <div
      className="subtitle-status-detail"
      role="group"
      aria-label="字幕准备状态"
      data-subtitle-complete={snapshot.savedCoverage.complete}
    >
      <p className="subtitle-status-summary">
        <strong>{text.title}</strong> · 已备 {text.amount}
      </p>
      <details
        className="subtitle-status-diagnostics"
        open={variant === 'player' || variant === 'icon'}
      >
        <summary>查看覆盖范围与任务详情</summary>
        <p>{text.coverage}</p>
        <p>{text.lead}</p>
        {text.jobText && <p className="subtitle-status-job">{text.jobText}</p>}
        {text.jobCoverageText && <p className="subtitle-status-job">{text.jobCoverageText}</p>}
        {text.preview && <p>新稿采用前，继续使用当前已保存的字幕。</p>}
      </details>
    </div>
  )
  const job = snapshot.job
  const active = job && ['queued', 'running', 'canceling'].includes(job.status)
  const stage = active
    ? job.status === 'canceling'
      ? '取消中'
      : job.status === 'queued'
        ? '排队'
        : job.stage === 'loading'
          ? '载入'
          : job.stage === 'checking-components'
            ? '检查'
            : '生成'
    : job?.status === 'failed'
      ? '失败'
      : job?.status === 'canceled'
        ? '已取消'
        : ''
  const progress = active
    ? job.totalChunks > 0
      ? { value: job.completedChunks, max: job.totalChunks, label: '字幕处理分段进度' }
      : null
    : snapshot.durationMs && snapshot.savedCoverage.coveredMs > 0
      ? {
          value: snapshot.savedCoverage.coveredMs,
          max: snapshot.durationMs,
          label: '已保存字幕覆盖',
        }
      : null
  const seconds = Math.floor(
    snapshot.savedCoverage.leadMs / (Number.isFinite(rate) && rate > 0 ? rate : 1) / 1000,
  )
  const state = active
    ? job.status
    : job?.status === 'failed'
      ? 'failed'
      : snapshot.savedStatus === 'stale'
        ? 'stale'
        : snapshot.savedCoverage.complete
          ? 'complete'
          : snapshot.savedCoverage.coveredMs > 0
            ? 'partial'
            : 'missing'
  const statusIcon =
    state === 'complete'
      ? 'check'
      : state === 'failed' || state === 'stale'
        ? 'info'
        : active
          ? 'clock'
          : 'transcript'
  return variant === 'player' || variant === 'icon' ? (
    <PlayerSubtitleStatus
      iconOnly={variant === 'icon'}
      busy={checking}
      summary={
        variant === 'icon' ? (
          <span className="subtitle-status-compact" data-state={checking ? 'checking' : state}>
            {checking ? (
              <span className="subtitle-status-spinner" aria-hidden="true" />
            ) : (
              <Icon name={statusIcon} />
            )}
          </span>
        ) : (
          <span className="subtitle-status-compact" data-state={state}>
            <Icon name={statusIcon} />
            {stage && <span className="subtitle-status-stage">{stage}</span>}
            <span className="subtitle-status-value">
              {active
                ? `${job.completedChunks}/${job.totalChunks || '…'}`
                : snapshot.savedCoverage.coveredMs > 0
                  ? subtitleTime(snapshot.savedCoverage.coveredMs)
                  : '—'}
            </span>
            {active && !progress ? (
              <progress className="subtitle-status-mini-progress" aria-label="字幕任务进度未知" />
            ) : (
              progress && (
                <progress
                  className="subtitle-status-mini-progress"
                  aria-label={progress.label}
                  value={progress.value}
                  max={progress.max}
                />
              )
            )}
            {!active && seconds > 0 && <span className="subtitle-status-lead">{seconds}s</span>}
            {text.preview && <Icon name="leaf" />}
          </span>
        )
      }
      title={
        checking && checkingNotice
          ? checkingNotice
          : `${text.details.join('；')}${text.preview ? '；新稿待采用' : ''}`
      }
    >
      {checking && <p role="status">{checkingNotice}</p>}
      {body}
      {variant === 'icon' && (active || progress) && (
        <div className="subtitle-status-expanded-progress">
          {active && (
            <span>
              {stage} · {job.completedChunks}/{job.totalChunks || '…'} 段
            </span>
          )}
          <progress
            aria-label={active && !progress ? '字幕任务进度未知' : progress!.label}
            {...(progress ? { value: progress.value, max: progress.max } : {})}
          />
        </div>
      )}
    </PlayerSubtitleStatus>
  ) : (
    body
  )
}
