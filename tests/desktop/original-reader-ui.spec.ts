import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import { closeOwnedElectron } from '../model/electron-lifecycle'
import {
  closeCompanionPanel,
  closeOriginalPanel,
  menuAction,
  openCompanionSettings,
  openOriginalContents,
  openOriginalSearch,
  openOriginalTools,
  useOriginalText,
  waitForOriginalReady,
} from '../helpers/ui'

const originalLine = (index: number) => `第${index}封信从山间寄来，清晨的风穿过树梢，故事仍在继续。`

async function fixture(withTranscript = true) {
  const root = mkdtempSync(join(tmpdir(), '听读原文书页 ')),
    audioFolder = join(root, '山间来信'),
    original = join(root, '山间来信.txt')
  mkdirSync(audioFolder)
  for (let index = 1; index <= 2; index++) {
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
    wav[wav.length - 1] = index
    writeFileSync(join(audioFolder, `第${index}集.wav`), wav)
  }
  writeFileSync(
    original,
    Array.from(
      { length: 3 },
      (_, chapter) =>
        `第${chapter + 1}章 山间来信\n${Array.from({ length: 60 }, (_, offset) =>
          originalLine(chapter * 60 + offset),
        ).join('\n')}`,
    ).join('\n'),
  )
  const store = new LibraryStore(createDataPaths(root).database)
  store.importBook(await scanBook(audioFolder, 'folder'))
  const episodes = store.listBooks()[0]!.episodes
  if (withTranscript) {
    for (const episode of episodes) {
      store.saveTranscript(episode.id, {
        version: 1,
        audioHash: episode.contentHash,
        kind: 'manual',
        coverage: [{ startMs: 0, endMs: 180000 }],
        segments: [
          { id: 's0', startMs: 1000, endMs: 3000, text: originalLine(0) },
          { id: 's1', startMs: 10000, endMs: 12000, text: originalLine(61) },
        ],
      })
    }
  }
  store.saveProgress({
    sessionId: '',
    episodeId: episodes[0]!.id,
    positionMs: 0,
    durationMs: 180000,
    rate: 1,
    volume: 0,
  })
  store.close()
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
  const page = await app.firstWindow(),
    errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setContentSize(1180, 900),
  )
  const read = page.getByRole('button', { name: '伴读阅读', exact: true })
  await expect(read).toHaveText('')
  await expect(read.locator('svg')).toBeVisible()
  await expect(
    page.getByRole('navigation', { name: '书架导航', exact: true }).getByRole('button'),
  ).toHaveCount(2)
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  await useOriginalText(page)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, original)
  await page.getByRole('button', { name: '导入 TXT / EPUB 原文', exact: true }).click()
  await waitForOriginalReady(page)
  await expect(page.locator('.original-sentence')).toHaveCount(60)
  return { app, page, episodes, errors, root }
}

async function clock(page: Page) {
  return page.locator('audio').evaluate((audio: HTMLAudioElement) => ({
    position: audio.currentTime,
    paused: audio.paused,
    source: audio.currentSrc,
  }))
}

async function originalView(page: Page) {
  return page.locator('.original-viewport').evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const sentence = Array.from(element.querySelectorAll<HTMLElement>('[data-ordinal]')).find(
      (node) =>
        Array.from(node.getClientRects()).some(
          (rect) =>
            rect.right > bounds.left + 1 &&
            rect.left < bounds.right - 1 &&
            rect.bottom > bounds.top + 1 &&
            rect.top < bounds.bottom - 1,
        ),
    )
    return {
      left: element.scrollLeft,
      top: element.scrollTop,
      ordinal: Number(sentence?.dataset.ordinal ?? -1),
    }
  })
}

