import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import { CHANNELS } from '../../src/shared/contracts'
import { closeOwnedElectron } from '../model/electron-lifecycle'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'player-icons-'))
  const path = join(root, '山间来信与远方的风景，一个较长的章节标题.wav')
  const wav = Buffer.alloc(44 + 90 * 16000)
  wav.write('RIFF')
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24)
  wav.writeUInt32LE(16000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(wav.length - 44, 40)
  writeFileSync(path, wav)
  const store = new LibraryStore(createDataPaths(root).database)
  store.importBook(await scanBook(path, 'file'))
  const book = store.listBooks()[0]!,
    episode = book.episodes[0]!
  store.recordSourceDuration(episode.id, episode.contentHash, 90000)
  store.saveTranscript(episode.id, {
    version: 1,
    kind: 'manual',
    audioHash: episode.contentHash,
    coverage: [
      { startMs: 0, endMs: 30000 },
      { startMs: 60000, endMs: 90000 },
    ],
    segments: [{ id: 's0', startMs: 61000, endMs: 89000, text: '山间来信写下了远方的风景。' }],
  })
  store.saveProgress({
    sessionId: '',
    episodeId: episode.id,
    positionMs: 65000,
    durationMs: 90000,
    rate: 2,
    volume: 0,
  })
  store.close()
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
  const page = await app.firstWindow()
  await page.bringToFront()
  return { app, page, title: episode.title, bookTitle: book.title }
}

const mediaState = (page: Page) =>
  page.locator('audio[data-player="persistent"]').evaluate((node: HTMLAudioElement) => ({
    source: node.currentSrc,
    time: node.currentTime,
    paused: node.paused,
  }))
async function seekTo(page: Page, value: number) {
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill(String(value))
  await expect.poll(async () => (await mediaState(page)).time).toBeCloseTo(value / 1000, 3)
}
async function playerGeometry(panel: Locator) {
  return panel.evaluate((node) => {
    const rect = (element: Element) => {
      const value = element.getBoundingClientRect()
      return {
        x: value.x,
        y: value.y,
        width: value.width,
        height: value.height,
        right: value.right,
        bottom: value.bottom,
      }
    }
    const controls = Array.from(
      node.querySelectorAll<HTMLElement>(
        '.audio-settings button, .audio-settings select, .audio-settings summary, .transport button',
      ),
    ).filter(
      (element) =>
        element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden',
    )
    const bounds = rect(node),
      rail = rect(node.querySelector('.player-seek-rail')!),
      seek = rect(node.querySelector('[aria-label="播放进度"]')!),
      play = rect(node.querySelector('.play-button')!),
      title = rect(node.querySelector('.now-playing h2')!),
      book = rect(node.querySelector('.now-playing > p')!)
    return {
      bounds,
      rail,
      seek,
      play,
      title,
      book,
      controlBounds: controls.map(rect),
      titleChildren: Array.from(node.querySelector('.now-playing')!.children).map(
        (element) => element.tagName,
      ),
      overflow: document.documentElement.scrollWidth > innerWidth,
    }
  })
}

