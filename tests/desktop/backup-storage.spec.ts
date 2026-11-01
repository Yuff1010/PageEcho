import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { createDataPaths } from '../../src/main/paths'
import { parseOriginal } from '../../src/main/original/parse'
import { BackupService } from '../../src/main/maintenance/backup'
import { unpackBackup } from '../../src/main/maintenance/archive'
import { closeOwnedElectron } from '../model/electron-lifecycle'
import { menuAction } from '../helpers/ui'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), '听读备份桌面 '))
  const paths = createDataPaths(root)
  const store = new LibraryStore(paths.database)
  try {
    const book = store.reading.import(
      parseOriginal(
        Buffer.from('第1章 山路\n少年沿着山路前行。\n清晨的阳光穿过树林。\n他们在远处看见村庄。'),
        '备份合成小说.txt',
      ),
    )
    store.reading.savePosition(book.id, 1)
    return { root, bookId: book.id }
  } finally {
    store.close()
  }
}

async function launch(root: string) {
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({
    ...(process.env.RALB_EXECUTABLE
      ? { executablePath: resolve(process.env.RALB_EXECUTABLE), args: [] }
      : { args: [resolve(process.env.RALB_APP_ROOT ?? '.')] }),
    env,
  })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('button', { name: '应用设置', exact: true })).toBeVisible()
  return { app, page, errors }
}

async function openPanel(page: Page) {
  await menuAction(page, '应用设置', '备份与存储')
  const panel = page.getByRole('dialog', { name: '备份与存储', exact: true })
  await expect(panel.getByRole('heading', { name: '备份与存储', exact: true })).toBeFocused()
  return panel
}

async function exportBackup(app: ElectronApplication, page: Page, destination: string) {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, destination)
  await page.getByRole('button', { name: '导出书架备份', exact: true }).click()
  await expect(page.locator('.backup-storage-notice')).toContainText('备份已保存')
  expect(existsSync(destination)).toBe(true)
}

async function pickBackup(app: ElectronApplication, page: Page, path: string | null) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({
      canceled: selected === null,
      filePaths: selected ? [selected] : [],
    })
  }, path)
  await page.getByRole('button', { name: '选择备份恢复', exact: true }).click()
}

test('backup and storage use exclusive keyboard panels, icon actions, saved policy and bounded modal geometry', async ({}, info) => {
  const data = fixture()
  const { app, page, errors } = await launch(data.root)
  try {
    const panel = await openPanel(page)
    await expect(panel.getByRole('tabpanel')).toHaveCount(1)
    const backup = panel.getByRole('tab', { name: '备份恢复', exact: true })
    const storage = panel.getByRole('tab', { name: '生成物存储', exact: true })
    await expect(backup).toHaveAttribute('aria-selected', 'true')
    await expect(panel.getByRole('spinbutton')).toHaveCount(0)
    for (const name of ['导出书架备份', '选择备份恢复', '关闭备份与存储'])
      expect((await panel.getByRole('button', { name, exact: true }).textContent())?.trim()).toBe(
        '',
      )
    await backup.press('End')
    await expect(storage).toBeFocused()
    await expect(storage).toHaveAttribute('aria-selected', 'true')
    await expect(panel.getByRole('button', { name: '导出书架备份', exact: true })).toHaveCount(0)
    const keep = panel.getByRole('spinbutton', { name: '每类至少保留份数', exact: true })
    await expect(keep).toHaveValue('2')
    await expect(
      panel.getByRole('checkbox', { name: '自动执行保留策略', exact: true }),
    ).not.toBeChecked()
    await keep.fill('3')
    await expect(panel.getByRole('button', { name: '预览生成物清理', exact: true })).toBeDisabled()
    await expect(panel).toContainText('请先保存策略，再预览清理。')
    await panel.getByRole('button', { name: '保存存储策略', exact: true }).click()
    await expect(panel.locator('.backup-storage-notice')).toContainText('保留策略已保存')
    await panel.getByRole('button', { name: '预览生成物清理', exact: true }).click()
    await expect(panel.locator('.backup-storage-preview')).toContainText('可清理 0 项')
    await expect(
      panel.getByRole('button', { name: '清理预览中的生成物', exact: true }),
    ).toBeDisabled()
    await storage.press('ArrowLeft')
    await expect(backup).toBeFocused()
    await expect(panel.getByRole('spinbutton')).toHaveCount(0)
    await backup.press('ArrowRight')
    await expect(keep).toHaveValue('3')
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1200, 800),
    )
    await page.screenshot({
      path: info.outputPath('backup-storage-wide.png'),
      animations: 'disabled',
    })
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(720, 600),
    )
    const geometry = await panel.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: innerWidth,
        height: innerHeight,
        overflow: document.documentElement.scrollWidth > innerWidth,
      }
    })
    expect(geometry.left).toBeGreaterThanOrEqual(0)
    expect(geometry.right).toBeLessThanOrEqual(geometry.width)
    expect(geometry.top).toBeGreaterThanOrEqual(0)
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.height)
    expect(geometry.overflow).toBe(false)
    await page.screenshot({
      path: info.outputPath('backup-storage-narrow.png'),
      animations: 'disabled',
    })
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(page.getByRole('button', { name: '应用设置', exact: true })).toBeFocused()
    await openPanel(page)
    await page.getByRole('tab', { name: '生成物存储', exact: true }).click()
    await expect(
      page.getByRole('spinbutton', { name: '每类至少保留份数', exact: true }),
    ).toHaveValue('3')
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
  }
})

