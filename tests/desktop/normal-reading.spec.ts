import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { zip, epub } from '../fixtures/original-epub'
import { closeOwnedElectron } from '../model/electron-lifecycle'

function fixtures(root: string) {
  const txt = join(root, '日常阅读.txt'),
    epubFile = join(root, '阅读顺序.epub'),
    invalid = join(root, '错误.txt')
  writeFileSync(
    txt,
    `第1章 山路\n${Array.from({ length: 135 }, (_, i) => `少年沿着山路前进，第${i}次听见钟声。`).join('\n')}\n第2章 清晨\n第二天清晨，他们来到远方的村庄。`,
  )
  writeFileSync(epubFile, zip(epub))
  writeFileSync(invalid, Buffer.from([0, 1]))
  return { txt, epubFile, invalid }
}
function environment(root: string) {
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  return env
}
async function reveal(page: Page) {
  await page.mouse.move(80, 15)
  await expect(page.locator('.reader-toolbar')).toHaveAttribute('data-visible', 'true')
}
async function back(page: Page) {
  await reveal(page)
  await page.getByRole('button', { name: '返回阅读书架', exact: true }).click()
  await expect(page.getByRole('heading', { name: '我的书架', exact: true })).toBeVisible()
}
async function settings(page: Page) {
  await reveal(page)
  await page.getByRole('button', { name: '阅读设置', exact: true }).click()
  await expect(page.getByRole('region', { name: '电子书阅读设置' })).toBeVisible()
}
async function position(page: Page) {
  return Number(await page.locator('.reader-progress-label').getAttribute('data-position'))
}
async function ready(page: Page) {
  await expect(page.getByRole('region', { name: '电子书正文' })).toHaveAttribute(
    'aria-busy',
    'false',
  )
}

