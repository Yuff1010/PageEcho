import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { closeOwnedElectron } from '../model/electron-lifecycle'

async function launch() {
  const root = mkdtempSync(join(tmpdir(), '听读双向导航 '))
  const audio = join(root, '山间来信.wav')
  const ebook = join(root, '山间来信.txt')
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
  writeFileSync(
    ebook,
    `第1章 山路\n${Array.from(
      { length: 180 },
      (_, index) => `第${index}封信写于山间，清晨的风穿过树梢。故事在每一页继续。`,
    ).join('\n')}\n第2章 清晨\n第二天清晨，他们来到远方的村庄。`,
  )
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('button', { name: '选择音频文件', exact: true })).toBeEnabled()
  return { app, page, audio, ebook, errors }
}

function shelves(page: Page) {
  return page.getByRole('navigation', { name: '书籍类型', exact: true })
}

async function choose(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, path)
}

async function importEbook(app: ElectronApplication, page: Page, path: string) {
  await shelves(page).getByRole('button', { name: '电子书', exact: true }).click()
  await choose(app, path)
  await page.getByRole('button', { name: '导入电子书', exact: true }).click()
  await readerReady(page)
}

async function readerReady(page: Page) {
  await expect(page.getByRole('region', { name: '电子书正文', exact: true })).toHaveAttribute(
    'aria-busy',
    'false',
  )
}

async function reveal(page: Page) {
  await page.mouse.move(80, 15)
  await expect(page.locator('.reader-toolbar')).toHaveAttribute('data-visible', 'true')
}

async function clock(page: Page) {
  return page.locator('audio[data-player="persistent"]').evaluate((audio: HTMLAudioElement) => ({
    position: audio.currentTime,
    paused: audio.paused,
    source: audio.currentSrc,
  }))
}

