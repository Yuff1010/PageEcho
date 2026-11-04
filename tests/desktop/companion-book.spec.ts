import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'

async function openBook() {
  const root = mkdtempSync(join(tmpdir(), '听读 书页伴读 '))
  const audio = join(root, '山间来信 · 第一章.wav')
  const wav = Buffer.alloc(44 + 180 * 16000)
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
  writeFileSync(audio, wav)
  const store = new LibraryStore(createDataPaths(root).database)
  store.importBook(await scanBook(audio, 'file'))
  const episode = store.listBooks()[0]!.episodes[0]!
  store.saveTranscript(episode.id, {
    version: 1,
    audioHash: episode.contentHash,
    kind: 'transcript',
    coverage: [{ startMs: 0, endMs: 180000 }],
    segments: Array.from({ length: 240 }, (_, index) => ({
      id: `s${index}`,
      startMs: index * 700,
      endMs: index * 700 + 650,
      text:
        index === 3
          ? 'The book.'
          : index === 4
            ? 'Tomorrow is another day.'
            : `第${index}封信写于山间，清晨的风穿过树梢。书页在桌上缓缓翻动，故事仍在继续。`,
    })),
  })
  store.saveProgress({
    sessionId: '',
    episodeId: episode.id,
    positionMs: 2800,
    durationMs: 180000,
    rate: 1,
    volume: 0,
  })
  store.close()
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setContentSize(1180, 820),
  )
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1180)
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  await expect(page.locator('.companion-prose .transcript-sentence')).toHaveCount(60)
  return { app, page }
}

async function clock(page: Page) {
  return page.locator('audio').evaluate((audio: HTMLAudioElement) => ({
    position: audio.currentTime,
    paused: audio.paused,
  }))
}

test('companion opens as a continuous book page; drawers overlay it and text selection does not seek', async ({}, info) => {
  const { app, page } = await openBook()
  try {
    await expect(page.locator('.companion-page')).toHaveAttribute('data-proofreading', 'false')
    await expect(page.locator('.sentence-actions')).toHaveCount(0)
    await expect(page.locator('.sentence-number:visible')).toHaveCount(0)
    await expect(page.locator('.companion-prose .transcript-sentence[tabindex="0"]')).toHaveCount(1)
    await expect(page.locator('.sidebar')).not.toBeVisible()
    await expect(page.locator('.companion-prose')).toContainText(
      'The book. Tomorrow is another day.',
      { useInnerText: true },
    )
    const viewport = page.getByLabel('文稿阅读区', { exact: true })
    const bounds = await viewport.boundingBox()
    expect(bounds!.height).toBeGreaterThan(820 * 0.6)
    await page.getByRole('button', { name: '伴读阅读设置', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '伴读阅读设置', exact: true })).toBeVisible()
    expect(await viewport.boundingBox()).toEqual(bounds)
    await page.getByRole('button', { name: '关闭伴读面板', exact: true }).click()
    const before = await clock(page)
    const first = page.locator('.transcript-sentence[data-segment-id="s0"]')
    const points = await first.locator('.transcript-sentence-text').evaluate((node) => {
      const text = node.firstChild!
      const range = document.createRange()
      range.setStart(text, 0)
      range.setEnd(text, 4)
      const box = range.getBoundingClientRect()
      return { left: box.left + 1, right: box.right - 1, y: box.top + box.height / 2 }
    })
    await page.mouse.move(points.left, points.y)
    await page.mouse.down()
    await page.mouse.move(points.right, points.y, { steps: 8 })
    await page.mouse.up()
    await expect
      .poll(() => page.evaluate(() => getSelection()?.toString().length ?? 0))
      .toBeGreaterThan(0)
    expect(await clock(page)).toEqual(before)
    await page.evaluate(() => getSelection()?.removeAllRanges())
    await first.focus()
    await first.press('Enter')
    await expect.poll(async () => (await clock(page)).position).toBeCloseTo(0, 2)
    const second = page.locator('.transcript-sentence[data-segment-id="s1"]')
    await second.focus()
    await second.press('Space')
    await expect.poll(async () => (await clock(page)).position).toBeCloseTo(0.7, 2)
    expect((await clock(page)).paused).toBe(true)
    await expect(second).toHaveAttribute('aria-current', 'true')
    await page.screenshot({
      path: info.outputPath('booklike-companion.png'),
      animations: 'disabled',
    })
  } finally {
    await app.close()
  }
})

