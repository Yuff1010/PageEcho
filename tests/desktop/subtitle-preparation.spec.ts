import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import { openSubtitleAdvanced } from '../helpers/ui'

function launch(root: string) {
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  return electron.launch({
    ...(process.env.RALB_EXECUTABLE
      ? { executablePath: resolve(process.env.RALB_EXECUTABLE), args: [] }
      : { args: [resolve(process.env.RALB_APP_ROOT ?? '.')] }),
    env,
  })
}

async function settings(page: Page, title: string) {
  await page.getByRole('button', { name: `打开 ${title} 的目录`, exact: true }).click()
  await page.getByRole('button', { name: '本书设置与书签', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '收听工具', exact: true })
  await openSubtitleAdvanced(dialog)
  return dialog
}

async function library(page: Page) {
  const result = await page.evaluate(() => window.desktop.getState())
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

test('subtitle strategy is explicit, per book and persistent for local and online books', async ({}, info) => {
  const root = mkdtempSync(join(tmpdir(), '听读 分块字幕设置 '))
  const store = new LibraryStore(createDataPaths(root).database)
  try {
    for (const name of ['分块故事.wav', '手动故事.wav']) {
      const path = join(root, name)
      copyFileSync(resolve('tests/fixtures/第32集-伴读样本.wav'), path)
      store.importBook(await scanBook(path, 'file'))
    }
    const id = store.rememberSourceBook(
      {
        sourceId: 'ting13',
        id: 'subtitle-settings',
        title: '在线字幕故事',
        authors: [],
        narrators: [],
        description: '',
        pageUrl: 'https://example.com/book/subtitle-settings',
      },
      [
        {
          sourceId: 'ting13',
          bookId: 'subtitle-settings',
          id: 'one',
          title: '第一集',
          order: 1,
          pageUrl: 'https://example.com/book/subtitle-settings/one',
        },
      ],
      true,
    )
    store.setSourcePreparation(id, {
      cacheNext: true,
      transcribeNext: true,
      engine: 'whisperx',
      device: 'cpu',
    })
  } finally {
    store.close()
  }
  let app = await launch(root)
  try {
    let page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    let dialog = await settings(page, '分块故事.wav')
    const section = dialog.getByRole('region', { name: '字幕准备', exact: true })
    const mode = section.getByRole('combobox', { name: '字幕准备方案', exact: true })
    await expect(mode).toHaveValue('auto')
    await expect(mode.locator('option')).toHaveText([
      '边播放边生成（推荐）',
      '先准备字幕再播放',
      '仅手动生成',
    ])
    await mode.selectOption('ahead')
    await expect(section.getByRole('button', { name: '保存字幕准备设置' })).toBeDisabled()
    await section.getByRole('combobox', { name: '字幕引擎' }).selectOption('paraformer')
    await section.getByRole('combobox', { name: '字幕设备' }).selectOption('cuda')
    await section.getByRole('checkbox', { name: '本集完成后准备下一集字幕' }).check()
    await section.getByRole('button', { name: '保存字幕准备设置' }).click()
    await expect(section.getByText('本书字幕准备设置已保存。')).toBeVisible()
    expect(
      (await library(page)).books.find((book) => book.title === '分块故事.wav')!
        .subtitlePreparation,
    ).toEqual({ mode: 'ahead', engine: 'paraformer', device: 'cuda', prepareNext: true })
    await dialog.getByRole('button', { name: '关闭收听工具' }).click()
    await page.getByRole('button', { name: '返回书架', exact: true }).click()
    dialog = await settings(page, '手动故事.wav')
    await expect(dialog.getByRole('combobox', { name: '字幕准备方案' })).toHaveValue('auto')
    expect(
      (await library(page)).books.find((book) => book.title === '手动故事.wav')!
        .subtitlePreparation,
    ).toBeUndefined()
    await dialog.getByRole('button', { name: '关闭收听工具' }).click()
    await page.getByRole('button', { name: '返回书架', exact: true }).click()
    dialog = await settings(page, '在线字幕故事')
    await expect(
      dialog.getByRole('checkbox', { name: '自动缓存下一集', exact: true }),
    ).toBeChecked()
    await expect(dialog.getByRole('combobox', { name: '字幕准备方案' })).toHaveValue('ahead')
    await expect(dialog.getByRole('combobox', { name: '预处理引擎' })).toHaveCount(0)
    await dialog.getByRole('combobox', { name: '字幕准备方案' }).selectOption('manual')
    await dialog.getByRole('button', { name: '保存字幕准备设置' }).click()
    await expect(dialog.getByText('本书字幕准备设置已保存。')).toBeVisible()
    const online = (await library(page)).books.find((book) => book.title === '在线字幕故事')!
    expect(online.subtitlePreparation?.mode).toBe('manual')
    expect(online.online?.preparation.cacheNext).toBe(true)
    expect(online.online?.preparation.transcribeNext).toBe(true)
    // Saving audio cache settings must not validate the superseded legacy engine.
    await dialog.getByRole('button', { name: '保存预处理设置', exact: true }).click()
    await expect(dialog.getByText('预处理设置已保存。', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await dialog.getByRole('button', { name: '关闭收听工具' }).click()
    await app.close()
    app = await launch(root)
    page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    dialog = await settings(page, '分块故事.wav')
    await expect(dialog.getByRole('combobox', { name: '字幕准备方案' })).toHaveValue('ahead')
    await expect(dialog.getByRole('combobox', { name: '字幕引擎' })).toHaveValue('paraformer')
    await expect(dialog.getByRole('combobox', { name: '字幕设备' })).toHaveValue('cuda')
    await expect(dialog.getByRole('checkbox', { name: '本集完成后准备下一集字幕' })).toBeChecked()
    await dialog.getByRole('region', { name: '字幕准备', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({
      path: info.outputPath('subtitle-preparation-settings.png'),
      animations: 'disabled',
    })
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})
