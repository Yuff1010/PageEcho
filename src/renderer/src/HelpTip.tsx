import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Icon } from './Icons'
import './help-tip.css'

/** Short optional guidance, available to mouse, keyboard and touch users. */
export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const bubble = useRef<HTMLSpanElement>(null)
  const pinned = useRef(false)
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const cancelClose = () => clearTimeout(closing.current)
  const close = useCallback(() => {
    clearTimeout(closing.current)
    pinned.current = false
    setOpen(false)
  }, [])
  const leave = () => {
    cancelClose()
    closing.current = setTimeout(() => {
      if (!pinned.current && document.activeElement !== trigger.current) setOpen(false)
    }, 120)
  }
  useLayoutEffect(() => {
    const popup = bubble.current
    if (!popup) return
    if (!open) {
      if (popup.matches(':popover-open')) popup.hidePopover()
      return
    }
    popup.showPopover()
    const place = () => {
      const button = trigger.current
      if (!button) return
      const bounds = button.getBoundingClientRect()
      popup.style.left = `${Math.max(8, Math.min(bounds.right - popup.offsetWidth, innerWidth - popup.offsetWidth - 8))}px`
      popup.style.top = `${Math.max(8, bounds.bottom + popup.offsetHeight + 8 <= innerHeight ? bounds.bottom + 8 : bounds.top - popup.offsetHeight - 8)}px`
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!trigger.current?.contains(target) && !bubble.current?.contains(target)) close()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape, true)
    const visibility = new ResizeObserver(() => {
      if (!trigger.current?.getClientRects().length) close()
    })
    if (trigger.current) visibility.observe(trigger.current)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape, true)
      visibility.disconnect()
    }
  }, [open, close])
  useEffect(() => () => clearTimeout(closing.current), [])
  return (
    <span className="help-tip">
      <button
        ref={trigger}
        type="button"
        className="help-tip-trigger"
        aria-label={`${label}说明`}
        aria-expanded={open}
        aria-controls={id}
        aria-describedby={open ? id : undefined}
        onPointerEnter={(event) => {
          cancelClose()
          if (event.pointerType !== 'touch') setOpen(true)
        }}
        onPointerLeave={leave}
        onFocus={() => setOpen(true)}
        onBlur={close}
        onClick={() => {
          pinned.current = !pinned.current
          setOpen(pinned.current)
        }}
      >
        <Icon name="info" />
      </button>
      <span
        ref={bubble}
        id={id}
        role="tooltip"
        popover="manual"
        className="help-tip-bubble"
        onPointerEnter={cancelClose}
        onPointerLeave={leave}
      >
        {children}
      </span>
    </span>
  )
}