test('ebook opens on a separate route with hidden controls, real pagination, search and persistent layout', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const root = mkdtempSync(join(tmpdir(), '听读正常阅读 ')),
    files = fixtures(root)
  const args = [resolve(process.env.RALB_APP_ROOT ?? '.')],
    env = environment(root)
  let app = await electron.launch({ args, env })
  const errors: string[] = []
  try {
    let page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    const choose = async (path: string | null) =>
      app.evaluate(({ dialog }, selected) => {
        dialog.showOpenDialog = async () => ({
          canceled: selected === null,
          filePaths: selected ? [selected] : [],
        })
      }, path)
    const books = async () => {
      const result = await page.evaluate(() => window.desktop.getReadingBooks())
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    }
    await page.getByRole('button', { name: '电子书', exact: true }).click()
    await choose(null)
    await page.getByRole('button', { name: '导入电子书', exact: true }).click()
    await expect(page.getByText('开始读一本书', { exact: true })).toBeVisible()
    await choose(files.invalid)
    await page.getByRole('button', { name: '导入电子书', exact: true }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    expect(await books()).toHaveLength(0)
    await choose(files.txt)
    await page.getByRole('button', { name: '导入电子书', exact: true }).click()
    await ready(page)
    await expect(page).toHaveURL(/#\/read\//)
    await expect(page.locator('.app-shell, .sidebar, .player-panel')).toHaveCount(0)
    expect(await page.locator('.ebook-reader-page').evaluate((node) => node.clientHeight)).toBe(
      await page.evaluate(() => innerHeight),
    )
    const audioState = await page.evaluate(() => window.desktop.getState())
    expect(audioState.ok && audioState.value.books.length).toBe(0)
    await page.bringToFront()
    await page.mouse.move(400, 250)
    await expect(page.locator('.reader-toolbar')).toHaveAttribute('data-visible', 'false')
    await expect(page.locator('.reader-toolbar')).toHaveAttribute('inert', '')
    await page.screenshot({ path: testInfo.outputPath('reader-paper-clean.png') })
    await page.locator('.book-viewport').press('Tab')
    await expect(page.getByRole('button', { name: '返回阅读书架' })).toBeFocused()
    await page.keyboard.press('Escape')
    await page.locator('.book-viewport').press('ArrowRight')
    await expect.poll(() => position(page)).toBeGreaterThan(0)
    expect(await position(page)).toBeLessThan(60)
    await page.locator('.book-viewport').press('ArrowLeft')
    await expect.poll(() => position(page)).toBe(0)
    await reveal(page)
    await page.getByRole('button', { name: '阅读设置', exact: true }).hover()
    await expect(page.getByRole('region', { name: '电子书阅读设置' })).toHaveCount(0)
    await page.mouse.move(400, 250)
    await expect(page.getByRole('region', { name: '电子书阅读设置' })).toHaveCount(0)
    await reveal(page)
    await page.getByRole('button', { name: '打开目录' }).click()
    await page.getByLabel('筛选目录').fill('清晨')
    await page.getByRole('button', { name: '第2章 清晨', exact: true }).click()
    await expect.poll(() => position(page)).toBe(135)
    await expect(page.locator('[data-sentence="135"]')).toBeInViewport()
    await page.locator('.book-viewport').press('Control+f')
    await page.getByLabel('全文搜索文字', { exact: true }).fill('第93次')
    await page.getByRole('button', { name: '搜索原文', exact: true }).click()
    await page.getByRole('list', { name: '全文搜索结果' }).getByRole('button').click()
    await expect.poll(() => position(page)).toBe(93)
    await expect(page.locator('[data-reader-hit="true"]')).toBeInViewport()
    await expect.poll(async () => (await books())[0]?.position).toBe(93)
    await settings(page)
    await page.getByLabel('电子书字号', { exact: true }).fill('24')
    await page.getByLabel('电子书行距', { exact: true }).fill('2.2')
    await page.getByLabel('电子书正文宽度', { exact: true }).fill('620')
    await page.getByRole('tab', { name: '翻页', exact: true }).click()
    await page.getByLabel('电子书翻页方式', { exact: true }).selectOption('scroll')
    await page.getByRole('tab', { name: '外观', exact: true }).click()
    await page.getByRole('button', { name: '主题：夜间', exact: true }).click()
    await page.keyboard.press('Escape')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 600))
    await expect(page.locator('[data-sentence="93"]')).toBeInViewport()
    expect(await position(page)).toBe(93)
    await page.mouse.move(350, 250)
    await expect(page.locator('.reader-toolbar')).toHaveAttribute('data-visible', 'false')
    await page.screenshot({ path: testInfo.outputPath('reader-small-dark.png') })
    await back(page)
    await page.getByRole('button', { name: '阅读 日常阅读', exact: true }).click()
    await ready(page)
    expect(await position(page)).toBe(93)
    await page.reload()
    await ready(page)
    expect(await position(page)).toBe(93)
    await expect(page.locator('.ebook-reader-page')).toHaveAttribute('data-mode', 'scroll')
    await closeOwnedElectron(app)
    app = await electron.launch({ args, env })
    page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await page.getByRole('button', { name: '电子书', exact: true }).click()
    await expect(page.getByRole('heading', { name: '我的书架', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '阅读 日常阅读', exact: true }).click()
    await ready(page)
    expect(await position(page)).toBe(93)
    await settings(page)
    await expect(page.getByLabel('电子书字号', { exact: true })).toHaveValue('24')
    await expect(page.getByLabel('电子书行距', { exact: true })).toHaveValue('2.2')
    await page.getByRole('tab', { name: '外观', exact: true }).click()
    await expect(page.getByRole('button', { name: '主题：夜间', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await page.keyboard.press('Escape')
    await back(page)
    await choose(files.txt)
    await page.getByRole('button', { name: '导入电子书', exact: true }).click()
    await ready(page)
    expect(await position(page)).toBe(93)
    expect(await books()).toHaveLength(1)
    await back(page)
    await choose(files.epubFile)
    await page.getByRole('button', { name: '导入电子书', exact: true }).click()
    await ready(page)
    await expect(page.locator('.book-viewport')).toContainText('这是阅读顺序中的第一段正文。')
    await expect(page.locator('.book-viewport')).not.toContainText('危险脚本')
    expect(await books()).toHaveLength(2)
    await back(page)
    await page.getByRole('button', { name: '更多 阅读顺序 的操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '移除电子书 阅读顺序', exact: true }).click()
    await page
      .getByRole('dialog', { name: '确认移除书籍', exact: true })
      .getByRole('button', { name: '确认移除记录', exact: true })
      .click()
    await expect.poll(async () => (await books()).length).toBe(1)
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
  }
})

test('standalone reader preserves the audio element and playback position across navigation', async () => {
  const root = mkdtempSync(join(tmpdir(), '听读阅读与播放 ')),
    files = fixtures(root)
  const app = await electron.launch({
    args: [resolve(process.env.RALB_APP_ROOT ?? '.')],
    env: environment(root),
  })
  try {
    const page = await app.firstWindow()
    const choose = async (path: string) =>
      app.evaluate(({ dialog }, selected) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
      }, path)
    await choose(resolve('tests/fixtures/第32集-伴读样本.wav'))
    await page.getByRole('button', { name: '选择音频文件', exact: true }).click()
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await page.getByRole('slider', { name: '播放进度', exact: true }).fill('1500')
    await expect(page.getByRole('slider', { name: '播放进度', exact: true })).toHaveValue('1500')
    await page.locator('audio').evaluate((node) => {
      node.dataset.readerProbe = 'original-audio'
    })
    const audio = () =>
      page.locator('audio').evaluate((node: HTMLAudioElement) => ({
        src: node.src,
        paused: node.paused,
        time: node.currentTime,
        identity: node.dataset.readerProbe,
      }))
    const before = await audio()
    await page.getByRole('button', { name: '电子书', exact: true }).click()
    await choose(files.txt)
    await page.getByRole('button', { name: '导入电子书', exact: true }).click()
    await ready(page)
    await page.locator('.book-viewport').press('ArrowRight')
    await reveal(page)
    await page.getByRole('button', { name: '打开目录' }).click()
    await page.getByRole('button', { name: '第2章 清晨', exact: true }).click()
    await expect.poll(() => position(page)).toBe(135)
    expect(await audio()).toEqual(before)
    await expect(page.getByRole('region', { name: '播放器', exact: true })).toHaveCount(0)
    await back(page)
    await expect(page.getByRole('button', { name: '播放', exact: true })).toBeVisible()
    await expect(page.getByRole('slider', { name: '播放进度', exact: true })).toHaveValue('1500')
    expect(await audio()).toEqual(before)
  } finally {
    await closeOwnedElectron(app)
  }
})

test('continuous scrolling loads beyond chunk boundaries and restores position while trimming distant text', async () => {
  const root = mkdtempSync(join(tmpdir(), '听读连续滚动 ')),
    path = join(root, '长篇小说.txt')
  writeFileSync(
    path,
    `第1章 旅途\n${Array.from({ length: 900 }, (_, i) => `这是旅途中的第${i}段，远山依然笼罩在淡淡的薄雾里，少年沿着河岸继续前行。`).join('\n')}`,
  )
  const app = await electron.launch({
    args: [resolve(process.env.RALB_APP_ROOT ?? '.')],
    env: environment(root),
  })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
    }, path)
    await page.getByRole('button', { name: '电子书', exact: true }).click()
    await page.getByRole('button', { name: '导入电子书', exact: true }).click()
    await ready(page)
    await settings(page)
    await page.getByRole('tab', { name: '翻页', exact: true }).click()
    await page.getByLabel('电子书翻页方式', { exact: true }).selectOption('scroll')
    await page.keyboard.press('Escape')
    const viewport = page.locator('.book-viewport')
    let previous = 0
    for (let i = 0; i < 8; i++) {
      const end = Number(await viewport.getAttribute('data-last'))
      await viewport.dispatchEvent('pointerdown', { pointerType: 'mouse' })
      await viewport.evaluate((node) => {
        node.scrollTop = node.scrollHeight - node.clientHeight - 50
      })
      await expect
        .poll(async () => Number(await viewport.getAttribute('data-last')))
        .toBeGreaterThan(end)
      expect(await position(page)).toBeGreaterThan(previous)
      previous = await position(page)
      expect(await viewport.locator('[data-sentence]').count()).toBeLessThanOrEqual(300)
      await expect(viewport.locator(`[data-sentence="${previous}"]`)).toBeInViewport()
    }
    expect(Number(await viewport.getAttribute('data-first'))).toBeGreaterThan(0)
    for (let i = 0; i < 3; i++) {
      const first = Number(await viewport.getAttribute('data-first'))
      await viewport.dispatchEvent('pointerdown', { pointerType: 'mouse' })
      await viewport.evaluate((node) => {
        node.scrollTop = 20
      })
      await expect
        .poll(async () => Number(await viewport.getAttribute('data-first')))
        .toBeLessThan(first)
      expect(await position(page)).toBeLessThan(previous)
      previous = await position(page)
    }
    await viewport.press('Control+End')
    await expect.poll(() => position(page)).toBe(899)
    await expect(viewport.locator('[data-sentence="899"]')).toBeInViewport()
    await reveal(page)
    await expect(page.getByRole('button', { name: '下一章', exact: true })).toBeDisabled()
    await viewport.press('Control+Home')
    await expect.poll(() => position(page)).toBe(0)
    await reveal(page)
    await expect(page.getByRole('button', { name: '上一章', exact: true })).toBeDisabled()
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
  }
})

test('pagination preserves character offsets inside long sentences after reopening and resizing', async ({}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), '听读长句分页 ')),
    path = join(root, '长句.txt')
  writeFileSync(path, `第1章 长路\n${'山间的风缓缓吹来'.repeat(83)}。\n最后一段文字。`)
  const app = await electron.launch({
    args: [resolve(process.env.RALB_APP_ROOT ?? '.')],
    env: environment(root),
  })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow, dialog }, selected) => {
      BrowserWindow.getAllWindows()[0]!.setSize(720, 600)
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
    }, path)
    await page.getByRole('button', { name: '电子书', exact: true }).click()
    await page.getByRole('button', { name: '导入电子书', exact: true }).click()
    await ready(page)
    await settings(page)
    await page.getByLabel('电子书字号', { exact: true }).fill('28')
    await page.keyboard.press('Escape')
    await page.locator('.book-viewport').press('ArrowRight')
    const offset = async () =>
      Number(await page.locator('.reader-progress-label').getAttribute('data-offset'))
    await expect.poll(offset).toBeGreaterThan(0)
    expect(await position(page)).toBe(0)
    const savedOffset = await offset()
    await back(page)
    await page.getByRole('button', { name: '阅读 长句', exact: true }).click()
    await ready(page)
    expect(await offset()).toBe(savedOffset)
    expect(
      await page.locator('.book-viewport').evaluate((node) => node.scrollLeft),
    ).toBeGreaterThan(0)
    await page.reload()
    await ready(page)
    expect(await offset()).toBe(savedOffset)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 750))
    expect(await offset()).toBe(savedOffset)
    await settings(page)
    await page.screenshot({ path: testInfo.outputPath('reader-settings.png') })
    await page.keyboard.press('Escape')
    await page.mouse.move(400, 250)
    await page.mouse.wheel(0, 100)
    await expect.poll(offset).toBeGreaterThan(savedOffset)
  } finally {
    await closeOwnedElectron(app)
  }
})

