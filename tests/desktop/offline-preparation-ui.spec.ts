import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import type { OfflinePlan } from '../../src/shared/offline'
import { menuAction } from '../helpers/ui'

function audio(path: string, marker: number) {
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
  wav.writeUInt32LE(16000, 40)
  wav.writeInt16LE(marker, 44)
  writeFileSync(path, wav)
}

async function fixture(count = 101, ready = true) {
  const root = mkdtempSync(join(tmpdir(), '听读 离线计划界面 ')),
    directory = join(root, '完整本地目录'),
    paths = createDataPaths(root)
  mkdirSync(directory)
  for (let i = 1; i <= count; i++) audio(join(directory, `第${i}集.wav`), i)
  const store = new LibraryStore(paths.database)
  store.importBook(await scanBook(directory, 'folder'))
  const book = store.listBooks()[0]!
  // Keep an explicit book profile distinct from the plan draft. Opening or
  // creating a plan must not silently rewrite the book's listening strategy.
  store.setSubtitlePreparation(book.id, {
    mode: 'manual',
    engine: 'paraformer',
    device: 'cpu',
    prepareNext: false,
  })
  for (const [index, episode] of book.episodes.entries()) {
    store.recordSourceDuration(episode.id, episode.contentHash, 1000)
    if (ready)
      store.saveTranscript(episode.id, {
        version: 1,
        kind: 'manual',
        audioHash: episode.contentHash,
        coverage: [{ startMs: 0, endMs: index === 1 ? 400 : 1000 }],
        segments: [
          { id: 'fixture-s1', startMs: 0, endMs: 400, text: '界面夹具，不是人工听审参考。' },
        ],
      })
  }
  store.rememberSourceBook(
    {
      sourceId: 'ting13',
      id: '70001',
      title: '离线计划在线目录',
      authors: [],
      narrators: [],
      description: '完整目录的 UI 夹具；本测试不会下载或生成。',
      pageUrl: 'https://www.ting13.com/book/70001.html',
    },
    [1, 2, 3].map((order) => ({
      sourceId: 'ting13' as const,
      bookId: '70001',
      id: `8000${order}`,
      title: `在线第${order}集`,
      order,
      pageUrl: `https://www.ting13.com/play/8000${order}.html`,
    })),
    true,
  )
  const online = store.listBooks().find((item) => item.online)!
  let paused: OfflinePlan | null = null
  if (!ready) {
    const created = store.createOfflinePlan({
      bookId: book.id,
      episodeIds: book.episodes.map((item) => item.id),
      scope: 'all',
      profile: { engine: 'whisperx', device: 'cpu' },
      audioBudgetBytes: 5 * 1024 ** 3,
    })
    paused = store.updateOfflinePlan({
      id: created.id,
      revision: created.revision,
      action: 'pause',
    })
    const resources = store.processingResources()
    store.setProcessingPaused({ revision: resources.revision, paused: true })
  }
  store.close()
  return { root, paths, directory, book, online, paused }
}
function launch(root: string, appRoot?: string) {
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  return electron.launch({
    ...(process.env.RALB_EXECUTABLE
      ? { executablePath: resolve(process.env.RALB_EXECUTABLE), args: [] }
      : { args: [appRoot ?? resolve(process.env.RALB_APP_ROOT ?? '.')] }),
    env: Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
  })
}
async function open(page: Page, bookId?: string) {
  await menuAction(page, '应用设置', '离线准备计划')
  const dialog = page.getByRole('dialog', { name: '离线准备计划', exact: true })
  await expect(dialog).toBeVisible()
  if (bookId) {
    await dialog.getByRole('tab', { name: '新建计划', exact: true }).click()
    await dialog.getByRole('combobox', { name: '离线准备书籍', exact: true }).selectOption(bookId)
  }
  return dialog
}
async function plans(page: Page) {
  return page.evaluate(async () => {
    const result = await window.desktop.listOfflinePreparations({ page: 0, activeOnly: false })
    if (!result.ok) throw new Error(result.error.message)
    return result.value.plans
  })
}
async function plan(page: Page, id: string) {
  return page.evaluate(async (id) => {
    const result = await window.desktop.getOfflinePreparation({ id, itemPage: 0 })
    if (!result.ok) throw new Error(result.error.message)
    return result.value.plan
  }, id)
}
async function notify(app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.webContents.send('offline:changed'),
  )
}

