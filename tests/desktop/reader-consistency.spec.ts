import { test, expect, _electron as electron, type Page, type Locator } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { createDataPaths } from '../../src/main/paths'
import { scanBook } from '../../src/main/files'
import { parseOriginal } from '../../src/main/original/parse'
import { closeOwnedElectron } from '../model/electron-lifecycle'
import {
  closeOriginalPanel,
  openOriginalContents,
  openOriginalSearch,
  useOriginalText,
} from '../helpers/ui'

async function fixture(positionMs = 5000) {
  const root = mkdtempSync(join(tmpdir(), '听读 阅读一致性 '))
  const audio = join(root, '第1集-山间来信.wav')
  const wav = Buffer.alloc(44 + 16000 * 90)
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
  const parsed = parseOriginal(
    Buffer.from(
      '第1章 山路\n' +
        Array.from(
          { length: 130 },
          (_, index) => `第${index}封信从山间寄来，清晨的风穿过树梢。`,
        ).join('\n'),
    ),
    '山间来信.txt',
  )
  const ebook = store.reading.import(parsed)
  store.reading.savePosition(ebook.id, 12)
  store.bookLinks.link({ bookId: book.id, readingBookId: ebook.id })
  store.saveTranscript(episode.id, {
    version: 1,
    kind: 'manual',
    audioHash: episode.contentHash,
    coverage: [{ startMs: 0, endMs: 90000 }],
    segments: [{ id: 's0', startMs: 1000, endMs: 3000, text: parsed.sentences[1]!.text }],
  })
  const transcript = store.getTranscript(episode.id, episode.contentHash)
  if (transcript.status !== 'ready') throw new Error('missing fixture transcript')
  store.originals.saveAlignment(
    { episodeId: episode.id, audioHash: episode.contentHash },
    ebook.id,
    transcript.transcript.id,
    transcript.transcript.revision,
    0,
    [
      {
        segmentId: 's0',
        startMs: 1000,
        endMs: 3000,
        asrText: parsed.sentences[1]!.text,
        candidates: [],
        selected: { first: 1, last: 1, method: 'auto' },
        reviewed: false,
      },
    ],
  )
  store.saveProgress({
    sessionId: '',
    episodeId: episode.id,
    positionMs,
    durationMs: 90000,
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
    await expect(
      page
        .getByRole('region', { name: '播放器', exact: true })
        .getByRole('button', { name: '播放', exact: true }),
    ).toBeEnabled()
    return { app, page, ebook }
  } catch (error) {
    await closeOwnedElectron(app)
    throw error
  }
}
const reader = (page: Page) => page.getByRole('main', { name: '独立阅读页', exact: true })
const companion = (page: Page) => page.getByRole('region', { name: '同步伴读', exact: true })
const notice = (page: Page) => page.locator('.reader-switch-notice')
const clock = (page: Page) =>
  page
    .locator('audio[data-player="persistent"]')
    .evaluate((audio: HTMLAudioElement) => ({ time: audio.currentTime, paused: audio.paused }))
async function openCompanion(page: Page) {
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  await expect(companion(page)).toBeVisible()
}
async function openEbookFromAudio(page: Page) {
  await reveal(page)
  await companion(page).getByRole('button', { name: '从当前进度阅读', exact: true }).click()
  await expect(reader(page)).toBeVisible()
  await expect(page.locator('.book-viewport')).toHaveAttribute('aria-busy', 'false')
}
async function reveal(page: Page) {
  await page.mouse.move(80, 15)
}
async function visual(root: Locator, prose: string) {
  const surface = await root.evaluate((element) => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor }
  })
  const text = await root.locator(prose).evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      size: style.fontSize,
      leading: style.lineHeight,
      family: style.fontFamily,
      weight: style.fontWeight,
      color: style.color,
      width: element.getBoundingClientRect().width,
    }
  })
  return { ...surface, ...text }
}

test('an unmapped switch notice expires, does not change either position and does not return when the same ebook is reopened', async () => {
  const { app, page, ebook } = await fixture()
  try {
    await openCompanion(page)
    const before = await clock(page)
    await openEbookFromAudio(page)
    await expect(notice(page)).toContainText('当前声音尚未匹配，已打开上次阅读位置。')
    await expect(page.locator('.reader-progress-label')).toHaveAttribute('data-position', '12')
    await expect(notice(page)).toBeHidden({ timeout: 6500 })
    expect(await clock(page)).toEqual(before)
    await expect(page.locator('.reader-progress-label')).toHaveAttribute('data-position', '12')
    await reveal(page)
    await page.getByRole('button', { name: '返回阅读书架', exact: true }).click()
    await page.getByRole('button', { name: `阅读 ${ebook.title}`, exact: true }).click()
    await expect(page.locator('.book-viewport')).toHaveAttribute('aria-busy', 'false')
    await expect(notice(page)).toBeHidden()
    expect(await clock(page)).toEqual(before)
  } finally {
    await closeOwnedElectron(app)
  }
})

