import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { closeOwnedElectron } from '../model/electron-lifecycle'

function environment(root: string) {
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  return env
}
async function openSettings(page: Page) {
  await page.mouse.move(80, 15)
  await page.getByRole('button', { name: '阅读设置', exact: true }).click()
  await page.getByRole('tab', { name: '翻页', exact: true }).click()
}
async function fixture(app: Awaited<ReturnType<typeof electron.launch>>, page: Page, root: string) {
  const file = join(root, '双页书本.txt')
  writeFileSync(
    file,
    `第一章 山海来信\n${Array.from({ length: 900 }, (_, i) => `第${i}段。雨停的时候，车站里只剩下最后一盏灯，少年把远方的来信收进口袋。沿着河边走过旧书店，风吹过梧桐树梢，他想起很多年前的一场约定。`).join('\n')}`,
  )
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, file)
  await page.getByRole('button', { name: '电子书', exact: true }).click()
  await page.getByRole('button', { name: '导入电子书', exact: true }).click()
  await expect(page.locator('.book-viewport')).toHaveAttribute('aria-busy', 'false')
}
async function position(page: Page) {
  return Number(await page.locator('.reader-progress-label').getAttribute('data-position'))
}
async function clickHalf(page: Page, right: boolean, margin = false) {
  const bounds = (await page.locator('.reader-stage').boundingBox())!
  await page.mouse.click(
    bounds.x + (margin ? (right ? bounds.width - 12 : 12) : bounds.width * (right ? 0.75 : 0.25)),
    bounds.y + 100,
  )
}

test('book layout renders two consecutive pages, flips at the spine, restores anchors and adapts to a narrow window', async ({}, info) => {
  const root = mkdtempSync(join(tmpdir(), 'reader-book-'))
  const app = await electron.launch({
    args: [resolve(process.env.RALB_APP_ROOT ?? '.')],
    env: environment(root),
  })
  try {
    const page = await app.firstWindow(),
      errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await fixture(app, page, root)
    await openSettings(page)
    await page.getByLabel('电子书页面布局', { exact: true }).selectOption('book')
    await expect(page.getByLabel('分页动画', { exact: true })).toHaveValue('fade')
    await page.getByLabel('分页动画', { exact: true }).selectOption('book')
    await expect(page.getByLabel('分页动画', { exact: true })).toHaveValue('book')
    await page.getByLabel('电子书动画时长', { exact: true }).fill('400')
    await page.keyboard.press('Escape')
    const viewport = page.locator('.book-viewport')
    const columns = () =>
      page
        .locator('.ebook-text')
        .first()
        .evaluate((node) => getComputedStyle(node).columnCount)
    expect(await columns()).toBe('2')
    const spread = await viewport.evaluate((node) => {
      const bounds = node.getBoundingClientRect()
      const rects = Array.from(node.querySelectorAll('[data-sentence]')).flatMap((el) =>
        Array.from(el.getClientRects()),
      )
      return {
        left: rects.some((r) => r.left >= bounds.left && r.right < bounds.left + bounds.width / 2),
        right: rects.some(
          (r) => r.left > bounds.left + bounds.width / 2 && r.right <= bounds.right + 1,
        ),
        stride: node.clientWidth + parseFloat(getComputedStyle(node.firstElementChild!).columnGap),
      }
    })
    expect(spread.left && spread.right).toBe(true)
    await page.mouse.move(600, 400)
    await page.screenshot({ path: info.outputPath('book-spread.png') })
    await clickHalf(page, true)
    await expect.poll(() => position(page)).toBeGreaterThan(0)
    expect(await viewport.evaluate((node) => node.scrollLeft)).toBeCloseTo(spread.stride, 0)
    const layer = page.locator('.reader-book-turn')
    await expect(layer).toHaveCount(1)
    expect(await layer.locator('.reader-turn-leaf').count()).toBe(3)
    expect(await layer.locator('[data-sentence]').count()).toBe(0)
    await layer.evaluate((node) =>
      node.getAnimations({ subtree: true }).forEach((animation) => {
        animation.pause()
        animation.currentTime = 120
      }),
    )
    await page.screenshot({ path: info.outputPath('book-turn.png') })
    await layer.evaluate((node) =>
      node.getAnimations({ subtree: true }).forEach((animation) => animation.play()),
    )
    await expect(layer).toHaveCount(0)
    await clickHalf(page, false)
    await expect.poll(() => position(page)).toBe(0)
    await expect.poll(() => viewport.evaluate((node) => node.scrollLeft)).toBe(0)
    for (let i = 0; i < 7; i++) await clickHalf(page, true, i % 2 === 0)
    await expect.poll(() => position(page)).toBeGreaterThan(20)
    await expect(layer).toHaveCount(0)
    const before = await position(page)
    const offset = await page.locator('.reader-progress-label').getAttribute('data-offset')
    await page.reload()
    await expect(viewport).toHaveAttribute('aria-busy', 'false')
    expect(await columns()).toBe('2')
    expect(await position(page)).toBe(before)
    expect(await page.locator('.reader-progress-label').getAttribute('data-offset')).toBe(offset)
    await expect(viewport.locator(`[data-sentence="${before}"]`)).toBeInViewport()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 600))
    await expect.poll(columns).toBe('1')
    expect(await position(page)).toBe(before)
    await expect(viewport.locator(`[data-sentence="${before}"]`)).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await openSettings(page)
    await page.getByRole('tab', { name: '排版', exact: true }).click()
    await page.getByLabel('电子书字号', { exact: true }).fill('36')
    await page.keyboard.press('Escape')
    expect(await position(page)).toBe(before)
    await expect(viewport.locator(`[data-sentence="${before}"]`)).toBeInViewport()
    await expect
      .poll(() =>
        page.locator('.ebook-reader-page').evaluate((node) => getComputedStyle(node).opacity),
      )
      .toBe('1')
    await page.screenshot({ path: info.outputPath('book-small.png') })
    await clickHalf(page, true)
    await expect.poll(() => position(page)).toBeGreaterThan(before)
    await expect(layer).toHaveCount(0)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1160, 800))
    await expect.poll(columns).toBe('2')
    await viewport.press('Control+End')
    await expect(viewport).toHaveAttribute('aria-busy', 'false')
    await page.mouse.move(80, 15)
    await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled()
    const end = await position(page)
    await clickHalf(page, true)
    expect(await position(page)).toBe(end)
    await clickHalf(page, false)
    await expect.poll(() => position(page)).toBeLessThan(end)
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
  }
})