test('both book shelves share navigation and preserve their route on refresh and history traversal', async ({}, info) => {
  const { app, page, errors } = await launch()
  try {
    await expect(
      page.getByRole('navigation', { name: '书架导航', exact: true }).getByRole('button'),
    ).toHaveCount(2)
    const read = page.getByRole('button', { name: '伴读阅读', exact: true })
    await expect(read).toHaveText('')
    await expect(read.locator('svg')).toBeVisible()
    const types = shelves(page)
    await expect(types.getByRole('button')).toHaveCount(2)
    await expect(types.getByRole('button', { name: '有声书', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await types.getByRole('button', { name: '电子书', exact: true }).click()
    await expect(page).toHaveURL(/#\/library\/ebooks$/)
    await expect(types.getByRole('button', { name: '电子书', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(page.getByRole('heading', { name: '我的书架', exact: true })).toBeVisible()
    await page.screenshot({
      path: info.outputPath('ebook-shelf-navigation.png'),
      animations: 'disabled',
    })
    await types.getByRole('button', { name: '有声书', exact: true }).click()
    await expect(page).toHaveURL(/#\/library\/audiobooks$/)
    await expect(page.getByRole('button', { name: '选择音频文件', exact: true })).toBeVisible()
    await page.evaluate(() => history.back())
    await expect(page).toHaveURL(/#\/library\/ebooks$/)
    await expect(types.getByRole('button', { name: '电子书', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await page.evaluate(() => history.forward())
    await expect(page).toHaveURL(/#\/library\/audiobooks$/)
    await page.reload()
    await expect(types.getByRole('button', { name: '有声书', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await types.getByRole('button', { name: '电子书', exact: true }).click()
    await page.reload()
    await expect(types.getByRole('button', { name: '电子书', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(720, 600),
    )
    await expect(types.getByRole('button', { name: '有声书', exact: true })).toBeInViewport()
    await expect(types.getByRole('button', { name: '电子书', exact: true })).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({
      path: info.outputPath('ebook-shelf-navigation-small.png'),
      animations: 'disabled',
    })
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
  }
})

test('the standalone reader returns directly to audiobooks and restores its saved position when reopened', async ({}, info) => {
  const { app, page, ebook, errors } = await launch()
  try {
    await importEbook(app, page, ebook)
    const readerUrl = page.url()
    await page.locator('.book-viewport').press('ArrowRight')
    const position = () =>
      page.locator('.reader-progress-label').getAttribute('data-position').then(Number)
    await expect.poll(position).toBeGreaterThan(0)
    const saved = await position()
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(720, 600),
    )
    await readerReady(page)
    await reveal(page)
    await expect(page.getByRole('button', { name: '返回阅读书架', exact: true })).toBeInViewport()
    const audioShelf = page.getByRole('button', { name: '有声书书架', exact: true })
    await expect(audioShelf).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({
      path: info.outputPath('reader-two-way-navigation-small.png'),
      animations: 'disabled',
    })
    await audioShelf.click()
    await expect(page).toHaveURL(/#\/library\/audiobooks$/)
    await expect(page.getByRole('button', { name: '选择音频文件', exact: true })).toBeVisible()
    await shelves(page).getByRole('button', { name: '电子书', exact: true }).click()
    await page.getByRole('button', { name: '阅读 山间来信', exact: true }).click()
    await readerReady(page)
    expect(page.url()).toBe(readerUrl)
    expect(await position()).toBe(saved)
    const books = await page.evaluate(() => window.desktop.getReadingBooks())
    expect(books.ok && books.value[0]?.position).toBe(saved)
    await reveal(page)
    await page.getByRole('button', { name: '返回阅读书架', exact: true }).click()
    await expect(page).toHaveURL(/#\/library\/ebooks$/)
    await expect(
      shelves(page).getByRole('button', { name: '电子书', exact: true }),
    ).toHaveAttribute('aria-current', 'page')
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
  }
})

test('switching shelves and returning from the reader preserves paused and playing audio', async ({}, info) => {
  test.setTimeout(60_000)
  const { app, page, audio, ebook, errors } = await launch()
  try {
    await choose(app, audio)
    await page.getByRole('button', { name: '选择音频文件', exact: true }).click()
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await page.getByRole('slider', { name: '播放进度', exact: true }).fill('45000')
    await expect.poll(async () => (await clock(page)).position).toBeCloseTo(45, 2)
    const paused = await clock(page)
    await importEbook(app, page, ebook)
    expect(await clock(page)).toEqual(paused)
    await reveal(page)
    await page.screenshot({
      path: info.outputPath('reader-return-to-listening.png'),
      animations: 'disabled',
    })
    await page.getByRole('button', { name: '返回听书', exact: true }).click()
    await expect(page).toHaveURL(/#\/listening$/)
    await expect(page.getByRole('region', { name: '同步伴读', exact: true })).toBeVisible()
    expect(await clock(page)).toEqual(paused)
    await page.getByRole('button', { name: '返回书架', exact: true }).click()
    await expect(page).toHaveURL(/#\/library\/audiobooks$/)
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await expect.poll(async () => (await clock(page)).paused).toBe(false)
    await expect.poll(async () => (await clock(page)).position).toBeGreaterThan(45)
    const playing = await clock(page)
    await shelves(page).getByRole('button', { name: '电子书', exact: true }).click()
    await page.getByRole('button', { name: '阅读 山间来信', exact: true }).click()
    await readerReady(page)
    await expect.poll(async () => (await clock(page)).position).toBeGreaterThan(playing.position)
    expect((await clock(page)).paused).toBe(false)
    expect((await clock(page)).source).toBe(playing.source)
    await reveal(page)
    await page.getByRole('button', { name: '返回听书', exact: true }).click()
    await expect(page).toHaveURL(/#\/listening$/)
    expect((await clock(page)).paused).toBe(false)
    expect((await clock(page)).source).toBe(playing.source)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await page.getByRole('button', { name: '返回书架', exact: true }).click()
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    await expect(page).toHaveURL(/#\/listening$/)
    expect((await clock(page)).paused).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
  }
})

test('chapter and source routes survive refresh and the sidebar returns to the most recent shelf type', async () => {
  const { app, page, audio, errors } = await launch()
  try {
    await choose(app, audio)
    await page.getByRole('button', { name: '选择音频文件', exact: true }).click()
    await page.getByRole('button', { name: '打开 山间来信.wav 的目录', exact: true }).click()
    await expect(page).toHaveURL(/#\/audiobooks\/[^/]+$/)
    const chapterUrl = page.url()
    const chapters = page.getByRole('region', { name: '章节目录', exact: true })
    await expect(chapters.getByRole('heading', { name: '山间来信.wav', exact: true })).toBeVisible()
    await page.reload()
    expect(page.url()).toBe(chapterUrl)
    await expect(chapters.getByRole('heading', { name: '山间来信.wav', exact: true })).toBeVisible()
    await expect(chapters.locator('.episode-list > li')).toHaveCount(1)
    await page.getByRole('button', { name: '在线书源', exact: true }).click()
    await expect(page).toHaveURL(/#\/sources$/)
    await page.reload()
    await expect(page).toHaveURL(/#\/sources$/)
    await expect(page.getByRole('searchbox', { name: '搜索书籍', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '我的书架', exact: true }).click()
    await shelves(page).getByRole('button', { name: '电子书', exact: true }).click()
    await page.getByRole('button', { name: '在线书源', exact: true }).click()
    await expect(page.getByRole('searchbox', { name: '搜索书籍', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '我的书架', exact: true }).click()
    await expect(page).toHaveURL(/#\/library\/ebooks$/)
    await expect(
      shelves(page).getByRole('button', { name: '电子书', exact: true }),
    ).toHaveAttribute('aria-current', 'page')
    await shelves(page).getByRole('button', { name: '有声书', exact: true }).click()
    await expect(page).toHaveURL(/#\/library\/audiobooks$/)
    await expect(
      page.getByRole('button', { name: '打开 山间来信.wav 的目录', exact: true }),
    ).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
  }
})

test('a missing ebook keeps both shelf exits available instead of trapping the reader', async () => {
  const { app, page, errors } = await launch()
  try {
    await page.evaluate(() => {
      location.hash = '/read/removed-book'
    })
    await page.reload()
    await expect(page.getByRole('alert')).toHaveText('这本电子书已移除，请返回书架重新选择。')
    const exits = page.getByRole('navigation', { name: '书架切换', exact: true })
    await expect(exits.getByRole('button')).toHaveCount(2)
    await exits.getByRole('button', { name: '返回阅读书架', exact: true }).click()
    await expect(page).toHaveURL(/#\/library\/ebooks$/)
    await expect(page.getByRole('heading', { name: '我的书架', exact: true })).toBeVisible()
    await page.evaluate(() => {
      location.hash = '/read/removed-book'
    })
    await expect(page.getByRole('alert')).toHaveText('这本电子书已移除，请返回书架重新选择。')
    await exits.getByRole('button', { name: '有声书书架', exact: true }).click()
    await expect(page).toHaveURL(/#\/library\/audiobooks$/)
    await expect(page.getByRole('button', { name: '选择音频文件', exact: true })).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
  }
})
