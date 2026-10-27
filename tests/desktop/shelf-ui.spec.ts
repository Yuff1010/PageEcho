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
import { menuAction } from '../helpers/ui'

async function choose(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
  }, path)
}
async function assertToolbar(page: Page, ebook = false) {
  await expect(page.getByRole('heading', { name: '我的书架', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '搜索书架', exact: true })).toBeVisible()
  await expect(
    page.getByRole('button', { name: ebook ? '导入电子书' : '选择音频文件', exact: true }),
  ).toBeEnabled()
  await expect(page.getByRole('combobox', { name: '书架排序', exact: true })).toBeVisible()
  const layout = page.getByRole('button', { name: '书架选项', exact: true })
  await expect(layout).toBeVisible()
  await expect(layout).toHaveText('')
}

test('audiobooks and ebooks use one shelf toolbar, card structure, shared layouts and accessible menus', async ({}, info) => {
  const root = mkdtempSync(join(tmpdir(), '听读统一书架 '))
  const audioPath = join(root, '故事2.wav')
  const ebookPaths = [join(root, '故事10.txt'), join(root, '故事2.txt')]
  const wav = Buffer.alloc(44 + 20 * 16000)
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
  for (const [index, file] of ebookPaths.entries())
    writeFileSync(file, `第1章 山路\n${index} 少年沿山路前进。\n第2章 清晨\n清晨的风穿过树林。`)
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await assertToolbar(page)
    await choose(app, audioPath)
    await page.getByRole('button', { name: '选择音频文件', exact: true }).click()
    const audioCard = page.locator('.bookshelf .shelf-card').first()
    await expect(audioCard).toHaveAttribute('data-book-kind', 'audio')
    const audioCover = await audioCard.locator('.book-cover').boundingBox()
    const cardSlots = await audioCard
      .locator('.file-info')
      .evaluate((node) => Array.from(node.children).map((child) => child.className))
    await expect(audioCard.locator('.book-availability')).toHaveCount(0)
    await expect(audioCard.locator('.shelf-book-meta')).toHaveText('1 集')
    await expect(audioCard.locator('.shelf-book-position')).toContainText('尚未开始收听')
    await menuAction(page, '更多 故事2.wav 的操作', '章节目录')
    await page.getByRole('button', { name: '返回书架', exact: true }).click()
    for (const file of ebookPaths) {
      await choose(app, file)
      const result = await page.evaluate(() => window.desktop.importReadingBook())
      expect(result.ok && !result.value.canceled).toBe(true)
    }
    await page
      .getByRole('navigation', { name: '书籍类型', exact: true })
      .getByRole('button', { name: '电子书', exact: true })
      .click()
    await assertToolbar(page, true)
    await expect(page.getByRole('heading', { name: '阅读书架', exact: true })).toHaveCount(0)
    const shelf = page.getByRole('list', { name: '电子书列表', exact: true })
    await expect(shelf.locator('.shelf-card')).toHaveCount(2)
    const ebookCard = shelf.locator('.shelf-card').first()
    await expect(ebookCard).toHaveAttribute('data-book-kind', 'ebook')
    expect(
      await ebookCard
        .locator('.file-info')
        .evaluate((node) => Array.from(node.children).map((child) => child.className)),
    ).toEqual(cardSlots)
    const ebookCover = await ebookCard.locator('.book-cover').boundingBox()
    expect(ebookCover?.width).toBeCloseTo(audioCover!.width, 1)
    expect(ebookCover?.height).toBeCloseTo(audioCover!.height, 1)
    await expect(ebookCard.locator('.shelf-cross-action')).toHaveCount(0)
    await expect(ebookCard.locator('.shelf-mode-actions')).toHaveCount(0)
    await expect(ebookCard.locator('.book-availability')).toHaveCount(0)
    await expect(ebookCard.locator('.shelf-book-meta')).toHaveText('TXT · 2 章')
    await expect(ebookCard.locator('.shelf-book-position')).toHaveText('尚未开始阅读')
    await page.getByRole('combobox', { name: '书架排序', exact: true }).selectOption('title')
    await expect(shelf.locator('h3')).toHaveText(['故事2', '故事10'])
    await page.keyboard.press('Control+k')
    const search = page.getByRole('textbox', { name: '搜索书架', exact: true })
    await expect(search).toBeFocused()
    await search.fill('故事10')
    await expect(shelf.locator('h3')).toHaveText(['故事10'])
    await search.fill('没有的故事')
    await expect(page.getByText('还没找到这本书', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '查看全部书籍', exact: true }).click()
    await expect(shelf.locator('.shelf-card')).toHaveCount(2)
    await menuAction(page, '书架选项', '列表视图')
    await expect(shelf).toHaveClass(/bookshelf-list/)
    const trigger = page.getByRole('button', { name: '更多 故事2 的操作', exact: true })
    await trigger.click()
    await page.getByRole('menuitem', { name: '移除电子书 故事2', exact: true }).click()
    await page.getByRole('button', { name: '保留这本书', exact: true }).click()
    await expect(trigger).toBeFocused()
    await trigger.click()
    await page.getByRole('menuitem', { name: '关联 故事2 的有声书', exact: true }).click()
    await expect(
      page.getByRole('dialog', { name: '关联有声书与电子书', exact: true }),
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await page
      .getByRole('navigation', { name: '书籍类型', exact: true })
      .getByRole('button', { name: '有声书', exact: true })
      .click()
    await assertToolbar(page)
    await expect(page.locator('.bookshelf:visible')).toHaveClass(/bookshelf-list/)
    await page.screenshot({
      path: info.outputPath('shared-shelf-list.png'),
      animations: 'disabled',
    })
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
  }
})

