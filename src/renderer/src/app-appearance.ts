import { useEffect, useSyncExternalStore } from 'react'

export type AppTheme = 'light' | 'dark' | 'system'
const KEY = 'ralb:app:theme:v1',
  EVENT = 'ralb:app-theme'
function readTheme(): AppTheme {
  try {
    const value = localStorage.getItem(KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}
function subscribe(callback: () => void) {
  window.addEventListener(EVENT, callback)
  window.addEventListener('storage', callback)
  return () => {
    window.removeEventListener(EVENT, callback)
    window.removeEventListener('storage', callback)
  }
}
function subscribeSystemTheme(callback: () => void) {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  query.addEventListener('change', callback)
  return () => query.removeEventListener('change', callback)
}
export function useAppAppearance() {
  const theme = useSyncExternalStore(subscribe, readTheme)
  const systemDark = useSyncExternalStore(
    subscribeSystemTheme,
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  const resolvedTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
  useEffect(() => {
    document.documentElement.dataset.uiTheme = resolvedTheme
  }, [resolvedTheme])
  return {
    theme,
    resolvedTheme,
    setTheme: (next: AppTheme) => {
      try {
        localStorage.setItem(KEY, next)
      } catch {
        return false
      }
      window.dispatchEvent(new Event(EVENT))
      return true
    },
  }
}