test('original text is a book page with separate overlay tools, contents and search at large and small sizes', async ({}, info) => {
  const { app, page, errors } = await fixture()
  try {
    const viewport = page.getByLabel('原文阅读区', { exact: true })
    const bodyBounds = await viewport.boundingBox()
    expect(bodyBounds!.height).toBeGreaterThan(900 * 0.55)
    await expect(page.locator('.original-number:visible')).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: '更换 TXT / EPUB 原文', exact: true }),
    ).toBeHidden()
    await expect(page.getByRole('button', { name: '匹配这一集转写稿', exact: true })).toBeHidden()
    await expect(page.locator('.original-review:visible')).toHaveCount(0)
    await expect(page.locator('.original-summary:visible')).toHaveCount(0)
    await openOriginalTools(page, '原文来源')
    const tools = page.getByRole('dialog', { name: '原文工具', exact: true })
    await expect(tools.getByRole('tab')).toHaveText(['原文来源', '匹配与校正', '字幕导出'])
    await expect(tools.locator('.original-summary')).toContainText('180 句')
    expect(await viewport.boundingBox()).toEqual(bodyBounds)
    await page.keyboard.press('Escape')
    await expect(tools).toBeHidden()
    await openOriginalContents(page)
    expect(await viewport.boundingBox()).toEqual(bodyBounds)
    await expect(page.getByRole('combobox', { name: '原文章节', exact: true })).toBeVisible()
    await closeOriginalPanel(page)
    await openOriginalSearch(page)
    expect(await viewport.boundingBox()).toEqual(bodyBounds)
    await closeOriginalPanel(page)
    await page.screenshot({
      path: info.outputPath('original-book-page.png'),
      animations: 'disabled',
    })
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(720, 600),
    )
    for (const theme of ['paper', 'dark']) {
      await openCompanionSettings(page)
      const preferences = page.getByRole('dialog', { name: '伴读阅读设置', exact: true })
      await preferences.getByRole('tab', { name: '外观', exact: true }).click()
      await preferences
        .getByRole('button', {
          name: theme === 'dark' ? '主题：夜间' : '主题：纸白',
          exact: true,
        })
        .click()
      await closeCompanionPanel(page)
      await expect(page.locator('.companion-page')).toHaveAttribute('data-theme', theme)
      const compactBounds = await viewport.boundingBox()
      expect(compactBounds!.height).toBeGreaterThanOrEqual(260)
      await openOriginalTools(page)
      expect(await viewport.boundingBox()).toEqual(compactBounds)
      await expect(page.getByRole('button', { name: '关闭原文面板', exact: true })).toBeInViewport()
      await expect(page.getByRole('button', { name: '播放', exact: true })).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      await page.screenshot({
        path: info.outputPath(`original-tools-small-${theme}.png`),
        animations: 'disabled',
      })
      await closeOriginalPanel(page)
    }
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
  }
})