async function shelfMetrics(page: Page) {
  return page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>('.app-shell[data-page-kind="shelf"]')!
    const visible = (selector: string) =>
      Array.from(shell.querySelectorAll<HTMLElement>(selector)).find(
        (node) => node.getClientRects().length > 0,
      )!
    const measure = (selector: string) => {
      const node = visible(selector)
      const box = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return {
        x: Math.round(box.x * 100) / 100,
        y: Math.round(box.y * 100) / 100,
        width: Math.round(box.width * 100) / 100,
        height: Math.round(box.height * 100) / 100,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        fontWeight: style.fontWeight,
        padding: style.padding,
      }
    }
    return {
      header: measure('.shelf-header'),
      title: measure('.shelf-header h1'),
      importButton: measure('[data-shelf-import]'),
      search: measure('.shelf-header .search-trigger, .shelf-header .library-search'),
      controls: measure('.shelf-controls'),
      sort: measure('.shelf-sort > select'),
      layout: measure('.library-options > .popover > .icon-button'),
      card: measure('.bookshelf .shelf-card'),
      cover: measure('.bookshelf .book-cover'),
      token: getComputedStyle(shell).getPropertyValue('--shelf-title-size').trim(),
    }
  })
}

test('shelf chrome computed metrics match across audiobook and ebook routes, themes, widths and search states', async ({}, info) => {
  const root = mkdtempSync(join(tmpdir(), '听读书架实际尺寸 '))
  const audioPath = join(root, '同一书名.wav')
  const ebookPath = join(root, '同一书名.txt')
  writeFileSync(audioPath, Buffer.from('fixture audio identity; this test never plays it'))
  writeFileSync(ebookPath, '第1章 山路\n少年沿着山路前进。\n第2章 清晨\n清晨的阳光照进窗户。')
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
  try {
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await assertToolbar(page)
    await choose(app, audioPath)
    await page.getByRole('button', { name: '选择音频文件', exact: true }).click()
    await choose(app, ebookPath)
    const imported = await page.evaluate(() => window.desktop.importReadingBook())
    if (!imported.ok || imported.value.canceled) throw new Error('Expected real ebook import')
    const library = await page.evaluate(() => window.desktop.getState())
    if (!library.ok) throw new Error(library.error.message)
    const linked = await page.evaluate((target) => window.desktop.linkReadingBook(target), {
      bookId: library.value.books[0]!.id,
      readingBookId: imported.value.book.id,
    })
    expect(linked.ok).toBe(true)
    const types = page.getByRole('navigation', { name: '书籍类型', exact: true })
    await types.getByRole('button', { name: '电子书', exact: true }).click()
    await assertToolbar(page, true)
    const reports: unknown[] = []
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        localStorage.setItem('ralb:app:theme:v1', value)
        window.dispatchEvent(new Event('ralb:app-theme'))
      }, theme)
      await expect(page.locator('html')).toHaveAttribute('data-ui-theme', theme)
      for (const width of [1360, 720]) {
        await app.evaluate(
          ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size, 900),
          width,
        )
        for (const layout of ['grid', 'list'] as const) {
          await types.getByRole('button', { name: '有声书', exact: true }).click()
          await menuAction(page, '书架选项', layout === 'grid' ? '网格视图' : '列表视图')
          await expect(page.locator('.bookshelf:visible')).toHaveClass(
            new RegExp(`bookshelf-${layout}`),
          )
          const audio = await shelfMetrics(page)
          expect(audio.title.fontSize).toBe('26px')
          expect(audio.title.lineHeight).toBe('34px')
          const readingAction = page.getByRole('button', {
            name: '阅读电子书 同一书名.wav',
            exact: true,
          })
          await expect(readingAction).toBeVisible()
          await expect(readingAction).toHaveText('')
          const audioCard = page.locator('.bookshelf:visible .shelf-card')
          await expect(audioCard.locator('.book-availability')).toHaveCount(0)
          await expect(audioCard.locator('.shelf-book-meta')).toHaveText('1 集')
          await expect(audioCard.locator('.shelf-book-position')).toHaveText('尚未开始收听')
          await readingAction.hover()
          await expect(page.getByRole('tooltip')).toHaveText(
            '已关联电子书，阅读电子书《同一书名.wav》',
          )
          await page.keyboard.press('Escape')
          await expect(page.getByRole('tooltip')).toBeHidden()
          await types.getByRole('button', { name: '电子书', exact: true }).click()
          await assertToolbar(page, true)
          const ebook = await shelfMetrics(page)
          expect(ebook).toEqual(audio)
          const listeningAction = page.getByRole('button', {
            name: '收听有声书 同一书名',
            exact: true,
          })
          await expect(listeningAction).toBeVisible()
          await expect(listeningAction).toHaveText('')
          const ebookCard = page.locator('.bookshelf:visible .shelf-card')
          await expect(ebookCard.locator('.book-availability')).toHaveCount(0)
          await expect(ebookCard.locator('.shelf-book-meta')).toHaveText('TXT · 2 章')
          await expect(ebookCard.locator('.shelf-book-position')).toHaveText('尚未开始阅读')
          await listeningAction.focus()
          await expect(page.getByRole('tooltip')).toHaveText(
            '已关联有声书，收听《同一书名》的有声书',
          )
          await page.keyboard.press('Escape')
          await expect(page.getByRole('tooltip')).toBeHidden()
          expect(await readingAction.count()).toBe(0)
          await page.getByRole('button', { name: '搜索书架', exact: true }).click()
          const ebookSearch = await shelfMetrics(page)
          await types.getByRole('button', { name: '有声书', exact: true }).click()
          await page.getByRole('button', { name: '搜索书架', exact: true }).click()
          const audioSearch = await shelfMetrics(page)
          expect(ebookSearch).toEqual(audioSearch)
          await page.getByRole('button', { name: '清除搜索', exact: true }).click()
          reports.push({ theme, width, layout, audio, ebook, audioSearch, ebookSearch })
        }
      }
    }
    await info.attach('shelf-computed-metrics', {
      body: JSON.stringify(reports, null, 2),
      contentType: 'application/json',
    })
  } finally {
    await closeOwnedElectron(app)
  }
})
