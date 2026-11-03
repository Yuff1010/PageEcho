import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { parseOriginal } from '../../src/main/original/parse'
import { createDataPaths } from '../../src/main/paths'
import { CHANNELS } from '../../src/shared/contracts'
import { menuAction, openCompanionProofreading, openCompanionTools } from '../helpers/ui'
import { closeOwnedElectron } from '../model/electron-lifecycle'

function audio(path: string, marker: number) {
  const bytes = Buffer.alloc(44 + 16000)
  bytes.write('RIFF')
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(8000, 24)
  bytes.writeUInt32LE(16000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(16000, 40)
  bytes.writeInt16LE(marker, 44)
  writeFileSync(path, bytes)
}

async function launch(root: string) {
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  return electron.launch({
    ...(process.env.RALB_EXECUTABLE
      ? { executablePath: resolve(process.env.RALB_EXECUTABLE), args: [] }
      : { args: [resolve(process.env.RALB_APP_ROOT ?? '.')] }),
    env,
  })
}

async function protectWholeLibraryReads(app: ElectronApplication) {
  await app.evaluate(
    ({ ipcMain }, channels) => {
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
        string,
        (...args: unknown[]) => unknown
      >
      const rejected: string[] = []
      Reflect.set(globalThis, 'overviewConsumerRejectedReads', rejected)
      for (const channel of channels)
        handlers.set(channel, () => {
          rejected.push(channel)
          return { ok: false, error: { code: 'INTERNAL', message: '该流程不应读取整库。' } }
        })
    },
    [CHANNELS.getState, CHANNELS.bookDetail],
  )
}

test('offline selections read bounded real pages and discard a late page after changing books', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pageecho overview consumers ')),
    paths = createDataPaths(root),
    store = new LibraryStore(paths.database)
  const books = []
  for (const [name, count] of [
    ['长目录', 201],
    ['短目录', 3],
  ] as const) {
    const directory = join(root, name)
    mkdirSync(directory)
    for (let index = 1; index <= count; index++) audio(join(directory, `第${index}集.wav`), index)
    store.importBook(await scanBook(directory, 'folder'))
    books.push(store.listBooks().find((book) => book.title === name)!)
  }
  store.close()
  const [long, short] = books
  if (!long || !short) throw new Error('Synthetic books missing')
  const app = await launch(root)
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '选择音频文件', exact: true })).toBeEnabled()
    await protectWholeLibraryReads(app)
    await app.evaluate(({ ipcMain }, channel) => {
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
          string,
          (...args: unknown[]) => unknown
        >,
        original = handlers.get(channel)!
      let held = false
      const calls: unknown[] = []
      Reflect.set(globalThis, 'overviewConsumerPageCalls', calls)
      handlers.set(channel, async (...args) => {
        const input = args[1] as { id: string; offset: number; limit: number }
        calls.push({ ...input })
        const result = await original(...args)
        if (input.offset === 100 && !held) {
          held = true
          await new Promise<void>((done) =>
            Reflect.set(globalThis, 'releaseOverviewConsumerPage', done),
          )
        }
        return result
      })
    }, CHANNELS.bookEpisodes)
    await menuAction(page, '应用设置', '离线准备计划')
    const dialog = page.getByRole('dialog', { name: '离线准备计划', exact: true })
    await dialog.getByRole('tab', { name: '新建计划', exact: true }).click()
    await dialog.getByRole('combobox', { name: '离线准备书籍', exact: true }).selectOption(long.id)
    await dialog
      .getByRole('combobox', { name: '离线准备范围', exact: true })
      .selectOption('selected')
    const choices = dialog.locator('.offline-episode-choices input[type="checkbox"]')
    await expect(choices).toHaveCount(100)
    await choices.first().check()
    await dialog.getByRole('button', { name: '下一页选集', exact: true }).click()
    await expect
      .poll(() => app.evaluate(() => typeof Reflect.get(globalThis, 'releaseOverviewConsumerPage')))
      .toBe('function')
    await dialog.getByRole('combobox', { name: '离线准备书籍', exact: true }).selectOption(short.id)
    await expect(choices).toHaveCount(3)
    await expect(dialog.locator('.offline-episode-choices')).toContainText('第 1 集 · 第1集')
    await app.evaluate(() =>
      (Reflect.get(globalThis, 'releaseOverviewConsumerPage') as () => void)(),
    )
    await expect(choices).toHaveCount(3)
    await expect(dialog.locator('.offline-episode-choices')).not.toContainText('第101集')
    await dialog.getByRole('combobox', { name: '离线准备书籍', exact: true }).selectOption(long.id)
    await expect(choices).toHaveCount(100)
    await choices.first().check()
    await dialog.getByRole('button', { name: '下一页选集', exact: true }).click()
    await expect(choices).toHaveCount(100)
    await expect(dialog.locator('.offline-episode-choices')).toContainText('第 101 集 · 第101集')
    await choices.first().check()
    await dialog.getByRole('button', { name: '上一页选集', exact: true }).click()
    await expect(choices.first()).toBeChecked()
    await expect(dialog).toContainText('已选择 2 集')
    const calls = await app.evaluate(
      () =>
        Reflect.get(globalThis, 'overviewConsumerPageCalls') as {
          id: string
          offset: number
          limit: number
        }[],
    )
    expect(calls.some((call) => call.id === long.id && call.offset === 100)).toBe(true)
    expect(calls.every((call) => call.limit === 100 && call.offset % 100 === 0)).toBe(true)
    expect(
      await app.evaluate(() => Reflect.get(globalThis, 'overviewConsumerRejectedReads')),
    ).toEqual([])
  } finally {
    await app
      .evaluate(() =>
        (Reflect.get(globalThis, 'releaseOverviewConsumerPage') as (() => void) | undefined)?.(),
      )
      .catch(() => undefined)
    await closeOwnedElectron(app)
  }
})

