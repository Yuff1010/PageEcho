import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import { parseOriginal } from '../../src/main/original/parse'
import { closeOwnedElectron } from '../model/electron-lifecycle'
import { closeCompanionPanel, openCompanionSettings, useOriginalText } from '../helpers/ui'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), '听读 实际分页 '))
  const audio = join(root, '第1集 山间来信.wav')
  const wav = Buffer.alloc(44 + 16000 * 450)
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
  const book = store.listBooks()[0]!,
    episode = book.episodes[0]!
  const original = parseOriginal(
    Buffer.from(
      '第1章 山间来信\n' +
        Array.from(
          { length: 600 },
          (_, index) =>
            `第${index}封信写于山间，清晨的风穿过树梢，书页在桌上缓缓翻动，故事仍在继续。`,
        ).join('\n'),
    ),
    '山间来信.txt',
  )
  const ebook = store.reading.import(original)
  store.bookLinks.link({ bookId: book.id, readingBookId: ebook.id })
  store.saveTranscript(episode.id, {
    version: 1,
    audioHash: episode.contentHash,
    kind: 'manual',
    coverage: [{ startMs: 0, endMs: 450000 }],
    segments: original.sentences.map((sentence, index) => ({
      id: `s${index}`,
      startMs: index * 700,
      endMs: index * 700 + 650,
      text: sentence.text,
    })),
  })
  const transcript = store.getTranscript(episode.id, episode.contentHash)
  if (transcript.status !== 'ready') throw new Error('missing fixture transcript')
  store.originals.saveAlignment(
    { episodeId: episode.id, audioHash: episode.contentHash },
    ebook.id,
    transcript.transcript.id,
    transcript.transcript.revision,
    0,
    original.sentences.map((sentence, index) => ({
      segmentId: `s${index}`,
      startMs: index * 700,
      endMs: index * 700 + 650,
      asrText: sentence.text,
      candidates: [],
      selected: { first: sentence.ordinal, last: sentence.ordinal, method: 'auto' },
      reviewed: false,
    })),
  )
  store.saveProgress({
    sessionId: '',
    episodeId: episode.id,
    positionMs: 1500,
    durationMs: 450000,
    rate: 1,
    volume: 0,
  })
  store.close()
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
  try {
    const page = await app.firstWindow()
    await page.bringToFront()
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1180, 820),
    )
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1180)
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    const reader = page.getByRole('region', { name: '同步伴读', exact: true })
    await expect(reader.locator('.companion-prose [data-sentence]')).toHaveCount(60)
    return { app, page, reader }
  } catch (error) {
    await closeOwnedElectron(app)
    throw error
  }
}
const media = (page: Page) =>
  page
    .locator('audio[data-player="persistent"]')
    .evaluate((audio: HTMLAudioElement) => ({ time: audio.currentTime, paused: audio.paused }))
async function viewState(viewport: Locator) {
  return viewport.evaluate((element) => {
    const node = element as HTMLDivElement,
      bounds = node.getBoundingClientRect()
    const first = Array.from(node.querySelectorAll<HTMLElement>('[data-sentence]')).find(
      (sentence) =>
        Array.from(sentence.getClientRects()).some(
          (rect) =>
            rect.right > bounds.left + 1 &&
            rect.left < bounds.right - 1 &&
            rect.bottom > bounds.top + 1 &&
            rect.top < bounds.bottom - 1,
        ),
    )
    const prose = node.firstElementChild!
    return {
      left: node.scrollLeft,
      top: node.scrollTop,
      width: node.clientWidth,
      height: node.clientHeight,
      scrollWidth: node.scrollWidth,
      scrollHeight: node.scrollHeight,
      column: Number(node.dataset.page),
      columns: Number(node.dataset.pages),
      gap: parseFloat(getComputedStyle(prose).columnGap),
      count: getComputedStyle(prose).columnCount,
      ordinal: Number(first?.dataset.sentence ?? -1),
      rendered: node.querySelectorAll('[data-sentence]').length,
    }
  })
}
async function turnSettings(reader: Locator) {
  await openCompanionSettings(reader)
  await reader.getByRole('tab', { name: '翻页', exact: true }).click()
  return reader.getByRole('dialog', { name: '伴读阅读设置', exact: true })
}