async function expectTrackPaintOnBoundary(
  app: ElectronApplication,
  page: Page,
  panel: Locator,
  info: TestInfo,
  name: string,
) {
  // Inspect the actual WebKit track painting, not the 16px input's rectangle:
  // the old centered native track passed all hit-area geometry assertions.
  await page.mouse.move(20, 20)
  // Blur instead of focusing another tooltip trigger: its zero-delay timer
  // could open after Escape and paint a bubble over the sampled track strip.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  const metrics = await panel.evaluate((node) => {
    const bounds = node.getBoundingClientRect()
    const rail = node.querySelector<HTMLElement>('.player-seek-rail')!
    const input = rail.querySelector('input')!
    const railBounds = rail.getBoundingClientRect()
    const row = node.querySelector('.reader-dock-row')?.getBoundingClientRect()
    const resolve = (value: string) => {
      const probe = document.createElement('span')
      probe.style.cssText = `position:fixed;visibility:hidden;color:${value}`
      node.append(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number)
    }
    const track = getComputedStyle(input, '::-webkit-slider-runnable-track')
    return {
      panelTop: bounds.top,
      borderTop: getComputedStyle(node).borderTopWidth,
      rowBottom: row?.bottom,
      rail: {
        x: railBounds.x,
        y: railBounds.y,
        width: railBounds.width,
        height: railBounds.height,
      },
      trackStyle: { height: track.height, transform: track.transform },
      colors: {
        played: resolve('var(--ui-accent)'),
        remaining: resolve('var(--ui-line)'),
        background: resolve(getComputedStyle(node).backgroundColor),
      },
      sourceControls: Array.from(
        node.querySelectorAll<HTMLElement>(
          '.reader-dock-row button, .reader-dock-row input, .reader-dock-row select',
        ),
      )
        .filter((element) => element.checkVisibility({ visibilityProperty: true }))
        .map((element) => ({
          name: element.getAttribute('aria-label') ?? element.textContent?.trim(),
          className: element.className,
          top: element.getBoundingClientRect().top,
          bottom: element.getBoundingClientRect().bottom,
        })),
    }
  })
  expect(metrics.borderTop).toBe('0px')
  expect(metrics.rail.height).toBe(16)
  expect(Math.abs(metrics.rail.y - (metrics.rowBottom ?? metrics.panelTop))).toBeLessThanOrEqual(1)
  await info.attach(`${name}-control-bounds`, {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  })
  expect(metrics.sourceControls.filter((element) => element.bottom > metrics.rail.y + 1)).toEqual(
    [],
  )
  const strip = await page.screenshot({
    path: info.outputPath(`${name}-track-paint.png`),
    animations: 'disabled',
    scale: 'css',
    clip: {
      x: metrics.rail.x,
      y: metrics.rail.y,
      width: metrics.rail.width,
      height: 14,
    },
  })
  const paint = await app.evaluate(
    ({ nativeImage }, data) => {
      const image = nativeImage.createFromBuffer(Buffer.from(data.image, 'base64'))
      const { width, height } = image.getSize()
      const bitmap = image.toBitmap()
      const sample = (fraction: number) => {
        const x = Math.floor(width * fraction)
        return Array.from({ length: height }, (_, y) => {
          const offset = (y * width + x) * 4
          return [bitmap[offset + 2]!, bitmap[offset + 1]!, bitmap[offset]!]
        })
      }
      return { width, height, played: sample(0.15), remaining: sample(0.85) }
    },
    { image: strip.toString('base64') },
  )
  await info.attach(`${name}-track-pixels`, {
    body: JSON.stringify({ metrics, paint }, null, 2),
    contentType: 'application/json',
  })
  for (const kind of ['played', 'remaining'] as const) {
    for (let y = 0; y < 3; y++) {
      const difference = Math.max(
        ...paint[kind][y]!.map((value, channel) =>
          Math.abs(value - metrics.colors[kind][channel]!),
        ),
      )
      expect(
        difference,
        `${kind} track row ${y} must paint directly on the boundary`,
      ).toBeLessThanOrEqual(2)
    }
    // The former track occupied rows 6–9. They must now be plain player paper,
    // leaving one boundary line rather than a border plus an inset track.
    for (let y = 6; y <= 10; y++) {
      const difference = Math.max(
        ...paint[kind][y]!.map((value, channel) =>
          Math.abs(value - metrics.colors.background[channel]!),
        ),
      )
      expect(
        difference,
        `${kind} old inset-track row ${y} must be player background`,
      ).toBeLessThanOrEqual(2)
    }
  }
}

