import { test, expect, _electron as electron, type Page, type Locator } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { createDataPaths } from '../../src/main/paths'
import { scanBook } from '../../src/main/files'
import { CHANNELS } from '../../src/shared/contracts'
import { menuAction } from '../helpers/ui'
import { closeOwnedElectron } from '../model/electron-lifecycle'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), '听读 真正标签 '))
  const store = new LibraryStore(createDataPaths(root).database)
  store.importBook(await scanBook(resolve('tests/fixtures/第32集-伴读样本.wav'), 'file'))
  const book = store.listBooks()[0]!
  const episode = book.episodes[0]!
  store.setSubtitlePreparation(book.id, {
    mode: 'manual',
    engine: 'paraformer',
    device: 'cpu',
    prepareNext: false,
  })
  store.saveProgress({
    sessionId: '',
    episodeId: episode.id,
    positionMs: 5000,
    durationMs: 16000,
    rate: 1,
    volume: 0,
  })
  for (let i = 0; i < 25; i++)
    store.saveBookmark({
      episodeId: episode.id,
      audioHash: episode.contentHash,
      positionMs: 100 + i * 100,
      note: `第${i}处已有备注，保留原来的文字。`,
    })
  store.close()
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 600))
  await expect(
    page
      .getByRole('region', { name: '播放器', exact: true })
      .getByRole('button', { name: '播放', exact: true }),
  ).toBeEnabled()
  return { app, page, book }
}

async function listeningTools(page: Page) {
  await menuAction(page, '播放选项', '收听工具')
  return page.getByRole('dialog', { name: '收听工具', exact: true })
}