test('offline preview uses the full catalog and cross-page selections, protects manual drafts and requires an explicit creation', async ({}, info) => {
  const data = await fixture(),
    app = await launch(data.root)
  try {
    const page = await app.firstWindow(),
      dialog = await open(page, data.book.id)
    const audioBefore = await page.locator('audio[data-player="persistent"]').getAttribute('src')
    await dialog
      .getByRole('combobox', { name: '离线计划引擎', exact: true })
      .selectOption('whisperx')
    await dialog.getByRole('spinbutton', { name: '离线音频预算 GiB', exact: true }).fill('0')
    await dialog.getByRole('button', { name: '预览离线准备', exact: true }).click()
    const preview = dialog.getByRole('region', { name: '离线准备预览', exact: true })
    await expect(preview).toContainText('预览 101 集')
    await expect(preview.locator('.offline-preview-counts')).toContainText('已有部分稿1 集')
    await expect(preview.locator('.offline-preview-counts')).toContainText('整集字幕已备100 集')
    await preview.getByRole('button', { name: '下一页预览', exact: true }).click()
    await expect(preview.locator('ol')).toContainText('第 101 集')
    expect(await plans(page)).toHaveLength(0)

    await dialog.getByRole('combobox', { name: '离线准备范围', exact: true }).selectOption('range')
    await dialog.getByRole('spinbutton', { name: '离线范围起始集', exact: true }).fill('100')
    await dialog.getByRole('spinbutton', { name: '离线范围结束集', exact: true }).fill('101')
    await dialog.getByRole('button', { name: '预览离线准备', exact: true }).click()
    await expect(preview).toContainText('预览 2 集')
    await expect(preview.locator('ol')).toContainText('第 100 集')
    await expect(preview.locator('ol')).toContainText('第 101 集')

    await dialog
      .getByRole('combobox', { name: '离线准备范围', exact: true })
      .selectOption('selected')
    await dialog
      .getByRole('checkbox', { name: `第 1 集 · ${data.book.episodes[0]!.title}`, exact: true })
      .check()
    await dialog.getByRole('button', { name: '下一页选集', exact: true }).click()
    await dialog
      .getByRole('checkbox', { name: `第 101 集 · ${data.book.episodes[100]!.title}`, exact: true })
      .check()
    await dialog.getByRole('button', { name: '上一页选集', exact: true }).click()
    await expect(
      dialog.getByRole('checkbox', {
        name: `第 1 集 · ${data.book.episodes[0]!.title}`,
        exact: true,
      }),
    ).toBeChecked()
    await dialog.getByRole('button', { name: '预览离线准备', exact: true }).click()
    await expect(preview).toContainText('预览 2 集')
    await dialog.getByRole('spinbutton', { name: '离线音频预算 GiB', exact: true }).fill('6')
    await expect(dialog.getByRole('button', { name: '确认创建离线计划', exact: true })).toHaveCount(
      0,
    )
    expect(await plans(page)).toHaveLength(0)
    await dialog.getByRole('button', { name: '预览离线准备', exact: true }).click()
    await expect(preview).toContainText('6.00 GiB')
    await dialog.getByRole('button', { name: '确认创建离线计划', exact: true }).click()
    await expect.poll(async () => (await plans(page)).length).toBe(1)
    const created = (await plans(page))[0]!
    expect(created.scope).toBe('ids')
    expect(created.counts.total).toBe(2)
    expect(created.profile).toEqual({ engine: 'whisperx', device: 'cpu' })
    const items = await page.evaluate(
      (id) => window.desktop.getOfflinePreparation({ id, itemPage: 0 }),
      created.id,
    )
    expect(items.ok && items.value.items.items.map((item) => item.episodeId)).toEqual([
      data.book.episodes[0]!.id,
      data.book.episodes[100]!.id,
    ])
    const library = await page.evaluate(() => window.desktop.getState())
    expect(
      library.ok &&
        library.value.books.find((item) => item.id === data.book.id)?.subtitlePreparation,
    ).toEqual({ mode: 'manual', engine: 'paraformer', device: 'cpu', prepareNext: false })
    expect(await page.locator('audio[data-player="persistent"]').getAttribute('src')).toBe(
      audioBefore,
    )
    const partial = await page.evaluate(
      (episode) =>
        window.desktop.getTranscript({ episodeId: episode.id, audioHash: episode.contentHash }),
      data.book.episodes[1]!,
    )
    if (!partial.ok || partial.value.status !== 'ready')
      throw new Error('Protected manual fixture was lost.')
    expect(partial.value.transcript.document.kind).toBe('manual')
    expect(partial.value.transcript.document.coverage).toEqual([{ startMs: 0, endMs: 400 }])

    // A complete saved online catalog can be previewed without starting a
    // provider request or interpreting unknown media sizes as zero.
    await dialog.getByRole('tab', { name: '新建计划', exact: true }).click()
    await dialog
      .getByRole('combobox', { name: '离线准备书籍', exact: true })
      .selectOption(data.online.id)
    await dialog.getByRole('combobox', { name: '离线准备范围', exact: true }).selectOption('all')
    await dialog
      .getByRole('combobox', { name: '离线计划引擎', exact: true })
      .selectOption('paraformer')
    await dialog.getByRole('button', { name: '预览离线准备', exact: true }).click()
    await expect(preview).toContainText('预览 3 集')
    await expect(preview.locator('.offline-preview-counts')).toContainText('大小未知3 集')
    await expect(preview).toContainText('未知项不会按零字节估算')
    expect(await plans(page)).toHaveLength(1)
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setBounds({ width: 720, height: 600 }),
    )
    await preview
      .getByRole('button', { name: '确认创建离线计划', exact: true })
      .scrollIntoViewIfNeeded()
    await expect(
      preview.getByRole('button', { name: '确认创建离线计划', exact: true }),
    ).toBeInViewport()
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    )
    await page.screenshot({ path: info.outputPath('offline-preview-720.png') })
  } finally {
    await app.close()
  }
})

