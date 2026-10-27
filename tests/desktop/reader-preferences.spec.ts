import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { closeOwnedElectron } from '../model/electron-lifecycle'
function env(root: string) {
  const value = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(value, 'ELECTRON_RUN_AS_NODE')
  return value
}
function fiction(root: string, name: string) {
  const path = join(root, `${name}.txt`)
  writeFileSync(
    path,
    `第1章 山路 · ${name}\n${Array.from({ length: 210 }, (_, i) => `第${i}次钟声响起，少年沿着山间的小路前进，河水静静流向远方。`).join('\n')}\n第2章 ${'清晨的山海与旅途'.repeat(8)}\n${Array.from({ length: 210 }, (_, i) => `清晨第${i}缕阳光照进窗户，旅人带着一本旧笔记开始了新的一天。`).join('\n')}`,
  )
  return path
}
async function reveal(page: Page) {
  await page.mouse.move(80, 15)
  await expect(page.locator('.reader-toolbar')).toHaveAttribute('data-visible', 'true')
}
async function settings(page: Page) {
  await reveal(page)
  await page.getByRole('button', { name: '阅读设置', exact: true }).click()
  await expect(page.getByRole('tab', { name: '排版', exact: true })).toBeVisible()
}
async function tab(page: Page, name: string) {
  await page.getByRole('tab', { name, exact: true }).click()
}
async function back(page: Page) {
  await reveal(page)
  await page.getByRole('button', { name: '返回阅读书架', exact: true }).click()
  await expect(page.getByRole('heading', { name: '我的书架', exact: true })).toBeVisible()
}
async function ready(page: Page) {
  await expect(page.locator('.book-viewport')).toHaveAttribute('aria-busy', 'false')
}
async function position(page: Page) {
  return Number(await page.locator('.reader-progress-label').getAttribute('data-position'))
}
async function color(page: Page, label: string, value: string) {
  if (!(await page.getByLabel(label, { exact: true }).isVisible()))
    await page
      .locator('.reader-advanced-settings > summary')
      .filter({ hasText: '自定义配色' })
      .click()
  await page.getByLabel(label, { exact: true }).evaluate((node, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
    node.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
}
async function importBook(
  app: Awaited<ReturnType<typeof electron.launch>>,
  page: Page,
  path: string,
) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, path)
  await page.getByRole('button', { name: '导入电子书', exact: true }).click()
  await ready(page)
}
async function locate(page: Page) {
  await page.locator('.book-viewport').press('Control+f')
  await page.getByLabel('全文搜索文字', { exact: true }).fill('第137次钟声')
  await page.getByRole('button', { name: '搜索原文', exact: true }).click()
  await page.getByRole('list', { name: '全文搜索结果' }).getByRole('button').click()
  await expect.poll(() => position(page)).toBe(137)
}

