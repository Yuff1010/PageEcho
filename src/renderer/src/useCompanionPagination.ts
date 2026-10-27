import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReaderAnchor, ReaderSettings } from './reader-layout'
import { pageMetrics, restoreReaderAnchor, visibleReaderAnchor } from './reader-dom'
import {
  animatePageTurn,
  cancelPageTurn,
  captureBookPage,
  reducedReaderMotion,
  type BookPageSnapshot,
} from './motion'

/** A data window is bounded; its measured columns are the actual reading pages. */
export function useCompanionPagination({
  settings,
  visible,
  contentKey,
  firstOrdinal,
  lastOrdinal,
  total,
  onManualBrowse,
  onBoundary,
}: {
  settings: ReaderSettings
  visible: boolean
  contentKey: string
  firstOrdinal: number
  lastOrdinal: number
  total: number
  onManualBrowse: () => void
  onBoundary: (ordinal: number) => void
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onManualBrowse, onBoundary })
  useLayoutEffect(() => {
    callbacks.current = { onManualBrowse, onBoundary }
  })
  const anchor = useRef<ReaderAnchor>({ ordinal: firstOrdinal, offset: 0 })
  const pending = useRef<ReaderAnchor | null>(null)
  const pendingTurn = useRef(0)
  const snapshot = useRef<BookPageSnapshot | null>(null)
  const restoring = useRef(false)
  const scrollIntent = useRef(false)
  const smoothTarget = useRef<number | null>(null)
  const frame = useRef(0)
  const restoreFrame = useRef(0)
  const [metrics, setMetrics] = useState({
    column: 0,
    columns: 1,
    moreAbove: false,
    moreBelow: false,
  })
  const [location, setLocation] = useState<ReaderAnchor>({ ordinal: firstOrdinal, offset: 0 })
  const record = useCallback((value: ReaderAnchor) => {
    anchor.current = value
    setLocation((previous) =>
      previous.ordinal === value.ordinal && previous.offset === value.offset ? previous : value,
    )
  }, [])
  const stopScrolling = useCallback(() => {
    if (smoothTarget.current !== null && viewport.current)
      viewport.current.scrollTo({ top: viewport.current.scrollTop, behavior: 'instant' })
    smoothTarget.current = null
  }, [])
  const measure = useCallback(() => {
    const element = viewport.current
    if (!element?.firstElementChild || !element.clientWidth || !element.clientHeight) return
    const next = {
      ...pageMetrics(element),
      moreAbove: element.scrollTop > 1,
      moreBelow: element.scrollTop + element.clientHeight < element.scrollHeight - 2,
    }
    setMetrics((previous) =>
      previous.column === next.column &&
      previous.columns === next.columns &&
      previous.moreAbove === next.moreAbove &&
      previous.moreBelow === next.moreBelow
        ? previous
        : next,
    )
  }, [])
  const remember = useCallback(() => {
    const element = viewport.current
    if (!element || restoring.current) return
    const value = visibleReaderAnchor(element, settings.mode)
    if (value) record(value)
  }, [record, settings.mode])
  const restore = useCallback(() => {
    const element = viewport.current
    if (
      !visible ||
      lastOrdinal < firstOrdinal ||
      !element?.firstElementChild ||
      !element.clientWidth ||
      !element.clientHeight
    )
      return
    stopScrolling()
    cancelPageTurn(element)
    restoring.current = true
    scrollIntent.current = false
    const value = pending.current ?? anchor.current
    const target =
      value.ordinal >= firstOrdinal && value.ordinal <= lastOrdinal
        ? value
        : { ordinal: firstOrdinal, offset: 0 }
    restoreReaderAnchor(element, target, settings.mode)
    pending.current = null
    // A spread may begin before the requested sentence. Preserve the logical
    // text anchor across a later resize instead of replacing it with that spread
    // start, just as useEbookDocument keeps its saved anchor during reflow.
    record(target)
    measure()
    if (pendingTurn.current && settings.mode === 'pages')
      animatePageTurn(
        element,
        {
          pageAnimation: settings.pageAnimation,
          animationDuration: settings.animationDuration,
          reduceMotion: settings.reduceMotion,
        },
        pendingTurn.current,
        snapshot.current,
      )
    pendingTurn.current = 0
    snapshot.current = null
    cancelAnimationFrame(restoreFrame.current)
    restoreFrame.current = requestAnimationFrame(() => {
      restoring.current = false
    })
  }, [
    visible,
    firstOrdinal,
    lastOrdinal,
    settings.mode,
    settings.pageAnimation,
    settings.animationDuration,
    settings.reduceMotion,
    measure,
    record,
    stopScrolling,
  ])
  useLayoutEffect(() => {
    restore()
  }, [
    contentKey,
    settings.fontSize,
    settings.fontFamily,
    settings.fontWeight,
    settings.lineHeight,
    settings.contentWidth,
    settings.letterSpacing,
    settings.paragraphSpacing,
    settings.indent,
    settings.pageLayout,
    restore,
  ])
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    let width = element.clientWidth,
      height = element.clientHeight
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width && element.clientHeight === height) return
      width = element.clientWidth
      height = element.clientHeight
      cancelAnimationFrame(restoreFrame.current)
      restoreFrame.current = requestAnimationFrame(restore)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [restore])
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const changed = () => {
      if (settings.reduceMotion || media.matches || settings.pageAnimation === 'none') {
        if (viewport.current) cancelPageTurn(viewport.current)
      }
      if (settings.reduceMotion || media.matches || !settings.smoothScroll) stopScrolling()
    }
    changed()
    media.addEventListener('change', changed)
    return () => media.removeEventListener('change', changed)
  }, [settings.reduceMotion, settings.pageAnimation, settings.smoothScroll, stopScrolling])
  useEffect(() => {
    const element = viewport.current
    return () => {
      cancelAnimationFrame(frame.current)
      cancelAnimationFrame(restoreFrame.current)
      if (element) cancelPageTurn(element)
    }
  }, [])
  const scrolled = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      if (restoring.current) return
      if (scrollIntent.current) remember()
      measure()
    })
  }, [measure, remember])
  const userBrowse = useCallback(() => {
    stopScrolling()
    scrollIntent.current = true
    callbacks.current.onManualBrowse()
  }, [stopScrolling])
  const turn = useCallback(
    (direction: number) => {
      const element = viewport.current
      if (!visible || !element?.firstElementChild || lastOrdinal < firstOrdinal) return
      const previousTarget = smoothTarget.current
      userBrowse()
      cancelPageTurn(element)
      if (settings.mode === 'scroll') {
        const target = Math.max(
          0,
          Math.min(
            element.scrollHeight - element.clientHeight,
            (previousTarget ?? element.scrollTop) +
              direction * Math.max(100, element.clientHeight - 40),
          ),
        )
        if (Math.abs(target - element.scrollTop) > 1) {
          const smooth =
            settings.smoothScroll && !reducedReaderMotion({ reduceMotion: settings.reduceMotion })
          smoothTarget.current = smooth ? target : null
          element.scrollTo({ top: target, behavior: smooth ? 'smooth' : 'instant' })
          scrolled()
          element.focus({ preventScroll: true })
          return
        }
      } else {
        const view = pageMetrics(element)
        const next = view.column + direction
        if (next >= 0 && next < view.columns) {
          const previous = captureBookPage(element, {
            pageAnimation: settings.pageAnimation,
            reduceMotion: settings.reduceMotion,
          })
          element.scrollLeft = next * view.stride
          remember()
          measure()
          animatePageTurn(
            element,
            {
              pageAnimation: settings.pageAnimation,
              animationDuration: settings.animationDuration,
              reduceMotion: settings.reduceMotion,
            },
            direction,
            previous,
          )
          element.focus({ preventScroll: true })
          return
        }
      }
      const ordinal = direction > 0 ? lastOrdinal + 1 : firstOrdinal - 1
      if (ordinal < 0 || ordinal >= total) return
      pending.current = { ordinal, offset: direction < 0 ? Number.MAX_SAFE_INTEGER : 0 }
      pendingTurn.current = direction
      snapshot.current = captureBookPage(element, {
        pageAnimation: settings.pageAnimation,
        reduceMotion: settings.reduceMotion,
      })
      callbacks.current.onBoundary(ordinal)
      element.focus({ preventScroll: true })
    },
    [
      visible,
      firstOrdinal,
      lastOrdinal,
      userBrowse,
      settings.mode,
      settings.smoothScroll,
      settings.reduceMotion,
      settings.pageAnimation,
      settings.animationDuration,
      scrolled,
      remember,
      measure,
      total,
    ],
  )
  const goPage = useCallback(
    (column: number) => {
      const element = viewport.current
      if (!element || settings.mode !== 'pages') return
      const view = pageMetrics(element)
      const next = Math.max(0, Math.min(view.columns - 1, Math.floor(column)))
      userBrowse()
      if (next === view.column) return
      cancelPageTurn(element)
      const previous = captureBookPage(element, {
        pageAnimation: settings.pageAnimation,
        reduceMotion: settings.reduceMotion,
      })
      element.scrollLeft = next * view.stride
      remember()
      measure()
      animatePageTurn(
        element,
        {
          pageAnimation: settings.pageAnimation,
          animationDuration: settings.animationDuration,
          reduceMotion: settings.reduceMotion,
        },
        Math.sign(next - view.column),
        previous,
      )
      element.focus({ preventScroll: true })
    },
    [
      settings.mode,
      settings.pageAnimation,
      settings.animationDuration,
      settings.reduceMotion,
      userBrowse,
      remember,
      measure,
    ],
  )
  /** Playback and search reveal a sentence without impersonating a manual page turn. */
  const reveal = useCallback(
    (ordinal: number, focus = false) => {
      const element = viewport.current
      if (!visible || !element?.clientWidth || !element.clientHeight) return
      const sentence = element.querySelector<HTMLElement>(`[data-sentence="${ordinal}"]`)
      if (!sentence) return
      stopScrolling()
      cancelPageTurn(element)
      restoring.current = true
      scrollIntent.current = false
      if (settings.mode === 'pages') restoreReaderAnchor(element, { ordinal, offset: 0 }, 'pages')
      else {
        const bounds = element.getBoundingClientRect()
        const rect = Array.from(sentence.getClientRects()).find((box) => box.width && box.height)
        if (rect)
          element.scrollTo({
            top: Math.max(
              0,
              element.scrollTop +
                rect.top -
                bounds.top -
                Math.max(0, element.clientHeight - rect.height) / 2,
            ),
            behavior: 'instant',
          })
      }
      record({ ordinal, offset: 0 })
      measure()
      if (focus) element.focus({ preventScroll: true })
      cancelAnimationFrame(restoreFrame.current)
      restoreFrame.current = requestAnimationFrame(() => {
        restoring.current = false
      })
    },
    [visible, settings.mode, stopScrolling, record, measure],
  )
  useEffect(() => {
    const element = viewport.current
    if (!visible || !element) return
    let accumulated = 0,
      lastTurn = Number.NEGATIVE_INFINITY
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey) return
      if (settings.mode === 'scroll') {
        userBrowse()
        const atEnd =
          event.deltaY > 0 && element.scrollTop + element.clientHeight >= element.scrollHeight - 2
        const atStart = event.deltaY < 0 && element.scrollTop <= 1
        if ((atEnd || atStart) && performance.now() - lastTurn >= 350) {
          event.preventDefault()
          turn(atEnd ? 1 : -1)
          lastTurn = performance.now()
        }
        return
      }
      event.preventDefault()
      if (performance.now() - lastTurn < 350) return
      accumulated += Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      if (Math.abs(accumulated) >= 40) {
        turn(Math.sign(accumulated))
        accumulated = 0
        lastTurn = performance.now()
      }
    }
    const ended = () => {
      smoothTarget.current = null
      scrolled()
    }
    element.addEventListener('wheel', wheel, { passive: false })
    element.addEventListener('scrollend', ended)
    return () => {
      element.removeEventListener('wheel', wheel)
      element.removeEventListener('scrollend', ended)
    }
  }, [visible, settings.mode, turn, userBrowse, scrolled])
  return {
    viewport,
    location,
    metrics,
    scrolled,
    userBrowse,
    turn,
    goPage,
    reveal,
    canPrevious:
      firstOrdinal > 0 || (settings.mode === 'pages' ? metrics.column > 0 : metrics.moreAbove),
    canNext:
      lastOrdinal + 1 < total ||
      (settings.mode === 'pages' ? metrics.column < metrics.columns - 1 : metrics.moreBelow),
  }
}
