import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ReadingBook } from '../../src/shared/reading'
import { readerPanelAppearance } from '../../src/renderer/src/reader-panel'
import {
  DEFAULT_READER_SETTINGS,
  densityPreset,
  DENSITY_PRESETS,
  normalizeReaderSettings,
  readBookPreferences,
  resolveReaderSettings,
  storeBookPreferences,
  colorContrast,
  readReaderPalettes,
  PALETTE_KEY,
} from '../../src/renderer/src/reader-settings'
import {
  initialReaderAnchor,
  readReaderSettings,
  readerChunkStarts,
  readingParagraphs,
  readingRoute,
  storeReaderAnchor,
  storeReaderSettings,
} from '../../src/renderer/src/reader-layout'

test('reader windows cover the requested sentence and its neighbors without crossing book bounds', () => {
  assert.deepEqual(readerChunkStarts(0, 900), [0, 60])
  assert.deepEqual(readerChunkStarts(179, 900), [60, 120, 180])
  assert.deepEqual(readerChunkStarts(899, 900), [780, 840])
  assert.deepEqual(readerChunkStarts(500, 1), [0])
  assert.deepEqual(readerChunkStarts(0, 0), [])
})

test('paragraphs join across fetch boundaries while keeping chapter boundaries distinct', () => {
  const sentence = (ordinal: number, chapter: number, paragraph: number) => ({
    ordinal,
    chapter,
    paragraph,
    text: `正文${ordinal}。`,
  })
  const result = readingParagraphs([
    sentence(58, 0, 4),
    sentence(59, 0, 4),
    sentence(60, 0, 4),
    sentence(61, 0, 5),
    sentence(62, 1, 5),
  ])
  assert.deepEqual(
    result.map((group) => group.map((item) => item.ordinal)),
    [[58, 59, 60], [61], [62]],
  )
})

test('reader routes survive refresh and reject malformed or unrelated routes', () => {
  assert.equal(readingRoute('#/read/book-123'), 'book-123')
  assert.equal(readingRoute('#/read/%E9%9D%92%E5%B1%B1'), '青山')
  for (const hash of ['#/library/ebooks', '#/read/', '#/read/a/b', '#/read/a?b', '#/read/%ff'])
    assert.equal(readingRoute(hash), null)
})

function withStorage(run: (values: Map<string, string>) => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  })
  try {
    run(values)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
}

test('reading settings migrate legacy preferences and validate persisted values', () =>
  withStorage((values) => {
    const defaults = readReaderSettings()
    values.set(
      'ralb:normal-reading:settings:v1',
      JSON.stringify({ fontSize: 24, lineHeight: 2.2, theme: 'dark' }),
    )
    const migrated = readReaderSettings()
    assert.equal(migrated.fontSize, 24)
    assert.equal(migrated.theme, 'dark')
    assert.equal(migrated.mode, 'pages')
    assert.equal(migrated.pageLayout, 'single')
    storeReaderSettings({
      ...migrated,
      mode: 'scroll',
      contentWidth: 900,
      fontFamily: 'sans',
      pageLayout: 'book',
      pageAnimation: 'book',
    })
    assert.equal(readReaderSettings().mode, 'scroll')
    assert.equal(readReaderSettings().contentWidth, 900)
    assert.equal(readReaderSettings().pageLayout, 'book')
    assert.equal(readReaderSettings().pageAnimation, 'book')
    values.set(
      'ralb:reader:global:v3',
      JSON.stringify({ fontSize: 999, lineHeight: -1, theme: 'unknown' }),
    )
    assert.deepEqual(readReaderSettings(), defaults)
    values.set('ralb:reader:global:v3', '{invalid')
    assert.equal(readReaderSettings().fontSize, 24)
  }))

test('per-book fields override global defaults, inherit other changes, and survive scope switches', () =>
  withStorage(() => {
    const global = { ...DEFAULT_READER_SETTINGS }
    storeBookPreferences('first', { enabled: true, overrides: { fontSize: 30 } })
    storeBookPreferences('second', { enabled: true, overrides: { lineHeight: 2.2 } })
    const first = readBookPreferences('first'),
      second = readBookPreferences('second')
    assert.equal(resolveReaderSettings(global, first).fontSize, 30)
    assert.equal(resolveReaderSettings({ ...global, letterSpacing: 1 }, first).letterSpacing, 1)
    assert.equal(resolveReaderSettings(global, second).fontSize, 20)
    storeBookPreferences('first', { ...first, enabled: false })
    assert.equal(resolveReaderSettings(global, readBookPreferences('first')).fontSize, 20)
    storeBookPreferences('first', { ...readBookPreferences('first'), enabled: true })
    assert.equal(resolveReaderSettings(global, readBookPreferences('first')).fontSize, 30)
  }))