async function selected(dialog: Locator, name: string) {
  await expect(dialog.getByRole('tab', { name, exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(dialog.getByRole('tab', { name, exact: true })).toHaveAttribute('tabindex', '0')
  await expect(dialog.getByRole('tabpanel')).toHaveCount(1)
  await expect(dialog.getByRole('tabpanel', { name, exact: true })).toBeVisible()
}

test('listening tools show only the selected category, follow keyboard navigation and open the requested initial tab', async ({}, info) => {
  const { app, page, book } = await fixture()
  try {
    let dialog = await listeningTools(page)
    const tabs = dialog.getByRole('tablist', { name: '本书设置导航', exact: true })
    await expect(tabs.getByRole('tab')).toHaveCount(3)
    await selected(dialog, '播放与定时')
    await expect(dialog.getByRole('tab', { name: '播放与定时', exact: true })).toBeFocused()
    await expect(dialog.getByRole('region', { name: '本地字幕组件', exact: true })).toBeHidden()
    await expect(dialog.getByRole('button', { name: '保存备注', exact: true })).toHaveCount(0)
    for (const tab of await tabs.getByRole('tab').all()) {
      const panelId = await tab.getAttribute('aria-controls')
      const tabId = await tab.getAttribute('id')
      expect(panelId).toBeTruthy()
      await expect(dialog.locator(`[id="${panelId}"]`)).toHaveAttribute('aria-labelledby', tabId!)
    }
    await tabs.getByRole('tab', { name: '播放与定时', exact: true }).press('ArrowRight')
    await selected(dialog, '字幕与缓存')
    await expect(tabs.getByRole('tab', { name: '字幕与缓存', exact: true })).toBeFocused()
    await expect(dialog.getByRole('spinbutton', { name: '定时分钟', exact: true })).toBeHidden()
    await tabs.getByRole('tab', { name: '字幕与缓存', exact: true }).press('End')
    await selected(dialog, '查看书签')
    await expect(dialog.getByRole('region', { name: '本书书签', exact: true })).toBeVisible()
    await tabs.getByRole('tab', { name: '查看书签', exact: true }).press('ArrowRight')
    await selected(dialog, '播放与定时')
    await tabs.getByRole('tab', { name: '播放与定时', exact: true }).press('ArrowLeft')
    await selected(dialog, '查看书签')
    await tabs.getByRole('tab', { name: '查看书签', exact: true }).press('Home')
    await selected(dialog, '播放与定时')
    await page.screenshot({
      path: info.outputPath('listening-tools-playback-tab-720.png'),
      animations: 'disabled',
    })
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    )
    await dialog.getByRole('button', { name: '关闭收听工具', exact: true }).click()
    await page
      .getByRole('region', { name: '播放器', exact: true })
      .getByRole('button', { name: '字幕与伴读', exact: true })
      .click()
    dialog = page.getByRole('dialog', { name: '收听工具', exact: true })
    await selected(dialog, '字幕与缓存')
    await expect(dialog.getByRole('tab', { name: '字幕与缓存', exact: true })).toBeFocused()
    await dialog.getByRole('button', { name: '关闭收听工具', exact: true }).click()
    await menuAction(page, `更多 ${book.title} 的操作`, '本书设置与书签')
    dialog = page.getByRole('dialog', { name: '收听工具', exact: true })
    await selected(dialog, '查看书签')
    await expect(dialog.getByRole('tab', { name: '查看书签', exact: true })).toBeFocused()
  } finally {
    await closeOwnedElectron(app)
  }
})

test('category switches keep their drafts and independent scroll positions without leaking delayed errors', async () => {
  const { app, page } = await fixture()
  try {
    const dialog = await listeningTools(page)
    await app.evaluate(({ ipcMain }, channel) => {
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
        string,
        (...args: unknown[]) => unknown
      >
      handlers.set(
        channel,
        () =>
          new Promise((resolve) => {
            Reflect.set(globalThis, 'releaseListeningTabError', () =>
              resolve({
                ok: false,
                error: { code: 'INTERNAL', message: '受控保存失败，草稿应留在播放设置。' },
              }),
            )
          }),
      )
    }, CHANNELS.bookSkips)
    await dialog.getByRole('spinbutton', { name: '跳过片头秒数', exact: true }).fill('3')
    await dialog.getByRole('spinbutton', { name: '跳过片尾秒数', exact: true }).fill('2')
    await dialog.getByRole('button', { name: '保存跳过设置', exact: true }).click()
    await expect
      .poll(() => app.evaluate(() => typeof Reflect.get(globalThis, 'releaseListeningTabError')))
      .toBe('function')
    const playbackScroll = await dialog
      .getByRole('tabpanel', { name: '播放与定时', exact: true })
      .evaluate((element) => element.scrollTop)
    await dialog.getByRole('tab', { name: '字幕与缓存', exact: true }).click()
    const subtitles = dialog.getByRole('tabpanel', { name: '字幕与缓存', exact: true })
    expect(await subtitles.evaluate((element) => element.scrollTop)).toBe(0)
    await app.evaluate(() => (Reflect.get(globalThis, 'releaseListeningTabError') as () => void)())
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await subtitles.locator('.subtitle-advanced-settings > summary').click()
    await subtitles
      .getByRole('combobox', { name: '字幕准备方案', exact: true })
      .selectOption('auto')
    const subtitleScroll = await subtitles.evaluate((element) => {
      element.scrollTop = 240
      return element.scrollTop
    })
    expect(subtitleScroll).toBeGreaterThan(0)
    await dialog.getByRole('tab', { name: '查看书签', exact: true }).click()
    const bookmarks = dialog.getByRole('tabpanel', { name: '查看书签', exact: true })
    expect(await bookmarks.evaluate((element) => element.scrollTop)).toBe(0)
    await bookmarks.getByRole('button', { name: '备注', exact: true }).first().click()
    await bookmarks
      .getByRole('textbox', { name: '书签备注', exact: true })
      .fill('没有保存的书签草稿')
    const bookmarkScroll = await bookmarks.evaluate((element) => {
      element.scrollTop = 280
      return element.scrollTop
    })
    expect(bookmarkScroll).toBeGreaterThan(0)
    await dialog.getByRole('tab', { name: '字幕与缓存', exact: true }).click()
    expect(await subtitles.evaluate((element) => element.scrollTop)).toBeCloseTo(subtitleScroll, 0)
    await expect(
      subtitles.getByRole('combobox', { name: '字幕准备方案', exact: true }),
    ).toHaveValue('auto')
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await dialog.getByRole('tab', { name: '播放与定时', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('受控保存失败')
    await expect(dialog.getByRole('spinbutton', { name: '跳过片头秒数', exact: true })).toHaveValue(
      '3',
    )
    await expect(dialog.getByRole('spinbutton', { name: '跳过片尾秒数', exact: true })).toHaveValue(
      '2',
    )
    expect(
      await dialog
        .getByRole('tabpanel', { name: '播放与定时', exact: true })
        .evaluate((element) => element.scrollTop),
    ).toBeCloseTo(playbackScroll, 0)
    await dialog.getByRole('tab', { name: '查看书签', exact: true }).click()
    await expect(dialog.getByRole('textbox', { name: '书签备注', exact: true })).toHaveValue(
      '没有保存的书签草稿',
    )
    expect(await bookmarks.evaluate((element) => element.scrollTop)).toBeCloseTo(bookmarkScroll, 0)
    await expect(dialog.getByRole('alert')).toHaveCount(0)
  } finally {
    await closeOwnedElectron(app)
  }
})

test('maintenance and offline categories expose selected panels and support directional keys, Home and End', async () => {
  const { app, page } = await fixture()
  try {
    await menuAction(page, '应用设置', '缓存与任务')
    const maintenance = page.getByRole('dialog', { name: '缓存与任务', exact: true })
    const list = maintenance.getByRole('tablist', { name: '管理页面', exact: true })
    await expect(list.getByRole('tab')).toHaveCount(3)
    await expect(maintenance.getByRole('tabpanel')).toHaveCount(1)
    const storage = list.getByRole('tab', { name: '存储与组件', exact: true })
    await expect(storage).toHaveAttribute('aria-selected', 'true')
    await storage.focus()
    await storage.press('End')
    const log = list.getByRole('tab', { name: '应用日志', exact: true })
    await expect(log).toBeFocused()
    await expect(log).toHaveAttribute('aria-selected', 'true')
    await expect(maintenance.getByRole('tabpanel', { name: '应用日志', exact: true })).toBeVisible()
    await log.press('Home')
    await expect(storage).toBeFocused()
    await storage.press('ArrowDown')
    const tasks = list.getByRole('tab', { name: /^转写任务/ })
    await expect(tasks).toBeFocused()
    await expect(tasks).toHaveAttribute('aria-selected', 'true')
    await expect(maintenance.getByRole('tabpanel')).toHaveCount(1)
    await maintenance.getByRole('button', { name: '管理离线计划', exact: true }).click()
    const offline = page.getByRole('dialog', { name: '离线准备计划', exact: true })
    const planList = offline.getByRole('tab', { name: '已有计划', exact: true })
    await expect(planList).toHaveAttribute('aria-selected', 'true')
    await planList.focus()
    await planList.press('Home')
    const fresh = offline.getByRole('tab', { name: '新建计划', exact: true })
    await expect(fresh).toBeFocused()
    await expect(fresh).toHaveAttribute('aria-selected', 'true')
    await expect(offline.getByRole('tabpanel')).toHaveCount(1)
    await offline.getByRole('spinbutton', { name: '离线音频预算 GiB', exact: true }).fill('7')
    await fresh.press('End')
    await expect(
      offline.getByRole('spinbutton', { name: '离线音频预算 GiB', exact: true }),
    ).toBeHidden()
    await planList.press('ArrowRight')
    await expect(fresh).toHaveAttribute('aria-selected', 'true')
    await expect(
      offline.getByRole('spinbutton', { name: '离线音频预算 GiB', exact: true }),
    ).toHaveValue('7')
  } finally {
    await closeOwnedElectron(app)
  }
})