test('real backup export and validated restore preview preserve current library; cancel and malformed IPC remain inert', async ({}, info) => {
  const data = fixture()
  const { app, page, errors } = await launch(data.root)
  const destination = join(data.root, '书架资料备份.zip')
  try {
    await page.evaluate(() => {
      localStorage.setItem('ralb:app:theme:v1', 'dark')
      localStorage.setItem('unrelated-local-key', 'synthetic-not-exported')
    })
    await page.reload()
    const panel = await openPanel(page)
    await exportBackup(app, page, destination)
    const files = await unpackBackup(readFileSync(destination))
    const manifest = JSON.parse(files.get('manifest.json')!.toString())
    expect(manifest.counts.readingBooks).toBe(1)
    expect(manifest.counts.books).toBe(0)
    const preferences = JSON.parse(files.get('preferences.json')!.toString())
    expect(preferences['ralb:app:theme:v1']).toBe('dark')
    expect(preferences['unrelated-local-key']).toBeUndefined()
    expect(
      [...files.keys()].every(
        (key) => !key.includes('source-plugins/') && !key.includes('models/'),
      ),
    ).toBe(true)
    await pickBackup(app, page, destination)
    const preview = panel.locator('.backup-storage-preview')
    await expect(preview).toContainText('1 本电子书')
    await expect(preview.getByRole('button', { name: '恢复并重启', exact: true })).toBeEnabled()
    await page.screenshot({
      path: info.outputPath('backup-restore-preview-dark.png'),
      animations: 'disabled',
    })
    await preview.getByRole('button', { name: '取消', exact: true }).click()
    await expect(preview).toHaveCount(0)
    expect(existsSync(join(data.root, 'maintenance', 'pending-restore.json'))).toBe(false)
    await pickBackup(app, page, null)
    await expect(preview).toHaveCount(0)
    const invalid = join(data.root, '无效备份.zip')
    writeFileSync(invalid, 'synthetic invalid ZIP')
    await pickBackup(app, page, invalid)
    await expect(panel.getByRole('alert')).toBeVisible()
    const malformed = await page.evaluate(async () => {
      const api = window.desktop
      return Promise.all([
        api.exportLibraryBackup({ settings: { arbitrary: 'synthetic' } }),
        api.restoreLibraryBackup({ previewId: '../arbitrary' }),
        api.clearGeneratedStorage({ token: '../arbitrary' }),
        api.saveGeneratedStoragePolicy({
          policy: { automatic: true, keepLatest: 0, maxBytes: 0, maxAgeDays: 0 },
        }),
        (
          api.getGeneratedStorage as (
            ...args: unknown[]
          ) => ReturnType<typeof api.getGeneratedStorage>
        )({ path: 'C:/arbitrary' }),
      ])
    })
    expect(
      malformed
        .slice(0, 4)
        .every((result) => !result.ok && result.error.code === 'INVALID_REQUEST'),
    ).toBe(true)
    // The zero-argument preload method discards JavaScript arguments rather than forwarding paths.
    const storage = malformed[4]!
    expect(storage.ok).toBe(true)
    if (storage.ok)
      expect(storage.value).toMatchObject({
        directory: join(data.root, 'cache', 'generated-artifacts'),
      })
    const reading = await page.evaluate(() => window.desktop.getReadingBooks())
    expect(
      reading.ok && reading.value.map((book) => ({ id: book.id, position: book.position })),
    ).toEqual([{ id: data.bookId, position: 1 }])
    expect(existsSync(join(data.root, 'maintenance', 'pending-restore.json'))).toBe(false)
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
  }
})

