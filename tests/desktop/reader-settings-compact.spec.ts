import { expect, test, _electron as electron, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { colorContrast } from '../../src/renderer/src/reader-settings'
import { closeOwnedElectron } from '../model/electron-lifecycle'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'

async function fixture(companion = false) {
  const root = mkdtempSync(join(tmpdir(), 'reader-compact-'))
  const file = join(root, '紧凑设置.txt')
  writeFileSync(file, `第一章 山路\n${'少年沿着山路前行，微风吹过树梢。\n'.repeat(150)}`)
  if (companion) {
    const path = join(root, '山路.wav')
    const wav = Buffer.alloc(44 + 90000 * 16)
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
    writeFileSync(path, wav)
    const store = new LibraryStore(createDataPaths(root).database)
    store.importBook(await scanBook(path, 'file'))
    const episode = store.listBooks()[0]!.episodes[0]!
    store.saveTranscript(episode.id, {
      version: 1,
      kind: 'manual',
      audioHash: episode.contentHash,
      coverage: [{ startMs: 0, endMs: 90000 }],
      segments: Array.from({ length: 80 }, (_, index) => ({
        id: `s${index}`,
        startMs: index * 1000,
        endMs: index * 1000 + 900,
        text: `第${index}段，少年沿着山路前行，微风吹过树梢。`,
      })),
    })
    store.saveProgress({
      sessionId: '',
      episodeId: episode.id,
      positionMs: 5000,
      durationMs: 90000,
      rate: 1,
      volume: 0,
    })
    store.close()
  }
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
  const page = await app.firstWindow()
  if (companion) {
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    await page.getByRole('button', { name: '伴读阅读设置', exact: true }).click()
    return { app, page, panel: page.getByRole('dialog', { name: '伴读阅读设置', exact: true }) }
  }
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await page.getByRole('button', { name: '电子书', exact: true }).click()
  await page.getByRole('button', { name: '导入电子书', exact: true }).click()
  await expect(page.locator('.book-viewport')).toHaveAttribute('aria-busy', 'false')
  await page.mouse.move(80, 15)
  await page.getByRole('button', { name: '阅读设置', exact: true }).click()
  return { app, page, panel: page.getByRole('region', { name: '电子书阅读设置', exact: true }) }
}

async function changeColor(page: Page, name: string, value: string) {
  await page.getByLabel(name, { exact: true }).evaluate((input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
}

test('reading settings stay compact at desktop and 720px widths, with bounded scroll and optional color controls', async ({}, info) => {
  const { app, page, panel } = await fixture()
  try {
    for (const [width, height] of [
      [1200, 900],
      [720, 600],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height)
        },
        { width: width!, height: height! },
      )
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
      for (const theme of ['light', 'dark']) {
        await panel.getByRole('tab', { name: '外观', exact: true }).click()
        await panel.getByLabel('应用界面主题', { exact: true }).selectOption(theme)
        await expect(page.locator('html')).toHaveAttribute('data-ui-theme', theme)
        const scope = panel.getByLabel('阅读设置应用范围', { exact: true })
        expect(await scope.locator('option').allTextContents()).toEqual(['全局', '本书'])
        const scopeBox = await scope.boundingBox()
        const labelBox = await panel.locator('.reader-scope-setting > label').boundingBox()
        expect(
          Math.abs(scopeBox!.y + scopeBox!.height / 2 - labelBox!.y - labelBox!.height / 2),
        ).toBeLessThan(2)
        await expect(panel.locator('.reader-advanced-settings[open]')).toHaveCount(0)
        await expect(panel.getByLabel('电子书背景色', { exact: true })).toBeHidden()
        await expect(panel.getByLabel('个人配色名称', { exact: true })).toBeHidden()
        for (const category of ['排版', '外观', '翻页']) {
          await panel.getByRole('tab', { name: category, exact: true }).click()
          const bounds = await panel.boundingBox()
          expect(bounds!.height).toBeLessThanOrEqual(Math.min(600, height! - 150) + 1)
          expect(bounds!.y + bounds!.height).toBeLessThan(height! - 60)
          expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
          await expect(
            panel.getByRole('button', { name: '恢复初始默认', exact: true }),
          ).toBeInViewport({ ratio: 1 })
          for (const row of await panel.locator('.reader-range-setting').all())
            expect((await row.boundingBox())!.height).toBeLessThanOrEqual(36)
        }
        await panel.getByRole('tab', { name: '外观', exact: true }).click()
        await panel
          .locator('.reader-advanced-settings > summary')
          .filter({ hasText: '自定义配色' })
          .click()
        await expect(panel.getByLabel('电子书背景色', { exact: true })).toBeVisible()
        await panel.locator('.reader-palettes > summary').click()
        await expect(panel.getByLabel('个人配色名称', { exact: true })).toBeVisible()
        const scroll = panel.locator('.reader-preferences')
        expect(await scroll.evaluate((node) => getComputedStyle(node).overflowY)).toBe('auto')
        await scroll.evaluate((node) => {
          node.scrollTop = node.scrollHeight
        })
        await expect(panel.getByLabel('应用界面主题', { exact: true })).toBeInViewport({ ratio: 1 })
        await page.screenshot({ path: info.outputPath(`compact-${width}-${theme}.png`) })
        // Advanced content is optional on the next category visit, while values persist.
        await panel.getByRole('tab', { name: '排版', exact: true }).click()
      }
    }
  } finally {
    await closeOwnedElectron(app)
  }
})

test('listening uses the same compact settings with three real categories and available turning controls', async () => {
  const { app, page, panel } = await fixture(true)
  try {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setContentSize(720, 600)
    })
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(720)
    await expect(panel.getByRole('tab')).toHaveCount(3)
    const layout = panel.getByRole('tab', { name: '排版', exact: true })
    await layout.focus()
    await layout.press('End')
    await expect(panel.getByRole('tab', { name: '翻页', exact: true })).toBeFocused()
    const turning = panel.getByRole('tabpanel')
    await expect(turning.getByLabel('电子书翻页方式', { exact: true })).toBeEnabled()
    await turning.getByLabel('电子书翻页方式', { exact: true }).selectOption('pages')
    await expect(turning.getByLabel('电子书页面布局', { exact: true })).toBeEnabled()
    await expect(turning.getByLabel('分页动画', { exact: true })).toBeEnabled()
    await turning.getByRole('button', { name: '阅读方式说明', exact: true }).focus()
    await expect(page.getByRole('tooltip')).toContainText('手动翻页或滚动后可回到当前播放位置')
    await page.keyboard.press('Escape')
    await expect(panel).toBeVisible()
    await panel.getByRole('tab', { name: '外观', exact: true }).click()
    await expect(panel.getByLabel('电子书翻页方式', { exact: true })).toHaveCount(0)
    const bounds = (await panel.boundingBox())!
    expect(bounds.height).toBeLessThan(500)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(600)
    expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
    await expect(panel.locator('.reader-advanced-settings[open]')).toHaveCount(0)
    await expect(panel.getByLabel('电子书面板透明度', { exact: true })).toBeEnabled()
  } finally {
    await closeOwnedElectron(app)
  }
})

