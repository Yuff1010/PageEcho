import type { ReaderAnchor, ReaderSettings } from './reader-layout'

export function pageMetrics(viewport: HTMLDivElement) {
  const gap = Number.parseFloat(getComputedStyle(viewport.firstElementChild!).columnGap) || 48
  const stride = viewport.clientWidth + gap
  return {
    stride,
    column: Math.round(viewport.scrollLeft / stride),
    columns: Math.max(1, Math.ceil((viewport.scrollWidth + gap) / stride - 0.01)),
  }
}
function characterRect(node: Text, offset: number) {
  const range = document.createRange()
  const start = Math.max(0, Math.min(offset, Math.max(0, node.length - 1)))
  range.setStart(node, start)
  range.setEnd(node, Math.min(node.length, start + 1))
  return range.getBoundingClientRect()
}
export function visibleReaderAnchor(
  viewport: HTMLDivElement,
  mode: ReaderSettings['mode'],
): ReaderAnchor | null {
  const bounds = viewport.getBoundingClientRect()
  for (const element of viewport.querySelectorAll<HTMLElement>('[data-sentence]')) {
    const visible = Array.from(element.getClientRects()).some(
      (rect) =>
        rect.right > bounds.left + 1 &&
        rect.left < bounds.right - 1 &&
        rect.bottom > bounds.top + 1 &&
        rect.top < bounds.bottom - 1,
    )
    if (!visible || element.firstChild?.nodeType !== Node.TEXT_NODE) continue
    const node = element.firstChild as Text
    let low = 0,
      high = node.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      const rect = characterRect(node, middle)
      const before =
        mode === 'pages' ? rect.right <= bounds.left + 1 : rect.bottom <= bounds.top + 1
      if (before) low = middle + 1
      else high = middle
    }
    return {
      ordinal: Number(element.dataset.sentence),
      offset: Math.min(low, Math.max(0, node.length - 1)),
    }
  }
  return null
}
export function restoreReaderAnchor(
  viewport: HTMLDivElement,
  anchor: ReaderAnchor,
  mode: ReaderSettings['mode'],
) {
  const element = viewport.querySelector<HTMLElement>(`[data-sentence="${anchor.ordinal}"]`)
  if (!element || element.firstChild?.nodeType !== Node.TEXT_NODE) return
  const bounds = viewport.getBoundingClientRect()
  const paragraph = element.parentElement
  const heading =
    anchor.offset === 0 &&
    paragraph?.firstElementChild === element &&
    paragraph.previousElementSibling?.matches('.ebook-chapter-title')
      ? paragraph.previousElementSibling
      : null
  const rect =
    heading?.getBoundingClientRect() ?? characterRect(element.firstChild as Text, anchor.offset)
  if (mode === 'pages') {
    const { stride } = pageMetrics(viewport)
    const column = Math.max(
      0,
      Math.floor((rect.left - bounds.left + viewport.scrollLeft + 1) / stride),
    )
    viewport.scrollLeft = column * stride
    viewport.scrollTop = 0
  } else {
    viewport.scrollLeft = 0
    viewport.scrollTop += rect.top - bounds.top - 8
  }
}