for (const source of ['transcript', 'original'] as const) {
  test(`${source} uses measured viewport pages, spreads and preserved text anchors without seeking audio`, async ({}, info) => {
    const { app, page, reader } = await fixture()
    try {
      if (source === 'original') await useOriginalText(reader)
      const viewport = reader.getByRole('region', {
        name: source === 'original' ? '原文阅读区' : '文稿阅读区',
        exact: true,
      })
      await expect(viewport).toHaveAttribute('aria-busy', 'false')
      await expect.poll(async () => (await viewState(viewport)).columns).toBeGreaterThan(1)
      const before = await viewState(viewport),
        audio = await media(page)
      await viewport.focus()
      await viewport.press('ArrowRight')
      await expect.poll(async () => (await viewState(viewport)).column).toBe(before.column + 1)
      const advanced = await viewState(viewport)
      expect(advanced.left - before.left).toBeCloseTo(before.width + before.gap, 0)
      expect(advanced.top).toBe(0)
      expect(advanced.ordinal).toBeGreaterThan(before.ordinal)
      expect(advanced.ordinal).toBeLessThan(60)
      expect(advanced.rendered).toBe(60)
      expect(await media(page)).toEqual(audio)
      await viewport.press('ArrowLeft')
      await expect.poll(async () => (await viewState(viewport)).ordinal).toBe(before.ordinal)
      await viewport.press('ArrowRight')
      const anchor = (await viewState(viewport)).ordinal
      await openCompanionSettings(reader)
      const typography = reader.getByRole('dialog', { name: '伴读阅读设置', exact: true })
      await typography.getByRole('tab', { name: '排版', exact: true }).click()
      await typography.getByRole('slider', { name: '电子书字号', exact: true }).fill('28')
      await closeCompanionPanel(reader)
      await expect(viewport.locator(`[data-sentence="${anchor}"]`)).toBeInViewport()
      expect(await viewport.evaluate((node) => getComputedStyle(node).fontSize)).toBe('28px')
      const preferences = await turnSettings(reader)
      await preferences
        .getByRole('combobox', { name: '电子书页面布局', exact: true })
        .selectOption('book')
      await closeCompanionPanel(reader)
      await expect.poll(async () => (await viewState(viewport)).count).toBe('2')
      await expect(viewport.locator(`[data-sentence="${anchor}"]`)).toBeInViewport()
      expect((await viewState(viewport)).gap).toBe(96)
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(720, 650),
      )
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(720)
      await expect
        .poll(() =>
          viewport.evaluate((node) =>
            getComputedStyle(node).getPropertyValue('--reader-page-count').trim(),
          ),
        )
        .toBe('1')
      await expect(viewport.locator(`[data-sentence="${anchor}"]`)).toBeInViewport()
      expect((await viewState(viewport)).rendered).toBeLessThanOrEqual(60)
      expect(await media(page)).toEqual(audio)
      await page.screenshot({
        path: info.outputPath(`${source}-measured-pages.png`),
        animations: 'disabled',
      })
    } finally {
      await closeOwnedElectron(app)
    }
  })

  test(`${source} applies real animation duration, reverse book direction and reduced motion`, async () => {
    const { app, page, reader } = await fixture()
    try {
      if (source === 'original') await useOriginalText(reader)
      const viewport = reader.getByRole('region', {
        name: source === 'original' ? '原文阅读区' : '文稿阅读区',
        exact: true,
      })
      const preferences = await turnSettings(reader)
      await preferences
        .getByRole('combobox', { name: '分页动画', exact: true })
        .selectOption('book')
      await preferences.getByRole('slider', { name: '电子书动画时长', exact: true }).fill('400')
      await closeCompanionPanel(reader)
      const audio = await media(page)
      const frames = async () =>
        reader.locator('.reader-book-turn').evaluateAll((layers) =>
          layers.flatMap((layer) =>
            layer.getAnimations({ subtree: true }).map((animation) => ({
              duration: animation.effect!.getTiming().duration,
              transforms: (animation.effect as KeyframeEffect)
                .getKeyframes()
                .map((frame) => String(frame.transform ?? '')),
            })),
          ),
        )
      await viewport.focus()
      await viewport.press('PageDown')
      const forward = await frames()
      expect(
        forward.some(
          (animation) =>
            animation.duration === 400 && animation.transforms.includes('rotateY(-90deg)'),
        ),
      ).toBe(true)
      await expect(reader.locator('.reader-book-turn')).toHaveCount(0)
      await viewport.press('PageUp')
      const backward = await frames()
      expect(
        backward.some(
          (animation) =>
            animation.duration === 400 && animation.transforms.includes('rotateY(90deg)'),
        ),
      ).toBe(true)
      await expect(reader.locator('.reader-book-turn')).toHaveCount(0)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      const before = (await viewState(viewport)).left
      await viewport.press('PageDown')
      await expect.poll(async () => (await viewState(viewport)).left).toBeGreaterThan(before)
      await expect(reader.locator('.reader-book-turn')).toHaveCount(0)
      expect(await viewport.evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(
        0,
      )
      expect(await media(page)).toEqual(audio)
    } finally {
      await closeOwnedElectron(app)
    }
  })

  test(`${source} scroll mode honors smooth scrolling and page navigation crosses bounded data windows`, async () => {
    const { app, page, reader } = await fixture()
    try {
      if (source === 'original') await useOriginalText(reader)
      const viewport = reader.getByRole('region', {
        name: source === 'original' ? '原文阅读区' : '文稿阅读区',
        exact: true,
      })
      const preferences = await turnSettings(reader)
      await preferences
        .getByRole('combobox', { name: '电子书翻页方式', exact: true })
        .selectOption('scroll')
      await preferences.getByRole('checkbox', { name: '平滑滚动', exact: true }).check()
      await closeCompanionPanel(reader)
      await expect
        .poll(
          async () => (await viewState(viewport)).scrollHeight - (await viewState(viewport)).height,
        )
        .toBeGreaterThan(100)
      const audio = await media(page)
      // Observe browser calls while preserving and exercising native scrollTo.
      await viewport.evaluate((element) => {
        const node = element as HTMLDivElement & { scrollCalls: ScrollToOptions[] }
        const scroll = node.scrollTo.bind(node)
        node.scrollCalls = []
        node.scrollTo = ((options: ScrollToOptions) => {
          node.scrollCalls.push(options)
          scroll(options)
        }) as typeof node.scrollTo
      })
      const before = await viewState(viewport)
      await viewport.focus()
      await viewport.press('PageDown')
      await expect
        .poll(async () => (await viewState(viewport)).top)
        .toBeGreaterThan(before.top + 20)
      expect(
        await viewport.evaluate((node) =>
          (node as HTMLDivElement & { scrollCalls: ScrollToOptions[] }).scrollCalls.some(
            (call) => call.behavior === 'smooth',
          ),
        ),
      ).toBe(true)
      await expect(
        reader.locator(source === 'original' ? '.original-reading-status' : '.follow-state'),
      ).toContainText('自由阅读')
      await expect
        .poll(async () => (await viewState(viewport)).top)
        .toBeCloseTo(
          Math.min(before.scrollHeight - before.height, before.top + before.height - 40),
          0,
        )
      const manual = await viewState(viewport)
      await page.getByRole('slider', { name: '播放进度', exact: true }).fill('100000')
      expect((await viewState(viewport)).top).toBeCloseTo(manual.top, 0)
      await expect(viewport.locator(`[data-sentence="${manual.ordinal}"]`)).toBeInViewport()
      const settings = await turnSettings(reader)
      await settings.getByRole('checkbox', { name: '平滑滚动', exact: true }).uncheck()
      await closeCompanionPanel(reader)
      await viewport.evaluate((node) => {
        ;(node as HTMLDivElement & { scrollCalls: ScrollToOptions[] }).scrollCalls = []
      })
      await viewport.focus()
      await viewport.press('PageDown')
      expect(
        await viewport.evaluate((node) =>
          (node as HTMLDivElement & { scrollCalls: ScrollToOptions[] }).scrollCalls.some(
            (call) => call.behavior === 'instant',
          ),
        ),
      ).toBe(true)
      // Reach the current bounded window's end, then use the real next-page action.
      await viewport.evaluate((node) => {
        node.scrollTop = node.scrollHeight
      })
      await expect
        .poll(async () => (await viewState(viewport)).top + (await viewState(viewport)).height)
        .toBeGreaterThan((await viewState(viewport)).scrollHeight - 3)
      const nav = reader.getByRole('navigation', {
        name: source === 'original' ? '原文分页' : '文稿翻页',
        exact: true,
      })
      await nav
        .getByRole('button', { name: source === 'original' ? '原文下一页' : '下一页', exact: true })
        .click()
      await expect
        .poll(async () =>
          Number(await viewport.locator('[data-sentence]').first().getAttribute('data-sentence')),
        )
        .toBe(60)
      expect((await viewState(viewport)).rendered).toBeLessThanOrEqual(60)
      expect((await media(page)).paused).toBe(audio.paused)
      expect((await media(page)).time).toBeCloseTo(100, 1)
    } finally {
      await closeOwnedElectron(app)
    }
  })
}