test('optional help supports keyboard, hover and touch; drafts and important errors remain visible', async () => {
  const { app, page, panel } = await fixture()
  try {
    const scope = panel.getByLabel('阅读设置应用范围', { exact: true })
    const help = panel.getByRole('button', { name: '应用范围说明', exact: true })
    await scope.focus()
    await scope.press('Tab')
    await expect(help).toBeFocused()
    const tooltip = page.getByRole('tooltip')
    await expect(tooltip).toBeVisible()
    await expect(help).toHaveAttribute('aria-describedby', (await tooltip.getAttribute('id'))!)
    await expect(tooltip).toContainText('本书原有专属设置会保留')
    const contrast = await tooltip.evaluate((node) => {
      const style = getComputedStyle(node)
      const hex = (css: string) => {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')!
        context.fillStyle = css
        context.fillRect(0, 0, 1, 1)
        return (
          '#' +
          [...context.getImageData(0, 0, 1, 1).data]
            .slice(0, 3)
            .map((v) => v.toString(16).padStart(2, '0'))
            .join('')
        )
      }
      return { foreground: hex(style.color), background: hex(style.backgroundColor) }
    })
    expect(colorContrast(contrast.foreground, contrast.background)).toBeGreaterThanOrEqual(4.5)
    await page.keyboard.press('Escape')
    await expect(tooltip).toHaveCount(0)
    await expect(panel).toBeVisible()
    await expect(help).toBeFocused()
    await scope.focus()
    await help.hover()
    await expect(tooltip).toBeVisible()
    await scope.hover()
    await expect(tooltip).toHaveCount(0)
    const touch = await page.context().newCDPSession(page)
    await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true })
    const button = (await help.boundingBox())!
    for (const visible of [true, false]) {
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: button.x + button.width / 2, y: button.y + button.height / 2 }],
      })
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await expect(help).toHaveAttribute('aria-expanded', String(visible))
    }
    await touch.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await touch.detach()
    await scope.selectOption('book')
    await panel.getByLabel('电子书字号', { exact: true }).fill('27')
    await panel.getByRole('tab', { name: '外观', exact: true }).click()
    const custom = panel
      .locator('.reader-advanced-settings > summary')
      .filter({ hasText: '自定义配色' })
    await custom.click()
    await changeColor(page, '电子书背景色', '#eeeeee')
    await changeColor(page, '电子书文字色', '#e0e0e0')
    await custom.click()
    await expect(panel.getByRole('status').filter({ hasText: '当前配色对比度较低' })).toBeVisible()
    await panel.locator('.reader-palettes > summary').click()
    await panel.getByLabel('个人配色名称', { exact: true }).fill('尚未保存的配色')
    await panel.getByRole('tab', { name: '排版', exact: true }).click()
    await expect(panel.getByLabel('电子书字号', { exact: true })).toHaveValue('27')
    await panel.getByRole('tab', { name: '外观', exact: true }).click()
    await panel.locator('.reader-palettes > summary').click()
    await expect(panel.getByLabel('个人配色名称', { exact: true })).toHaveValue('尚未保存的配色')
    // Inject only the storage failure; real preference handling must keep its error visible.
    await page.evaluate(() => {
      const original = Storage.prototype.setItem
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('ralb:reader:'))
          throw new DOMException('controlled full storage', 'QuotaExceededError')
        return original.call(this, key, value)
      }
    })
    await panel.getByLabel('电子书面板透明度', { exact: true }).fill('30')
    await panel.getByRole('tab', { name: '翻页', exact: true }).click()
    const error = panel.getByRole('status').filter({ hasText: '本地偏好保存失败' })
    await expect(error).toBeVisible()
    await expect(error).toBeInViewport({ ratio: 1 })
    await expect(page.getByRole('tooltip')).toHaveCount(0)
  } finally {
    await closeOwnedElectron(app)
  }
})
