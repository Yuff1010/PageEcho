import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import type { TranscriptDocument } from '../../src/shared/transcript'
import { menuAction, leaveCompanionPage } from '../helpers/ui'

// These cases exercise real IPC, policy CAS, SQLite restart and ordinary audio.
// Actual worker thread/priority feedback is covered separately with an isolated
// worker; this suite must not infer resource enforcement from a saved policy.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), '听读 资源设置界面 ')),
    store = new LibraryStore(createDataPaths(root).database)
  store.importBook(await scanBook(resolve('tests/fixtures/第32集-伴读样本.wav'), 'file'))
  const episode = store.listBooks()[0]!.episodes[0]!
  store.saveTranscript(
    episode.id,
    JSON.parse(
      await readFile(resolve('tests/fixtures/reading-manual.json'), 'utf8'),
    ) as TranscriptDocument,
  )
  store.saveProgress({
    sessionId: '',
    episodeId: episode.id,
    positionMs: 0,
    durationMs: 16360,
    rate: 1,
    volume: 1,
  })
  store.close()
  return root
}
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
async function openResources(page: Page) {
  await leaveCompanionPage(page)
  await menuAction(page, '应用设置', '缓存与任务')
  const dialog = page.getByRole('dialog', { name: '缓存与任务', exact: true })
  await dialog.getByRole('tab', { name: /^转写任务/ }).click()
  const panel = dialog.getByRole('region', { name: '处理资源与暂停', exact: true })
  await expect(panel.getByRole('combobox', { name: 'CPU 处理线程', exact: true })).toBeEnabled()
  return { dialog, panel }
}
async function current(page: Page) {
  return page.evaluate(async () => {
    const result = await window.desktop.getProcessingResources()
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  })
}

test('low-usage settings and global pause survive restart while ordinary playback continues and the reader can resume', async ({}, info) => {
  const root = await fixture()
  let app = await launch(root)
  try {
    let page = await app.firstWindow()
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await expect
      .poll(() => page.locator('audio').evaluate((a: HTMLAudioElement) => a.paused))
      .toBe(false)
    const { dialog, panel } = await openResources(page)
    await panel.getByRole('button', { name: '低占用预设', exact: true }).click()
    await panel
      .getByRole('checkbox', { name: '后台预取仅在电脑空闲满 1 分钟后处理', exact: true })
      .check()
    await panel.getByRole('button', { name: '保存资源设置', exact: true }).click()
    await expect(panel.getByLabel('当前生效资源', { exact: true })).toContainText(
      '1 线程 · 低优先级 · 后台预取仅空闲时处理',
    )
    await expect(panel.getByLabel('实际工作进程资源', { exact: true })).toHaveText(
      '当前没有已报告的工作进程。',
    )
    await panel.getByRole('button', { name: '暂停处理', exact: true }).click()
    await expect(panel.getByRole('button', { name: '恢复处理', exact: true })).toBeEnabled()
    expect(await page.locator('audio').evaluate((a: HTMLAudioElement) => a.paused)).toBe(false)
    const saved = await current(page)
    expect(saved.policy).toEqual({ cpuThreads: 1, lowPriority: true, backgroundIdleOnly: true })
    expect(saved.paused).toBe(true)
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setBounds({ width: 720, height: 600 }),
    )
    await panel
      .getByRole('combobox', { name: 'CPU 处理线程', exact: true })
      .scrollIntoViewIfNeeded()
    const fit = await panel.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return (
        bounds.left >= 0 &&
        bounds.right <= window.innerWidth &&
        element.scrollWidth <= element.clientWidth
      )
    })
    expect(fit).toBe(true)
    await page.screenshot({ path: info.outputPath('resource-settings-720x600.png') })
    await dialog.getByRole('button', { name: '关闭缓存与任务', exact: true }).click()
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    const notice = page.getByRole('complementary', { name: '全局处理状态', exact: true })
    const pausedStatus = notice.getByRole('status', {
      name: '字幕生成与原文声音对齐已暂停，音频播放继续。',
      exact: true,
    })
    await expect(pausedStatus).toHaveText('处理暂停')
    await expect(pausedStatus).toHaveAttribute(
      'title',
      '字幕生成与原文声音对齐已暂停，音频播放继续。',
    )
    await expect(notice.getByRole('button', { name: '恢复处理', exact: true })).toBeVisible()
    await expect(notice.getByRole('button', { name: '恢复处理', exact: true })).toBeEnabled()
    await app.close()

    app = await launch(root)
    page = await app.firstWindow()
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    const restored = await current(page)
    expect(restored.paused).toBe(true)
    expect(restored.policy).toEqual(saved.policy)
    const restoredNotice = page.getByRole('complementary', { name: '全局处理状态', exact: true })
    await expect(restoredNotice.getByRole('status')).toHaveText('处理暂停')
    await expect(restoredNotice.getByRole('status')).toHaveAttribute(
      'title',
      '字幕生成与原文声音对齐已暂停，音频播放继续。',
    )
    await restoredNotice.getByRole('button', { name: '恢复处理', exact: true }).click()
    await expect(restoredNotice).toHaveCount(0)
    expect((await current(page)).paused).toBe(false)
    const reopened = await openResources(page)
    await expect(
      reopened.panel.getByRole('combobox', { name: 'CPU 处理线程', exact: true }),
    ).toHaveValue('1')
    await expect(
      reopened.panel.getByRole('checkbox', { name: '降低处理进程优先级', exact: true }),
    ).toBeChecked()
    await expect(
      reopened.panel.getByRole('checkbox', {
        name: '后台预取仅在电脑空闲满 1 分钟后处理',
        exact: true,
      }),
    ).toBeChecked()
    await page.screenshot({ path: info.outputPath('resource-settings-restored.png') })
  } finally {
    await app.close()
  }
})

