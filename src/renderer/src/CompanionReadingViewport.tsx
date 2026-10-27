import { useRef, type ReactNode } from 'react'
import type { ReaderSettings } from './reader-settings'
import type { useCompanionPagination } from './useCompanionPagination'
import './companion-pagination.css'

export function CompanionReadingViewport({
  pagination,
  settings,
  label,
  className = '',
  busy = false,
  children,
}: {
  pagination: ReturnType<typeof useCompanionPagination>
  settings: ReaderSettings
  label: string
  className?: string
  busy?: boolean
  children: ReactNode
}) {
  const { viewport, metrics, scrolled, userBrowse, turn, goPage } = pagination
  const touch = useRef<{ x: number; y: number } | null>(null)
  return (
    <div
      className="companion-page-window"
      data-mode={settings.mode}
      data-page-layout={settings.pageLayout}
    >
      <div className="companion-content-frame">
        <div
          className={`transcript-viewport companion-flow-viewport ${className}`}
          ref={viewport}
          role="region"
          aria-label={label}
          aria-busy={busy}
          tabIndex={0}
          data-page={metrics.column + 1}
          data-pages={metrics.columns}
          onScroll={scrolled}
          onPointerDown={userBrowse}
          onTouchStart={(event) => {
            userBrowse()
            const first = event.touches[0]
            if (first) touch.current = { x: first.clientX, y: first.clientY }
          }}
          onTouchEnd={(event) => {
            const first = event.changedTouches[0],
              previous = touch.current
            touch.current = null
            if (!previous || !first || settings.mode !== 'pages') return
            const dx = first.clientX - previous.x,
              dy = first.clientY - previous.y
            if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) turn(dx < 0 ? 1 : -1)
          }}
          onKeyDown={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest('input,textarea,select,button,[contenteditable="true"]')
            )
              return
            const forward =
              ['ArrowRight', 'PageDown'].includes(event.key) ||
              (event.key === ' ' && !event.shiftKey)
            const backward =
              ['ArrowLeft', 'PageUp'].includes(event.key) || (event.key === ' ' && event.shiftKey)
            if (
              forward ||
              backward ||
              (settings.mode === 'pages' && ['ArrowDown', 'ArrowUp'].includes(event.key))
            ) {
              event.preventDefault()
              turn(backward || event.key === 'ArrowUp' ? -1 : 1)
            } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              userBrowse()
              if (settings.mode === 'pages') {
                event.preventDefault()
                goPage(event.key === 'Home' ? 0 : metrics.columns - 1)
              }
            }
          }}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
