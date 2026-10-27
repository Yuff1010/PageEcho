import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { createDataPaths } from '../../src/main/paths'
import { scanBook } from '../../src/main/files'
import { colorContrast } from '../../src/renderer/src/reader-settings'
import { closeOwnedElectron } from '../model/electron-lifecycle'
import { openCompanionTools } from '../helpers/ui'

async function fixture(theme: 'light' | 'dark') {
  const root = mkdtempSync(join(tmpdir(), '听读 设置展开 '))
  const store = new LibraryStore(createDataPaths(root).database)
  store.importBook(await scanBook(resolve('tests/fixtures/第32集-伴读样本.wav'), 'file'))
  const book = store.listBooks()[0]!
  store.setSubtitlePreparation(book.id, {
    mode: 'manual',
    engine: 'paraformer',
    device: 'cpu',
    prepareNext: false,
  })
  store.close()
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 600))
  await page.evaluate((theme) => {
    localStorage.setItem('ralb:app:theme:v1', theme)
    dispatchEvent(new Event('ralb:app-theme'))
  }, theme)
  await expect(page.locator('html')).toHaveAttribute('data-ui-theme', theme)
  await page.getByRole('button', { name: `打开 ${book.title} 的目录`, exact: true }).click()
  await page.getByRole('button', { name: '本书设置与书签', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '收听工具', exact: true })
  await dialog.getByRole('tab', { name: '字幕与缓存', exact: true }).click()
  return { app, page, dialog }
}

test('subtitle generation settings keep the disclosure hierarchy inside a paper reading drawer with a dark app theme', async ({}, info) => {
  const { app, page, dialog } = await fixture('dark')
  try {
    await dialog.getByRole('button', { name: '关闭收听工具', exact: true }).click()
    await page.getByRole('button', { name: '返回书架', exact: true }).click()
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await page
      .getByRole('region', { name: '播放器', exact: true })
      .getByRole('button', { name: '暂停', exact: true })
      .click()
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    await openCompanionTools(page)
    const controls = page.locator('.transcription-controls > details')
    if ((await controls.getAttribute('open')) === null)
      await controls.locator(':scope > summary').click()
    await controls.getByRole('button', { name: '调整字幕方案', exact: true }).click()
    const advanced = page.locator('.subtitle-advanced-settings')
    await expect(advanced).toHaveAttribute('open', '')
    await assertReadableSettings(page)
    const summary = advanced.locator(':scope > summary')
    expect(
      await summary
        .locator('.settings-disclosure-heading')
        .evaluate((element) => getComputedStyle(element).display),
    ).toBe('flex')
    await summary.evaluate((element) => element.scrollIntoView({ block: 'start' }))
    await page.screenshot({
      path: info.outputPath('paper-reading-settings-dark-app.png'),
      animations: 'disabled',
    })
    expect(
      await page
        .locator('.companion-drawer:not([hidden])')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true)
    await summary.focus()
    await summary.press('Enter')
    await expect(advanced).not.toHaveAttribute('open', '')
    await summary.press('Space')
    await expect(advanced).toHaveAttribute('open', '')
  } finally {
    await closeOwnedElectron(app)
  }
})

