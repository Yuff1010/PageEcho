import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import './tooltip.css'

/** Action labels on demand, without a wrapper that changes control geometry or refs. */
export function Tooltip({
  content,
  children,
  disabled = false,
}: {
  content: ReactNode
  children: ReactElement<HTMLAttributes<HTMLElement>>
  disabled?: boolean
}) {
  const id = useId()
  const anchor = useRef<HTMLElement | null>(null)
  const popup = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => {
    clearTimeout(timer.current)
    setOpen(false)
  }, [])
  const reveal = (element: HTMLElement, delay: number) => {
    clearTimeout(timer.current)
    anchor.current = element
    if (disabled || !content) return
    timer.current = setTimeout(() => {
      if (!element.matches('select:open, [aria-expanded="true"]')) setOpen(true)
    }, delay)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  const shown = open && !disabled
  useLayoutEffect(() => {
    const node = popup.current
    const target = anchor.current
    if (!shown || !node || !target) return
    node.showPopover()
    const place = () => {
      const bounds = target.getBoundingClientRect()
      const width = node.offsetWidth
      const height = node.offsetHeight
      const above = bounds.top - height - 10
      node.style.left = `${Math.max(8, Math.min(bounds.left + (bounds.width - width) / 2, innerWidth - width - 8))}px`
      node.style.top = `${Math.max(8, Math.min(above >= 8 ? above : bounds.bottom + 10, innerHeight - height - 8))}px`
    }
    place()
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // A native picker owns Escape while open; help must never take that key away.
      if (target.matches('select:open')) {
        close()
        return
      }
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    const another = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) close()
    }
    const visibility = new ResizeObserver(() => {
      if (!target.getClientRects().length) close()
      else place()
    })
    visibility.observe(target)
    visibility.observe(node)
    document.dispatchEvent(new CustomEvent('ralb:tooltip-open', { detail: id }))
    document.addEventListener('ralb:tooltip-open', another)
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', escape, true)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      visibility.disconnect()
      document.removeEventListener('ralb:tooltip-open', another)
      document.removeEventListener('pointerdown', close, true)
      document.removeEventListener('keydown', escape, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
      if (node.matches(':popover-open')) node.hidePopover()
    }
  }, [shown, id, close])
  const props = children.props
  // cloneElement installs handlers; it does not invoke them or read refs during render.
  // eslint-disable-next-line react-hooks/refs
  const trigger = cloneElement(children, {
    title: undefined,
    'aria-describedby':
      [props['aria-describedby'], shown ? id : undefined].filter(Boolean).join(' ') || undefined,
    onPointerEnter: (event) => {
      props.onPointerEnter?.(event)
      if (event.pointerType !== 'touch') reveal(event.currentTarget, 360)
    },
    onPointerLeave: (event) => {
      props.onPointerLeave?.(event)
      close()
    },
    onFocus: (event) => {
      props.onFocus?.(event)
      reveal(event.currentTarget, 0)
    },
    onBlur: (event) => {
      props.onBlur?.(event)
      close()
    },
    onClick: (event) => {
      close()
      props.onClick?.(event)
    },
    onKeyDown: (event) => {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) close()
      props.onKeyDown?.(event)
    },
  })
  return (
    <>
      {trigger}
      {shown &&
        createPortal(
          <span ref={popup} id={id} role="tooltip" popover="manual" className="action-tooltip">
            {content}
          </span>,
          document.body,
        )}
    </>
  )
}