test('density presets resolve to custom on fine adjustment and malformed settings cannot inject styles', () => {
  for (const [name, value] of Object.entries(DENSITY_PRESETS)) {
    const settings = { ...DEFAULT_READER_SETTINGS, ...value }
    assert.equal(densityPreset(settings), name)
    assert.equal(densityPreset({ ...settings, letterSpacing: 2.9 }), 'custom')
  }
  assert.deepEqual(
    normalizeReaderSettings({
      fontSize: 200,
      lineHeight: 0,
      contentWidth: -1,
      backgroundColor: 'url(evil)',
      textColor: '#123',
      mode: 'pdf',
      pageLayout: 'invalid',
    }),
    {},
  )
  assert.equal(
    normalizeReaderSettings({
      fontSize: 36,
      lineHeight: 2.4,
      letterSpacing: 3,
      paragraphSpacing: 1.8,
      contentWidth: 900,
    }).fontSize,
    36,
  )
  assert.equal(
    resolveReaderSettings(DEFAULT_READER_SETTINGS, { enabled: true, overrides: { theme: 'dark' } })
      .backgroundColor,
    '#1B1E1C',
  )
  assert.equal(normalizeReaderSettings({ panelTransparency: 60 }).panelTransparency, 60)
  assert.deepEqual(
    normalizeReaderSettings({ panelTransparency: 101, pageAnimation: 'invalid' }),
    {},
  )
  for (const pageAnimation of ['rise', 'zoom', 'flip', 'wipe', 'book'])
    assert.equal(normalizeReaderSettings({ pageAnimation }).pageAnimation, pageAnimation)
})

test('saved palettes are bounded and contrast warning uses both selected colors', () =>
  withStorage((values) => {
    assert.equal(colorContrast('#FFFFFF', '#000000'), 21)
    assert.equal(colorContrast('#FFFFFF', '#FFFFFF'), 1)
    assert.ok(colorContrast('#F4EFDF', '#39382F') > 4.5)
    values.set(
      PALETTE_KEY,
      JSON.stringify(
        Array.from({ length: 20 }, (_, i) => ({
          id: String(i),
          name: '颜色',
          backgroundColor: '#ffffff',
          textColor: '#123456',
        })),
      ),
    )
    assert.equal(readReaderPalettes().length, 8)
    values.set(
      PALETTE_KEY,
      JSON.stringify([{ id: 'a', name: '错误', backgroundColor: 'url(x)', textColor: '#123456' }]),
    )
    assert.deepEqual(readReaderPalettes(), [])
  }))

test('transparent reader panels keep labels, hints and menus readable across app and reading colors', () => {
  for (const background of [
    '#FAFAF7',
    '#F4EFDF',
    '#E4EDDF',
    '#1B1E1C',
    '#808080',
    '#AA4488',
    '#00AAFF',
  ]) {
    for (const theme of ['light', 'dark'] as const) {
      for (let transparency = 0; transparency <= 100; transparency++) {
        const { variables } = readerPanelAppearance(background, theme, transparency)
        for (const foreground of ['--ui-text', '--ui-muted', '--ui-accent'] as const) {
          for (const surface of ['--reader-panel-solid', '--ui-field', '--ui-hover'] as const) {
            assert.ok(
              colorContrast(variables[surface], variables[foreground]) >= 4.5,
              `${background}/${theme}/${transparency}/${foreground}/${surface}`,
            )
          }
        }
      }
    }
  }
  assert.equal(readerPanelAppearance('#FAFAF7', 'dark', 100).tone, 'light')
  assert.equal(readerPanelAppearance('#1B1E1C', 'light', 100).tone, 'dark')
})

test('character anchors survive database timestamp rounding and defer to a newer database position', () =>
  withStorage((values) => {
    const book: ReadingBook = {
      id: 'book',
      hash: 'hash',
      parserVersion: 2,
      title: '书',
      sourceName: '书.txt',
      format: 'txt',
      encoding: 'utf-8',
      bytes: 100,
      chapters: [],
      warnings: [],
      sentenceCount: 500,
      importedAt: new Date().toISOString(),
      position: 60,
      lastReadAt: null,
    }
    storeReaderAnchor(book.id, { ordinal: 60, offset: 128 })
    book.lastReadAt = new Date(Date.now() + 10).toISOString()
    assert.deepEqual(initialReaderAnchor(book), { ordinal: 60, offset: 128 })
    book.position = 120
    book.lastReadAt = new Date(Date.now() + 1000).toISOString()
    assert.deepEqual(initialReaderAnchor(book), { ordinal: 120, offset: 0 })
    values.set(
      'ralb:reading:anchor:book',
      JSON.stringify({ ordinal: 500, offset: 0, updatedAt: Date.now() + 2000 }),
    )
    assert.deepEqual(initialReaderAnchor(book), { ordinal: 120, offset: 0 })
  }))
