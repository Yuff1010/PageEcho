import { useSyncExternalStore, type KeyboardEvent } from 'react'

const tabLayoutQuery = '(max-width: 760px)'
function subscribeTabLayout(callback: () => void) {
  const query = window.matchMedia(tabLayoutQuery)
  query.addEventListener('change', callback)
  return () => query.removeEventListener('change', callback)
}
export function useSettingsTabOrientation(): 'horizontal' | 'vertical' {
  return useSyncExternalStore(subscribeTabLayout, () => window.matchMedia(tabLayoutQuery).matches)
    ? 'horizontal'
    : 'vertical'
}

/** Automatic activation for a small, already-mounted settings tab set. */
export function settingsTabIndex(
  event: KeyboardEvent<HTMLElement>,
  index: number,
  count: number,
): number | null {
  if (event.altKey || event.ctrlKey || event.metaKey || count < 1) return null
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? count - 1
        : event.key === 'ArrowRight' || event.key === 'ArrowDown'
          ? (index + 1) % count
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
            ? (index + count - 1) % count
            : null
  if (next !== null) event.preventDefault()
  return next
}
