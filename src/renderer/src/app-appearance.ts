import { useEffect, useSyncExternalStore } from 'react'

export type AppTheme = 'light' | 'dark' | 'system'
export type AppVisualStyle = 'minimal' | 'neumorphic'
const KEY = 'ralb:app:theme:v1',
  EVENT = 'ralb:app-theme',
  STYLE_KEY = 'ralb:app:style:v1',
  STYLE_EVENT = 'ralb:app-style'
function readTheme(): AppTheme {
  try {
    const value = localStorage.getItem(KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}
function readVisualStyle(): AppVisualStyle {
  try {
    return localStorage.getItem(STYLE_KEY) === 'minimal' ? 'minimal' : 'neumorphic'
  } catch {
    return 'neumorphic'
  }
}
function subscribe(callback: () => void) {
  window.addEventListener(EVENT, callback)
  window.addEventListener(STYLE_EVENT, callback)
  window.addEventListener('storage', callback)
  return () => {
    window.removeEventListener(EVENT, callback)
    window.removeEventListener(STYLE_EVENT, callback)
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
  const visualStyle = useSyncExternalStore(subscribe, readVisualStyle)
  const systemDark = useSyncExternalStore(
    subscribeSystemTheme,
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  const resolvedTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
  useEffect(() => {
    document.documentElement.dataset.uiTheme = resolvedTheme
    document.documentElement.dataset.uiStyle = visualStyle
  }, [resolvedTheme, visualStyle])
  return {
    theme,
    resolvedTheme,
    visualStyle,
    setTheme: (next: AppTheme) => {
      try {
        localStorage.setItem(KEY, next)
      } catch {
        return false
      }
      window.dispatchEvent(new Event(EVENT))
      return true
    },
    setVisualStyle: (next: AppVisualStyle) => {
      try {
        localStorage.setItem(STYLE_KEY, next)
      } catch {
        return false
      }
      window.dispatchEvent(new Event(STYLE_EVENT))
      return true
    },
  }
}
