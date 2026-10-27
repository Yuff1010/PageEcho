import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ORIGINAL_PAGE_SIZE, type OriginalPage } from '../../shared/original'
import type { ReadingBook } from '../../shared/reading'
import {
  initialReaderAnchor,
  readerChunkStarts,
  storeReaderAnchor,
  type ReaderAnchor,
  type ReaderSettings,
} from './reader-layout'
import { pageMetrics, restoreReaderAnchor, visibleReaderAnchor } from './reader-dom'
import {
  animatePageTurn,
  cancelPageTurn,
  captureBookPage,
  reducedReaderMotion,
  type BookPageSnapshot,
} from './motion'

export function useEbookDocument(book: ReadingBook, settings: ReaderSettings) {
  const viewport = useRef<HTMLDivElement>(null)
  const [pages, setPages] = useState<OriginalPage[]>([])
  const [location, setLocation] = useState(() => initialReaderAnchor(book))
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(true)
  const [metrics, setMetrics] = useState({
    column: 0,
    columns: 1,
    moreAbove: false,
    moreBelow: false,
  })
  const cache = useRef(new Map<number, Promise<OriginalPage>>())
  const documentPages = useRef<OriginalPage[]>([])
  const anchor = useRef(location)
  const pending = useRef<ReaderAnchor | null>(location)
  const alive = useRef(true)
  const generation = useRef(0)
  const extending = useRef(false)
  const restoring = useRef(true)
  const scrollIntent = useRef(false)
  const saveTimer = useRef<number | undefined>(undefined)
  const frame = useRef(0)
  const restoreFrame = useRef(0)
  const savedOrdinal = useRef(book.position)
  const pendingTurn = useRef(0)
  const pendingSnapshot = useRef<BookPageSnapshot | null>(null)
  const smoothTarget = useRef<number | null>(null)
  const stopScrolling = useCallback(() => {
    if (smoothTarget.current !== null && viewport.current)
      viewport.current.scrollTo({ top: viewport.current.scrollTop, behavior: 'instant' })
    smoothTarget.current = null
  }, [])
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
  const persist = useCallback(async () => {
    const current = anchor.current
    storeReaderAnchor(book.id, current)
    try {
      const result = await window.desktop.saveReadingPosition({
        id: book.id,
        position: current.ordinal,
      })
      if (!alive.current) return
      if (
        result.ok &&
        anchor.current.ordinal === current.ordinal &&
        anchor.current.offset === current.offset
      )
        storeReaderAnchor(book.id, current)
      if (result.ok) {
        savedOrdinal.current = current.ordinal
        if (anchor.current.ordinal === current.ordinal) setSaved(true)
      } else setError(result.error.message)
    } catch {
      if (alive.current) setError('阅读位置保存失败，请重试保存。')
    }
  }, [book.id])
  const record = useCallback(
    (value: ReaderAnchor) => {
      if (anchor.current.ordinal === value.ordinal && anchor.current.offset === value.offset) return
      anchor.current = value
      storeReaderAnchor(book.id, value)
      setLocation(value)
      window.clearTimeout(saveTimer.current)
      if (savedOrdinal.current !== value.ordinal) {
        setSaved(false)
        saveTimer.current = window.setTimeout(() => void persist(), 220)
      }
    },
    [book.id, persist],
  )
  const fetchPage = useCallback(
    (start: number) => {
      const existing = cache.current.get(start)
      if (existing) return existing
      const request = window.desktop
        .getReadingPage({ id: book.id, start })
        .then((result) => {
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        })
        .catch((error) => {
          cache.current.delete(start)
          throw error
        })
      cache.current.set(start, request)
      if (cache.current.size > 9) cache.current.delete(cache.current.keys().next().value!)
      return request
    },
    [book.id],
  )
  const go = useCallback(
    async (value: ReaderAnchor, direction = 0, snapshot: BookPageSnapshot | null = null) => {
      const target = {
        ordinal: Math.max(0, Math.min(value.ordinal, book.sentenceCount - 1)),
        offset: Math.max(0, value.offset),
      }
      const serial = ++generation.current
      if (viewport.current) cancelPageTurn(viewport.current)
      pendingTurn.current = direction
      pendingSnapshot.current = snapshot
      stopScrolling()
      restoring.current = true
      scrollIntent.current = false
      setBusy(true)
      setError('')
      try {
        const result = await Promise.all(
          readerChunkStarts(target.ordinal, book.sentenceCount).map(fetchPage),
        )
        if (!alive.current || serial !== generation.current) return
        pending.current = target
        documentPages.current = result
        setPages(result)
        record(target)
      } catch (error) {
        if (alive.current && serial === generation.current)
          setError(error instanceof Error ? error.message : '正文加载失败。')
      } finally {
        if (alive.current && serial === generation.current) setBusy(false)
      }
    },
    [book.sentenceCount, fetchPage, record, stopScrolling],
  )
  useEffect(() => {
    alive.current = true
    const element = viewport.current
    void Promise.resolve().then(() => go(anchor.current))
    const stop = window.desktop.onFlush(() => {
      void persist()
    })
    const flush = () => {
      void persist()
    }
    window.addEventListener('pagehide', flush)
    return () => {
      alive.current = false
      window.clearTimeout(saveTimer.current)
      cancelAnimationFrame(frame.current)
      cancelAnimationFrame(restoreFrame.current)
      if (element) cancelPageTurn(element)
      pendingSnapshot.current = null
      stop()
      window.removeEventListener('pagehide', flush)
      void persist()
    }
  }, [go, persist])
  const updateMetrics = useCallback(() => {
    if (!viewport.current?.firstElementChild) return
    const element = viewport.current
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
  }, [viewport])
  const restore = useCallback(() => {
    const element = viewport.current
    if (!element || !element.firstElementChild || !documentPages.current.length) return
    stopScrolling()
    restoring.current = true
    scrollIntent.current = false
    restoreReaderAnchor(element, pending.current ?? anchor.current, settings.mode)
    pending.current = null
    updateMetrics()
    if (pendingTurn.current && settings.mode === 'pages') {
      animatePageTurn(
        element,
        {
          pageAnimation: settings.pageAnimation,
          animationDuration: settings.animationDuration,
          reduceMotion: settings.reduceMotion,
        },
        pendingTurn.current,
        pendingSnapshot.current,
      )
      pendingTurn.current = 0
      pendingSnapshot.current = null
    }
    cancelAnimationFrame(restoreFrame.current)
    restoreFrame.current = requestAnimationFrame(() => {
      restoring.current = false
    })
  }, [
    settings.mode,
    settings.pageAnimation,
    settings.animationDuration,
    settings.reduceMotion,
    stopScrolling,
    updateMetrics,
    viewport,
  ])
  useLayoutEffect(() => {
    if (!busy) restore()
  }, [
    pages,
    busy,
    settings.fontSize,
    settings.fontFamily,
    settings.lineHeight,
    settings.contentWidth,
    settings.fontWeight,
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
    const resize = () => {
      if (element.clientWidth === width && element.clientHeight === height) return
      width = element.clientWidth
      height = element.clientHeight
      cancelPageTurn(element)
      restoring.current = true
      cancelAnimationFrame(restoreFrame.current)
      restoreFrame.current = requestAnimationFrame(restore)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    window.addEventListener('resize', resize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', resize)
    }
  }, [restore, viewport])
  const extend = useCallback(
    async (direction: number) => {
      const current = documentPages.current
      const start =
        direction > 0
          ? (current.at(-1)?.start ?? 0) + ORIGINAL_PAGE_SIZE
          : (current[0]?.start ?? 0) - ORIGINAL_PAGE_SIZE
      if (extending.current || start < 0 || start >= book.sentenceCount || !current.length) return
      const serial = generation.current
      extending.current = true
      try {
        const page = await fetchPage(start)
        if (!alive.current || serial !== generation.current) return
        const latest = documentPages.current
        if (latest.some((item) => item.start === page.start)) return
        const next = [...latest, page].sort((a, b) => a.start - b.start)
        if (next.length > 5) {
          if (direction > 0 && anchor.current.ordinal >= next[1]!.start) next.shift()
          else if (direction < 0 && anchor.current.ordinal < next.at(-1)!.start) next.pop()
        }
        pending.current = anchor.current
        restoring.current = true
        documentPages.current = next
        setPages(next)
      } catch (error) {
        if (alive.current && serial === generation.current)
          setError(error instanceof Error ? error.message : '后续正文加载失败，请重试。')
      } finally {
        extending.current = false
      }
    },
    [book.sentenceCount, fetchPage],
  )
  const checkEdges = useCallback(() => {
    const element = viewport.current
    if (!element || !documentPages.current.length || smoothTarget.current !== null) return
    if (settings.mode === 'scroll') {
      if (element.scrollHeight - element.scrollTop - element.clientHeight < element.clientHeight)
        void extend(1)
      else if (element.scrollTop < element.clientHeight / 2) void extend(-1)
    } else {
      const view = pageMetrics(element)
      if (view.column >= view.columns - 2) void extend(1)
      else if (view.column <= 1) void extend(-1)
    }
  }, [extend, settings.mode, viewport])
  useEffect(() => {
    if (busy) return
    const next = requestAnimationFrame(() => {
      const element = viewport.current
      if (!element) return
      if (
        (settings.mode === 'scroll' && element.scrollHeight <= element.clientHeight) ||
        (settings.mode === 'pages' && pageMetrics(element).columns <= 1)
      )
        checkEdges()
    })
    return () => cancelAnimationFrame(next)
  }, [
    pages,
    busy,
    settings.fontSize,
    settings.lineHeight,
    settings.contentWidth,
    settings.letterSpacing,
    settings.paragraphSpacing,
    settings.mode,
    checkEdges,
  ])
  const userScroll = useCallback(() => {
    stopScrolling()
    cancelAnimationFrame(restoreFrame.current)
    restoring.current = false
    scrollIntent.current = true
  }, [stopScrolling])
  const scrolled = useCallback(() => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      if (restoring.current || busy || !viewport.current) return
      if (scrollIntent.current) {
        const current = visibleReaderAnchor(viewport.current, settings.mode)
        if (current) record(current)
      }
      updateMetrics()
      checkEdges()
    })
  }, [busy, checkEdges, record, settings.mode, updateMetrics, viewport])
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const ended = () => {
      if (smoothTarget.current !== null && Math.abs(element.scrollTop - smoothTarget.current) > 2)
        return
      smoothTarget.current = null
      scrolled()
    }
    element.addEventListener('scrollend', ended)
    return () => element.removeEventListener('scrollend', ended)
  }, [scrolled])
  const turn = useCallback(
    (direction: number) => {
      const element = viewport.current
      if (!element || busy || !documentPages.current.length) return
      const animationSettings = {
        pageAnimation: settings.pageAnimation,
        animationDuration: settings.animationDuration,
        reduceMotion: settings.reduceMotion,
      }
      if (settings.mode === 'scroll') {
        const previousTarget = smoothTarget.current
        userScroll()
        const target = Math.max(
          0,
          Math.min(
            element.scrollHeight - element.clientHeight,
            (previousTarget ?? element.scrollTop) +
              direction * Math.max(100, element.clientHeight - 40),
          ),
        )
        const smooth =
          settings.smoothScroll && !reducedReaderMotion({ reduceMotion: settings.reduceMotion })
        smoothTarget.current = smooth && Math.abs(target - element.scrollTop) > 1 ? target : null
        element.scrollTo({
          top: target,
          behavior: smooth ? 'smooth' : 'instant',
        })
        scrolled()
      } else {
        const view = pageMetrics(element)
        const next = view.column + direction
        if (next >= 0 && next < view.columns) {
          cancelPageTurn(element)
          const snapshot = captureBookPage(element, animationSettings)
          restoring.current = true
          scrollIntent.current = false
          element.scrollLeft = next * view.stride
          const current = visibleReaderAnchor(element, 'pages')
          if (current) record(current)
          animatePageTurn(element, animationSettings, direction, snapshot)
          updateMetrics()
          checkEdges()
          cancelAnimationFrame(restoreFrame.current)
          restoreFrame.current = requestAnimationFrame(() => {
            restoring.current = false
          })
        } else if (direction > 0) {
          const last = documentPages.current.at(-1)?.sentences.at(-1)?.ordinal ?? 0
          if (last + 1 < book.sentenceCount) {
            cancelPageTurn(element)
            void go(
              { ordinal: last + 1, offset: 0 },
              direction,
              captureBookPage(element, animationSettings),
            )
          }
        } else {
          const first = documentPages.current[0]!.start
          if (first > 0) {
            cancelPageTurn(element)
            void go(
              { ordinal: first - 1, offset: Number.MAX_SAFE_INTEGER },
              direction,
              captureBookPage(element, animationSettings),
            )
          }
        }
      }
      element.focus({ preventScroll: true })
    },
    [
      book.sentenceCount,
      busy,
      checkEdges,
      go,
      record,
      scrolled,
      settings.mode,
      settings.smoothScroll,
      settings.reduceMotion,
      settings.pageAnimation,
      settings.animationDuration,
      updateMetrics,
      userScroll,
      viewport,
    ],
  )
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    let accumulated = 0,
      lastTurn = Number.NEGATIVE_INFINITY
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey) return
      if (settings.mode === 'scroll') {
        userScroll()
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
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [settings.mode, turn, userScroll, viewport])
  return {
    viewport,
    pages,
    location,
    busy,
    error,
    saved,
    go: (ordinal: number) => {
      void go({ ordinal, offset: 0 })
    },
    goAnchor: (value: ReaderAnchor) => {
      void go(value)
    },
    followAnchor: (value: ReaderAnchor) => {
      const element = viewport.current
      const sentence = element?.querySelector<HTMLElement>(`[data-sentence="${value.ordinal}"]`)
      const bounds = element?.getBoundingClientRect()
      const visible =
        !!bounds &&
        !!sentence &&
        Array.from(sentence.getClientRects()).some(
          (rect) =>
            rect.left >= bounds.left - 1 &&
            rect.right <= bounds.right + 1 &&
            rect.top >= bounds.top - 1 &&
            rect.bottom <= bounds.bottom + 1,
        )
      if (visible) record(value)
      else void go(value)
    },
    turn,
    scrolled,
    userScroll,
    rememberLayout: () => {
      if (viewport.current) cancelPageTurn(viewport.current)
      if (viewport.current && scrollIntent.current && !restoring.current) {
        const current = visibleReaderAnchor(viewport.current, settings.mode)
        if (current) record(current)
      }
      stopScrolling()
      pending.current = anchor.current
      restoring.current = true
    },
    retry: () => {
      void go(anchor.current)
      void persist()
    },
    flush: persist,
    canPrevious:
      location.ordinal > 0 || location.offset > 0 || metrics.column > 0 || metrics.moreAbove,
    canNext:
      !!pages.length &&
      ((settings.mode === 'scroll' ? metrics.moreBelow : metrics.column < metrics.columns - 1) ||
        (pages.at(-1)?.sentences.at(-1)?.ordinal ?? 0) < book.sentenceCount - 1),
  }
}
