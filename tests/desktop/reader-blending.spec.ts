import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { closeOwnedElectron } from '../model/electron-lifecycle'
import { colorContrast } from '../../src/renderer/src/reader-settings'

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
async function assertContrast(page: Page) {
  const colors = await page.locator('.reader-panel-drawer').evaluate((node) => {
    const canvas = document.createElement('canvas'),
      ctx = canvas.getContext('2d')!
    canvas.width = canvas.height = 1
    const hex = (css: string) => {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = css
      ctx.fillRect(0, 0, 1, 1)
      return (
        '#' +
        Array.from(ctx.getImageData(0, 0, 1, 1).data)
          .slice(0, 3)
          .map((v) => v.toString(16).padStart(2, '0'))
          .join('')
      )
    }
    const style = getComputedStyle(node)
    const painted = style.getPropertyValue('--reader-panel-solid').trim()
    const text = Array.from(
      node.querySelectorAll(
        'h2, .reader-hint, .reader-setting-caption label, .reader-range-setting output, .reader-color-setting, .reader-color-setting > span, .reader-settings-reset button',
      ),
    )
      .filter((el) => (el as HTMLElement).offsetHeight > 0)
      .map((el) => hex(getComputedStyle(el).color))
    const select = node.querySelector('select')!
    return {
      painted,
      text,
      field: hex(getComputedStyle(select).backgroundColor),
      fieldText: hex(getComputedStyle(select).color),
      menu: hex(getComputedStyle(select, '::picker(select)').backgroundColor),
    }
  })
  for (const foreground of colors.text)
    expect(colorContrast(colors.painted, foreground)).toBeGreaterThanOrEqual(4.5)
  expect(colorContrast(colors.field, colors.fieldText)).toBeGreaterThanOrEqual(4.5)
  expect(colors.menu.toLowerCase()).toBe(colors.painted.toLowerCase())
}

test('two columns blend into every reading background and transparent controls follow the painted surface', async ({}, info) => {
  const root = mkdtempSync(join(tmpdir(), 'reader-blending-'))
  const file = join(root, '自然阅读.txt')
  writeFileSync(
    file,
    `第一章 山海来信\n${Array.from({ length: 300 }, (_, i) => `第${i}段。雨停的时候，远方的群山渐渐清晰起来。风吹过窗前的树梢，少年收好那封旧信，沿着河流继续前行。`).join('\n')}`,
  )
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, file)
    await page.getByRole('button', { name: '电子书', exact: true }).click()
    await page.getByRole('button', { name: '导入电子书', exact: true }).click()
    await expect(page.locator('.book-viewport')).toHaveAttribute('aria-busy', 'false')
    await page.mouse.move(80, 15)
    await page.getByRole('button', { name: '阅读设置', exact: true }).click()
    await page.getByRole('tab', { name: '翻页', exact: true }).click()
    await page.getByLabel('电子书页面布局', { exact: true }).selectOption('book')
    await expect(page.getByLabel('分页动画', { exact: true })).toHaveValue('fade')
    await page.getByRole('tab', { name: '外观', exact: true }).click()
    for (const readingTheme of ['纸白', '米黄', '浅绿', '夜间']) {
      await page.getByRole('button', { name: `主题：${readingTheme}`, exact: true }).click()
      await expect
        .poll(() =>
          page.locator('.ebook-reader-page').evaluate((node) => node.getAnimations().length),
        )
        .toBe(0)
      const surface = await page.locator('.ebook-reader-page').evaluate((node) => {
        const frame = node.querySelector('.reader-content-frame')!,
          viewport = node.querySelector('.book-viewport')!
        return {
          background: getComputedStyle(node).backgroundColor,
          selected: getComputedStyle(node).getPropertyValue('--reading-bg').trim(),
          frame: getComputedStyle(frame).backgroundColor,
          border: getComputedStyle(frame).borderWidth,
          shadow: getComputedStyle(frame).boxShadow,
          before: getComputedStyle(frame, '::before').content,
          after: getComputedStyle(frame, '::after').content,
          count: getComputedStyle(viewport.firstElementChild!).columnCount,
        }
      })
      const expected = await page.evaluate((hex) => {
        const el = document.createElement('div')
        el.style.backgroundColor = hex
        document.body.append(el)
        const result = getComputedStyle(el).backgroundColor
        el.remove()
        return result
      }, surface.selected)
      expect(surface).toMatchObject({
        background: expected,
        frame: 'rgba(0, 0, 0, 0)',
        border: '0px',
        shadow: 'none',
        before: 'none',
        after: 'none',
        count: '2',
      })
      for (const appTheme of ['dark', 'light']) {
        await page.getByLabel('应用界面主题', { exact: true }).selectOption(appTheme)
        for (const transparency of [0, 25, 50, 75, 100]) {
          await page.getByLabel('电子书面板透明度', { exact: true }).fill(String(transparency))
          await assertContrast(page)
        }
      }
    }
    await page.getByRole('button', { name: '主题：纸白', exact: true }).click()
    await page.getByLabel('应用界面主题', { exact: true }).selectOption('dark')
    await page.getByLabel('电子书面板透明度', { exact: true }).fill('100')
    await expect(page.locator('.reader-panel-drawer')).toHaveAttribute('data-panel-tone', 'light')
    await assertContrast(page)
    await expect
      .poll(() =>
        page.evaluate(
          () => document.getAnimations().filter((a) => a.playState === 'running').length,
        ),
      )
      .toBe(0)
    await page.screenshot({ path: info.outputPath('transparent-on-paper.png') })
    await page.keyboard.press('Escape')
    await page.reload()
    await expect(page.locator('.book-viewport')).toHaveAttribute('aria-busy', 'false')
    await page.mouse.move(80, 15)
    await page.getByRole('button', { name: '阅读设置', exact: true }).click()
    await page.getByRole('tab', { name: '外观', exact: true }).click()
    await expect(page.getByLabel('电子书面板透明度', { exact: true })).toHaveValue('100')
    await assertContrast(page)
    await page.getByLabel('应用界面主题', { exact: true }).selectOption('system')
    await page.getByLabel('电子书面板透明度', { exact: true }).fill('0')
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.locator('.reader-panel-drawer')).toHaveAttribute('data-panel-tone', 'light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('.reader-panel-drawer')).toHaveAttribute('data-panel-tone', 'dark')
    await color(page, '电子书背景色', '#808080')
    await page.getByLabel('电子书面板透明度', { exact: true }).fill('60')
    await assertContrast(page)
    await page.keyboard.press('Escape')
    await page.mouse.move(550, 450)
    await expect
      .poll(() =>
        page.locator('.reader-toolbar').evaluate((node) => getComputedStyle(node).opacity),
      )
      .toBe('0')
    await page.screenshot({ path: info.outputPath('blended-two-columns.png') })
  } finally {
    await closeOwnedElectron(app)
  }
})