test('offline plan budget drafts survive notifications and CAS failure, while pause, cancellation and release persist across restart', async ({}, info) => {
  const data = await fixture(2, false),
    id = data.paused!.id
  let app = await launch(data.root)
  try {
    let page = await app.firstWindow(),
      dialog = await open(page)
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setBounds({ width: 720, height: 600 }),
    )
    await expect(
      dialog.getByRole('complementary', { name: '全局处理状态', exact: true }),
    ).toContainText('暂停')
    await expect(dialog.getByRole('button', { name: '恢复处理', exact: true })).toBeInViewport()
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    )
    await page.screenshot({ path: info.outputPath('offline-global-pause-720.png') })
    await dialog.getByRole('button', { name: '恢复处理', exact: true }).click()
    await expect
      .poll(async () => {
        const result = await page.evaluate(() => window.desktop.getProcessingResources())
        if (!result.ok) throw new Error(result.error.message)
        return result.value.paused
      })
      .toBe(false)
    expect((await plan(page, id)).status).toBe('paused')
    await dialog
      .locator(`[data-offline-plan-id="${id}"]`)
      .getByRole('button', { name: '查看详情', exact: true })
      .click()
    let detail = dialog.getByRole('region', { name: '离线计划详情', exact: true })
    await expect(detail).toContainText('计划已暂停')
    const budget = detail.getByRole('spinbutton', { name: '调整在线音频预算 GiB', exact: true })
    await budget.fill('7')
    await notify(app)
    // Let the panel's notification debounce finish before introducing the
    // separate control revision below; this is a deliberate stale-CAS test.
    await page.waitForTimeout(250)
    await expect(budget).toHaveValue('7')
    // A second connection performs a genuine control revision change without
    // delivering a notification first: the UI's next save must fail its CAS.
    const concurrent = new LibraryStore(data.paths.database)
    const current = concurrent.offlinePlan(id)!
    concurrent.updateOfflinePlan({
      id,
      revision: current.revision,
      action: 'set-budget',
      audioBudgetBytes: 9 * 1024 ** 3,
    })
    concurrent.close()
    await detail.getByRole('button', { name: '保存音频预算', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('变化')
    await expect(detail).toContainText('9.00 GiB')
    await expect(budget).toHaveValue('7')
    await detail.getByRole('button', { name: '保存音频预算', exact: true }).click()
    await expect.poll(async () => (await plan(page, id)).audioBudgetBytes).toBe(7 * 1024 ** 3)
    await expect(detail).toContainText('7.00 GiB')
    await dialog.getByRole('button', { name: '关闭离线准备计划', exact: true }).click()
    await app.close()
    app = await launch(data.root)
    page = await app.firstWindow()
    // The task page exposes the same persisted plan list instead of starting a
    // second queue or changing the current playback episode.
    await menuAction(page, '应用设置', '缓存与任务')
    await page
      .getByRole('dialog', { name: '缓存与任务', exact: true })
      .getByRole('tab', { name: /^转写任务/ })
      .click()
    await page
      .getByRole('dialog', { name: '缓存与任务', exact: true })
      .getByRole('button', { name: '管理离线计划', exact: true })
      .click()
    dialog = page.getByRole('dialog', { name: '离线准备计划', exact: true })
    await dialog
      .locator(`[data-offline-plan-id="${id}"]`)
      .getByRole('button', { name: '查看详情', exact: true })
      .click()
    detail = dialog.getByRole('region', { name: '离线计划详情', exact: true })
    await expect(detail).toContainText('计划已暂停')
    await expect(detail).toContainText('7.00 GiB')
    await detail.getByRole('button', { name: '恢复计划', exact: true }).click()
    await expect.poll(async () => (await plan(page, id)).status).not.toBe('paused')
    await detail.getByRole('button', { name: '暂停计划', exact: true }).click()
    await expect.poll(async () => (await plan(page, id)).status).toBe('paused')
    await detail.getByRole('button', { name: '取消计划', exact: true }).click()
    await expect.poll(async () => (await plan(page, id)).status).toBe('canceled')
    await expect(detail.getByRole('button', { name: '恢复计划', exact: true })).toHaveCount(0)
    await expect(detail.getByRole('button', { name: '重试失败项', exact: true })).toHaveCount(0)
    await detail.getByRole('button', { name: '解除本计划离线保留…', exact: true }).click()
    await expect(
      detail.getByRole('group', { name: '确认解除离线保留', exact: true }),
    ).toContainText('不立即删除音频')
    expect((await plan(page, id)).retentionReleasedAt).toBeNull()
    await detail.getByRole('button', { name: '返回，保留离线音频', exact: true }).click()
    expect((await plan(page, id)).retentionReleasedAt).toBeNull()
    await detail.getByRole('button', { name: '解除本计划离线保留…', exact: true }).click()
    await detail.getByRole('button', { name: '确认解除离线保留', exact: true }).click()
    await expect.poll(async () => (await plan(page, id)).retentionReleasedAt).not.toBeNull()
    await expect(detail).toContainText('分集显示上次处理状态')
    expect(existsSync(join(data.directory, '第1集.wav'))).toBe(true)
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setBounds({ width: 720, height: 600 }),
    )
    await detail.scrollIntoViewIfNeeded()
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    )
    await page.screenshot({ path: info.outputPath('offline-plan-detail-720.png') })
  } finally {
    await app.close()
  }
})