test('typography sliders, density presets and reflow keep the current text anchored', async ({}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), 'reader-layout-')),
    app = await electron.launch({
      args: [resolve(process.env.RALB_APP_ROOT ?? '.')],
      env: env(root),
    })
  try {
    const page = await app.firstWindow(),
      errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.getByRole('button', { name: '电子书', exact: true }).click()
    await importBook(app, page, fiction(root, '排版验证'))
    const metrics = () =>
      page.locator('.book-viewport').evaluate((node) => {
        const s = getComputedStyle(node),
          p = getComputedStyle(node.querySelector('p')!)
        return {
          size: s.fontSize,
          line: s.lineHeight,
          tracking: s.letterSpacing,
          weight: s.fontWeight,
          font: s.fontFamily,
          gap: p.marginBottom,
          indent: p.textIndent,
          width: node.clientWidth,
        }
      })
    expect(await metrics()).toMatchObject({
      size: '20px',
      line: '36px',
      gap: '14px',
      indent: '40px',
    })
    expect((await metrics()).width).toBeLessThanOrEqual(680)
    await locate(page)
    await settings(page)
    await page.getByLabel('电子书字号', { exact: true }).fill('36')
    await page.getByLabel('电子书字体', { exact: true }).selectOption('kai')
    await page.getByLabel('电子书字重', { exact: true }).selectOption('700')
    await page.getByLabel('电子书行距', { exact: true }).fill('2.3')
    await page.getByLabel('电子书字距', { exact: true }).fill('1.3')
    await page.getByLabel('电子书段间距', { exact: true }).fill('1.4')
    await page.getByLabel('电子书正文宽度', { exact: true }).fill('360')
    await page.getByLabel('首行缩进两个汉字', { exact: true }).uncheck()
    expect(await metrics()).toMatchObject({
      size: '36px',
      line: '82.8px',
      tracking: '1.3px',
      weight: '700',
      gap: '50.4px',
      indent: '0px',
      width: 360,
    })
    expect((await metrics()).font).toContain('KaiTi')
    await page.getByRole('button', { name: '紧凑', exact: true }).click()
    await expect(page.getByLabel('电子书行距', { exact: true })).toHaveValue('1.5')
    await expect(page.getByLabel('电子书段间距', { exact: true })).toHaveValue('0.3')
    await page.getByRole('button', { name: '舒展', exact: true }).click()
    await expect(page.getByLabel('电子书字距', { exact: true })).toHaveValue('0.6')
    await page.getByLabel('电子书字距', { exact: true }).fill('0.7')
    await expect(page.locator('.reader-density-caption')).toContainText('自定义')
    await page.getByRole('button', { name: '标准', exact: true }).click()
    expect(await position(page)).toBe(137)
    await page.getByLabel('电子书字号', { exact: true }).press('ArrowLeft')
    expect(await position(page)).toBe(137)
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-sentence="137"]')).toBeInViewport()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 600))
    await expect(page.locator('[data-sentence="137"]')).toBeInViewport()
    await settings(page)
    await expect(page.locator('.reader-panel-drawer')).toBeInViewport()
    const panel = await page.locator('.reader-panel-drawer').boundingBox(),
      footer = await page.locator('.reader-bottom-bar').boundingBox()
    expect(panel!.y + panel!.height).toBeLessThanOrEqual(footer!.y)
    await page.keyboard.press('Escape')
    await reveal(page)
    await page.getByRole('button', { name: '打开目录', exact: true }).click()
    await page.getByRole('button', { name: /^第2章 清晨的山海/ }).click()
    await expect.poll(() => position(page)).toBe(210)
    const longTitle = page.locator('.ebook-chapter-title').filter({ hasText: '清晨的山海' })
    expect(
      await longTitle.evaluate((node) => {
        const range = document.createRange()
        range.selectNodeContents(node)
        return range.getClientRects().length
      }),
    ).toBeGreaterThan(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await locate(page)
    await settings(page)
    await page.getByRole('button', { name: '恢复初始默认', exact: true }).click()
    expect(await metrics()).toMatchObject({
      size: '20px',
      line: '36px',
      tracking: 'normal',
      weight: '400',
      gap: '14px',
      indent: '40px',
    })
    await page.screenshot({ path: testInfo.outputPath('settings-small.png') })
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
  }
})

test('global defaults, per-book overrides and reading bookmarks persist through reopening and restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reader-scopes-')),
    args = [resolve(process.env.RALB_APP_ROOT ?? '.')],
    environment = env(root)
  let app = await electron.launch({ args, env: environment })
  try {
    let page = await app.firstWindow()
    await page.getByRole('button', { name: '电子书', exact: true }).click()
    await importBook(app, page, fiction(root, '第一本'))
    await settings(page)
    await page.getByLabel('电子书字号', { exact: true }).fill('24')
    await page.getByLabel('阅读设置应用范围', { exact: true }).selectOption('book')
    await page.getByLabel('电子书字号', { exact: true }).fill('30')
    await page.keyboard.press('Escape')
    await locate(page)
    await reveal(page)
    await page.getByRole('button', { name: '阅读书签', exact: true }).click()
    await page.getByRole('button', { name: '添加当前位置书签', exact: true }).click()
    await expect(page.getByRole('region', { name: '电子书书签' })).toContainText('书签已保存')
    await back(page)
    await importBook(app, page, fiction(root, '第二本'))
    await settings(page)
    await expect(page.getByLabel('电子书字号', { exact: true })).toHaveValue('24')
    await page.getByLabel('电子书字号', { exact: true }).fill('22')
    await page.getByLabel('电子书行距', { exact: true }).fill('2.05')
    await page.keyboard.press('Escape')
    await back(page)
    await page.getByRole('button', { name: '阅读 第一本', exact: true }).click()
    await ready(page)
    await settings(page)
    await expect(page.getByLabel('电子书字号', { exact: true })).toHaveValue('30')
    await expect(page.getByLabel('电子书行距', { exact: true })).toHaveValue('2.05')
    await page.getByLabel('阅读设置应用范围', { exact: true }).selectOption('global')
    await expect(page.getByLabel('电子书字号', { exact: true })).toHaveValue('22')
    await page.getByLabel('阅读设置应用范围', { exact: true }).selectOption('book')
    await expect(page.getByLabel('电子书字号', { exact: true })).toHaveValue('30')
    await page.keyboard.press('Escape')
    await page.locator('.book-viewport').press('Control+Home')
    await reveal(page)
    await page.getByRole('button', { name: '阅读书签', exact: true }).click()
    await page.getByRole('button', { name: /^跳转书签/ }).click()
    await expect.poll(() => position(page)).toBe(137)
    await closeOwnedElectron(app)
    app = await electron.launch({ args, env: environment })
    page = await app.firstWindow()
    await page.getByRole('button', { name: '电子书', exact: true }).click()
    await page.getByRole('button', { name: '阅读 第一本', exact: true }).click()
    await ready(page)
    expect(await position(page)).toBe(137)
    await settings(page)
    await expect(page.getByLabel('电子书字号', { exact: true })).toHaveValue('30')
    await page.getByRole('button', { name: '恢复全局默认', exact: true }).click()
    await expect(page.getByLabel('电子书字号', { exact: true })).toHaveValue('22')
    await page.keyboard.press('Escape')
    await reveal(page)
    await page.getByRole('button', { name: '阅读书签', exact: true }).click()
    await expect(page.getByRole('button', { name: /^跳转书签/ })).toHaveCount(1)
    await page.getByRole('button', { name: /^删除书签/ }).click()
    await expect(page.getByRole('button', { name: /^跳转书签/ })).toHaveCount(0)
    await page.reload()
    await ready(page)
    await reveal(page)
    await page.getByRole('button', { name: '阅读书签', exact: true }).click()
    await expect(page.getByRole('button', { name: /^跳转书签/ })).toHaveCount(0)
  } finally {
    await closeOwnedElectron(app)
  }
})