test('source switching retains free reading and search drafts, and each book keeps its source across episodes', async () => {
  const { app, page, episodes, errors } = await fixture()
  try {
    await page.getByRole('button', { name: '原文下一页', exact: true }).click()
    await expect.poll(async () => (await originalView(page)).left).toBeGreaterThan(0)
    const browsed = await originalView(page)
    expect(browsed.ordinal).toBeGreaterThan(0)
    expect(browsed.ordinal).toBeLessThan(60)
    await expect(page.locator('.original-sentence')).toHaveCount(60)
    const before = await clock(page)
    await openOriginalSearch(page)
    await page.getByRole('textbox', { name: '全文搜索文字', exact: true }).fill('第137封信')
    await closeOriginalPanel(page)
    const source = page.getByRole('group', { name: '伴读文字来源', exact: true })
    await source.getByRole('button', { name: '转写字幕', exact: true }).click()
    await useOriginalText(page)
    await expect.poll(async () => (await originalView(page)).ordinal).toBe(browsed.ordinal)
    expect((await originalView(page)).left).toBeCloseTo(browsed.left, 0)
    await expect(page.locator('.original-reader')).toContainText('自由阅读')
    await openOriginalSearch(page)
    await expect(page.getByRole('textbox', { name: '全文搜索文字', exact: true })).toHaveValue(
      '第137封信',
    )
    await page.getByRole('button', { name: '搜索原文', exact: true }).click()
    await page.locator('.original-search-results button').first().click()
    await expect(page.getByRole('dialog', { name: '搜索小说原文', exact: true })).toBeHidden()
    await expect(page.locator('.original-sentence[data-search-hit="true"]')).toContainText(
      '第137封信',
    )
    await expect(page.locator('.original-sentence[data-search-hit="true"]')).toBeInViewport()
    expect(await clock(page)).toEqual(before)
    await menuAction(page, '播放选项', '下一集')
    await expect(page.locator('.companion-title')).toContainText(episodes[1]!.title)
    await expect(source.getByRole('button', { name: '小说原文', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(page.locator('.original-sentence')).toHaveCount(60)
    if ((await clock(page)).paused === false)
      await page.getByRole('button', { name: '暂停', exact: true }).click()
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
  }
})

test('selecting original text does not seek while Enter and Space explicitly use its mapped audio time', async () => {
  const { app, page, episodes, errors } = await fixture()
  try {
    const target = { episodeId: episodes[0]!.id, audioHash: episodes[0]!.contentHash }
    const matched = await page.evaluate((input) => window.desktop.matchOriginal(input), target)
    if (!matched.ok) throw new Error(matched.error.message)
    const { info: original, alignment } = matched.value
    if (!original || !alignment)
      throw new Error('Expected original and formal transcript alignment')
    const corrected = await page.evaluate((input) => window.desktop.correctOriginal(input), {
      ...target,
      originalId: original.id,
      revision: alignment.revision,
      segmentId: 's0',
      selection: { first: 0, last: 0 },
      startMs: 1000,
      endMs: 3000,
    })
    if (!corrected.ok) throw new Error(corrected.error.message)
    expect(corrected.value.alignment?.matches[0]?.selected?.first).toBe(0)
    // Reopen the persisted manual selection instead of relying on an automatic
    // candidate being unique among these deliberately similar fixture lines.
    await page.reload()
    await waitForOriginalReady(page)
    await page.getByRole('slider', { name: '播放进度', exact: true }).fill('9000')
    const before = await clock(page)
    const sentence = page.locator('.original-sentence[data-ordinal="0"]')
    await expect(sentence).toHaveAttribute('role', 'button')
    expect(await sentence.evaluate((node) => node.tagName)).toBe('SPAN')
    const points = await sentence.evaluate((node) => {
      const range = document.createRange()
      range.setStart(node.firstChild!, 0)
      range.setEnd(node.firstChild!, 6)
      const rect = range.getBoundingClientRect()
      return { left: rect.left + 1, right: rect.right - 1, y: rect.top + rect.height / 2 }
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
    await sentence.focus()
    await sentence.press('Enter')
    await expect.poll(async () => (await clock(page)).position).toBeCloseTo(1, 2)
    expect((await clock(page)).paused).toBe(true)
    await page.getByRole('slider', { name: '播放进度', exact: true }).fill('9000')
    await sentence.focus()
    await sentence.press('Space')
    await expect.poll(async () => (await clock(page)).position).toBeCloseTo(1, 2)
    expect((await clock(page)).paused).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
  }
})

test('original text remains readable before a formal transcript exists and matching clearly stays unavailable', async () => {
  const { app, page, errors } = await fixture(false)
  try {
    await expect(page.locator('.original-sentence').first()).toContainText(originalLine(0))
    await page.getByRole('button', { name: '原文下一页', exact: true }).click()
    await expect.poll(async () => (await originalView(page)).left).toBeGreaterThan(0)
    const browsed = await originalView(page)
    expect(browsed.ordinal).toBeGreaterThan(0)
    expect(browsed.ordinal).toBeLessThan(60)
    await expect(page.locator('.original-sentence')).toHaveCount(60)
    await openOriginalTools(page)
    await expect(page.getByRole('button', { name: '匹配这一集转写稿', exact: true })).toBeDisabled()
    await closeOriginalPanel(page)
    await expect.poll(async () => (await originalView(page)).ordinal).toBe(browsed.ordinal)
    expect((await originalView(page)).left).toBeCloseTo(browsed.left, 0)
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
  }
})

test('the final original chapter opens at its exact first sentence beyond the last full data page', async () => {
  const { app, page, root, errors } = await fixture(false)
  try {
    const text = join(root, '尾章定位.txt')
    writeFileSync(
      text,
      `第1章 正文\n${Array.from({ length: 133 }, (_, index) => originalLine(index)).join('\n')}\n第2章 尾声\n${Array.from({ length: 4 }, (_, index) => originalLine(133 + index)).join('\n')}`,
    )
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, text)
    await openOriginalTools(page, '原文来源')
    await page.getByRole('button', { name: '更换 TXT / EPUB 原文', exact: true }).click()
    await waitForOriginalReady(page)
    const before = await clock(page)
    await openOriginalContents(page)
    await page.getByRole('combobox', { name: '原文章节', exact: true }).selectOption('1')
    await expect(page.getByRole('dialog', { name: '原文目录', exact: true })).toBeHidden()
    await expect(page.locator('.original-sentence').first()).toHaveAttribute('data-ordinal', '133')
    await expect(page.locator('.original-sentence')).toHaveCount(4)
    await expect(page.locator('.original-chapter-heading')).toHaveText('第2章 尾声')
    expect(await clock(page)).toEqual(before)
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
  }
})