test('half-screen clicks work on text and margins while selections, controls, focus and scroll mode avoid accidental turns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reader-click-'))
  const app = await electron.launch({
    args: [resolve(process.env.RALB_APP_ROOT ?? '.')],
    env: environment(root),
  })
  try {
    const page = await app.firstWindow()
    await fixture(app, page, root)
    const viewport = page.locator('.book-viewport')
    await clickHalf(page, true)
    await expect.poll(() => position(page)).toBeGreaterThan(0)
    await clickHalf(page, false, true)
    await expect.poll(() => position(page)).toBe(0)
    const rect = await viewport.locator('[data-sentence="0"]').evaluate((node) => {
      const range = document.createRange()
      range.selectNodeContents(node)
      const r = range.getClientRects()[0]!
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
    await page.mouse.move(rect.x + 5, rect.y + rect.height / 2)
    await page.mouse.down()
    await page.mouse.move(rect.x + Math.min(150, rect.width - 5), rect.y + rect.height / 2, {
      steps: 10,
    })
    await page.mouse.up()
    expect(await page.evaluate(() => window.getSelection()?.toString().length)).toBeGreaterThan(0)
    expect(await position(page)).toBe(0)
    await clickHalf(page, true)
    expect(await position(page)).toBe(0)
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
    await openSettings(page)
    await page.getByLabel('电子书页面布局', { exact: true }).selectOption('book')
    expect(await position(page)).toBe(0)
    await page.getByLabel('电子书翻页方式', { exact: true }).selectOption('scroll')
    await expect(page.getByLabel('电子书页面布局', { exact: true })).toBeDisabled()
    await page.keyboard.press('Escape')
    await clickHalf(page, true)
    expect(await position(page)).toBe(0)
    await openSettings(page)
    await page.getByLabel('电子书翻页方式', { exact: true }).selectOption('pages')
    await page.getByLabel('减少动态效果', { exact: true }).check()
    await page.keyboard.press('Escape')
    await page.mouse.move(80, 15)
    await page.getByRole('button', { name: '专注阅读', exact: true }).click()
    await clickHalf(page, true)
    await expect.poll(() => position(page)).toBeGreaterThan(0)
    await expect(page.locator('.reader-book-turn')).toHaveCount(0)
    await viewport.press('ArrowRight')
    const before = await position(page)
    await clickHalf(page, true)
    await expect.poll(() => position(page)).toBeGreaterThan(before)
  } finally {
    await closeOwnedElectron(app)
  }
})