test('reading colors, saved palettes and application themes are independent and persist', async ({}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), 'reader-colors-')),
    app = await electron.launch({
      args: [resolve(process.env.RALB_APP_ROOT ?? '.')],
      env: env(root),
    })
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: '电子书', exact: true }).click()
    await importBook(app, page, fiction(root, '配色验证'))
    const bg = () =>
      page.locator('.ebook-reader-page').evaluate((n) => getComputedStyle(n).backgroundColor)
    expect(await bg()).toBe('rgb(244, 239, 223)')
    await settings(page)
    await tab(page, '外观')
    for (const [label, rgb] of [
      ['纸白', 'rgb(250, 250, 247)'],
      ['米黄', 'rgb(244, 239, 223)'],
      ['浅绿', 'rgb(228, 237, 223)'],
      ['夜间', 'rgb(27, 30, 28)'],
    ]) {
      await page.getByRole('button', { name: `主题：${label}`, exact: true }).click()
      await expect.poll(bg).toBe(rgb)
    }
    await color(page, '电子书背景色', '#eeeeee')
    await color(page, '电子书文字色', '#e0e0e0')
    await expect(
      page.getByText('当前配色对比度较低，长时间阅读可能费力。', { exact: true }),
    ).toBeVisible()
    await color(page, '电子书背景色', '#eef2e8')
    await color(page, '电子书文字色', '#213528')
    await page.locator('.reader-palettes > summary').click()
    await page.getByLabel('个人配色名称', { exact: true }).fill('清晨')
    await page.getByRole('button', { name: '保存配色', exact: true }).click()
    await page.getByRole('button', { name: '主题：夜间', exact: true }).click()
    await page.getByRole('button', { name: '应用配色 清晨', exact: true }).click()
    await expect.poll(bg).toBe('rgb(238, 242, 232)')
    await page.getByLabel('应用界面主题', { exact: true }).selectOption('light')
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'light')
    expect(await bg()).toBe('rgb(238, 242, 232)')
    await page.getByLabel('应用界面主题', { exact: true }).selectOption('system')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'dark')
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'light')
    await page.reload()
    await ready(page)
    await settings(page)
    await tab(page, '外观')
    await page.locator('.reader-palettes > summary').click()
    await expect(page.getByRole('button', { name: '应用配色 清晨', exact: true })).toBeVisible()
    expect(await bg()).toBe('rgb(238, 242, 232)')
    await page.getByLabel('应用界面主题', { exact: true }).selectOption('light')
    await page.screenshot({ path: testInfo.outputPath('reader-light-appearance.png') })
    await page.keyboard.press('Escape')
    await back(page)
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'light')
    await page.screenshot({ path: testInfo.outputPath('library-light.png') })
  } finally {
    await closeOwnedElectron(app)
  }
})