test('controlled close and manual restart apply a real backup and restore preferences before the first App render', async () => {
  test.setTimeout(120_000)
  const data = fixture()
  let app: ElectronApplication | null = null
  try {
    let launched = await launch(data.root)
    app = launched.app
    let page = launched.page
    await page.evaluate((bookId) => {
      localStorage.setItem('ralb:app:theme:v1', 'dark')
      localStorage.setItem(
        `ralb:reading:bookmarks:${bookId}:v1`,
        '[{"position":1,"note":"合成书签"}]',
      )
      localStorage.setItem('unrelated-local-key', 'keep-this-local-value')
    }, data.bookId)
    await page.reload()
    await openPanel(page)
    const destination = join(data.root, '重启恢复备份.zip')
    await exportBackup(app, page, destination)
    const changed = await page.evaluate(
      (id) => window.desktop.saveReadingPosition({ id, position: 2 }),
      data.bookId,
    )
    expect(changed.ok).toBe(true)
    await page.evaluate((bookId) => {
      localStorage.setItem('ralb:app:theme:v1', 'light')
      localStorage.removeItem(`ralb:reading:bookmarks:${bookId}:v1`)
    }, data.bookId)
    await closeOwnedElectron(app)
    app = null
    // Stage while no Electron owns this synthetic data. Relaunch is manual so no process escapes the test.
    const backup = new BackupService({
      root: data.root,
      version: '0.35.0-dev.1',
      maxSchemaVersion: 17,
    })
    const preview = await backup.previewFile(destination)
    await backup.stageRestore(preview.previewId)
    launched = await launch(data.root)
    app = launched.app
    page = launched.page
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'dark')
    const restored = await page.evaluate(
      async (bookId) => ({
        reading: await window.desktop.getReadingBooks(),
        metadata: await window.desktop.getRestoredPreferences(),
        bookmarks: localStorage.getItem(`ralb:reading:bookmarks:${bookId}:v1`),
        unrelated: localStorage.getItem('unrelated-local-key'),
      }),
      data.bookId,
    )
    expect(
      restored.reading.ok &&
        restored.reading.value.find((book) => book.id === data.bookId)?.position,
    ).toBe(1)
    expect(restored.metadata.ok && restored.metadata.value?.acknowledged).toBe(true)
    expect(restored.bookmarks).toContain('合成书签')
    expect(restored.unrelated).toBe('keep-this-local-value')
    expect(readdirSync(join(data.root, 'maintenance', 'rollback')).length).toBe(1)
    expect(existsSync(join(data.root, 'maintenance', 'pending-restore.json'))).toBe(false)
    await openPanel(page)
    await page.getByText(/最近恢复 · /).click()
    await expect(page.getByText('阅读设置已应用。', { exact: true })).toBeVisible()
    expect(launched.errors).toEqual([])
  } finally {
    if (app) await closeOwnedElectron(app)
  }
})