test('opening a reader asks for only that ebook and missing books retain both exits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pageecho targeted reader ')),
    paths = createDataPaths(root),
    store = new LibraryStore(paths.database)
  const book = store.reading.import(
    parseOriginal(Buffer.from('第1章 清晨\n山间的钟声响起。\n少年走向远方。'), '单本阅读.txt'),
  )
  store.reading.import(parseOriginal(Buffer.from('第1章 远山\n另一本书的内容。'), '无需读取.txt'))
  store.close()
  const app = await launch(root)
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '选择音频文件', exact: true })).toBeEnabled()
    await protectWholeLibraryReads(app)
    await app.evaluate(
      ({ ipcMain }, channels) => {
        const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
            string,
            (...args: unknown[]) => unknown
          >,
          original = handlers.get(channels.one)!,
          calls: string[] = []
        Reflect.set(globalThis, 'targetedReaderCalls', calls)
        handlers.set(channels.list, () => {
          throw new Error('Opening one reader must not request the ebook shelf')
        })
        handlers.set(channels.one, (...args) => {
          calls.push((args[1] as { id: string }).id)
          return original(...args)
        })
      },
      { one: CHANNELS.readingBook, list: CHANNELS.readingList },
    )
    await page.evaluate((id) => {
      location.hash = `#/read/${id}`
    }, book.id)
    await expect(page.getByRole('region', { name: '电子书正文', exact: true })).toHaveAttribute(
      'aria-busy',
      'false',
    )
    await expect(page.getByRole('region', { name: '电子书正文', exact: true })).toContainText(
      '山间的钟声响起',
    )
    const missing = '00000000-0000-4000-8000-000000000099'
    await page.evaluate((id) => {
      location.hash = `#/read/${id}`
    }, missing)
    await expect(page.getByRole('alert')).toContainText('已移除')
    await expect(page.getByRole('button', { name: '返回阅读书架', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '有声书书架', exact: true })).toBeVisible()
    expect(await app.evaluate(() => Reflect.get(globalThis, 'targetedReaderCalls'))).toEqual([
      book.id,
      missing,
    ])
    expect(
      await app.evaluate(() => Reflect.get(globalThis, 'overviewConsumerRejectedReads')),
    ).toEqual([])
  } finally {
    await closeOwnedElectron(app)
  }
})