test('resource progress keeps a dirty draft, conflicting saves require review and pause uses the latest independent revision', async ({}, info) => {
  const root = await fixture(),
    app = await launch(root)
  try {
    const page = await app.firstWindow()
    const { panel } = await openResources(page)
    const threads = panel.getByRole('combobox', { name: 'CPU 处理线程', exact: true })
    const low = panel.getByRole('checkbox', { name: '降低处理进程优先级', exact: true })
    await threads.selectOption('2')
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.send('resources:changed'),
    )
    await expect(threads).toHaveValue('2')
    await expect(panel.getByText('有未保存改动', { exact: true })).toBeVisible()
    await page.evaluate(async () => {
      const before = await window.desktop.getProcessingResources()
      if (!before.ok) throw new Error(before.error.message)
      const changed = await window.desktop.setProcessingResources({
        revision: before.value.revision,
        policy: { cpuThreads: 1, lowPriority: true, backgroundIdleOnly: false },
      })
      if (!changed.ok) throw new Error(changed.error.message)
    })
    await expect(
      panel.getByText('当前生效设置已在其他入口更新，草稿仍保留；保存时会检查版本。', {
        exact: true,
      }),
    ).toBeVisible()
    await expect(threads).toHaveValue('2')
    await expect(low).not.toBeChecked()
    await panel.getByRole('button', { name: '保存资源设置', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('处理资源设置已更新')
    await expect(
      panel.getByText('草稿已保留，已读取当前生效设置。检查后可再次保存你的草稿。', {
        exact: true,
      }),
    ).toBeVisible()
    expect((await current(page)).policy.cpuThreads).toBe(1)
    await expect(threads).toHaveValue('2')
    await panel.getByRole('button', { name: '保存资源设置', exact: true }).click()
    await expect(
      panel.getByText('资源设置已保存；CPU 线程设置用于新建任务。', { exact: true }),
    ).toBeVisible()
    expect((await current(page)).policy).toEqual({
      cpuThreads: 2,
      lowPriority: false,
      backgroundIdleOnly: false,
    })
    await threads.selectOption('4')
    await page.evaluate(async () => {
      const before = await window.desktop.getProcessingResources()
      if (!before.ok) throw new Error(before.error.message)
      const changed = await window.desktop.setProcessingPaused({
        revision: before.value.revision,
        paused: true,
      })
      if (!changed.ok) throw new Error(changed.error.message)
    })
    await expect(panel.getByRole('button', { name: '恢复处理', exact: true })).toBeEnabled()
    await expect(threads).toHaveValue('4')
    await panel.getByRole('button', { name: '恢复处理', exact: true }).click()
    await expect(panel.getByRole('button', { name: '暂停处理', exact: true })).toBeEnabled()
    await expect(threads).toHaveValue('4')
    expect((await current(page)).policy.cpuThreads).toBe(2)
    await panel.getByRole('button', { name: '保存资源设置', exact: true }).click()
    await expect(
      panel.getByText('资源设置已保存；CPU 线程设置用于新建任务。', { exact: true }),
    ).toBeVisible()
    expect((await current(page)).policy.cpuThreads).toBe(4)
    expect((await current(page)).paused).toBe(false)
    await page.screenshot({ path: info.outputPath('resource-draft-conflict-recovered.png') })
  } finally {
    await app.close()
  }
})
