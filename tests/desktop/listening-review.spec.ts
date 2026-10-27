import { openCompanionTools, closeCompanionPanel, openSubtitleAdvanced } from '../helpers/ui'
import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { cpSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'

// Synthetic sentence text exercises storage and UI only; it is never a human
// reference for the fixture audio, a novel quality score, or engine acceptance.
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), '听读 试听校对 '))
  const store = new LibraryStore(createDataPaths(root).database)
  store.importBook(await scanBook(resolve('tests/fixtures/第32集-伴读样本.wav'), 'file'))
  const book = store.listBooks()[0]!,
    episode = book.episodes[0]!
  store.recordSourceDuration(episode.id, episode.contentHash, 16360)
  store.saveTranscript(episode.id, {
    version: 1,
    audioHash: episode.contentHash,
    kind: 'manual',
    coverage: [{ startMs: 0, endMs: 16360 }],
    segments: Array.from({ length: 10 }, (_, index) => ({
      id: `review-s${index}`,
      startMs: index * 1500 + 100,
      endMs: index * 1500 + 900,
      text: `界面测试段落${index}，不作为音频参考。`,
    })),
  })
  store.close()
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  return {
    root,
    bookId: book.id,
    target: { episodeId: episode.id, audioHash: episode.contentHash },
    env: Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
  }
}
function launch(env: Record<string, string>, appRoot?: string) {
  return electron.launch({
    ...(process.env.RALB_EXECUTABLE
      ? { executablePath: resolve(process.env.RALB_EXECUTABLE), args: [] }
      : { args: [appRoot ?? resolve(process.env.RALB_APP_ROOT ?? '.')] }),
    env,
  })
}
async function reading(page: Page) {
  await page.getByRole('button', { name: '继续播放', exact: true }).click()
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  await openCompanionTools(page)
  await expect(page.getByRole('button', { name: '试听校对', exact: true })).toBeVisible()
}