test('canceling or closing a pending offline preview suppresses late results without creating a plan or resetting the draft', async ({}, info) => {
  test.skip(
    !!process.env.RALB_EXECUTABLE,
    'Delays IPC delivery only in an isolated copied preview.',
  )
  const data = await fixture(2),
    appRoot = mkdtempSync(join(tmpdir(), '听读 离线预览延迟 '))
  cpSync(resolve(process.env.RALB_APP_ROOT ?? '.', 'out'), join(appRoot, 'out'), {
    recursive: true,
  })
  symlinkSync(resolve('node_modules'), join(appRoot, 'node_modules'), 'junction')
  writeFileSync(
    join(appRoot, 'package.json'),
    JSON.stringify({
      name: 'offline-preview-latency-fixture',
      type: 'module',
      main: './out/main/index.js',
    }),
  )
  const mainPath = join(appRoot, 'out/main/index.js'),
    original = readFileSync(mainPath, 'utf8'),
    marker = '[CHANNELS.offlinePreview]: (request) => service.preview(request)'
  expect(original.includes(marker)).toBe(true)
  const modified = original.replace(
    marker,
    `[CHANNELS.offlinePreview]: async (request) => {
    const result = await service.preview(request);
    globalThis.__offlinePreviewCount = (globalThis.__offlinePreviewCount || 0) + 1;
    if (globalThis.__offlinePreviewCount <= 2)
      await new Promise((resolve) => ipcMain.once('fixture:release-offline-preview', resolve));
    return result;
  }`,
  )
  writeFileSync(mainPath, modified)
  writeFileSync(
    info.outputPath('latency-fixture-scope.json'),
    JSON.stringify(
      {
        sourcePreview: resolve(process.env.RALB_APP_ROOT ?? '.'),
        copiedApp: appRoot,
        originalMainSha256: createHash('sha256').update(original).digest('hex'),
        modifiedMainSha256: createHash('sha256').update(modified).digest('hex'),
        scope:
          'Delay delivery of two real preview results only; IPC validation, preview/catalog checks, cancellation, plan store and player remain real. No model inference or provider response is simulated.',
      },
      null,
      2,
    ),
  )
  const app = await launch(data.root, appRoot)
  try {
    const page = await app.firstWindow()
    let dialog = await open(page, data.book.id)
    await dialog.getByRole('button', { name: '预览离线准备', exact: true }).click()
    await expect
      .poll(() => app.evaluate(() => Reflect.get(globalThis, '__offlinePreviewCount')))
      .toBe(1)
    await dialog.getByRole('button', { name: '取消本次预览', exact: true }).click()
    await expect(dialog.getByRole('button', { name: '预览离线准备', exact: true })).toBeEnabled()
    await dialog
      .getByRole('combobox', { name: '离线计划引擎', exact: true })
      .selectOption('whisperx')
    await dialog.getByRole('combobox', { name: '离线计划设备', exact: true }).selectOption('cuda')
    await dialog.getByRole('spinbutton', { name: '离线音频预算 GiB', exact: true }).fill('8')
    await notify(app)
    await app.evaluate(({ ipcMain }) => {
      ipcMain.emit('fixture:release-offline-preview')
    })
    await expect(dialog.getByRole('combobox', { name: '离线计划引擎', exact: true })).toHaveValue(
      'whisperx',
    )
    await expect(dialog.getByRole('combobox', { name: '离线计划设备', exact: true })).toHaveValue(
      'cuda',
    )
    await expect(
      dialog.getByRole('spinbutton', { name: '离线音频预算 GiB', exact: true }),
    ).toHaveValue('8')
    await expect(dialog.getByRole('region', { name: '离线准备预览', exact: true })).toHaveCount(0)
    expect(await plans(page)).toHaveLength(0)
    await dialog.getByRole('button', { name: '预览离线准备', exact: true }).click()
    await expect
      .poll(() => app.evaluate(() => Reflect.get(globalThis, '__offlinePreviewCount')))
      .toBe(2)
    await dialog.getByRole('button', { name: '关闭离线准备计划', exact: true }).click()
    await app.evaluate(({ ipcMain }) => {
      ipcMain.emit('fixture:release-offline-preview')
    })
    expect(await plans(page)).toHaveLength(0)
    dialog = await open(page, data.book.id)
    await expect(dialog.getByRole('region', { name: '离线准备预览', exact: true })).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: '确认创建离线计划', exact: true })).toHaveCount(
      0,
    )
    await dialog.getByRole('button', { name: '预览离线准备', exact: true }).click()
    await expect(dialog.getByRole('region', { name: '离线准备预览', exact: true })).toContainText(
      '预览 2 集',
    )
    expect(await plans(page)).toHaveLength(0)
  } finally {
    await app
      .evaluate(({ ipcMain }) => {
        ipcMain.emit('fixture:release-offline-preview')
      })
      .catch(() => undefined)
    await app.close()
  }
})