test('animations, smooth scrolling, focus and PC shortcuts preserve content and avoid control conflicts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reader-controls-')),
    app = await electron.launch({
      args: [resolve(process.env.RALB_APP_ROOT ?? '.')],
      env: env(root),
    })
  try {
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.getByRole('button', { name: '电子书', exact: true }).click()
    await importBook(app, page, fiction(root, '操作验证'))
    await settings(page)
    await tab(page, '翻页')
    await page.getByLabel('分页动画', { exact: true }).selectOption('slide')
    await page.getByLabel('电子书动画时长', { exact: true }).fill('320')
    await page.keyboard.press('Escape')
    const viewport = page.locator('.book-viewport')
    await viewport.press('ArrowRight')
    const animation = await viewport.evaluate((n) =>
      n.parentElement!.getAnimations().map((a) => a.effect!.getTiming().duration),
    )
    expect(animation).toContain(320)
    for (let i = 0; i < 6; i++) await viewport.press('ArrowRight')
    expect(await position(page)).toBeGreaterThan(0)
    await settings(page)
    await tab(page, '翻页')
    await page.getByLabel('减少动态效果', { exact: true }).check()
    await page.keyboard.press('Escape')
    await viewport.press('ArrowRight')
    expect(
      await viewport.evaluate(
        (n) => n.getAnimations().length + n.parentElement!.getAnimations().length,
      ),
    ).toBe(0)
    await settings(page)
    await tab(page, '翻页')
    await page.getByLabel('减少动态效果', { exact: true }).uncheck()
    await page.getByLabel('分页动画', { exact: true }).selectOption('none')
    await expect(page.getByLabel('电子书动画时长', { exact: true })).toBeDisabled()
    await page.keyboard.press('Escape')
    await viewport.press('Control+Home')
    await ready(page)
    await viewport.press('ArrowRight')
    expect(
      await viewport.evaluate(
        (n) => n.getAnimations().length + n.parentElement!.getAnimations().length,
      ),
    ).toBe(0)
    await settings(page)
    await tab(page, '翻页')
    await page.getByLabel('分页动画', { exact: true }).selectOption('fade')
    await page.getByLabel('电子书动画时长', { exact: true }).fill('100')
    await page.keyboard.press('Escape')
    await viewport.press('Control+Home')
    await ready(page)
    await viewport.press('ArrowRight')
    expect(
      await viewport.evaluate((n) =>
        n.getAnimations().map((animation) => animation.effect!.getTiming().duration),
      ),
    ).toContain(100)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await viewport.press('ArrowRight')
    expect(
      await viewport.evaluate(
        (n) => n.getAnimations().length + n.parentElement!.getAnimations().length,
      ),
    ).toBe(0)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await settings(page)
    await tab(page, '翻页')
    await page.getByLabel('分页动画', { exact: true }).selectOption('slide')
    await page.getByLabel('电子书动画时长', { exact: true }).fill('320')
    await page.getByLabel('电子书翻页方式', { exact: true }).selectOption('scroll')
    await expect(page.getByLabel('分页动画', { exact: true })).toBeDisabled()
    await expect(page.getByLabel('分页动画', { exact: true })).toHaveValue('slide')
    await expect(page.getByLabel('电子书动画时长', { exact: true })).toBeDisabled()
    await page.keyboard.press('Escape')
    await viewport.press('Control+Home')
    await reveal(page)
    await expect(page.getByRole('button', { name: '上一章', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '下一章', exact: true }).click()
    await expect.poll(() => position(page)).toBe(210)
    const top = await viewport.evaluate((n) => n.scrollTop),
      height = await viewport.evaluate((n) => n.clientHeight)
    for (let i = 0; i < 3; i++) await viewport.press('PageDown')
    await expect
      .poll(() => viewport.evaluate((n) => n.scrollTop))
      .toBeGreaterThan(top + 2 * (height - 40))
    await reveal(page)
    await page.getByRole('button', { name: '专注阅读', exact: true }).click()
    await expect(page.getByRole('button', { name: /^退出专注/ })).toBeVisible()
    await expect(page.locator('.reader-toolbar')).toHaveAttribute('inert', '')
    await page.mouse.move(80, 15)
    await expect(page.locator('.reader-toolbar')).toHaveAttribute('data-visible', 'false')
    await viewport.press('Escape')
    await expect(page.getByRole('button', { name: /^退出专注/ })).toHaveCount(0)
    const before = await position(page)
    await viewport.hover()
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -100)
    await page.keyboard.up('Control')
    await expect(page.locator('.ebook-reader-page')).toHaveAttribute('data-font', '21')
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor(),
      ),
    ).toBe(1)
    expect(await position(page)).toBe(before)
    await settings(page)
    await tab(page, '排版')
    const current = await position(page)
    await page.getByLabel('电子书字号', { exact: true }).press('ArrowRight')
    expect(await position(page)).toBe(current)
    await page.keyboard.press('Escape')
    await viewport.press('Control+f')
    await expect(page.getByLabel('全文搜索文字', { exact: true })).toBeFocused()
    await page.getByLabel('全文搜索文字', { exact: true }).fill('测试空格 不应翻页')
    expect(await position(page)).toBe(current)
    await page.keyboard.press('Escape')
    await settings(page)
    await tab(page, '翻页')
    await page.getByLabel('平滑滚动', { exact: true }).uncheck()
    await page.keyboard.press('Escape')
    const prior = await position(page)
    await viewport.press('PageDown')
    await expect.poll(() => position(page)).toBeGreaterThan(prior)
  } finally {
    await closeOwnedElectron(app)
  }
})
