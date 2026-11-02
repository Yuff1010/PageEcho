import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { inspectSelectedAudio } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import { closeOwnedElectron } from '../model/electron-lifecycle'
import { menuAction } from '../helpers/ui'

async function fixture(withLegacyAudio = false) {
  const root = mkdtempSync(join(tmpdir(), '听读应用信息 '))
  const legacyName = '此前选择.wav'
  if (withLegacyAudio) {
    const path = join(root, legacyName)
    const wav = Buffer.alloc(44 + 16000)
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
    try {
      store.rememberFile(await inspectSelectedAudio(path))
    } finally {
      store.close()
    }
  }
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '应用设置', exact: true })).toBeVisible()
    return { app, page, root, legacyName }
  } catch (error) {
    await closeOwnedElectron(app)
    throw error
  }
}

test('appearance and application information have separate content, real version data and working legacy imports', async ({}, info) => {
  const { app, page, root, legacyName } = await fixture(true)
  try {
    await expect(page).toHaveTitle('听见书页 · PageEcho')
    await expect(page.getByRole('link', { name: '听见书页首页', exact: true })).toBeVisible()
    const state = await page.evaluate(() => window.desktop.getState())
    if (!state.ok) throw new Error(state.error.message)
    expect(state.value.dataLocation).toBe(root)
    expect(state.value.files.map((file) => file.name)).toEqual([legacyName])
    expect(state.value.books).toHaveLength(0)
    const runtime = await app.evaluate(() => ({
      electron: process.versions.electron!,
      chrome: process.versions.chrome!,
    }))
    const settings = page.getByRole('button', { name: '应用设置', exact: true })
    await menuAction(page, '应用设置', '外观设置')
    const appearance = page.getByRole('dialog', { name: '外观设置', exact: true })
    const about = page.getByRole('dialog', { name: '应用信息', exact: true })
    await expect(appearance).toBeVisible()
    await expect(appearance.getByRole('heading', { name: '外观设置', exact: true })).toBeFocused()
    await expect(
      appearance.getByRole('combobox', { name: '应用界面主题', exact: true }),
    ).toBeVisible()
    await expect(
      appearance.getByRole('combobox', { name: '应用视觉风格', exact: true }),
    ).toBeVisible()
    await expect(appearance.locator('[data-app-version], [data-app-runtime]')).toHaveCount(0)
    await expect(appearance.getByText('数据与存储位置', { exact: true })).toHaveCount(0)
    await expect(appearance.getByText(`数据目录：${root}`, { exact: true })).toHaveCount(0)
    await expect(appearance.getByText('此前选择的音频 · 1', { exact: true })).toHaveCount(0)
    await expect(about).toHaveCount(0)
    await page.screenshot({
      path: info.outputPath('appearance-settings.png'),
      animations: 'disabled',
    })
    await appearance.getByRole('button', { name: '关闭外观设置', exact: true }).click()
    await expect(appearance).toHaveCount(0)
    await expect(settings).toBeFocused()
    await menuAction(page, '应用设置', '外观设置')
    await page.keyboard.press('Escape')
    await expect(appearance).toHaveCount(0)
    await expect(settings).toBeFocused()

    await menuAction(page, '应用设置', '应用信息')
    await expect(about).toBeVisible()
    await expect(about.getByText('听见书页 · PageEcho', { exact: true })).toBeVisible()
    await expect(about.getByRole('heading', { name: '应用信息', exact: true })).toBeFocused()
    await expect(appearance).toHaveCount(0)
    await expect(about.getByRole('combobox', { name: '应用界面主题', exact: true })).toHaveCount(0)
    await expect(about.getByRole('combobox', { name: '应用视觉风格', exact: true })).toHaveCount(0)
    await expect(about.locator('[data-app-version]')).toHaveText(`v${state.value.version}`)
    await expect(about.locator('[data-app-runtime]')).toContainText(runtime.electron)
    await expect(about.locator('[data-app-runtime]')).toContainText(runtime.chrome)
    await page.screenshot({
      path: info.outputPath('application-information.png'),
      animations: 'disabled',
    })
    await about.getByText('数据与存储位置', { exact: true }).click()
    await expect(about.getByText(`数据目录：${root}`, { exact: true })).toBeVisible()
    await about.getByRole('button', { name: '关闭应用信息', exact: true }).click()
    await expect(about).toHaveCount(0)
    await expect(settings).toBeFocused()
    await menuAction(page, '应用设置', '应用信息')
    await page.keyboard.press('Escape')
    await expect(about).toHaveCount(0)
    await expect(settings).toBeFocused()

    await menuAction(page, '应用设置', '应用信息')
    await about.getByText('此前选择的音频 · 1', { exact: true }).click()
    await about.getByRole('button', { name: `加入书架 ${legacyName}`, exact: true }).click()
    await expect(page.getByRole('heading', { name: legacyName, exact: true })).toBeVisible()
    const imported = await page.evaluate(() => window.desktop.getState())
    if (!imported.ok) throw new Error(imported.error.message)
    expect(imported.value.books).toHaveLength(1)
    expect(imported.value.books[0]?.title).toBe(legacyName)
    expect(imported.value.books[0]?.episodes[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/)
  } finally {
    await closeOwnedElectron(app)
  }
})

test('application theme and visual style change independently and preserve choices after reload', async () => {
  const { app, page } = await fixture()
  try {
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'neumorphic')
    await menuAction(page, '应用设置', '外观设置')
    const appearance = page.getByRole('dialog', { name: '外观设置', exact: true })
    const theme = appearance.getByRole('combobox', { name: '应用界面主题', exact: true })
    const style = appearance.getByRole('combobox', { name: '应用视觉风格', exact: true })
    await expect(style).toHaveValue('neumorphic')
    await style.selectOption('minimal')
    await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'minimal')
    await expect(theme).toHaveValue('system')
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'light')
    await theme.selectOption('dark')
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'dark')
    await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'minimal')
    await appearance.getByRole('button', { name: '关闭外观设置', exact: true }).click()
    await expect(page.getByRole('button', { name: '应用设置', exact: true })).toBeFocused()
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'dark')
    await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'minimal')
    await menuAction(page, '应用设置', '外观设置')
    await expect(theme).toHaveValue('dark')
    await expect(style).toHaveValue('minimal')
    await style.selectOption('neumorphic')
    await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'neumorphic')
    await expect(theme).toHaveValue('dark')
    await theme.selectOption('light')
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'light')
    await theme.selectOption('system')
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'dark')
    await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'neumorphic')
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'light')
    await page.keyboard.press('Escape')
    await expect(appearance).toHaveCount(0)
    await expect(page.getByRole('button', { name: '应用设置', exact: true })).toBeFocused()
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'light')
    await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'neumorphic')
    await menuAction(page, '应用设置', '外观设置')
    await expect(theme).toHaveValue('system')
    await expect(style).toHaveValue('neumorphic')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'dark')
    expect(
      await page.evaluate(() => ({
        theme: localStorage.getItem('ralb:app:theme:v1'),
        style: localStorage.getItem('ralb:app:style:v1'),
      })),
    ).toEqual({ theme: 'system', style: 'neumorphic' })
  } finally {
    await closeOwnedElectron(app)
  }
})