for (const [width, height] of [
  [1180, 800],
  [720, 600],
]) {
  test(`single-row player keeps full-width top seeking, centered transport and exact subtitle details at ${width}px`, async ({}, info) => {
    const { app, page, title, bookTitle } = await fixture()
    try {
      await app.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height),
        { width: width!, height: height! },
      )
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
      const panel = page.getByRole('region', { name: '播放器', exact: true })
      const seek = panel.getByRole('slider', { name: '播放进度', exact: true })
      await expect(panel.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
      const audio = page.locator('audio[data-player="persistent"]')
      const originalElement = await audio.elementHandle()
      const original = await mediaState(page)
      expect(original.paused).toBe(true)
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme })
        await expect(page.locator('html')).toHaveAttribute('data-ui-theme', theme)
        await expect(panel.locator('.now-playing h2')).toHaveText(title)
        await expect(panel.locator('.now-playing > p')).toHaveText(bookTitle)
        await expect(panel.locator('time')).toHaveCount(0)
        const geometry = await playerGeometry(panel)
        await info.attach(`player-geometry-${theme}`, {
          body: JSON.stringify(geometry, null, 2),
          contentType: 'application/json',
        })
        expect(geometry.titleChildren).toEqual(['H2', 'P'])
        expect(geometry.bounds.height).toBe(84)
        expect(Math.abs(geometry.rail.x - geometry.bounds.x)).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.rail.right - geometry.bounds.right)).toBeLessThanOrEqual(1)
        expect(Math.abs(geometry.rail.y - geometry.bounds.y)).toBeLessThanOrEqual(1)
        expect(geometry.rail.height).toBe(16)
        expect(geometry.seek.width).toBeGreaterThanOrEqual(geometry.bounds.width - 2)
        expect(
          Math.abs(geometry.play.x + geometry.play.width / 2 - width! / 2),
        ).toBeLessThanOrEqual(1)
        expect(geometry.title.bottom).toBeLessThanOrEqual(geometry.book.y + 1)
        for (const control of geometry.controlBounds) {
          expect(control.x).toBeGreaterThanOrEqual(geometry.bounds.x - 1)
          expect(control.right).toBeLessThanOrEqual(geometry.bounds.right + 1)
          expect(control.y).toBeGreaterThanOrEqual(geometry.rail.bottom - 1)
          expect(control.bottom).toBeLessThanOrEqual(geometry.bounds.bottom + 1)
        }
        expect(geometry.overflow).toBe(false)
        await expectTrackPaintOnBoundary(app, page, panel, info, `player-${width}-${theme}`)
        await seek.hover()
        await expect(
          page.getByRole('tooltip', { name: '已播放 01:05 / 总时长 01:30', exact: true }),
        ).toBeVisible()
        expect(await mediaState(page)).toEqual(original)
        await page.mouse.move(20, 20)
        await expect(page.getByRole('tooltip')).toHaveCount(0)
        await seek.focus()
        await expect(
          page.getByRole('tooltip', { name: '已播放 01:05 / 总时长 01:30', exact: true }),
        ).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(seek).toBeFocused()
        await expect(page.getByRole('tooltip')).toHaveCount(0)
        await seek.press('ArrowRight')
        await expect(seek).toHaveValue('70000')
        await expect.poll(async () => (await mediaState(page)).time).toBeCloseTo(70, 3)
        await expect(seek).toHaveAttribute('aria-valuetext', /已播放 01:10.*总时长 01:30/)
        await seek.press('ArrowLeft')
        await expect(seek).toHaveValue('65000')
        await seekTo(page, 11234)
        await seek.press('ArrowRight')
        await expect(seek).toHaveValue('16234')
        await seek.press('Home')
        await expect(seek).toHaveValue('0')
        await seek.press('ArrowLeft')
        await expect(seek).toHaveValue('0')
        await seek.press('End')
        await expect(seek).toHaveValue('90000')
        await seek.press('ArrowRight')
        await expect(seek).toHaveValue('90000')
        await seekTo(page, 65000)
        expect(await mediaState(page)).toEqual(original)
        await panel.getByRole('button', { name: '字幕与伴读', exact: true }).click()
        const tools = page.getByRole('dialog', { name: '收听工具', exact: true })
        await expect(tools.getByRole('tab', { name: '字幕与缓存', exact: true })).toHaveAttribute(
          'aria-selected',
          'true',
        )
        await tools.getByRole('button', { name: '关闭收听工具', exact: true }).click()
        for (const name of ['字幕与伴读', '伴读阅读']) {
          const action = panel.getByRole('button', { name, exact: true })
          await expect(action).toHaveText('')
          await expect(action.locator('svg')).toBeVisible()
          await expect(action).toBeInViewport({ ratio: 1 })
          await action.focus()
          await expect(page.getByRole('tooltip')).toBeVisible()
          await expect(action).not.toHaveAttribute('title')
          await page.keyboard.press('Escape')
          await expect(page.getByRole('tooltip')).toHaveCount(0)
          await expect(action).toBeFocused()
        }
        const summary = panel.locator('.subtitle-status-icon > summary')
        await expect(summary).toHaveAccessibleName(
          /字幕部分已备.*已备 01:00 \/ 01:30.*2×可听约 12 秒/,
        )
        await expect(panel.locator('.now-playing .subtitle-status-player')).toHaveCount(0)
        await expect(panel.locator('.player-right .subtitle-status-icon')).toHaveCount(1)
        await expect(summary).toHaveText('')
        await expect(summary.locator('svg')).toHaveCount(1)
        await expect(
          summary.locator('progress, .subtitle-status-value, .subtitle-status-lead'),
        ).toHaveCount(0)
        await summary.focus()
        await expect(page.getByRole('tooltip')).toContainText('覆盖 00:00–00:30、01:00–01:30')
        await page.keyboard.press('Escape')
        await summary.press('Enter')
        const status = panel.getByRole('group', { name: '字幕准备状态', exact: true })
        await expect(status).toContainText('已备 01:00 / 01:30')
        await expect(status).toContainText('从头连续 00:30')
        await expect(status).toContainText('25 秒音频，2×可听约 12 秒')
        const coverage = panel
          .locator('.subtitle-status-popup')
          .getByRole('progressbar', { name: '已保存字幕覆盖', exact: true })
        await expect(coverage).toHaveAttribute('value', '60000')
        await expect(coverage).toHaveAttribute('max', '90000')
        await panel.getByRole('button', { name: '收起字幕状态', exact: true }).click()
        await expect(coverage).toBeHidden()
        await page.mouse.move(20, 20)
        await page.screenshot({
          path: info.outputPath(`player-${width}-${theme}.png`),
          animations: 'disabled',
        })
      }
      await seekTo(page, 67000)
      const summary = panel.locator('.subtitle-status-icon > summary')
      await expect(summary).toHaveAccessibleName(/2×可听约 11 秒/)
      await summary.click()
      await expect(panel.getByRole('group', { name: '字幕准备状态', exact: true })).toContainText(
        '23 秒音频，2×可听约 11 秒',
      )
      await panel.getByRole('button', { name: '收起字幕状态', exact: true }).click()
      await panel.getByRole('button', { name: '伴读阅读', exact: true }).click()
      await expect(page.getByRole('region', { name: '同步伴读', exact: true })).toBeVisible()
      await expect(panel).toHaveCount(1)
      await expect(panel).toHaveAttribute('data-reader-dock', 'true')
      await expect(audio).toHaveCount(1)
      expect(
        await page.evaluate(
          (element) => document.querySelector('audio[data-player="persistent"]') === element,
          originalElement,
        ),
      ).toBe(true)
      expect(await mediaState(page)).toEqual({ ...original, time: 67 })
      const dock = await panel.boundingBox(),
        row = await panel.locator('.reader-dock-row').boundingBox(),
        rail = await panel.locator('.player-seek-rail').boundingBox()
      expect(Math.abs(rail!.x - dock!.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(rail!.x + rail!.width - dock!.x - dock!.width)).toBeLessThanOrEqual(1)
      expect(Math.abs(rail!.y - (row!.y + row!.height))).toBeLessThanOrEqual(1)
      await expectTrackPaintOnBoundary(app, page, panel, info, `reader-dock-${width}`)
    } finally {
      await closeOwnedElectron(app)
    }
  })
}

