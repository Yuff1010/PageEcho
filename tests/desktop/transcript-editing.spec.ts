import { openCompanionProofreading, openCompanionTools } from '../helpers/ui'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import type { TranscriptRequest } from '../../src/shared/transcript'
import { CHANNELS } from '../../src/shared/contracts'

function wave(path: string, marker: number) {
  const wav = Buffer.alloc(44 + 16000 * 16)
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
  wav.writeInt16LE(marker, 44)
  writeFileSync(path, wav)
}
async function fixture(count = 2, segments = 3, skipLast = false, firstText = '王林😀走进大殿。') {
  const root = mkdtempSync(join(tmpdir(), '听读 字幕编辑 ')),
    folder = join(root, '字幕编辑有声书')
  mkdirSync(folder)
  for (let i = 1; i <= count; i++) wave(join(folder, `第${i}集.wav`), i)
  const paths = createDataPaths(root),
    store = new LibraryStore(paths.database)
  store.importBook(await scanBook(folder, 'folder'))
  const book = store.listBooks()[0]!
  store.setSubtitlePreparation(book.id, {
    mode: 'manual',
    engine: 'whisperx',
    device: 'cpu',
    prepareNext: false,
  })
  for (const [episodeIndex, episode] of book.episodes.entries()) {
    store.recordSourceDuration(episode.id, episode.contentHash, 16000)
    if (skipLast && episodeIndex === count - 1) continue
    store.saveTranscript(episode.id, {
      version: 1,
      kind: 'manual',
      audioHash: episode.contentHash,
      coverage: [{ startMs: 0, endMs: 16000 }],
      segments: Array.from({ length: segments }, (_, i) => ({
        id: `editing-s${i}`,
        startMs: segments === 3 ? [100, 2500, 4800][i]! : 100 + i * 250,
        endMs: segments === 3 ? [1900, 4300, 6500][i]! : 200 + i * 250,
        text: i === 0 ? firstText : `王林在第${i + 1}处说话。`,
      })),
    })
  }
  const episode = book.episodes[0]!
  store.saveProgress({
    sessionId: '',
    episodeId: episode.id,
    positionMs: 0,
    durationMs: 16000,
    rate: 1,
    volume: 1,
  })
  store.close()
  return { root, paths, book, target: { episodeId: episode.id, audioHash: episode.contentHash } }
}
function launch(root: string, appRoot?: string) {
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  return electron.launch({
    ...(process.env.RALB_EXECUTABLE
      ? { executablePath: resolve(process.env.RALB_EXECUTABLE), args: [] }
      : { args: [appRoot ?? resolve(process.env.RALB_APP_ROOT ?? '.')] }),
    env,
  })
}
async function read(page: Page) {
  await page.getByRole('button', { name: '继续播放', exact: true }).click()
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  await expect(page.locator('.transcript-sentence').first()).toBeVisible()
  await openCompanionProofreading(page)
}
async function document(page: Page, target: TranscriptRequest) {
  return page.evaluate(async (target) => {
    const result = await window.desktop.getTranscript(target)
    if (!result.ok || result.value.status !== 'ready')
      throw new Error('Expected current formal transcript')
    return result.value.transcript
  }, target)
}
async function editor(page: Page) {
  await openCompanionTools(page)
  await page.getByRole('button', { name: '字幕编辑与撤销', exact: true }).click()
  return page.getByRole('dialog', { name: '字幕编辑', exact: true })
}
async function notification(app: ElectronApplication, target: TranscriptRequest) {
  await app.evaluate(
    ({ BrowserWindow }, { channel, target }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.send(channel, target),
    { channel: CHANNELS.transcriptionChanged, target },
  )
}

test('Unicode split, merge, manual timing and persistent undo/redo keep media coordinates and stop a bounded audition on close', async ({}, info) => {
  const data = await fixture()
  let app = await launch(data.root)
  try {
    let page = await app.firstWindow()
    await read(page)
    const original = await document(page, data.target)
    await openCompanionProofreading(page)
    await page.getByRole('button', { name: '结构编辑第 1 句', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: '字幕编辑', exact: true })
    await dialog.getByRole('button', { name: '拆句', exact: true }).click()
    await expect(dialog.getByRole('spinbutton', { name: '拆句分割毫秒', exact: true })).toHaveValue(
      '',
    )
    await dialog.getByRole('spinbutton', { name: '拆句字符切点', exact: true }).fill('3')
    await dialog.getByRole('spinbutton', { name: '拆句分割毫秒', exact: true }).fill('900')
    await dialog.getByRole('button', { name: '预览字幕修改', exact: true }).click()
    await expect(dialog.locator('.transcript-edit-preview')).toContainText('前句：王林😀')
    expect((await document(page, data.target)).revision).toBe(original.revision)
    await dialog.getByRole('button', { name: '应用字幕修改', exact: true }).click()
    await expect
      .poll(async () => (await document(page, data.target)).document.segments.length)
      .toBe(4)
    const split = await document(page, data.target)
    expect(
      split.document.segments
        .slice(0, 2)
        .map((segment) => ({ text: segment.text, startMs: segment.startMs, endMs: segment.endMs })),
    ).toEqual([
      { text: '王林😀', startMs: 100, endMs: 900 },
      { text: '走进大殿。', startMs: 900, endMs: 1900 },
    ])
    expect(split.document.segments[0]!.id).not.toBe(original.document.segments[0]!.id)
    await dialog.getByRole('button', { name: '合句', exact: true }).click()
    await dialog.getByRole('button', { name: '预览字幕修改', exact: true }).click()
    await dialog.getByRole('button', { name: '应用字幕修改', exact: true }).click()
    await expect
      .poll(async () => (await document(page, data.target)).document.segments.length)
      .toBe(3)
    await dialog.getByRole('button', { name: '撤销字幕修改', exact: true }).click()
    await expect
      .poll(async () => (await document(page, data.target)).document.segments.length)
      .toBe(4)
    await dialog.getByRole('button', { name: '撤销字幕修改', exact: true }).click()
    await expect
      .poll(async () => (await document(page, data.target)).document)
      .toEqual(original.document)
    await dialog.getByRole('button', { name: '重做字幕修改', exact: true }).click()
    await expect
      .poll(async () => (await document(page, data.target)).document)
      .toEqual(split.document)
    await dialog.getByRole('button', { name: '关闭字幕编辑', exact: true }).click()
    await app.close()
    app = await launch(data.root)
    page = await app.firstWindow()
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    dialog = await editor(page)
    await expect(dialog.getByRole('button', { name: '撤销字幕修改', exact: true })).toBeEnabled()
    await dialog.getByRole('button', { name: '撤销字幕修改', exact: true }).click()
    await expect
      .poll(async () => (await document(page, data.target)).document)
      .toEqual(original.document)
    await dialog.getByRole('button', { name: '调整时间', exact: true }).click()
    await dialog.getByRole('spinbutton', { name: '第 1 句起始毫秒', exact: true }).fill('150')
    await dialog.getByRole('spinbutton', { name: '第 1 句结束毫秒', exact: true }).fill('1800')
    await dialog.getByRole('button', { name: '预览字幕修改', exact: true }).click()
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setBounds({ width: 720, height: 600 }),
    )
    await dialog.getByRole('button', { name: '应用字幕修改', exact: true }).scrollIntoViewIfNeeded()
    await expect(dialog.getByRole('button', { name: '应用字幕修改', exact: true })).toBeInViewport()
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    )
    await page.screenshot({
      path: info.outputPath('editing-timing-720.png'),
      animations: 'disabled',
    })
    await dialog.getByRole('button', { name: '应用字幕修改', exact: true }).click()
    await expect
      .poll(async () => (await document(page, data.target)).document.segments[0]!.startMs)
      .toBe(150)
    await dialog.getByRole('button', { name: '撤销字幕修改', exact: true }).click()
    await expect
      .poll(async () => (await document(page, data.target)).document)
      .toEqual(original.document)
    await dialog.getByRole('button', { name: '关闭字幕编辑', exact: true }).click()
    // Reopen playback after restart before the explicit audition; opening the
    // editor itself must not load a new episode or create another audio track.
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    dialog = await editor(page)
    await dialog.getByRole('button', { name: '试听当前字幕范围', exact: true }).click()
    const audio = page.locator('audio[data-player="persistent"]')
    await expect.poll(() => audio.evaluate((value: HTMLAudioElement) => value.paused)).toBe(false)
    await dialog.getByRole('button', { name: '关闭字幕编辑', exact: true }).click()
    await expect.poll(() => audio.evaluate((value: HTMLAudioElement) => value.paused)).toBe(true)
    expect(await page.locator('audio').count()).toBe(1)
  } finally {
    await app.close()
  }
})