test('horizontal pages remain navigable across fetched windows and support progress and fullscreen', async () => {
  test.setTimeout(60_000)
  const root = mkdtempSync(join(tmpdir(), '听读跨页 ')),
    path = join(root, '跨页阅读.txt')
  writeFileSync(
    path,
    `第1章 山海\n${Array.from({ length: 900 }, (_, i) => `第${i}段记下了路上的风景，山海之间仍有漫长的旅程。`).join('\n')}`,
  )
  const app = await electron.launch({
    args: [resolve(process.env.RALB_APP_ROOT ?? '.')],
    env: environment(root),
  })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
    }, path)
    await page.getByRole('button', { name: '电子书', exact: true }).click()
    await page.getByRole('button', { name: '导入电子书', exact: true }).click()
    await ready(page)
    const viewport = page.locator('.book-viewport')
    let previous = 0
    for (let i = 0; i < 35; i++) {
      await viewport.press('PageDown')
      await expect.poll(() => position(page)).toBeGreaterThan(previous)
      previous = await position(page)
      expect(await viewport.locator('[data-sentence]').count()).toBeLessThanOrEqual(300)
    }
    expect(Number(await viewport.getAttribute('data-first'))).toBeGreaterThan(0)
    for (let i = 0; i < 10; i++) {
      await viewport.press('PageUp')
      await expect.poll(() => position(page)).toBeLessThan(previous)
      previous = await position(page)
    }
    await reveal(page)
    const progress = page.getByRole('slider', { name: '阅读进度', exact: true })
    await progress.fill('800')
    await progress.dispatchEvent('pointerup')
    await expect.poll(() => position(page)).toBe(800)
    await expect(viewport.locator('[data-sentence="800"]')).toBeInViewport()
    await viewport.press('F11')
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)
    expect(await position(page)).toBe(800)
    await viewport.press('F11')
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false)
    await back(page)
    await page.getByRole('button', { name: '阅读 跨页阅读', exact: true }).click()
    await ready(page)
    expect(await position(page)).toBe(800)
    await page.evaluate(() => history.back())
    await expect(page.getByRole('heading', { name: '我的书架', exact: true })).toBeVisible()
  } finally {
    await closeOwnedElectron(app)
  }
})