test('whole-book editing waits for a real on-demand detail instead of using the shelf summary as a chapter list', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pageecho on demand editing ')),
    folder = join(root, '完整纠错目录'),
    paths = createDataPaths(root)
  mkdirSync(folder)
  for (let index = 1; index <= 2; index++) audio(join(folder, `第${index}集.wav`), index)
  const store = new LibraryStore(paths.database)
  store.importBook(await scanBook(folder, 'folder'))
  const book = store.listBooks()[0]!,
    episode = book.episodes[0]!
  store.setSubtitlePreparation(book.id, {
    mode: 'manual',
    engine: 'whisperx',
    device: 'cpu',
    prepareNext: false,
  })
  store.recordSourceDuration(episode.id, episode.contentHash, 1000)
  store.saveTranscript(episode.id, {
    version: 1,
    kind: 'manual',
    audioHash: episode.contentHash,
    coverage: [{ startMs: 0, endMs: 1000 }],
    segments: [{ id: 's1', startMs: 0, endMs: 900, text: '王林走进山间。' }],
  })
  store.saveProgress({
    sessionId: '',
    episodeId: episode.id,
    positionMs: 0,
    durationMs: 1000,
    rate: 1,
    volume: 1,
  })
  store.close()
  const app = await launch(root)
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '伴读阅读', exact: true })).toBeEnabled()
    await app.evaluate(
      ({ ipcMain }, channels) => {
        const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
            string,
            (...args: unknown[]) => unknown
          >,
          detail = handlers.get(channels.detail)!,
          calls: string[] = []
        Reflect.set(globalThis, 'editorDetailCalls', calls)
        handlers.set(channels.state, () => {
          throw new Error('Editing must not read the full library')
        })
        handlers.set(channels.detail, async (...args) => {
          calls.push((args[1] as { id: string }).id)
          const result = await detail(...args)
          await new Promise<void>((done) =>
            Reflect.set(globalThis, 'releaseEditorBookDetail', done),
          )
          return result
        })
      },
      { detail: CHANNELS.bookDetail, state: CHANNELS.getState },
    )
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    await openCompanionProofreading(page)
    await expect(page.locator('.transcript-sentence').first()).toBeVisible()
    expect(await app.evaluate(() => Reflect.get(globalThis, 'editorDetailCalls'))).toEqual([])
    await openCompanionTools(page)
    await page.getByRole('button', { name: '字幕编辑与撤销', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '字幕编辑', exact: true })
    await dialog.getByRole('button', { name: '名称批量纠错', exact: true }).click()
    const scope = dialog.getByRole('combobox', { name: '名称替换范围', exact: true })
    await expect(scope.locator('option[value="book"]')).toHaveAttribute('disabled', '')
    await expect(
      dialog.getByText('正在读取完整目录，整书纠错就绪后可选。', { exact: true }),
    ).toBeVisible()
    await expect
      .poll(() => app.evaluate(() => typeof Reflect.get(globalThis, 'releaseEditorBookDetail')))
      .toBe('function')
    await app.evaluate(() => (Reflect.get(globalThis, 'releaseEditorBookDetail') as () => void)())
    await expect(scope.locator('option[value="book"]')).not.toHaveAttribute('disabled')
    await scope.selectOption('book')
    await expect(
      dialog.locator('.transcript-edit-book-choices input[type="checkbox"]'),
    ).toHaveCount(2)
    expect(await app.evaluate(() => Reflect.get(globalThis, 'editorDetailCalls'))).toEqual([
      book.id,
    ])
  } finally {
    await app
      .evaluate(() =>
        (Reflect.get(globalThis, 'releaseEditorBookDetail') as (() => void) | undefined)?.(),
      )
      .catch(() => undefined)
    await closeOwnedElectron(app)
  }
})
