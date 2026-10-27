import { expect, test, _electron as electron, type Locator, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
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
