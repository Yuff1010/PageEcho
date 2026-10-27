import type { ReaderSettings } from './reader-settings'
import { useSyncExternalStore } from 'react'
const systemMotionQuery = () => window.matchMedia('(prefers-reduced-motion: reduce)')
function subscribeSystemMotion(change: () => void) {
  const query = systemMotionQuery()
  query.addEventListener('change', change)
  return () => query.removeEventListener('change', change)
}
export function useSystemReducedMotion() {
  return useSyncExternalStore(subscribeSystemMotion, () => systemMotionQuery().matches)
}
const pageTurns = new WeakMap<HTMLElement, { animations: Animation[]; cleanup: () => void }>()
export function reducedReaderMotion(settings: Pick<ReaderSettings, 'reduceMotion'>) {
  return settings.reduceMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
export function cancelPageTurn(viewport: HTMLElement) {
  const turn = pageTurns.get(viewport)
  pageTurns.delete(viewport)
  turn?.animations.forEach((animation) => animation.cancel())
  turn?.cleanup()
}

export interface BookPageSnapshot {
  content: HTMLDivElement
  width: number
  height: number
  left: number
  pages: number
}
/** Keep the old page as a visual layer, separate from the live text and its anchors. */
export function captureBookPage(
  viewport: HTMLDivElement,
  settings: Pick<ReaderSettings, 'pageAnimation' | 'reduceMotion'>,
): BookPageSnapshot | null {
  if (settings.pageAnimation !== 'book' || reducedReaderMotion(settings)) return null
  const content = viewport.cloneNode(true) as HTMLDivElement
  content.className = 'reader-page-snapshot'
  for (const attribute of Array.from(content.attributes))
    if (attribute.name !== 'class') content.removeAttribute(attribute.name)
  content
    .querySelectorAll('[data-sentence]')
    .forEach((node) => node.removeAttribute('data-sentence'))
  const style = getComputedStyle(viewport)
  for (const property of [
    'font-family',
    'font-size',
    'font-weight',
    'line-height',
    'letter-spacing',
    'color',
    '--reader-page-count',
  ])
    content.style.setProperty(property, style.getPropertyValue(property))
  Object.assign(content.style, {
    position: 'absolute',
    top: '0',
    width: `${viewport.clientWidth}px`,
    height: `${viewport.clientHeight}px`,
    overflow: 'hidden',
    padding: '0',
    margin: '0',
    textAlign: 'justify',
  })
  content.inert = true
  content.setAttribute('aria-hidden', 'true')
  return {
    content,
    width: viewport.clientWidth,
    height: viewport.clientHeight,
    left: viewport.scrollLeft,
    pages: Number(style.getPropertyValue('--reader-page-count')) || 1,
  }
}
function rememberPageTurn(viewport: HTMLElement, animations: Animation[], cleanup = () => {}) {
  const turn = { animations, cleanup }
  pageTurns.set(viewport, turn)
  void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
    if (pageTurns.get(viewport) === turn) {
      pageTurns.delete(viewport)
      cleanup()
    }
  })
}
function animateBookTurn(
  viewport: HTMLDivElement,
  previous: BookPageSnapshot,
  settings: Pick<ReaderSettings, 'pageAnimation' | 'animationDuration' | 'reduceMotion'>,
  direction: number,
) {
  const current = captureBookPage(viewport, settings)!
  const layer = document.createElement('div')
  layer.className = 'reader-book-turn'
  layer.setAttribute('aria-hidden', 'true')
  layer.inert = true
  viewport.parentElement!.append(layer)
  const leaf = (snapshot: BookPageSnapshot, right: boolean, z: number) => {
    const page = document.createElement('div')
    page.className = 'reader-turn-leaf'
    const offset = snapshot.pages === 2 && right ? snapshot.width / 2 : 0
    Object.assign(page.style, {
      left: `${offset}px`,
      width: `${snapshot.width / snapshot.pages}px`,
      zIndex: String(z),
      transformOrigin: right ? 'left center' : 'right center',
    })
    const content = snapshot.content.cloneNode(true) as HTMLDivElement
    content.style.left = `${-offset}px`
    page.append(content)
    layer.append(page)
    content.scrollLeft = snapshot.left
    return page
  }
  const forward = direction > 0
  const moving = leaf(previous, forward, 4)
  const shade = document.createElement('span')
  shade.className = 'reader-turn-shade'
  moving.append(shade)
  const duration = settings.animationDuration
  const animations = [
    moving.animate(
      [{ transform: 'rotateY(0deg)' }, { transform: `rotateY(${forward ? -90 : 90}deg)` }],
      { duration: previous.pages === 2 ? duration / 2 : duration, easing: 'ease-in', fill: 'both' },
    ),
  ]
  if (previous.pages === 2) {
    const resting = leaf(previous, !forward, 1)
    const arriving = leaf(current, !forward, 3)
    animations.push(
      resting.animate(
        [{ opacity: 1 }, { opacity: 1, offset: 0.49 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }],
        { duration, fill: 'both' },
      ),
      arriving.animate(
        [{ transform: `rotateY(${forward ? 90 : -90}deg)` }, { transform: 'rotateY(0deg)' }],
        { duration: duration / 2, delay: duration / 2, easing: 'ease-out', fill: 'both' },
      ),
    )
  } else moving.style.transformOrigin = forward ? 'left center' : 'right center'
  rememberPageTurn(viewport, animations, () => layer.remove())
}

/** Animate the page frame, never the measured text columns or the saved anchor. */
export function animatePageTurn(
  viewport: HTMLDivElement,
  settings: Pick<ReaderSettings, 'pageAnimation' | 'animationDuration' | 'reduceMotion'>,
  direction: number,
  previous: BookPageSnapshot | null = null,
) {
  cancelPageTurn(viewport)
  if (reducedReaderMotion(settings) || settings.pageAnimation === 'none') return
  if (
    settings.pageAnimation === 'book' &&
    previous &&
    previous.width === viewport.clientWidth &&
    previous.height === viewport.clientHeight
  ) {
    animateBookTurn(viewport, previous, settings, direction)
    return
  }
  const frame = viewport.parentElement ?? viewport
  let target: HTMLElement = frame
  let frames: Keyframe[]
  switch (settings.pageAnimation) {
    case 'slide':
      frames = [
        { translate: `${direction * 48}px 0`, opacity: 0.25 },
        { translate: '0 0', opacity: 1 },
      ]
      break
    case 'rise':
      frames = [
        { translate: `0 ${direction * 32}px`, opacity: 0.2 },
        { translate: '0 0', opacity: 1 },
      ]
      break
    case 'zoom':
      frames = [
        { scale: '0.94', opacity: 0 },
        { scale: '1', opacity: 1 },
      ]
      break
    case 'flip': {
      const base = getComputedStyle(frame).transform
      const transform = base === 'none' ? '' : base
      frames = [
        {
          transform: `${transform} perspective(1200px) rotateY(${-direction * 24}deg)`,
          opacity: 0.1,
        },
        { transform: `${transform} perspective(1200px) rotateY(0deg)`, opacity: 1 },
      ]
      break
    }
    case 'wipe':
      target = viewport
      frames = [
        { clipPath: direction > 0 ? 'inset(0 100% 0 0)' : 'inset(0 0 0 100%)', opacity: 0.2 },
        { clipPath: 'inset(0 0 0 0)', opacity: 1 },
      ]
      break
    default:
      target = viewport
      frames = [{ opacity: 0 }, { opacity: 1 }]
  }
  rememberPageTurn(viewport, [
    target.animate(frames, {
      duration: settings.animationDuration,
      easing: 'ease-out',
    }),
  ])
}
