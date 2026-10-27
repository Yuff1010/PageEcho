import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { closeOwnedElectron } from '../model/electron-lifecycle'
import { menuAction } from '../helpers/ui'
function environment(root: string) {
  const value = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(value, 'ELECTRON_RUN_AS_NODE')
  return value
}
async function reveal(page: Page) {
  await page.mouse.move(80, 15)
  await expect(page.locator('.reader-toolbar')).toHaveAttribute('data-visible', 'true')
}
async function openSettings(page: Page) {
  await reveal(page)
  await page.getByRole('button', { name: '阅读设置', exact: true }).click()
  await expect(page.getByRole('region', { name: '电子书阅读设置', exact: true })).toBeVisible()
}
async function openFixture(
  app: Awaited<ReturnType<typeof electron.launch>>,
  page: Page,
  root: string,
) {
  const path = join(root, '浮层测试.txt')
  writeFileSync(
    path,
    `第1章 山路\n${Array.from({ length: 900 }, (_, i) => `第${i}段记下了旅途中的风景，少年走过山间的小路，看见远方的河流映着温暖的阳光。`).join('\n')}`,
  )
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, path)
  await page.getByRole('button', { name: '电子书', exact: true }).click()
  await page.getByRole('button', { name: '导入电子书', exact: true }).click()
  await expect(page.locator('.book-viewport')).toHaveAttribute('aria-busy', 'false')
}
async function alpha(page: Page) {
  return page.locator('.reader-panel-drawer').evaluate((node) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')!
    context.fillStyle = getComputedStyle(node).backgroundColor
    context.fillRect(0, 0, 1, 1)
    return context.getImageData(0, 0, 1, 1).data[3]!
  })
}

test('settings require a click, overlay without reflow, save transparency, and keep scrolling at the window edge', async ({}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), 'reader-overlay-')),
    app = await electron.launch({
      args: [resolve(process.env.RALB_APP_ROOT ?? '.')],
      env: environment(root),
    })
  try {
    const page = await app.firstWindow(),
      errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await openFixture(app, page, root)
    const viewport = page.locator('.book-viewport'),
      article = page.locator('.ebook-text')
    const before = await viewport.boundingBox(),
      textBefore = await article.boundingBox()
    await reveal(page)
    await page.getByRole('button', { name: '阅读设置', exact: true }).hover()
    await expect(page.getByRole('region', { name: '电子书阅读设置', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '阅读设置', exact: true }).click()
    expect(await viewport.boundingBox()).toEqual(before)
    expect(await article.boundingBox()).toEqual(textBefore)
    await page.getByRole('tab', { name: '外观', exact: true }).click()
    await page.getByLabel('电子书面板透明度', { exact: true }).fill('60')
    await expect.poll(() => alpha(page)).toBe(102)
    expect(
      await page.locator('.reader-panel-drawer').evaluate((node) => getComputedStyle(node).opacity),
    ).toBe('1')
    expect(await viewport.boundingBox()).toEqual(before)
    await page.keyboard.press('Escape')
    await page.reload()
    await expect(viewport).toHaveAttribute('aria-busy', 'false')
    await openSettings(page)
    await page.getByRole('tab', { name: '外观', exact: true }).click()
    await expect(page.getByLabel('电子书面板透明度', { exact: true })).toHaveValue('60')
    await page.getByRole('tab', { name: '翻页', exact: true }).click()
    await page.getByLabel('电子书翻页方式', { exact: true }).selectOption('scroll')
    await page.keyboard.press('Escape')
    const full = await viewport.boundingBox(),
      windowWidth = await page.evaluate(() => innerWidth),
      body = await article.boundingBox()
    expect(Math.abs(full!.x + full!.width - windowWidth)).toBeLessThanOrEqual(1)
    expect(body!.width).toBeLessThanOrEqual(680)
    expect(Math.abs(body!.x + body!.width / 2 - windowWidth / 2)).toBeLessThan(8)
    await viewport.dispatchEvent('pointerdown', { pointerType: 'mouse' })
    await viewport.evaluate((node) => {
      node.scrollTop = 1000
    })
    await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
    await page.screenshot({ path: testInfo.outputPath('scrollbar-at-window-edge.png') })
    await openSettings(page)
    await page.getByRole('tab', { name: '排版', exact: true }).click()
    const font = page.getByLabel('电子书字体', { exact: true })
    await font.click()
    await expect.poll(() => font.evaluate((node) => node.matches(':open'))).toBe(true)
    expect(await font.evaluate((node) => getComputedStyle(node).appearance)).toBe('base-select')
    await page.getByRole('option', { name: '楷体', exact: true }).click()
    await expect(font).toHaveValue('kai')
    await font.click()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('region', { name: '电子书阅读设置', exact: true })).toBeVisible()
    await font.click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await expect(font).toHaveValue('system')
    await page.screenshot({ path: testInfo.outputPath('overlay-transparent.png') })
    await page.keyboard.press('Escape')
    await reveal(page)
    await page.getByRole('button', { name: '返回阅读书架', exact: true }).click()
    await page.getByRole('button', { name: '有声书', exact: true }).click()
    const sort = page.getByRole('combobox', { name: '书架排序', exact: true })
    await sort.click()
    await page.getByRole('option', { name: '书名排序', exact: true }).click()
    await expect(sort).toHaveValue('title')
    const rate = page.getByRole('combobox', { name: '播放倍速', exact: true })
    await rate.click()
    await page.getByRole('option', { name: '2×', exact: true }).click()
    await expect(rate).toHaveValue('2')
    await menuAction(page, '应用设置', '应用信息')
    const appTheme = page.getByRole('combobox', { name: '应用界面主题', exact: true })
    await appTheme.click()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: '应用信息', exact: true })).toBeVisible()
    await appTheme.click()
    await page.getByRole('option', { name: '浅色', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'light')
    await appTheme.click()
    await page.screenshot({ path: testInfo.outputPath('dropdown-light.png') })
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
  }
})