test('reduced motion keeps the top seek rail, time help and actual paused and playing media usable', async () => {
  const { app, page } = await fixture()
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const panel = page.getByRole('region', { name: '播放器', exact: true })
    const seek = panel.getByRole('slider', { name: '播放进度', exact: true })
    await expect(panel.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
    await seekTo(page, 12345)
    await seek.focus()
    await expect(
      page.getByRole('tooltip', { name: '已播放 00:12 / 总时长 01:30', exact: true }),
    ).toBeVisible()
    await seek.press('ArrowRight')
    await expect(seek).toHaveValue('17345')
    await expect.poll(async () => (await mediaState(page)).time).toBeCloseTo(17.345, 3)
    expect((await mediaState(page)).paused).toBe(true)
    const bounds = await playerGeometry(panel)
    expect(bounds.rail.width).toBeGreaterThanOrEqual(bounds.bounds.width - 2)
    await panel.getByRole('button', { name: '播放', exact: true }).click()
    await expect(panel.getByRole('button', { name: '暂停', exact: true })).toBeEnabled()
    await expect.poll(async () => (await mediaState(page)).time).toBeGreaterThan(17.4)
    await panel.getByRole('button', { name: '暂停', exact: true }).click()
    expect((await mediaState(page)).paused).toBe(true)
    await expect(page.locator('audio[data-player="persistent"]')).toHaveCount(1)
  } finally {
    await closeOwnedElectron(app)
  }
})