test('a repeated switch restarts the notice lifetime and a mapped notice can be dismissed without changing playback', async () => {
  const { app, page } = await fixture(1500)
  try {
    await openCompanion(page)
    const before = await clock(page)
    await openEbookFromAudio(page)
    await expect(notice(page)).toContainText('已定位到当前声音对应的原文。')
    const firstShown = Date.now()
    await expect.poll(() => Date.now() - firstShown).toBeGreaterThan(2200)
    await page.goBack()
    await expect(companion(page)).toBeVisible()
    await openEbookFromAudio(page)
    await expect(notice(page)).toContainText('已定位到当前声音对应的原文。')
    // The first notice's four-second deadline must not dismiss the new one.
    await expect.poll(() => Date.now() - firstShown).toBeGreaterThan(4200)
    await expect(notice(page)).toBeVisible()
    await notice(page).getByRole('button', { name: '关闭阅读提示', exact: true }).click()
    await expect(notice(page)).toBeHidden()
    await expect(page.locator('.reader-progress-label')).toHaveAttribute('data-position', '1')
    expect(await clock(page)).toEqual(before)
    await page.goBack()
    await expect(companion(page)).toBeVisible()
    await openEbookFromAudio(page)
    await expect(notice(page)).toContainText('已定位到当前声音对应的原文。')
    await expect(notice(page)).toBeHidden({ timeout: 6500 })
  } finally {
    await closeOwnedElectron(app)
  }
})

test('ebook, transcript and original reading share the actual book visual design and global preferences', async ({}, info) => {
  const { app, page } = await fixture(1500)
  try {
    await openCompanion(page)
    await expect(companion(page)).toHaveAttribute('data-reader-design', 'book')
    await expect(companion(page).locator('.companion-prose')).toBeVisible()
    const transcript = await visual(companion(page), '.companion-prose')
    await useOriginalText(page)
    await expect(page.locator('.original-viewport')).toHaveAttribute('aria-busy', 'false')
    const original = await visual(companion(page), '.original-prose')
    await openEbookFromAudio(page)
    await expect(reader(page)).toHaveAttribute('data-reader-design', 'book')
    const ebook = await visual(reader(page), '.ebook-text')
    for (const target of [transcript, original]) {
      expect(target.background).toBe(ebook.background)
      expect(target.size).toBe(ebook.size)
      expect(target.leading).toBe(ebook.leading)
      expect(target.family).toBe(ebook.family)
      expect(target.color).toBe(ebook.color)
      expect(target.width).toBeCloseTo(ebook.width, 0)
    }
    await reveal(page)
    await page.getByRole('button', { name: '阅读设置', exact: true }).click()
    const preferences = page.getByRole('region', { name: '电子书阅读设置', exact: true })
    await preferences
      .getByRole('combobox', { name: '阅读设置应用范围', exact: true })
      .selectOption('global')
    await preferences.getByRole('slider', { name: '电子书字号', exact: true }).fill('24')
    await preferences.getByRole('tab', { name: '外观', exact: true }).click()
    await preferences.getByRole('button', { name: '主题：纸白', exact: true }).click()
    await page.keyboard.press('Escape')
    const changed = await visual(reader(page), '.ebook-text')
    await page.goBack()
    await expect(companion(page)).toBeVisible()
    await expect
      .poll(async () => (await visual(companion(page), '.original-prose')).size)
      .toBe('24px')
    expect(await visual(companion(page), '.original-prose')).toMatchObject({
      size: changed.size,
      leading: changed.leading,
      family: changed.family,
      background: changed.background,
      color: changed.color,
    })
    await page.screenshot({
      path: info.outputPath('audio-reader-shared-design.png'),
      animations: 'disabled',
    })
  } finally {
    await closeOwnedElectron(app)
  }
})