test('fade survives asynchronous prefetch and every animation remains cancellable without losing the reading anchor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reader-animation-')),
    app = await electron.launch({
      args: [resolve(process.env.RALB_APP_ROOT ?? '.')],
      env: environment(root),
    })
  try {
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await openFixture(app, page, root)
    const viewport = page.locator('.book-viewport')
    await openSettings(page)
    await page.getByRole('tab', { name: '翻页', exact: true }).click()
    await page.getByLabel('分页动画', { exact: true }).selectOption('fade')
    await page.getByLabel('电子书动画时长', { exact: true }).fill('400')
    await page.keyboard.press('Escape')
    const last = Number(await viewport.getAttribute('data-last'))
    await viewport.evaluate((node) => {
      const gap = 48,
        stride = node.clientWidth + gap,
        columns = Math.ceil((node.scrollWidth + gap) / stride - 0.01)
      node.scrollLeft = Math.max(0, columns - 3) * stride
    })
    await viewport.press('ArrowRight')
    const animation = await viewport.evaluateHandle((node) => node.getAnimations()[0])
    expect(await animation.evaluate((value) => !!value)).toBe(true)
    await expect
      .poll(async () => Number(await viewport.getAttribute('data-last')))
      .toBeGreaterThan(last)
    await expect
      .poll(() => animation.evaluate((value) => Number(value!.currentTime)), {
        intervals: [16, 32],
      })
      .toBeGreaterThan(130)
    expect(await animation.evaluate((value) => value!.playState)).toBe('running')
    const mid = await viewport.evaluate((node) => Number(getComputedStyle(node).opacity))
    expect(mid).toBeGreaterThan(0.1)
    expect(mid).toBeLessThan(0.95)
    await animation.evaluate((value) => value!.finished.then(() => true))
    expect(await viewport.evaluate((node) => Number(getComputedStyle(node).opacity))).toBe(1)
    await animation.dispose()
    for (const [mode, property] of [
      ['rise', 'translate'],
      ['zoom', 'scale'],
      ['flip', 'transform'],
      ['wipe', 'clipPath'],
    ]) {
      await openSettings(page)
      await page.getByRole('tab', { name: '翻页', exact: true }).click()
      await page.getByLabel('分页动画', { exact: true }).selectOption(mode!)
      await page.keyboard.press('Escape')
      await viewport.press('Control+Home')
      await expect(viewport).toHaveAttribute('aria-busy', 'false')
      await viewport.press('ArrowRight')
      const keys = await viewport.evaluate((node) =>
        [...node.getAnimations(), ...node.parentElement!.getAnimations()]
          .flatMap((a) => (a.effect as KeyframeEffect).getKeyframes())
          .flatMap((frame) => Object.keys(frame)),
      )
      expect(keys).toContain(property)
    }
    for (let i = 0; i < 8; i++) await viewport.press('ArrowRight')
    const position = await page.locator('.reader-progress-label').getAttribute('data-position'),
      offset = await page.locator('.reader-progress-label').getAttribute('data-offset')
    await reveal(page)
    await page.getByRole('button', { name: '返回阅读书架', exact: true }).click()
    await page.getByRole('button', { name: '阅读 浮层测试', exact: true }).click()
    await expect(viewport).toHaveAttribute('aria-busy', 'false')
    await expect(page.locator('.reader-progress-label')).toHaveAttribute('data-position', position!)
    await expect(page.locator('.reader-progress-label')).toHaveAttribute('data-offset', offset!)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openSettings(page)
    await page.getByRole('tab', { name: '翻页', exact: true }).click()
    await expect(
      page.getByText('系统已开启减少动态效果，分页动画和平滑滚动暂不播放。', { exact: true }),
    ).toBeVisible()
  } finally {
    await closeOwnedElectron(app)
  }
})