test('fixed listening review plays real audio, preserves unknown boundaries, persists additions, and freezes old transcript revisions', async ({}, info) => {
  const data = await fixture()
  let app = await launch(data.env)
  try {
    let page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await reading(page)
    await page.getByRole('button', { name: '试听校对', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: '本集试听校对', exact: true })
    await dialog.getByRole('button', { name: '建立本集固定试听样本', exact: true }).click()
    await expect(dialog.getByRole('region', { name: '听审完成情况' })).toContainText(
      '固定 3 段 + 追加 0 段',
    )
    await expect(dialog.getByRole('textbox', { name: '人工参考文字', exact: true })).toHaveCount(0)
    let clip = dialog.locator('audio')
    await expect
      .poll(() => clip.evaluate((audio: HTMLAudioElement) => audio.readyState))
      .toBeGreaterThan(0)
    const initial = await clip.evaluate((audio: HTMLAudioElement) => audio.currentTime)
    await clip.evaluate((audio: HTMLAudioElement) => audio.play())
    await expect
      .poll(() => clip.evaluate((audio: HTMLAudioElement) => audio.currentTime))
      .toBeGreaterThan(initial + 0.1)
    await clip.evaluate((audio: HTMLAudioElement) => audio.pause())
    expect(
      await page
        .locator('audio[data-player="persistent"]')
        .evaluate((audio: HTMLAudioElement) => audio.paused),
    ).toBe(true)
    await dialog.getByRole('checkbox', { name: '我已实际听过这个片段', exact: true }).check()
    await dialog
      .getByRole('combobox', { name: '实际听到的内容', exact: true })
      .selectOption('speech')
    await expect(dialog.getByRole('textbox', { name: '人工参考文字', exact: true })).toHaveValue('')
    await dialog
      .getByRole('textbox', { name: '人工参考文字', exact: true })
      .fill('合成界面测试记录，不作为真实听审参考')
    await dialog
      .getByRole('checkbox', { name: '我已核对目标范围的专名（包括确认没有专名）', exact: true })
      .check()
    await dialog
      .getByRole('combobox', { name: '字幕同步判断', exact: true })
      .selectOption('aligned')
    await expect(
      dialog.getByRole('spinbutton', { name: '人工声音起点（秒）', exact: true }),
    ).toHaveValue('')
    await expect(
      dialog.getByRole('spinbutton', { name: '人工声音终点（秒）', exact: true }),
    ).toHaveValue('')
    await dialog.getByRole('button', { name: '保存本片段校对', exact: true }).click()
    await expect(dialog.getByText('本片段校对已保存。', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('region', { name: '听审完成情况' })).toContainText(
      '人工起止均已标 0/3',
    )
    await dialog.getByRole('button', { name: '关闭试听校对', exact: true }).click()
    await closeCompanionPanel(page)
    await page.locator('.transcript-sentence[data-segment-id="review-s0"]').click()
    await openCompanionTools(page)
    await page.getByRole('button', { name: '试听校对', exact: true }).click()
    await dialog.getByRole('button', { name: '添加当前播放句为额外样本', exact: true }).click()
    await expect(dialog.getByRole('region', { name: '听审完成情况' })).toContainText(
      '固定 3 段 + 追加 1 段',
    )
    await expect(dialog.getByRole('region', { name: '听审完成情况' })).toContainText('参考未知 3')
    await page.screenshot({ path: info.outputPath('listening-review.png'), fullPage: true })
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setBounds({ width: 720, height: 600 }),
    )
    await dialog.locator('audio').scrollIntoViewIfNeeded()
    const layout = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return {
        top: rect.top,
        bottom: rect.bottom,
        height: innerHeight,
        overflow: element.scrollWidth - element.clientWidth,
      }
    })
    expect(layout.top).toBeGreaterThanOrEqual(0)
    expect(layout.bottom).toBeLessThanOrEqual(layout.height)
    expect(layout.overflow).toBeLessThanOrEqual(1)
    await page.screenshot({ path: info.outputPath('listening-review-720x600.png'), fullPage: true })
    await dialog
      .getByRole('button', { name: '保存本片段校对', exact: true })
      .scrollIntoViewIfNeeded()
    await page.screenshot({
      path: info.outputPath('listening-review-720x600-editor.png'),
      fullPage: true,
    })
    const detachedAudio = await dialog.locator('audio').elementHandle()
    await detachedAudio!.evaluate((audio: HTMLAudioElement) => audio.play())
    await dialog.getByRole('button', { name: '关闭试听校对', exact: true }).click()
    expect(await detachedAudio!.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true)
    await detachedAudio!.dispose()
    await app.close()
    app = await launch(data.env)
    page = await app.firstWindow()
    await reading(page)
    await page.getByRole('button', { name: '试听校对', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '本集试听校对', exact: true })
    await expect(dialog.getByRole('region', { name: '听审完成情况' })).toContainText(
      '固定 3 段 + 追加 1 段',
    )
    await expect(dialog.getByRole('textbox', { name: '人工参考文字', exact: true })).toHaveValue(
      '合成界面测试记录，不作为真实听审参考',
    )
    clip = dialog.locator('audio')
    await clip.evaluate((audio: HTMLAudioElement) => audio.play())
    const old = await page.evaluate(async (target) => {
      const saved = await window.desktop.getListeningReview(target)
      if (!saved.ok || !saved.value.review) throw new Error('Missing saved review')
      const document = await window.desktop.getTranscript(target)
      if (!document.ok || document.value.status !== 'ready') throw new Error('Missing transcript')
      const changed = await window.desktop.editTranscript({
        ...target,
        revision: document.value.transcript.revision,
        segmentId: 'review-s0',
        text: '界面测试段落零，不作为音频参考。',
      })
      if (!changed.ok) throw new Error(changed.error.message)
      return saved.value.review.id
    }, data.target)
    await expect(
      dialog.getByText('历史记录保留冻结来源，无法编辑。', { exact: false }),
    ).toBeVisible()
    await expect(dialog.getByRole('button', { name: '保存本片段校对', exact: true })).toBeDisabled()
    await expect.poll(() => clip.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true)
    await dialog.getByRole('button', { name: '建立本集固定试听样本', exact: true }).click()
    await expect(dialog.getByRole('region', { name: '听审完成情况' })).toContainText(
      '固定 3 段 + 追加 0 段',
    )
    await dialog.getByRole('combobox', { name: '试听校对版本', exact: true }).selectOption(old)
    await expect(dialog.getByRole('region', { name: '听审完成情况' })).toContainText(
      '固定 3 段 + 追加 1 段',
    )
    await expect(dialog.getByRole('button', { name: '保存本片段校对', exact: true })).toBeDisabled()
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('same-transcript progress preserves dirty listening notes and cannot supersede an in-flight save', async () => {
  test.skip(
    !!process.env.RALB_EXECUTABLE,
    'Uses a copied preview with controlled IPC latency; packaged runtime is never modified.',
  )
  const data = await fixture()
  const appRoot = mkdtempSync(join(tmpdir(), '听读 校对响应延迟 '))
  cpSync(resolve(process.env.RALB_APP_ROOT ?? '.', 'out'), join(appRoot, 'out'), {
    recursive: true,
  })
  symlinkSync(resolve('node_modules'), join(appRoot, 'node_modules'), 'junction')
  writeFileSync(
    join(appRoot, 'package.json'),
    JSON.stringify({ name: 'review-latency-fixture', type: 'module', main: './out/main/index.js' }),
  )
  const mainPath = join(appRoot, 'out/main/index.js'),
    main = readFileSync(mainPath, 'utf8')
  const original = '[CHANNELS.listeningReviewSave]: (request) => reviews.save(request)'
  expect(main.split(original)).toHaveLength(2)
  // Delay only delivery to the real store. Trusted IPC validation, media checks,
  // CAS, persistence, and playback stay real; no reference or model is fabricated.
  writeFileSync(
    mainPath,
    main.replace(
      original,
      `[CHANNELS.listeningReviewSave]: async (request) => {
    globalThis.__reviewSavePending = true;
    await new Promise((resolve) => ipcMain.once('fixture:release-review-save', resolve));
    globalThis.__reviewSavePending = false;
    return reviews.save(request);
  }`,
    ),
  )
  const app = await launch(data.env, appRoot)
  try {
    const page = await app.firstWindow()
    await reading(page)
    await page.getByRole('button', { name: '试听校对', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '本集试听校对', exact: true })
    await dialog.getByRole('button', { name: '建立本集固定试听样本', exact: true }).click()
    await dialog.getByRole('checkbox', { name: '我已实际听过这个片段', exact: true }).check()
    await dialog
      .getByRole('combobox', { name: '实际听到的内容', exact: true })
      .selectOption('speech')
    const reference = dialog.getByRole('textbox', { name: '人工参考文字', exact: true })
    await reference.fill('未保存的合成界面测试文字')
    await dialog
      .getByRole('textbox', { name: '校对备注', exact: true })
      .fill('保留未保存的人工备注')
    const clip = dialog.locator('audio')
    await clip.evaluate((audio: HTMLAudioElement) => audio.play())
    const before = await clip.evaluate((audio: HTMLAudioElement) => audio.currentTime)
    // Preview progress uses this notification while the formal transcript stays
    // unchanged. Sending the real main→preload event exercises the same reader path.
    await app.evaluate(
      ({ BrowserWindow }, target) =>
        BrowserWindow.getAllWindows()[0]!.webContents.send('transcription:changed', target),
      data.target,
    )
    await expect
      .poll(() => clip.evaluate((audio: HTMLAudioElement) => audio.currentTime))
      .toBeGreaterThan(before + 0.2)
    await expect(reference).toHaveValue('未保存的合成界面测试文字')
    await expect(dialog.getByRole('textbox', { name: '校对备注', exact: true })).toHaveValue(
      '保留未保存的人工备注',
    )
    await dialog.getByRole('button', { name: '保存本片段校对', exact: true }).click()
    await expect
      .poll(() => app.evaluate(() => Reflect.get(globalThis, '__reviewSavePending')))
      .toBe(true)
    await app.evaluate(
      ({ BrowserWindow }, target) =>
        BrowserWindow.getAllWindows()[0]!.webContents.send('transcription:changed', target),
      data.target,
    )
    await expect(dialog.getByRole('button', { name: '正在保存…', exact: true })).toBeDisabled()
    await app.evaluate(({ ipcMain }) => {
      ipcMain.emit('fixture:release-review-save')
    })
    await expect(dialog.getByText('本片段校对已保存。', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '保存本片段校对', exact: true })).toBeEnabled()
    await expect(reference).toHaveValue('未保存的合成界面测试文字')
    const saved = await page.evaluate(
      (target) => window.desktop.getListeningReview(target),
      data.target,
    )
    expect(saved.ok && saved.value.review?.revision).toBe(2)
    expect(saved.ok && saved.value.review?.samples[0]?.entry.notes).toBe('保留未保存的人工备注')
    await clip.evaluate((audio: HTMLAudioElement) => audio.play())
    const changed = await page.evaluate(async (target) => {
      const result = await window.desktop.editTranscript({
        ...target,
        revision: 1,
        segmentId: 'review-s0',
        text: '界面测试段落零，不作为音频参考。',
      })
      if (!result.ok) throw new Error(result.error.message)
    }, data.target)
    expect(changed).toBeUndefined()
    await expect(dialog.getByRole('button', { name: '保存本片段校对', exact: true })).toBeDisabled()
    await expect.poll(() => clip.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true)
    await expect(reference).toHaveValue('未保存的合成界面测试文字')
  } finally {
    await app
      .evaluate(({ ipcMain }) => {
        ipcMain.emit('fixture:release-review-save')
      })
      .catch(() => undefined)
    await app.close()
  }
})

