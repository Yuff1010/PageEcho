import { menuAction, leaveCompanionPage } from '../helpers/ui'
import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('library search, sorting, saved layouts and recent listening work across navigation', async ({}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), '听读书架设计 '))
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.getByRole('button', { name: '选择音频文件', exact: true })).toBeEnabled()
    await page.screenshot({ path: testInfo.outputPath('library-empty.png') })
    const titles = ['山间来信.wav', '夜航笔记.wav', '慢慢走过四季.wav', '风起时读你.wav']
    for (const [index, title] of titles.entries()) {
      const audio = join(root, title)
      const wav = Buffer.alloc(44 + (180 + index) * 16000)
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
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
      }, audio)
      await page.getByRole('button', { name: '选择音频文件', exact: true }).click()
      await expect(page.locator('.bookshelf > li')).toHaveCount(index + 1)
    }
    await page.getByRole('combobox', { name: '书架排序' }).selectOption('title')
    await expect(page.locator('.bookshelf h3')).toHaveText(
      [...titles].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true })),
    )
    await page.keyboard.press('Control+k')
    const search = page.getByRole('textbox', { name: '搜索书架' })
    await expect(search).toBeFocused()
    await search.fill('山间')
    await expect(page.locator('.bookshelf h3')).toHaveText(['山间来信.wav'])
    await search.fill('不存在的故事')
    await expect(page.getByText('还没找到这本书', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '查看全部书籍', exact: true }).click()
    await expect(page.locator('.bookshelf > li')).toHaveCount(4)
    await menuAction(page, '书架选项', '列表视图')
    await expect(page.locator('.bookshelf')).toHaveClass(/bookshelf-list/)
    await page.reload()
    await expect(page.locator('.bookshelf')).toHaveClass(/bookshelf-list/)
    await menuAction(page, '书架选项', '网格视图')
    await page.locator('.bookshelf .card-play').first().click()
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await page.getByRole('slider', { name: '播放进度' }).fill('45000')
    await expect(page.getByRole('region', { name: '继续收听', exact: true })).toHaveCount(0)
    await expect(page.locator('.welcome-banner')).toHaveCount(0)
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(page.getByRole('slider', { name: '音量', exact: true })).toHaveCount(0)
    await expect(
      page.getByRole('navigation', { name: '书架导航' }).getByRole('button'),
    ).toHaveCount(2)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1360, 980))
    await page.locator('main').evaluate((node) => {
      node.scrollTop = 0
    })
    expect(
      await page
        .locator('.book-cover')
        .first()
        .evaluate((node) => node.getBoundingClientRect().width),
    ).toBeLessThanOrEqual(160)
    expect(
      await page
        .getByRole('region', { name: '播放器', exact: true })
        .evaluate((node) => node.getBoundingClientRect().height),
    ).toBeLessThanOrEqual(104)
    await page.screenshot({ path: testInfo.outputPath('library-grid.png') })
    await menuAction(page, '书架选项', '列表视图')
    await page.screenshot({ path: testInfo.outputPath('library-list.png') })
    await page.getByRole('combobox', { name: '书架排序' }).selectOption('played')
    await expect(page.locator('.bookshelf > li')).toHaveCount(1)
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    await expect(page.getByRole('region', { name: '同步伴读', exact: true })).toBeVisible()
    await leaveCompanionPage(page)
    await page.getByRole('button', { name: '电子书', exact: true }).click()
    await expect(page.getByText('开始读一本书', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '在线书源', exact: true }).click()
    await expect(page.getByRole('searchbox', { name: '搜索书籍', exact: true })).toBeVisible()
    await page.getByRole('button', { name: /我的书架/ }).click()
    await page.getByRole('button', { name: '有声书', exact: true }).click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 600))
    await expect(page.getByRole('button', { name: '播放', exact: true })).toBeInViewport()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('library-small.png') })
    const options = page.getByRole('button', { name: '书架选项', exact: true })
    await options.focus()
    await options.press('ArrowDown')
    await expect(page.getByRole('menuitem', { name: '网格视图', exact: true })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('menuitem', { name: '列表视图', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(options).toBeFocused()
    await options.click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(740, 620))
    await expect(page.getByRole('menu')).toHaveCount(0)
    await page.getByRole('button', { name: '调整音量', exact: true }).click()
    await expect(page.getByRole('slider', { name: '音量', exact: true })).toBeVisible()
    await page.getByRole('heading', { name: '我的书架', exact: true }).click()
    await expect(page.getByRole('slider', { name: '音量', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '搜索书架', exact: true }).click()
    await expect(search).toBeFocused()
    await search.press('Escape')
    await expect(search).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})