test('failed theme and style saves stay visible and retain their independent saved values', async () => {
  const { app, page } = await fixture()
  try {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await menuAction(page, '应用设置', '外观设置')
    const appearance = page.getByRole('dialog', { name: '外观设置', exact: true })
    const theme = appearance.getByRole('combobox', { name: '应用界面主题', exact: true })
    const style = appearance.getByRole('combobox', { name: '应用视觉风格', exact: true })
    await theme.selectOption('light')
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'light')
    await style.selectOption('minimal')
    await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'minimal')
    await page.evaluate(() => {
      const original = Storage.prototype.setItem
      Storage.prototype.setItem = function (key, value) {
        if (key === 'ralb:app:theme:v1' || key === 'ralb:app:style:v1')
          throw new DOMException('controlled full storage', 'QuotaExceededError')
        return original.call(this, key, value)
      }
    })
    await theme.selectOption('dark')
    await expect(appearance.getByRole('alert')).toHaveText('应用主题保存失败，请重试。')
    await expect(appearance.getByRole('alert')).toBeVisible()
    await expect(theme).toHaveValue('light')
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'light')
    expect(await page.evaluate(() => localStorage.getItem('ralb:app:theme:v1'))).toBe('light')
    await theme.focus()
    await expect(appearance.getByRole('alert')).toBeVisible()
    await style.selectOption('neumorphic')
    await expect(
      appearance.getByRole('alert').filter({ hasText: '视觉风格保存失败，请重试。' }),
    ).toBeVisible()
    await expect(style).toHaveValue('minimal')
    await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'minimal')
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'light')
    expect(await page.evaluate(() => localStorage.getItem('ralb:app:style:v1'))).toBe('minimal')
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
  }
})
