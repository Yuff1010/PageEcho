import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createDataPaths } from '../../src/main/paths'
import { CHANNELS } from '../../src/shared/contracts'
import { closeOwnedElectron } from '../model/electron-lifecycle'

test('ebook removal explains progress loss, cancel preserves data, and a failed deletion can be retried', async ({}, info) => {
  const root = mkdtempSync(join(tmpdir(), '听读电子书移除保护 '))
  const file = join(root, '保留原书.txt')
  writeFileSync(
    file,
    `第一章 山路\n${Array.from({ length: 12 }, (_, i) => `第${i}段，沿着山路继续阅读。`).join('\n')}`,
  )
  const original = createHash('sha256').update(readFileSync(file)).digest('hex')
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, file)
    const imported = await page.evaluate(() => window.desktop.importReadingBook())
    expect(imported.ok && !imported.value.canceled).toBe(true)
    if (!imported.ok || imported.value.canceled) throw new Error('Import failed')
    const book = imported.value.book
    await page.evaluate(async ({ id }) => {
      const saved = await window.desktop.saveReadingPosition({ id, position: 3 })
      if (!saved.ok) throw new Error(saved.error.message)
      localStorage.setItem(
        `ralb:reading:bookmarks:${id}:v1`,
        JSON.stringify([
          {
            id: 'kept-bookmark',
            anchor: { ordinal: 3, offset: 0 },
            chapter: '第一章',
            excerpt: '原书签',
            createdAt: '2026-10-24T00:00:00Z',
          },
        ]),
      )
    }, book)
    await page.getByRole('button', { name: '电子书', exact: true }).click()
    const actions = page.getByRole('button', { name: `更多 ${book.title} 的操作`, exact: true })
    const remove = page.getByRole('menuitem', { name: `移除电子书 ${book.title}`, exact: true })
    await actions.click()
    await remove.click()
    const dialog = page.getByRole('dialog', { name: '确认移除书籍', exact: true })
    await expect(dialog).toContainText('书架记录和阅读进度')
    await expect(dialog).toContainText('可能无法恢复')
    await expect(dialog).toContainText('原 TXT / EPUB 文件仍保留')
    await expect(dialog.getByRole('button', { name: '保留这本书', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(actions).toBeFocused()
    const preserved = await page.evaluate(() => window.desktop.getReadingBooks())
    expect(preserved.ok && preserved.value[0]?.position).toBe(3)
    const bookmark = await page.evaluate(
      (id) => localStorage.getItem(`ralb:reading:bookmarks:${id}:v1`),
      book.id,
    )
    expect(bookmark).toContain('kept-bookmark')
    await actions.click()
    await remove.click()
    await dialog.getByRole('button', { name: '保留这本书', exact: true }).click()
    await expect(actions).toBeFocused()
    await app.evaluate(({ ipcMain }, channel) => {
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
        string,
        (...args: unknown[]) => unknown
      >
      const original = handlers.get(channel)!
      let first = true
      handlers.set(channel, (...args) => {
        if (!first) return original(...args)
        first = false
        return { ok: false, error: { code: 'INTERNAL', message: '测试存储暂不可用，请重试。' } }
      })
    }, CHANNELS.readingRemove)
    await actions.click()
    await remove.click()
    const confirm = dialog.getByRole('button', { name: '确认移除记录', exact: true })
    await confirm.click()
    await expect(dialog.getByRole('alert')).toContainText('测试存储暂不可用')
    await expect(confirm).toBeEnabled()
    const failed = await page.evaluate(() => window.desktop.getReadingBooks())
    expect(failed.ok && failed.value.length).toBe(1)
    await page.screenshot({ path: info.outputPath('ebook-removal-retry.png') })
    await confirm.click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: '导入电子书', exact: true })).toBeFocused()
    const deleted = await page.evaluate(() => window.desktop.getReadingBooks())
    expect(deleted.ok && deleted.value.length).toBe(0)
    expect(existsSync(file)).toBe(true)
    expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(original)
    const db = new DatabaseSync(createDataPaths(root).database)
    try {
      expect(db.prepare('SELECT count(*) AS n FROM reading_books').get()!.n).toBe(0)
    } finally {
      db.close()
    }
  } finally {
    await closeOwnedElectron(app)
  }
})