test('engine reference follows device choice without selecting an engine or saving the book profile', async () => {
  const data = await fixture(),
    app = await launch(data.env)
  try {
    const page = await app.firstWindow()
    await reading(page)
    await page.getByRole('button', { name: '字幕与伴读', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '收听工具', exact: true })
    await openSubtitleAdvanced(dialog)
    const engine = dialog.getByRole('combobox', { name: '字幕引擎', exact: true })
    await expect(engine).toHaveValue('')
    await dialog.locator('.engine-reference > summary').click()
    const table = dialog.locator('.engine-reference table')
    await expect(table).toBeVisible()
    await expect(table).toContainText('43.45%')
    await dialog.getByRole('combobox', { name: '字幕设备', exact: true }).selectOption('cuda')
    await expect(table).toContainText('43.82%')
    await expect(table).not.toContainText('43.45%')
    await expect(engine).toHaveValue('')
    await expect(
      dialog.getByRole('button', { name: '保存字幕准备设置', exact: true }),
    ).toBeDisabled()
    await dialog.getByRole('button', { name: '关闭收听工具', exact: true }).click()
    const persisted = await page.evaluate(() => window.desktop.getState())
    expect(
      persisted.ok &&
        persisted.value.books.find((book) => book.id === data.bookId)?.subtitlePreparation,
    ).toBeUndefined()
  } finally {
    await app.close()
  }
})