async function assertReadableSettings(page: Page) {
  const surfaces = await page.locator('.subtitle-advanced-settings').evaluate((panel) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')!
    const hex = (css: string) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = css
      context.fillRect(0, 0, 1, 1)
      return (
        '#' +
        [...context.getImageData(0, 0, 1, 1).data]
          .slice(0, 3)
          .map((channel) => channel.toString(16).padStart(2, '0'))
          .join('')
      )
    }
    const summary = panel.querySelector('summary')!
    const field = panel.querySelector('select')!
    const summaryStyle = getComputedStyle(summary)
    const fieldStyle = getComputedStyle(field)
    const text = [
      '.settings-disclosure-title',
      '.settings-disclosure-description',
      '.settings-disclosure-action',
    ].map((selector) => hex(getComputedStyle(summary.querySelector(selector)!).color))
    return {
      summaryBackground: hex(summaryStyle.backgroundColor),
      panelBackground: hex(getComputedStyle(panel).backgroundColor),
      fieldBackground: hex(fieldStyle.backgroundColor),
      fieldText: hex(fieldStyle.color),
      text,
      fieldArrow: getComputedStyle(field, '::picker-icon').content,
      fieldArrowSeparator: getComputedStyle(field, '::picker-icon').borderInlineStartWidth,
    }
  })
  expect(surfaces.summaryBackground).not.toBe(surfaces.panelBackground)
  expect(surfaces.fieldBackground).not.toBe(surfaces.summaryBackground)
  for (const text of surfaces.text)
    expect(colorContrast(surfaces.summaryBackground, text)).toBeGreaterThanOrEqual(4.5)
  expect(colorContrast(surfaces.fieldBackground, surfaces.fieldText)).toBeGreaterThanOrEqual(4.5)
  expect(surfaces.fieldArrow).toContain('⌄')
  expect(surfaces.fieldArrowSeparator).toBe('1px')
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme} settings panels have distinct full-row disclosure controls, nested content and keyboard-selectable fields at 720px`, async ({}, info) => {
    const { app, page, dialog } = await fixture(theme)
    try {
      const advanced = dialog.locator('.subtitle-advanced-settings')
      const summary = advanced.locator(':scope > summary')
      await expect(advanced).not.toHaveAttribute('open', '')
      await expect(summary.locator('.settings-disclosure-expand')).toBeVisible()
      await summary.scrollIntoViewIfNeeded()
      const geometry = await summary.evaluate((element) => {
        const box = element.getBoundingClientRect()
        const panel = element.parentElement!.getBoundingClientRect()
        return { height: box.height, width: box.width, panelWidth: panel.width }
      })
      expect(geometry.height).toBeGreaterThanOrEqual(56)
      expect(geometry.panelWidth - geometry.width).toBeLessThanOrEqual(3)
      // Clicking the far end of the row must open the panel, not only its title.
      await summary.click({ position: { x: geometry.width - 20, y: geometry.height / 2 } })
      await expect(advanced).toHaveAttribute('open', '')
      await expect(summary.locator('.settings-disclosure-collapse')).toBeVisible()
      await expect(summary.locator('.settings-disclosure-expand')).toBeHidden()
      const body = advanced.locator(':scope > .settings-disclosure-body')
      await expect(body).toBeVisible()
      expect(
        await body.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).borderLeftWidth),
        ),
      ).toBeGreaterThanOrEqual(2)
      await assertReadableSettings(page)
      const reference = advanced.locator('.engine-reference')
      const referenceSummary = reference.locator(':scope > summary')
      await referenceSummary.focus()
      await referenceSummary.press('Space')
      await expect(reference).toHaveAttribute('open', '')
      await expect(reference.getByRole('table')).toBeVisible()
      await referenceSummary.press('Enter')
      await expect(reference).not.toHaveAttribute('open', '')
      const mode = advanced.getByRole('combobox', { name: '字幕准备方案', exact: true })
      await mode.focus()
      expect(await mode.evaluate((element) => getComputedStyle(element).outlineWidth)).toBe('3px')
      await mode.press('ArrowDown')
      await mode.press('Escape')
      await expect(advanced).toHaveAttribute('open', '')
      await mode.selectOption('auto')
      await expect(mode).toHaveValue('auto')
      await summary.evaluate((element) => element.scrollIntoView({ block: 'start' }))
      await page.screenshot({
        path: info.outputPath(`settings-disclosures-${theme}.png`),
        animations: 'disabled',
      })
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      )
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      await summary.focus()
      await summary.press('Space')
      await expect(advanced).not.toHaveAttribute('open', '')
      await expect(mode).toBeHidden()
      const installation = dialog.locator('.component-installation')
      const installSummary = installation.locator(':scope > summary')
      await installSummary.focus()
      await installSummary.press('Enter')
      await expect(installation).toHaveAttribute('open', '')
      expect(
        await installSummary.evaluate((element) => getComputedStyle(element, '::after').content),
      ).toContain('收起')
      await installSummary.press('Space')
      await expect(installation).not.toHaveAttribute('open', '')
    } finally {
      await closeOwnedElectron(app)
    }
  })
}