test('background subtitle checking stays in the right-hand status icon while audio continues', async ({}, info) => {
  const { app, page } = await fixture()
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const panel = page.getByRole('region', { name: '播放器', exact: true })
    const audio = page.locator('audio[data-player="persistent"]')
    const originalElement = await audio.elementHandle()
    const source = (await mediaState(page)).source
    await seekTo(page, 10000)
    await panel.getByRole('combobox', { name: '播放倍速', exact: true }).selectOption('0.5')
    await app.evaluate(({ ipcMain }, channel) => {
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
        string,
        (...args: unknown[]) => unknown
      >
      const original = handlers.get(channel)!
      Reflect.set(globalThis, 'playerCheckingCalls', 0)
      handlers.set(channel, async (...args) => {
        Reflect.set(
          globalThis,
          'playerCheckingCalls',
          Number(Reflect.get(globalThis, 'playerCheckingCalls')) + 1,
        )
        // Delay the real reply, leaving prepareSubtitles in its actual checking
        // state without replacing player state, media or subtitle contents.
        await new Promise<void>((resolve) => {
          Reflect.set(globalThis, 'releasePlayerChecking', resolve)
        })
        return original(...args)
      })
    }, CHANNELS.startAutomaticSubtitles)
    await panel.getByRole('button', { name: '播放', exact: true }).click()
    await expect
      .poll(() => app.evaluate(() => Reflect.get(globalThis, 'playerCheckingCalls')))
      .toBe(1)
    await expect.poll(async () => (await mediaState(page)).time).toBeGreaterThan(10.05)
    const summary = panel.locator('.audio-settings .subtitle-status-icon > summary')
    const checkingText = '正在后台检查字幕…'
    const observations: unknown[] = []
    for (const width of [1144, 720]) {
      await app.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height),
        { width, height: width === 1144 ? 761 : 600 },
      )
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
      for (const style of ['minimal', 'neumorphic']) {
        await page.evaluate((value) => {
          localStorage.setItem('ralb:app:style:v1', value)
          window.dispatchEvent(new Event('ralb:app-style'))
        }, style)
        await expect(page.locator('html')).toHaveAttribute('data-ui-style', style)
        for (const theme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: theme })
          await expect(page.locator('html')).toHaveAttribute('data-ui-theme', theme)
          await expect(summary).toHaveAttribute('aria-busy', 'true')
          await expect(summary).toHaveAccessibleName(new RegExp(`^字幕状态：${checkingText}`))
          await expect(
            summary.locator('[data-state="checking"] .subtitle-status-spinner'),
          ).toBeVisible()
          await expect(summary).toHaveText('')
          await expect(panel.locator('.player-subtitle-notice')).toHaveCount(0)
          await expect(panel.locator('.player-messages')).toHaveText('')
          const geometry = await panel.evaluate((node) => {
            const rect = (element: Element) => {
              const bounds = element.getBoundingClientRect()
              return {
                x: bounds.x,
                y: bounds.y,
                right: bounds.right,
                bottom: bounds.bottom,
                width: bounds.width,
                height: bounds.height,
              }
            }
            return {
              panel: rect(node),
              status: rect(node.querySelector('.subtitle-status-icon > summary')!),
              controls: rect(node.querySelector('.audio-settings')!),
              transport: rect(node.querySelector('.transport')!),
              overflow: document.documentElement.scrollWidth > innerWidth,
            }
          })
          expect(geometry.status.x).toBeGreaterThanOrEqual(geometry.controls.x - 1)
          expect(geometry.status.right).toBeLessThanOrEqual(geometry.controls.right + 1)
          expect(geometry.status.x).toBeGreaterThanOrEqual(geometry.transport.right - 1)
          expect(geometry.status.y).toBeGreaterThanOrEqual(geometry.panel.y)
          expect(geometry.status.bottom).toBeLessThanOrEqual(geometry.panel.bottom + 1)
          expect(geometry.panel.height).toBe(84)
          expect(geometry.overflow).toBe(false)
          const beforeHover = await mediaState(page)
          expect(beforeHover.paused).toBe(false)
          await page.mouse.move(20, 20)
          await summary.hover()
          const tip = page.getByRole('tooltip')
          await expect(tip).toContainText(checkingText)
          const bubble = await tip.boundingBox()
          expect(bubble).not.toBeNull()
          const horizontalOverlap =
            Math.min(bubble!.x + bubble!.width, geometry.transport.right) -
            Math.max(bubble!.x, geometry.transport.x)
          const verticalOverlap =
            Math.min(bubble!.y + bubble!.height, geometry.transport.bottom) -
            Math.max(bubble!.y, geometry.transport.y)
          expect(horizontalOverlap <= 0 || verticalOverlap <= 0).toBe(true)
          await expect
            .poll(async () => (await mediaState(page)).time)
            .toBeGreaterThan(beforeHover.time)
          expect((await mediaState(page)).paused).toBe(false)
          await page.screenshot({
            path: info.outputPath(`checking-${width}-${style}-${theme}.png`),
            animations: 'disabled',
          })
          observations.push({ width, style, theme, geometry, bubble })
          await page.mouse.move(20, 20)
          await expect(tip).toHaveCount(0)
        }
      }
    }
    // A simultaneous skip warning must keep its own visible and accessible
    // wording; background work stays represented by the busy subtitle icon.
    await panel.getByRole('button', { name: '字幕与伴读', exact: true }).click()
    const tools = page.getByRole('dialog', { name: '收听工具', exact: true })
    await tools.getByRole('tab', { name: '播放与定时', exact: true }).click()
    await tools.getByRole('spinbutton', { name: '跳过片头秒数', exact: true }).fill('120')
    await tools.getByRole('button', { name: '保存跳过设置', exact: true }).click()
    await expect(tools.getByText('本书跳过设置已保存。', { exact: true })).toBeVisible()
    await tools.getByRole('button', { name: '关闭收听工具', exact: true }).click()
    const skipText = '本集短于跳过时长，本集完整播放。'
    const skipNotice = panel.locator('.player-subtitle-notice')
    await expect(skipNotice).toHaveText(skipText)
    await expect(skipNotice).not.toContainText(checkingText)
    await expect(summary).toHaveAttribute('aria-busy', 'true')
    const skipGeometry = await panel.evaluate((node) => {
      const rect = (element: Element) => {
        const bounds = element.getBoundingClientRect()
        return { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom }
      }
      return {
        panel: rect(node),
        notice: rect(node.querySelector('.player-subtitle-notice')!),
        controls: rect(node.querySelector('.audio-settings')!),
        transport: rect(node.querySelector('.transport')!),
      }
    })
    expect(skipGeometry.notice.x).toBeGreaterThanOrEqual(skipGeometry.controls.x - 1)
    expect(skipGeometry.notice.right).toBeLessThanOrEqual(skipGeometry.controls.right + 1)
    expect(skipGeometry.notice.x).toBeGreaterThanOrEqual(skipGeometry.transport.right - 1)
    expect(skipGeometry.notice.y).toBeGreaterThanOrEqual(skipGeometry.panel.y)
    expect(skipGeometry.notice.bottom).toBeLessThanOrEqual(skipGeometry.panel.bottom + 1)
    const beforeSkipHelp = await mediaState(page)
    expect(beforeSkipHelp.paused).toBe(false)
    await skipNotice.locator(':scope > span').focus()
    await expect(page.getByRole('tooltip')).toHaveText(skipText)
    await page.screenshot({
      path: info.outputPath('checking-with-skip-notice-720-neumorphic-dark.png'),
      animations: 'disabled',
    })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await expect
      .poll(async () => (await mediaState(page)).time)
      .toBeGreaterThan(beforeSkipHelp.time)
    expect((await mediaState(page)).paused).toBe(false)
    observations.push({ state: 'checking-with-skip-notice', geometry: skipGeometry })
    await app.evaluate(() => {
      const release = Reflect.get(globalThis, 'releasePlayerChecking') as () => void
      release()
    })
    await expect(summary).not.toHaveAttribute('aria-busy', 'true')
    await expect(summary.locator('.subtitle-status-spinner')).toHaveCount(0)
    await expect(summary).toHaveAccessibleName(/字幕部分已备/)
    expect(await app.evaluate(() => Reflect.get(globalThis, 'playerCheckingCalls'))).toBe(1)
    expect((await mediaState(page)).source).toBe(source)
    expect((await mediaState(page)).paused).toBe(false)
    expect(
      await page.evaluate(
        (element) => document.querySelector('audio[data-player="persistent"]') === element,
        originalElement,
      ),
    ).toBe(true)
    await info.attach('background-check-status-geometry', {
      body: JSON.stringify(observations, null, 2),
      contentType: 'application/json',
    })
  } finally {
    await app
      .evaluate(() => {
        const release = Reflect.get(globalThis, 'releasePlayerChecking')
        if (typeof release === 'function') release()
      })
      .catch(() => undefined)
    await closeOwnedElectron(app)
  }
})