test('book page follows media, preserves manual reading, searches across pages and exits focus mode', async ({}, info) => {
  const { app, page } = await openBook()
  try {
    const viewport = page.getByLabel('文稿阅读区', { exact: true })
    await page.getByRole('button', { name: '伴读阅读设置', exact: true }).click()
    const preferences = page.getByRole('dialog', { name: '伴读阅读设置', exact: true })
    await preferences.getByRole('tab', { name: '翻页', exact: true }).click()
    await preferences
      .getByRole('combobox', { name: '电子书翻页方式', exact: true })
      .selectOption('scroll')
    await preferences.getByRole('checkbox', { name: '平滑滚动', exact: true }).uncheck()
    await page.getByRole('button', { name: '关闭伴读面板', exact: true }).click()
    const progress = page.getByRole('slider', { name: '播放进度', exact: true })
    await progress.fill('80000')
    await expect(viewport.locator('[data-segment-id]').first()).toHaveAttribute(
      'data-segment-id',
      's60',
    )
    await expect(page.locator('.transcript-sentence[aria-current="true"]')).toBeInViewport()
    const before = await viewport.evaluate((node) => node.scrollTop)
    await viewport.hover()
    await page.mouse.wheel(0, -250)
    await expect(page.locator('.follow-state')).toHaveText('自由阅读')
    await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeLessThan(before)
    const manual = await viewport.evaluate((node) => node.scrollTop)
    await progress.fill('120000')
    await expect(viewport.locator('[data-segment-id]').first()).toHaveAttribute(
      'data-segment-id',
      's60',
    )
    expect(await viewport.evaluate((node) => node.scrollTop)).toBeCloseTo(manual, 0)
    await page.getByRole('button', { name: '回到当前播放位置', exact: true }).click()
    await expect(viewport.locator('[data-segment-id]').first()).toHaveAttribute(
      'data-segment-id',
      's120',
    )
    await expect(page.locator('.transcript-sentence[aria-current="true"]')).toHaveAttribute(
      'data-segment-id',
      's171',
    )
    const followedTop = await viewport.evaluate((node) => node.scrollTop)
    await page
      .getByRole('navigation', { name: '文稿翻页', exact: true })
      .getByRole('button', { name: '上一页', exact: true })
      .click()
    await expect(viewport.locator('[data-segment-id]').first()).toHaveAttribute(
      'data-segment-id',
      's120',
    )
    await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeLessThan(followedTop)
    await expect(page.locator('.follow-state')).toHaveText('自由阅读')
    const media = await clock(page)
    await page.getByRole('button', { name: '搜索伴读文稿', exact: true }).click()
    await page.getByRole('textbox', { name: '文稿搜索文字', exact: true }).fill('第190封信')
    await expect(page.getByRole('button', { name: '搜索文稿', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '搜索文稿', exact: true }).click()
    await page.locator('.transcript-search-results button').click()
    await expect(page.locator('.companion-search-panel')).toHaveCount(0)
    const hit = page.locator('.transcript-sentence[data-segment-id="s190"]')
    await expect(hit).toHaveAttribute('data-search-hit', 'true')
    await expect(hit).toBeInViewport()
    expect(await clock(page)).toEqual(media)
    await page.getByRole('button', { name: '专注伴读', exact: true }).click()
    await expect(page.getByRole('button', { name: '退出专注伴读', exact: true })).toBeVisible()
    await expect(page.locator('.companion-toolbar')).not.toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.companion-toolbar')).toBeVisible()
    await page.screenshot({
      path: info.outputPath('booklike-search-hit.png'),
      animations: 'disabled',
    })
  } finally {
    await app.close()
  }
})

test('small dark book page exposes proofreading only when requested and keeps playback reachable', async ({}, info) => {
  const { app, page } = await openBook()
  try {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(720, 600),
    )
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(720)
    await page.getByRole('button', { name: '伴读阅读设置', exact: true }).click()
    const preferences = page.getByRole('dialog', { name: '伴读阅读设置', exact: true })
    await preferences.getByRole('tab', { name: '外观', exact: true }).click()
    await preferences.getByRole('button', { name: '主题：夜间', exact: true }).click()
    await preferences.getByRole('tab', { name: '排版', exact: true }).click()
    await preferences.getByRole('slider', { name: '电子书字号', exact: true }).fill('28')
    await page.getByRole('button', { name: '关闭伴读面板', exact: true }).click()
    await expect(page.locator('.companion-page')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByRole('button', { name: '播放', exact: true })).toBeInViewport({
      ratio: 1,
    })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(page.locator('.sentence-actions')).toHaveCount(0)
    await page.screenshot({
      path: info.outputPath('booklike-small-dark.png'),
      animations: 'disabled',
    })
    await page.getByRole('button', { name: '伴读工具', exact: true }).click()
    await page.getByRole('button', { name: '校对与标注模式', exact: true }).click()
    await expect(page.locator('.companion-page')).toHaveAttribute('data-proofreading', 'true')
    await expect(page.getByRole('button', { name: '编辑第 1 句', exact: true })).toBeVisible()
    await expect(page.locator('.sentence-number').first()).toBeVisible()
  } finally {
    await app.close()
  }
})
