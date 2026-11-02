import { useEffect, useState } from 'react'

export interface ReaderSettings {
  fontSize: number
  fontFamily: 'serif' | 'sans' | 'kai' | 'system'
  fontWeight: 400 | 500 | 700
  lineHeight: number
  letterSpacing: number
  paragraphSpacing: number
  contentWidth: number
  indent: boolean
  theme: 'paper' | 'sepia' | 'green' | 'dark' | 'custom'
  backgroundColor: string
  textColor: string
  mode: 'pages' | 'scroll'
  pageLayout: 'single' | 'book'
  smoothScroll: boolean
  pageAnimation: 'none' | 'slide' | 'fade' | 'rise' | 'zoom' | 'flip' | 'wipe' | 'book'
  animationDuration: number
  reduceMotion: boolean
  panelTransparency: number
}
export const READING_THEMES = {
  paper: { label: '纸白', backgroundColor: '#FAFAF7', textColor: '#33352F' },
  sepia: { label: '米黄', backgroundColor: '#F4EFDF', textColor: '#39382F' },
  green: { label: '浅绿', backgroundColor: '#E4EDDF', textColor: '#354333' },
  dark: { label: '夜间', backgroundColor: '#1B1E1C', textColor: '#C9CEC7' },
} as const
export const READER_FONTS = {
  serif: { label: '宋体', family: '"Noto Serif CJK SC", "Source Han Serif SC", SimSun, serif' },
  sans: { label: '黑体', family: '"Microsoft YaHei", "Noto Sans CJK SC", "Segoe UI", sans-serif' },
  kai: { label: '楷体', family: 'KaiTi, STKaiti, "Noto Serif CJK SC", SimSun, serif' },
  system: { label: '应用界面字体', family: '"Segoe UI", "Microsoft YaHei UI", sans-serif' },
} as const
export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  fontSize: 20,
  fontFamily: 'serif',
  fontWeight: 400,
  lineHeight: 1.8,
  letterSpacing: 0,
  paragraphSpacing: 0.7,
  contentWidth: 680,
  indent: true,
  theme: 'sepia',
  backgroundColor: '#F4EFDF',
  textColor: '#39382F',
  mode: 'pages',
  pageLayout: 'single',
  smoothScroll: true,
  pageAnimation: 'fade',
  animationDuration: 180,
  reduceMotion: false,
  panelTransparency: 0,
}
export const DENSITY_PRESETS = {
  compact: { label: '紧凑', lineHeight: 1.5, letterSpacing: 0, paragraphSpacing: 0.3 },
  standard: { label: '标准', lineHeight: 1.8, letterSpacing: 0, paragraphSpacing: 0.7 },
  relaxed: { label: '舒展', lineHeight: 2, letterSpacing: 0.6, paragraphSpacing: 1.1 },
} as const
export function densityPreset(settings: ReaderSettings) {
  return (
    Object.entries(DENSITY_PRESETS).find(([, value]) =>
      (['lineHeight', 'letterSpacing', 'paragraphSpacing'] as const).every(
        (key) => Math.abs(value[key] - settings[key]) < 0.001,
      ),
    )?.[0] ?? 'custom'
  )
}
const GLOBAL_KEY = 'ralb:reader:global:v3'
const bookKey = (id: string) => `ralb:reader:book:${id}:v3`
function themeColors(settings: Partial<ReaderSettings>) {
  const theme =
    settings.theme && settings.theme !== 'custom' ? READING_THEMES[settings.theme] : null
  return theme ? { backgroundColor: theme.backgroundColor, textColor: theme.textColor } : {}
}
function read(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null')
  } catch {
    return null
  }
}
export function writeReaderPreference(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    if (typeof window !== 'undefined')
      window.dispatchEvent(new CustomEvent('ralb:reader-preferences-changed', { detail: key }))
    return true
  } catch {
    return false
  }
}
export function validColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
}
export function normalizeReaderSettings(value: unknown): Partial<ReaderSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const data = value as Record<string, unknown>,
    result: Partial<ReaderSettings> = {}
  const numeric = (key: keyof ReaderSettings, min: number, max: number, step: number) => {
    const number = data[key]
    if (typeof number === 'number' && Number.isFinite(number) && number >= min && number <= max)
      Object.assign(result, { [key]: Number((Math.round(number / step) * step).toFixed(3)) })
  }
  numeric('fontSize', 14, 36, 1)
  numeric('lineHeight', 1.3, 2.4, 0.05)
  numeric('letterSpacing', 0, 3, 0.1)
  numeric('paragraphSpacing', 0, 1.8, 0.1)
  numeric('contentWidth', 360, 900, 10)
  numeric('animationDuration', 100, 400, 10)
  numeric('panelTransparency', 0, 100, 1)
  if ([400, 500, 700].includes(Number(data.fontWeight)))
    result.fontWeight = Number(data.fontWeight) as ReaderSettings['fontWeight']
  if (typeof data.fontFamily === 'string' && Object.hasOwn(READER_FONTS, data.fontFamily))
    result.fontFamily = data.fontFamily as ReaderSettings['fontFamily']
  if (['paper', 'sepia', 'green', 'dark', 'custom'].includes(String(data.theme)))
    result.theme = data.theme as ReaderSettings['theme']
  if (data.mode === 'pages' || data.mode === 'scroll') result.mode = data.mode
  if (data.pageLayout === 'single' || data.pageLayout === 'book')
    result.pageLayout = data.pageLayout
  if (
    ['none', 'slide', 'fade', 'rise', 'zoom', 'flip', 'wipe', 'book'].includes(
      String(data.pageAnimation),
    )
  )
    result.pageAnimation = data.pageAnimation as ReaderSettings['pageAnimation']
  for (const key of ['indent', 'smoothScroll', 'reduceMotion'] as const)
    if (typeof data[key] === 'boolean') result[key] = data[key]
  for (const key of ['backgroundColor', 'textColor'] as const)
    if (validColor(data[key])) result[key] = data[key].toUpperCase()
  return result
}
export function readReaderSettings(): ReaderSettings {
  const stored = read(GLOBAL_KEY)
  if (stored && typeof stored === 'object')
    return {
      ...DEFAULT_READER_SETTINGS,
      ...themeColors(normalizeReaderSettings(stored)),
      ...normalizeReaderSettings(stored),
    }
  const old = read('ralb:normal-reading:settings:v2') ?? read('ralb:normal-reading:settings:v1')
  const migrated = normalizeReaderSettings(old)
  if (old && typeof old === 'object') {
    const legacy = old as Record<string, unknown>
    const widths: Record<string, number> = { narrow: 620, normal: 760, wide: 900 }
    if (typeof legacy.width === 'string' && widths[legacy.width])
      migrated.contentWidth = widths[legacy.width]
    if (migrated.theme && migrated.theme !== 'custom')
      Object.assign(migrated, themeColors(migrated))
  }
  return { ...DEFAULT_READER_SETTINGS, ...migrated }
}
export function storeReaderSettings(settings: ReaderSettings) {
  return writeReaderPreference(GLOBAL_KEY, normalizeReaderSettings(settings))
}
export interface BookReaderPreferences {
  enabled: boolean
  overrides: Partial<ReaderSettings>
}
export function readBookPreferences(id: string): BookReaderPreferences {
  const data = read(bookKey(id)) as Partial<BookReaderPreferences> | null
  return { enabled: data?.enabled === true, overrides: normalizeReaderSettings(data?.overrides) }
}
export function storeBookPreferences(id: string, value: BookReaderPreferences) {
  return writeReaderPreference(bookKey(id), {
    enabled: value.enabled,
    overrides: normalizeReaderSettings(value.overrides),
  })
}
export function resolveReaderSettings(
  global: ReaderSettings,
  book: BookReaderPreferences,
): ReaderSettings {
  const settings = {
    ...global,
    ...(book.enabled ? { ...themeColors(book.overrides), ...book.overrides } : {}),
  }
  if (
    settings.fontWeight === 500 &&
    (settings.fontFamily === 'serif' || settings.fontFamily === 'kai')
  )
    settings.fontWeight = 400
  return settings
}
export function useReaderPreferences(id: string, legacy?: () => Partial<ReaderSettings> | null) {
  const [global, setGlobal] = useState(readReaderSettings)
  const [book, setBook] = useState(() => {
    const existing = readBookPreferences(id)
    const fallback = !read(bookKey(id)) && !read(GLOBAL_KEY) ? legacy?.() : null
    return fallback ? { enabled: true, overrides: normalizeReaderSettings(fallback) } : existing
  })
  const [storageError, setStorageError] = useState('')
  useEffect(() => {
    const sync = (event: Event) => {
      const key = (event as CustomEvent<string>).detail
      if (!key || key === GLOBAL_KEY) setGlobal(readReaderSettings())
      if (key === bookKey(id)) setBook(readBookPreferences(id))
    }
    const external = (event: StorageEvent) => {
      if (!event.key || event.key === GLOBAL_KEY) setGlobal(readReaderSettings())
      if (event.key === bookKey(id)) setBook(readBookPreferences(id))
    }
    window.addEventListener('ralb:reader-preferences-changed', sync)
    window.addEventListener('storage', external)
    return () => {
      window.removeEventListener('ralb:reader-preferences-changed', sync)
      window.removeEventListener('storage', external)
    }
  }, [id])
  const report = (ok: boolean) =>
    setStorageError(ok ? '' : '本地偏好保存失败，当前设置仍有效；请检查磁盘空间。')
  const storeBook = (next: BookReaderPreferences) => {
    setBook(next)
    report(storeBookPreferences(id, next))
  }
  return {
    settings: resolveReaderSettings(global, book),
    scope: book.enabled ? ('book' as const) : ('global' as const),
    storageError,
    change: (patch: Partial<ReaderSettings>) => {
      if (book.enabled) storeBook({ ...book, overrides: { ...book.overrides, ...patch } })
      else {
        const next = { ...global, ...patch }
        setGlobal(next)
        report(storeReaderSettings(next))
      }
    },
    selectScope: (scope: 'global' | 'book') => storeBook({ ...book, enabled: scope === 'book' }),
    reset: () => {
      if (book.enabled) storeBook({ enabled: true, overrides: {} })
      else {
        setGlobal({ ...DEFAULT_READER_SETTINGS })
        report(storeReaderSettings(DEFAULT_READER_SETTINGS))
      }
    },
  }
}
export interface ReaderPalette {
  id: string
  name: string
  backgroundColor: string
  textColor: string
}
export const PALETTE_KEY = 'ralb:reader:palettes:v1'
export function readReaderPalettes(): ReaderPalette[] {
  const data = read(PALETTE_KEY)
  return Array.isArray(data)
    ? data
        .filter(
          (item): item is ReaderPalette =>
            item &&
            typeof item.id === 'string' &&
            item.id.length <= 100 &&
            typeof item.name === 'string' &&
            item.name.length <= 30 &&
            validColor(item.backgroundColor) &&
            validColor(item.textColor),
        )
        .slice(0, 8)
    : []
}
export function colorContrast(background: string, foreground: string) {
  const luminance = (color: string) => {
    const channels = [1, 3, 5]
      .map((start) => parseInt(color.slice(start, start + 2), 16) / 255)
      .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
  }
  const a = luminance(background),
    b = luminance(foreground)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
