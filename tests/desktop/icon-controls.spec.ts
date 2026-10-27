import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { closeOwnedElectron } from '../model/electron-lifecycle'

async function explain(page: Page, control: Locator, text: string) {
  await control.hover()
  const bubble = page.getByRole('tooltip', { name: text, exact: true })
  await expect(bubble).toBeVisible()
  expect(await control.getAttribute('aria-describedby')).toBe(await bubble.getAttribute('id'))
  const bounds = await bubble.boundingBox()
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)
  await page.mouse.move(viewport.width / 2, viewport.height / 2)
  await expect(bubble).toHaveCount(0)
  await control.focus()
  await expect(bubble).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(bubble).toHaveCount(0)
  await expect(control).toBeFocused()
}

for (const width of [1318, 720]) {
  test(`icon actions keep labels on demand and native menus work at ${width}px`, async ({}, info) => {
    const root = mkdtempSync(join(tmpdir(), '听读 图标操作 '))
    const audioPath = join(root, '山间来信.wav')
    const wav = Buffer.alloc(44 + 16000 * 20)
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
    writeFileSync(audioPath, wav)
    const ebookPath = join(root, '山间来信.txt')
    writeFileSync(
      ebookPath,
      '第一章 山路\n少年沿着山路前进，清晨的风吹过树林。\n第二章 清晨\n故事继续。',
    )
    const env = { ...process.env, RALB_USER_DATA: root }
    Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
    const app = await electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
    try {
      const page = await app.firstWindow()
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await app.evaluate(
        ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size, 858),
        width,
      )
      await page.emulateMedia({ reducedMotion: 'reduce' })
      const audioImport = page.getByRole('button', { name: '选择音频文件', exact: true })
      await expect(audioImport).toBeEnabled()
      const nav = page.getByRole('navigation', { name: '书架导航', exact: true })
      const types = page.getByRole('navigation', { name: '书籍类型', exact: true })
      const actionNames = [
        '搜索书架',
        '选择音频文件',
        '更多导入方式',
        '书架选项',
        '应用设置',
        '伴读阅读',
        '字幕与伴读',
      ]
      for (const name of actionNames)
        await expect(page.getByRole('button', { name, exact: true })).toHaveText('')
      await expect(nav.getByRole('button')).toHaveText(['', ''])
      await expect(types.getByRole('button')).toHaveText(['', ''])
      await explain(page, nav.getByRole('button', { name: '在线书源', exact: true }), '在线书源')
      await expect(page.getByRole('heading', { name: '我的书架', exact: true })).toBeVisible()
      await explain(page, audioImport, '导入音频文件')
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
      }, audioPath)
      await audioImport.click()
      await expect(page.locator('.bookshelf .shelf-card h3')).toHaveText('山间来信.wav')
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
      }, ebookPath)
      const imported = await page.evaluate(() => window.desktop.importReadingBook())
      if (!imported.ok || imported.value.canceled) throw new Error('Expected TXT import')
      const state = await page.evaluate(() => window.desktop.getState())
      if (!state.ok) throw new Error(state.error.message)
      const linked = await page.evaluate((value) => window.desktop.linkReadingBook(value), {
        bookId: state.value.books[0]!.id,
        readingBookId: imported.value.book.id,
      })
      expect(linked.ok).toBe(true)
      await types.getByRole('button', { name: '电子书', exact: true }).click()
      await types.getByRole('button', { name: '有声书', exact: true }).click()
      const sort = page.getByRole('combobox', { name: '书架排序', exact: true })
      await explain(page, sort, '排序 · 最近添加')
      await sort.selectOption('title')
      await expect(sort).toHaveValue('title')
      await sort.focus()
      await page.keyboard.press('Space')
      await expect.poll(() => sort.evaluate((node) => node.matches(':open'))).toBe(true)
      await page.keyboard.press('Escape')
      await expect.poll(() => sort.evaluate((node) => node.matches(':open'))).toBe(false)
      await expect(sort).toHaveValue('title')
      const layout = page.getByRole('button', { name: '书架选项', exact: true })
      await explain(page, layout, '书架选项')
      await layout.click()
      await expect(page.getByRole('menu', { name: '书架选项', exact: true })).toBeVisible()
      await expect(page.getByRole('tooltip')).toHaveCount(0)
      await page.getByRole('menuitem', { name: '列表视图', exact: false }).click()
      await expect(page.locator('.bookshelf:visible')).toHaveClass(/bookshelf-list/)
      await layout.click()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('menu', { name: '书架选项', exact: true })).toHaveCount(0)
      await expect(layout).toBeFocused()
      await layout.click()
      await page.getByRole('menuitem', { name: '网格视图', exact: false }).click()
      for (const theme of ['dark', 'light']) {
        await page.evaluate((value) => {
          localStorage.setItem('ralb:app:theme:v1', value)
          window.dispatchEvent(new Event('ralb:app-theme'))
        }, theme)
        await expect(page.locator('html')).toHaveAttribute('data-ui-theme', theme)
        await page.mouse.move(width / 2, 500)
        await page.screenshot({ path: info.outputPath(`shelf-icons-${width}-${theme}.png`) })
        await types.getByRole('button', { name: '电子书', exact: true }).click()
        await expect(page.getByRole('button', { name: '导入电子书', exact: true })).toHaveText('')
        await expect(page.locator('.bookshelf .shelf-card h3')).toHaveText('山间来信')
        await page.mouse.move(width / 2, 500)
        await page.screenshot({ path: info.outputPath(`ebook-icons-${width}-${theme}.png`) })
        await types.getByRole('button', { name: '有声书', exact: true }).click()
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      )
      expect(errors).toEqual([])
    } finally {
      await closeOwnedElectron(app)
    }
  })
}