test('literal name replacement previews all counts across saved episode pages, skips missing drafts and shows grouped undo conflicts', async ({}, info) => {
  const data = await fixture(101, 52, true),
    app = await launch(data.root)
  try {
    const page = await app.firstWindow()
    await read(page)
    const original = await document(page, data.target),
      dialog = await editor(page)
    await dialog.getByRole('button', { name: '名称批量纠错', exact: true }).click()
    await dialog.getByRole('combobox', { name: '名称替换范围', exact: true }).selectOption('book')
    await dialog.getByRole('button', { name: '下一页分集', exact: true }).click()
    await dialog
      .getByRole('checkbox', { name: `第 101 集 · ${data.book.episodes[100]!.title}`, exact: true })
      .check()
    await dialog.getByRole('textbox', { name: '查找名称', exact: true }).fill('王林')
    await dialog.getByRole('textbox', { name: '替换名称', exact: true }).fill('王琳')
    await dialog.getByRole('button', { name: '预览名称替换', exact: true }).click()
    const preview = dialog.getByRole('region', { name: '名称替换预览', exact: true })
    await expect(preview).toContainText('52 处替换')
    await expect(preview).toContainText('跳过 1 集')
    expect((await document(page, data.target)).document).toEqual(original.document)
    await preview.getByRole('button', { name: '下一页样例', exact: true }).click()
    await expect(preview.locator('ol > li')).toHaveCount(2)
    await dialog.getByRole('button', { name: '勾选本书全部已保存分集', exact: true }).click()
    await expect(preview).toHaveCount(0)
    await dialog.getByRole('button', { name: '预览名称替换', exact: true }).click()
    await expect(preview).toContainText('5200 处替换')
    await expect(preview).toContainText('100 集')
    await expect(preview).toContainText('跳过 1 集')
    await preview.getByRole('button', { name: '应用全部名称替换', exact: true }).click()
    await expect
      .poll(async () => (await document(page, data.target)).document.segments[0]!.text)
      .toContain('王琳')
    const lastReady = data.book.episodes[99]!,
      lastTarget = { episodeId: lastReady.id, audioHash: lastReady.contentHash }
    expect((await document(page, lastTarget)).document.segments[0]!.text).toContain('王琳')
    await expect(dialog.getByRole('region', { name: '字幕编辑历史', exact: true })).toContainText(
      '100 集',
    )
    await dialog.getByRole('button', { name: '撤销字幕修改', exact: true }).click()
    await expect
      .poll(async () => (await document(page, data.target)).document)
      .toEqual(original.document)
    expect((await document(page, lastTarget)).document.segments[0]!.text).toContain('王林')
    await dialog.getByRole('button', { name: '重做字幕修改', exact: true }).click()
    await expect
      .poll(async () => (await document(page, data.target)).document.segments[0]!.text)
      .toContain('王琳')
    const currentLast = await document(page, lastTarget)
    const result = await page.evaluate((request) => window.desktop.changeTranscript(request), {
      ...lastTarget,
      revision: currentLast.revision,
      commandId: randomUUID(),
      operation: {
        kind: 'text' as const,
        segmentId: currentLast.document.segments[0]!.id,
        text: currentLast.document.segments[0]!.text.replace('大殿', '殿门'),
      },
    })
    expect(result.ok).toBe(true)
    await expect(dialog.getByRole('button', { name: '撤销字幕修改', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('region', { name: '字幕编辑历史', exact: true })).toContainText(
      '无法撤销',
    )
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setBounds({ width: 720, height: 600 }),
    )
    await dialog.getByRole('region', { name: '字幕编辑历史', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({
      path: info.outputPath('grouped-history-conflict-720.png'),
      animations: 'disabled',
    })
  } finally {
    await app.close()
  }
})

test('100 supplementary-plane code points survive literal name inputs and replacement while over-limit text is explicitly rejected', async () => {
  const find = '𠮷'.repeat(100),
    replacement = '𠀀'.repeat(100),
    data = await fixture(1, 3, false, `${find}结束。`),
    app = await launch(data.root)
  try {
    const page = await app.firstWindow()
    await read(page)
    const before = await document(page, data.target),
      dialog = await editor(page)
    await dialog.getByRole('button', { name: '名称批量纠错', exact: true }).click()
    const from = dialog.getByRole('textbox', { name: '查找名称', exact: true }),
      to = dialog.getByRole('textbox', { name: '替换名称', exact: true })
    await from.fill('甲'.repeat(101))
    await to.fill('乙')
    await dialog.getByRole('button', { name: '预览名称替换', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('1–100 个 Unicode 字符')
    expect((await document(page, data.target)).document).toEqual(before.document)
    await from.fill(find)
    await to.fill(replacement)
    await expect(from).toHaveValue(find)
    await expect(to).toHaveValue(replacement)
    await dialog.getByRole('button', { name: '预览名称替换', exact: true }).click()
    const preview = dialog.getByRole('region', { name: '名称替换预览', exact: true })
    await expect(preview).toContainText('1 处替换')
    expect((await document(page, data.target)).revision).toBe(before.revision)
    await preview.getByRole('button', { name: '应用全部名称替换', exact: true }).click()
    await expect
      .poll(async () => (await document(page, data.target)).document.segments[0]!.text)
      .toBe(`${replacement}结束。`)
    await dialog.getByRole('button', { name: '撤销字幕修改', exact: true }).click()
    await expect
      .poll(async () => (await document(page, data.target)).document)
      .toEqual(before.document)
  } finally {
    await app.close()
  }
})

test('sentence annotation, small correction and structural editing remain distinct clickable actions at the minimum window size', async ({}, info) => {
  const data = await fixture(),
    app = await launch(data.root)
  try {
    const page = await app.firstWindow()
    await read(page)
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setBounds({ width: 720, height: 600 }),
    )
    const row = page.locator('.transcript-segments > li').first()
    const mark = row.getByRole('button', { name: '标注第 1 句', exact: true }),
      correction = row.getByRole('button', { name: '编辑第 1 句', exact: true }),
      structure = row.getByRole('button', { name: '结构编辑第 1 句', exact: true })
    await mark.scrollIntoViewIfNeeded()
    const bounds = await Promise.all([
      mark.boundingBox(),
      correction.boundingBox(),
      structure.boundingBox(),
    ])
    for (let i = 1; i < bounds.length; i++)
      expect(bounds[i - 1]!.x + bounds[i - 1]!.width).toBeLessThanOrEqual(bounds[i]!.x)
    await mark.click()
    await expect(page.getByRole('dialog', { name: '编辑片段标注', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '取消标注', exact: true }).click()
    await correction.click()
    await expect(row.getByRole('textbox', { name: '纠正这句文字', exact: true })).toBeVisible()
    await row.getByRole('button', { name: '取消纠错', exact: true }).click()
    await structure.click()
    await expect(page.getByRole('dialog', { name: '字幕编辑', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '关闭字幕编辑', exact: true }).click()
    await mark.scrollIntoViewIfNeeded()
    await page.screenshot({
      path: info.outputPath('sentence-actions-720.png'),
      animations: 'disabled',
    })
  } finally {
    await app.close()
  }
})

test('same-revision progress preserves an unsaved edit while a real revision freezes the draft and stops audition', async () => {
  const data = await fixture(),
    app = await launch(data.root)
  try {
    const page = await app.firstWindow()
    await read(page)
    const original = await document(page, data.target),
      dialog = await editor(page),
      text = dialog.getByRole('textbox', { name: '字幕编辑文字', exact: true })
    await text.fill('王琳😀走进大殿。')
    await notification(app, data.target)
    await page.waitForTimeout(200)
    await expect(text).toHaveValue('王琳😀走进大殿。')
    await dialog.getByRole('button', { name: '试听当前字幕范围', exact: true }).click()
    const audio = page.locator('audio[data-player="persistent"]')
    await expect.poll(() => audio.evaluate((value: HTMLAudioElement) => value.paused)).toBe(false)
    const result = await page.evaluate((request) => window.desktop.changeTranscript(request), {
      ...data.target,
      revision: original.revision,
      commandId: randomUUID(),
      operation: {
        kind: 'text' as const,
        segmentId: original.document.segments[0]!.id,
        text: original.document.segments[0]!.text.replace('大殿', '殿门'),
      },
    })
    expect(result.ok).toBe(true)
    await expect(dialog).toContainText('正式文稿已变化，当前草稿保留')
    await expect(text).toHaveValue('王琳😀走进大殿。')
    await expect(text).toBeDisabled()
    await expect.poll(() => audio.evaluate((value: HTMLAudioElement) => value.paused)).toBe(true)
    await dialog.getByRole('button', { name: '载入当前修订并清空草稿', exact: true }).click()
    await expect(text).toBeEnabled()
    await expect(text).toHaveValue('王林😀走进殿门。')
  } finally {
    await app.close()
  }
})

test('a progress notification during an acknowledged edit cannot supersede the successful save response', async ({}, info) => {
  test.skip(!!process.env.RALB_EXECUTABLE, 'Delays delivery only in a disposable copied preview.')
  const data = await fixture(),
    appRoot = mkdtempSync(join(tmpdir(), '听读 字幕保存延迟 '))
  cpSync(resolve(process.env.RALB_APP_ROOT ?? '.', 'out'), join(appRoot, 'out'), {
    recursive: true,
  })
  symlinkSync(resolve('node_modules'), join(appRoot, 'node_modules'), 'junction')
  writeFileSync(
    join(appRoot, 'package.json'),
    JSON.stringify({
      name: 'transcript-edit-latency-fixture',
      type: 'module',
      main: './out/main/index.js',
    }),
  )
  const mainPath = join(appRoot, 'out/main/index.js'),
    original = readFileSync(mainPath, 'utf8'),
    marker = '[CHANNELS.transcriptChange]: (request) => service.change(request)'
  expect(original.includes(marker)).toBe(true)
  const modified = original.replace(
    marker,
    `[CHANNELS.transcriptChange]: async (request) => {
    const result = service.change(request);
    globalThis.__transcriptEditPending = true;
    await new Promise((resolve) => ipcMain.once('fixture:release-transcript-edit', resolve));
    globalThis.__transcriptEditPending = false;
    return result;
  }`,
  )
  writeFileSync(mainPath, modified)
  writeFileSync(
    info.outputPath('latency-fixture-scope.json'),
    JSON.stringify(
      {
        originalMainSha256: createHash('sha256').update(original).digest('hex'),
        modifiedMainSha256: createHash('sha256').update(modified).digest('hex'),
        sourcePreview: resolve(process.env.RALB_APP_ROOT ?? '.'),
        copiedApp: appRoot,
        scope:
          'Only delay delivery after the real edit commits. Real validation, store transaction, history, notifications and playback remain unchanged; no model or reference is fabricated.',
      },
      null,
      2,
    ),
  )
  const app = await launch(data.root, appRoot)
  try {
    const page = await app.firstWindow()
    await read(page)
    const dialog = await editor(page)
    await dialog
      .getByRole('textbox', { name: '字幕编辑文字', exact: true })
      .fill('王琳😀走进大殿。')
    await dialog.getByRole('button', { name: '预览字幕修改', exact: true }).click()
    await dialog.getByRole('button', { name: '应用字幕修改', exact: true }).click()
    await expect
      .poll(() => app.evaluate(() => Reflect.get(globalThis, '__transcriptEditPending')))
      .toBe(true)
    await notification(app, data.target)
    await app.evaluate(({ ipcMain }) => {
      ipcMain.emit('fixture:release-transcript-edit')
    })
    await expect(
      dialog.getByText('字幕修改已保存，可在本面板撤销。', { exact: true }),
    ).toBeVisible()
    await expect(dialog.getByRole('textbox', { name: '字幕编辑文字', exact: true })).toHaveValue(
      '王琳😀走进大殿。',
    )
    await expect(dialog.getByRole('textbox', { name: '字幕编辑文字', exact: true })).toBeEnabled()
    const saved = await document(page, data.target)
    expect(saved.revision).toBe(2)
    const history = await page.evaluate(
      (target) => window.desktop.getTranscriptEditingState(target),
      data.target,
    )
    expect(history.ok && history.value.historyCount).toBe(1)
  } finally {
    await app
      .evaluate(({ ipcMain }) => {
        ipcMain.emit('fixture:release-transcript-edit')
      })
      .catch(() => {})
    await app.close()
  }
})
