import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from './Icons'
import { Tooltip } from './Tooltip'

export function Popover({
  label,
  icon = 'more',
  children,
  placement = 'bottom',
  kind = 'menu',
  className = '',
  disabled = false,
  triggerText,
}: {
  label: string
  icon?: IconName
  children: ReactNode
  placement?: 'top' | 'bottom'
  kind?: 'menu' | 'group'
  className?: string
  disabled?: boolean
  triggerText?: string
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return
    const anchor = trigger.current.getBoundingClientRect()
    const popup = panel.current
    const left = Math.max(
      12,
      Math.min(anchor.right - popup.offsetWidth, window.innerWidth - popup.offsetWidth - 12),
    )
    const preferredTop =
      placement === 'top' ? anchor.top - popup.offsetHeight - 8 : anchor.bottom + 8
    const top = Math.max(12, Math.min(preferredTop, window.innerHeight - popup.offsetHeight - 12))
    popup.style.left = `${left}px`
    popup.style.top = `${top}px`
    popup.style.visibility = 'visible'
    const reposition = (event: Event) => {
      if (!(event.target instanceof Node) || !popup.contains(event.target)) setOpen(false)
    }
    window.addEventListener('resize', reposition)
    document.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      document.removeEventListener('scroll', reposition, true)
    }
  }, [open, placement])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.target instanceof Element && event.target.closest('select:open')) return
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        trigger.current?.focus()
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  return (
    <div
      className={`popover ${className}`}
      ref={root}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget))
          setOpen(false)
      }}
    >
      <Tooltip content={label} disabled={open}>
        <button
          ref={trigger}
          className={triggerText ? 'icon-button labeled-icon-button' : 'icon-button'}
          aria-label={label}
          title={label}
          aria-haspopup={kind === 'menu' ? 'menu' : undefined}
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          disabled={disabled}
          onClick={() => setOpen(!open)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setOpen(true)
              requestAnimationFrame(() =>
                root.current
                  ?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled), input')
                  ?.focus(),
              )
            }
          }}
        >
          <Icon name={icon} />
          {triggerText && <span>{triggerText}</span>}
        </button>
      </Tooltip>
      {open && (
        <div
          ref={panel}
          id={id}
          className={`popover-panel popover-${placement}`}
          role={kind}
          aria-label={label}
          onClick={(event) => {
            if ((event.target as Element).closest('[role="menuitem"]')) setOpen(false)
          }}
          onKeyDown={(event) => {
            if (kind !== 'menu' || !(event.target as Element).matches('[role="menuitem"]')) return
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"]:not(:disabled)',
              ),
            )
            const index = items.indexOf(event.target as HTMLButtonElement)
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault()
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? items.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
              items[next]?.focus()
            }
          }}
        >
          {children}
        </div>
      )}
    </div>
  )
}