test('both book toolbars keep reading actions reachable at 720px and overlay panels preserve the text layout and paused audio', async ({}, info) => {
  const { app, page } = await fixture(1500)
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 600))
    await openCompanion(page)
    const before = await clock(page)
    const audioRoot = companion(page)
    await expect(audioRoot).toHaveAttribute('data-reader-design', 'book')
    for (const name of ['搜索伴读文稿', '伴读阅读设置', '专注伴读'])
      await expect(audioRoot.getByRole('button', { name, exact: true })).toBeInViewport()
    await audioRoot.getByRole('button', { name: '搜索伴读文稿', exact: true }).click()
    await expect(
      page.getByRole('complementary', { name: '搜索伴读文稿', exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: '关闭伴读搜索', exact: true }).click()
    const audioBounds = await audioRoot.locator('.companion-prose').boundingBox()
    await audioRoot.getByRole('button', { name: '伴读阅读设置', exact: true }).click()
    const audioSettings = page.getByRole('dialog', { name: '伴读阅读设置', exact: true })
    await expect(audioSettings).toBeVisible()
    await expect(audioSettings.getByRole('tab', { name: '排版', exact: true })).toBeVisible()
    await expect(audioSettings.getByRole('tab', { name: '外观', exact: true })).toBeVisible()
    await expect(audioSettings.getByRole('tab', { name: '翻页', exact: true })).toBeVisible()
    expect(await audioRoot.locator('.companion-prose').boundingBox()).toEqual(audioBounds)
    await page.keyboard.press('Escape')
    await useOriginalText(page)
    await openOriginalContents(page)
    await expect(page.getByRole('dialog', { name: '原文目录', exact: true })).toBeVisible()
    await closeOriginalPanel(page)
    await openOriginalSearch(page)
    await expect(page.getByRole('dialog', { name: '搜索小说原文', exact: true })).toBeVisible()
    await closeOriginalPanel(page)
    await openEbookFromAudio(page)
    await reveal(page)
    const bookRoot = reader(page)
    for (const name of [
      '打开目录',
      '搜索书内文字',
      '阅读设置',
      '专注阅读',
      '从此处听书',
      '朗读电子书',
    ])
      await expect(bookRoot.getByRole('button', { name, exact: true })).toBeInViewport()
    const bookBounds = await bookRoot.locator('.book-viewport').boundingBox()
    await bookRoot.getByRole('button', { name: '阅读设置', exact: true }).click()
    await expect(page.getByRole('region', { name: '电子书阅读设置', exact: true })).toBeVisible()
    expect(await bookRoot.locator('.book-viewport').boundingBox()).toEqual(bookBounds)
    await page.keyboard.press('Escape')
    await bookRoot.getByRole('button', { name: '专注阅读', exact: true }).click()
    await expect(bookRoot).toHaveAttribute('data-focus', 'true')
    await page.keyboard.press('Escape')
    await expect(bookRoot).toHaveAttribute('data-focus', 'false')
    expect(await clock(page)).toEqual(before)
    await page.screenshot({
      path: info.outputPath('ebook-reader-shared-design-small.png'),
      animations: 'disabled',
    })
  } finally {
    await closeOwnedElectron(app)
  }
})

test('reader icon actions keep their accessible names, show hover and focus explanations, and retain media and panel behavior', async () => {
  const { app, page } = await fixture(1500)
  try {
    await openCompanion(page)
    const audioRoot = companion(page)
    const before = await clock(page)
    for (const name of ['返回书架', '从当前进度阅读', '搜索伴读文稿', '伴读阅读设置', '专注伴读']) {
      const action = audioRoot.getByRole('button', { name, exact: true })
      await expect(action).toBeVisible()
      expect(await action.textContent()).toBe('')
      await expect(action.locator('svg[aria-hidden="true"]')).toHaveCount(1)
      await expect(action).not.toHaveAttribute('title')
    }
    const source = audioRoot.getByRole('group', { name: '伴读文字来源', exact: true })
    const transcript = source.getByRole('button', { name: '转写字幕', exact: true })
    const original = source.getByRole('button', { name: '小说原文', exact: true })
    await expect(transcript).toHaveAttribute('aria-pressed', 'true')
    for (const action of [transcript, original]) expect(await action.textContent()).toBe('')
    expect(await transcript.locator('svg').innerHTML()).not.toBe(
      await original.locator('svg').innerHTML(),
    )
    const bounds = await source.boundingBox()
    await original.hover()
    await expect(page.getByRole('tooltip', { name: '小说原文', exact: true })).toBeVisible()
    expect(await source.boundingBox()).toEqual(bounds)
    expect(await clock(page)).toEqual(before)
    await original.click()
    await expect(original).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.original-viewport')).toHaveAttribute('aria-busy', 'false')
    const follow = audioRoot.getByRole('button', { name: '跟随原文播放位置', exact: true })
    expect(await follow.textContent()).toBe('')
    await follow.focus()
    await expect(
      page.getByRole('tooltip', { name: '仅跟随已匹配的原文，不改变播放位置', exact: true }),
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await expect(follow).toBeFocused()
    await follow.click()
    await expect(audioRoot.locator('.original-sentence[aria-current="true"]')).toBeInViewport()
    expect(await clock(page)).toEqual(before)
    await transcript.click()
    await openEbookFromAudio(page)
    await reveal(page)
    const bookRoot = reader(page)
    for (const name of [
      '返回阅读书架',
      '从此处听书',
      '朗读电子书',
      '打开目录',
      '搜索书内文字',
      '阅读设置',
    ]) {
      const action = bookRoot.getByRole('button', { name, exact: true })
      expect(await action.textContent()).toBe('')
      await expect(action.locator('svg[aria-hidden="true"]')).toHaveCount(1)
    }
    const back = bookRoot.getByRole('button', { name: '返回阅读书架', exact: true })
    await back.focus()
    await expect(page.getByRole('tooltip', { name: '返回阅读书架', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(back).toBeFocused()
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    const settings = bookRoot.getByRole('button', { name: '阅读设置', exact: true })
    await settings.click()
    await expect(page.getByRole('region', { name: '电子书阅读设置', exact: true })).toBeVisible()
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    expect(await clock(page)).toEqual(before)
  } finally {
    await closeOwnedElectron(app)
  }
})
