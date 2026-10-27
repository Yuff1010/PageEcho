import { menuAction } from '../helpers/ui'
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

function environment(root: string) {
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  return env
}

function launch(root: string) {
  return electron.launch({
    ...(process.env.RALB_EXECUTABLE
      ? { executablePath: resolve(process.env.RALB_EXECUTABLE), args: [] }
      : { args: [resolve(process.env.RALB_APP_ROOT ?? '.')] }),
    env: environment(root),
  })
}

async function choose(app: ElectronApplication, filePaths: string[]) {
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths })
  }, filePaths)
}

test('concurrent selection is rejected and dialog failures do not leave selection busy', async () => {
  const app = await launch(mkdtempSync(join(tmpdir(), '听读 busy ')))
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '选择音频文件' })).toBeEnabled()
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = () =>
        new Promise((resolveDialog) => Reflect.set(globalThis, 'm0ResolveDialog', resolveDialog))
    })
    await page.getByRole('button', { name: '选择音频文件' }).click()
    await expect(page.getByRole('button', { name: '正在处理…' })).toBeDisabled()
    await expect
      .poll(() => app.evaluate(() => typeof Reflect.get(globalThis, 'm0ResolveDialog')))
      .toBe('function')
    expect(await page.evaluate(() => window.desktop.selectAudio({ kind: 'audio' }))).toMatchObject({
      ok: false,
      error: { code: 'BUSY' },
    })
    await app.evaluate(() => {
      Reflect.get(globalThis, 'm0ResolveDialog')({ canceled: true, filePaths: [] })
      Reflect.deleteProperty(globalThis, 'm0ResolveDialog')
    })
    await expect(page.getByRole('button', { name: '选择音频文件' })).toBeEnabled()

    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => {
        throw new Error('M0 acceptance: simulated native picker failure')
      }
    })
    await page.getByRole('button', { name: '选择音频文件' }).click()
    await expect(page.getByRole('alert')).toContainText('操作未完成')
    await expect(page.getByRole('button', { name: '选择音频文件' })).toBeEnabled()
    await choose(app, [])
    await page.getByRole('button', { name: '选择音频文件' }).click()
    await expect(page.getByRole('button', { name: '选择音频文件' })).toBeEnabled()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByText('你的故事，从这里开始')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('legacy recent records stay bounded while the M1 shelf retains all imported books', async () => {
  const root = mkdtempSync(join(tmpdir(), '听读 recent '))
  const files = Array.from({ length: 21 }, (_, i) => join(root, `第${i}章 中文.MP3`))
  // M0 inspects metadata only; these bytes are not a playback fixture.
  for (const file of files) writeFileSync(file, Buffer.alloc(32))
  let app = await launch(root)
  try {
    let page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '选择音频文件' })).toBeEnabled()
    for (const file of files) {
      await choose(app, [file])
      const result = await page.evaluate(() => window.desktop.selectAudio({ kind: 'audio' }))
      expect(result.ok).toBe(true)
    }
    const before = await page.evaluate(() => window.desktop.getState())
    if (!before.ok) throw new Error(before.error.message)
    expect(before.value.files).toHaveLength(20)
    expect(before.value.files.map((file) => file.name)).toEqual(
      Array.from({ length: 20 }, (_, i) => `第${20 - i}章 中文.MP3`),
    )
    const originalId = before.value.files.find((file) => file.name === '第1章 中文.MP3')!.id
    writeFileSync(files[1]!, Buffer.alloc(64))
    await choose(app, [files[1]!])
    await page.getByRole('button', { name: '选择音频文件' }).click()
    await expect(page.locator('.file-list li')).toHaveCount(21)
    await expect(page.locator('.file-list h3').first()).toHaveText('第1章 中文.MP3')
    const after = await page.evaluate(() => window.desktop.getState())
    if (!after.ok) throw new Error(after.error.message)
    expect(after.value.files[0]).toMatchObject({ id: originalId, sizeBytes: 64 })

    await choose(app, [files[0]!, files[1]!])
    const invalid = await page.evaluate(() => window.desktop.selectAudio({ kind: 'audio' }))
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    const unchanged = await page.evaluate(() => window.desktop.getState())
    expect(unchanged).toEqual(after)
    await app.close()
    app = await launch(root)
    page = await app.firstWindow()
    await expect(page.locator('.file-list li')).toHaveCount(21)
    expect(await page.evaluate(() => window.desktop.getState())).toEqual(after)
    expect(files.every((file) => existsSync(file))).toBe(true)
  } finally {
    await app.close()
  }
})

test('minimum window remains usable offline with a long filename', async ({}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), '听读 layout '))
  const name = `${'很长的中文音频名称 '.repeat(10)}.wav`
  const file = join(root, name)
  writeFileSync(file, Buffer.alloc(32))
  const app = await launch(root)
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '选择音频文件' })).toBeEnabled()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.context().setOffline(true)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 600))
    await choose(app, [file])
    await page.getByRole('button', { name: '选择音频文件' }).click()
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
    await menuAction(page, '应用设置', '应用信息')
    await page.getByText('数据与存储位置', { exact: true }).click()
    await expect(page.getByText(`数据目录：${root}`, { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('minimum-window.png'), fullPage: true })
    const layout = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      overflowing: [...document.querySelectorAll('body *')]
        .filter((element) => element.getBoundingClientRect().right > window.innerWidth)
        .map((element) => ({
          element: element.tagName,
          class: element.className,
          right: element.getBoundingClientRect().right,
        })),
    }))
    await testInfo.attach('layout', {
      body: JSON.stringify(layout, null, 2),
      contentType: 'application/json',
    })
    expect(layout.document, JSON.stringify(layout)).toBeLessThanOrEqual(layout.viewport)
    await page.getByRole('button', { name: '关闭应用信息', exact: true }).click()
    await menuAction(page, `更多 ${name} 的操作`, `移除 ${name} 的记录`)
    await page
      .getByRole('dialog', { name: '确认移除书籍', exact: true })
      .getByRole('button', { name: '确认移除记录', exact: true })
      .click()
    await expect(page.getByText('你的故事，从这里开始')).toBeVisible()
    expect(existsSync(file)).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('a second process exits and restores the existing minimized window', async () => {
  const root = mkdtempSync(join(tmpdir(), '听读 instance '))
  const app = await launch(root)
  let second: ReturnType<typeof spawn> | undefined
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '选择音频文件' })).toBeEnabled()
    const executable = await app.evaluate(() => process.execPath)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.minimize())
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized()),
      )
      .toBe(true)
    second = spawn(executable, process.env.RALB_EXECUTABLE ? [] : [resolve('.')], {
      env: environment(root),
      windowsHide: true,
      stdio: 'ignore',
    })
    const [code] = await once(second, 'exit', { signal: AbortSignal.timeout(10_000) })
    expect(code).toBe(0)
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized()),
      )
      .toBe(false)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    await expect(page.getByRole('button', { name: '选择音频文件' })).toBeEnabled()
  } finally {
    if (second?.exitCode === null) second.kill()
    await app.close()
  }
})
