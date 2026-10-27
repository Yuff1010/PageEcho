import { test, expect, _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { createDataPaths } from '../../src/main/paths'
import { scanBook } from '../../src/main/files'
import { parseOriginal } from '../../src/main/original/parse'
import { closeOwnedElectron } from '../model/electron-lifecycle'
import { CHANNELS } from '../../src/shared/contracts'
import { useOriginalText, openOriginalTools, openCompanionTools, menuAction } from '../helpers/ui'

async function fixture(linked = true, duplicate = false, transcript = true) {
  const root = mkdtempSync(join(tmpdir(), '听读关联 '))
  const folder = join(root, '山间来信')
  mkdirSync(folder)
  for (let i = 1; i <= 2; i++) {
    const wav = Buffer.alloc(44 + 16000 * 10)
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
    wav[wav.length - 1] = i
    writeFileSync(join(folder, `第${i}集.wav`), wav)
  }
  const store = new LibraryStore(createDataPaths(root).database)
  store.importBook(await scanBook(folder, 'folder'))
  const book = store.listBooks()[0]!
  const parsed = parseOriginal(
    Buffer.from(
      '第1章 山路\n' +
        Array.from({ length: 90 }, (_, i) => `第${i}封信从山间寄来，清晨的风穿过树梢。`).join('\n'),
    ),
    '山间来信.txt',
  )
  const ebook = store.reading.import(parsed)
  store.reading.savePosition(ebook.id, 12)
  if (linked) store.bookLinks.link({ bookId: book.id, readingBookId: ebook.id })
  for (const [i, episode] of book.episodes.entries()) {
    store.saveProgress({
      sessionId: '',
      episodeId: episode.id,
      positionMs: 1500,
      durationMs: 10000,
      rate: 1,
      volume: 0,
    })
    if (transcript) {
      const ordinal = duplicate ? 1 : i + 1
      const text = parsed.sentences[ordinal]!.text
      store.saveTranscript(episode.id, {
        version: 1,
        kind: 'manual',
        audioHash: episode.contentHash,
        coverage: [{ startMs: 0, endMs: 10000 }],
        segments: [{ id: 's0', startMs: 1000, endMs: 3000, text }],
      })
      if (linked) {
        const saved = store.getTranscript(episode.id, episode.contentHash)
        if (saved.status !== 'ready') throw new Error('missing fixture transcript')
        store.originals.saveAlignment(
          { episodeId: episode.id, audioHash: episode.contentHash },
          ebook.id,
          saved.transcript.id,
          saved.transcript.revision,
          0,
          [
            {
              segmentId: 's0',
              startMs: 1000,
              endMs: 3000,
              asrText: text,
              candidates: [],
              selected: { first: ordinal, last: ordinal, method: 'auto' },
              reviewed: false,
            },
          ],
        )
      }
    }
  }
  store.saveProgress({
    sessionId: '',
    episodeId: book.episodes[0]!.id,
    positionMs: 1500,
    durationMs: 10000,
    rate: 1,
    volume: 0,
  })
  store.close()
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
  const page = await app.firstWindow()
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
  return { app, page, book, ebook }
}

test('an existing ebook can be explicitly linked and detached without removing either shelf item', async () => {
  const { app, page, book, ebook } = await fixture(false)
  try {
    await page.getByRole('button', { name: '打开 山间来信 的目录', exact: true }).click()
    await page.getByRole('button', { name: '关联电子书', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '关联有声书与电子书' })
    await dialog.getByRole('combobox', { name: '关联电子书', exact: true }).selectOption(ebook.id)
    await dialog.getByRole('button', { name: '关联并用于伴读' }).click()
    await expect(dialog).toBeHidden()
    const links = await page.evaluate(() => window.desktop.getBookLinks())
    expect(links.ok && links.value[0]?.audioBookId).toBe(book.id)
    await page.getByRole('button', { name: '管理电子书关联', exact: true }).click()
    await dialog.getByRole('button', { name: '解除原文关联' }).click()
    await expect(dialog).toBeHidden()
    const data = await page.evaluate(async () => ({
      books: await window.desktop.getState(),
      ebooks: await window.desktop.getReadingBooks(),
      links: await window.desktop.getBookLinks(),
    }))
    expect(data.books.ok && data.books.value.books.length).toBe(1)
    expect(data.ebooks.ok && data.ebooks.value[0]?.position).toBe(12)
    expect(data.links.ok && data.links.value).toEqual([])
  } finally {
    await closeOwnedElectron(app)
  }
})

test('listening and reading switch at a valid mapped location and the listen action starts paused media', async ({}, info) => {
  const { app, page } = await fixture()
  try {
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    await page.getByRole('button', { name: '从当前进度阅读', exact: true }).click()
    await expect(page.locator('.reader-progress-label')).toHaveAttribute('data-position', '1')
    await page.mouse.move(80, 15)
    await expect(page.getByRole('button', { name: '从此处听书', exact: true })).toBeVisible()
    await page.screenshot({ path: info.outputPath('linked-reader.png'), animations: 'disabled' })
    await page.locator('audio').evaluate((audio: HTMLAudioElement) => {
      audio.addEventListener('seeked', () =>
        Reflect.set(audio, 'linkedListeningSeek', audio.currentTime),
      )
    })
    await page.getByRole('button', { name: '从此处听书', exact: true }).click()
    await expect(page).toHaveURL(/#\/listening$/)
    await expect
      .poll(() =>
        page
          .locator('audio')
          .evaluate((audio: HTMLAudioElement) => Reflect.get(audio, 'linkedListeningSeek')),
      )
      .toBeCloseTo(1, 1)
    expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(
      false,
    )
    await expect(page.locator('.companion-page')).toHaveAttribute('data-source', 'original')
  } finally {
    await closeOwnedElectron(app)
  }
})

test('unmapped text retains reading and playback positions and can close the choice without trapping navigation', async () => {
  const { app, page, ebook } = await fixture()
  try {
    await page.evaluate((id) => {
      location.hash = `/read/${id}`
    }, ebook.id)
    await expect(page.locator('.book-viewport')).toHaveAttribute('aria-busy', 'false')
    await page.locator('.book-viewport').press('Control+End')
    await expect(page.locator('.reader-progress-label')).toHaveAttribute('data-position', '89')
    const before = await page
      .locator('audio')
      .evaluate((audio: HTMLAudioElement) => audio.currentTime)
    await page.mouse.move(80, 15)
    await page.getByRole('button', { name: '从此处听书', exact: true }).click()
    const choice = page.getByRole('dialog', { name: '选择对应的声音位置' })
    await expect(choice).toContainText('这段文字还没有声音同步点')
    await choice.getByRole('button', { name: '继续阅读', exact: true }).click()
    expect(
      await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime),
    ).toBe(before)
    await page.mouse.move(80, 15)
    await page.getByRole('button', { name: '返回阅读书架', exact: true }).click()
    await expect(page).toHaveURL(/#\/library\/ebooks$/)
  } finally {
    await closeOwnedElectron(app)
  }
})

test('multiple audio positions are presented for an explicit choice', async () => {
  const { app, page, ebook } = await fixture(true, true)
  try {
    await page.evaluate((id) => {
      location.hash = `/read/${id}`
    }, ebook.id)
    await expect(page.locator('.book-viewport')).toHaveAttribute('aria-busy', 'false')
    await page.locator('.book-viewport').press('Control+Home')
    await page.mouse.move(80, 15)
    await page.getByRole('slider', { name: '阅读进度', exact: true }).fill('1')
    await page.getByRole('slider', { name: '阅读进度', exact: true }).dispatchEvent('pointerup')
    await expect(page.locator('.reader-progress-label')).toHaveAttribute('data-position', '1')
    await page.mouse.move(80, 15)
    await page.getByRole('button', { name: '从此处听书', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '选择对应的声音位置' })
    await expect(dialog).toContainText('这段文字对应多个声音位置')
    await dialog.getByRole('button', { name: /第2集/ }).click()
    await expect(page.locator('.companion-title')).toContainText('第2集')
  } finally {
    await closeOwnedElectron(app)
  }
})

test('quick subtitle setup uses a checked CPU capability and reports a start failure without changing the book', async () => {
  const { app, page, book } = await fixture(false, false, false)
  try {
    await app.evaluate(({ ipcMain, BrowserWindow }, channels) => {
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
        string,
        (...args: unknown[]) => unknown
      >
      handlers.set(channels.detectTranscriptionComponents, () => ({
        ok: true,
        value: {
          configured: true,
          currentDirectory: 'C:/fixture-component',
          candidates: [],
          check: {
            ready: true,
            checkedAt: new Date().toISOString(),
            pythonVersion: '3.12',
            cudaName: null,
            freeBytes: null,
            issues: [],
            level: 'imports-and-files',
            capabilities: [
              { engine: 'paraformer', device: 'cpu', available: true, message: 'ready' },
            ],
          },
        },
      }))
      handlers.set(channels.prepareAndStartTranscription, (_event, request) => {
        Reflect.set(globalThis, 'quickSubtitleRequest', request)
        return { ok: false, error: { code: 'INTERNAL', message: '受控字幕启动失败，可重试。' } }
      })
      BrowserWindow.getAllWindows()[0]!.webContents.send(channels.componentChanged)
    }, CHANNELS)
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    await openCompanionTools(page)
    await page.locator('.transcription-controls > details > summary').click()
    await page.getByRole('button', { name: '使用可用配置开始生成', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('受控字幕启动失败')
    const request = await app.evaluate(() => Reflect.get(globalThis, 'quickSubtitleRequest'))
    expect(request.settings).toEqual({
      mode: 'auto',
      engine: 'paraformer',
      device: 'cpu',
      prepareNext: false,
    })
    const state = await page.evaluate(() => window.desktop.getState())
    expect(
      state.ok && state.value.books.find((item) => item.id === book.id)?.subtitlePreparation,
    ).toBeUndefined()
  } finally {
    await closeOwnedElectron(app)
  }
})

test('a choice is revalidated after the book was detached while the dialog was open', async () => {
  const { app, page, book, ebook } = await fixture(true, true)
  try {
    await page.evaluate((id) => {
      location.hash = `/read/${id}`
    }, ebook.id)
    await expect(page.locator('.book-viewport')).toHaveAttribute('aria-busy', 'false')
    await page.mouse.move(80, 15)
    await page.getByRole('slider', { name: '阅读进度', exact: true }).fill('1')
    await page.getByRole('slider', { name: '阅读进度', exact: true }).dispatchEvent('pointerup')
    await expect(page.locator('.reader-progress-label')).toHaveAttribute('data-position', '1')
    await page.getByRole('button', { name: '从此处听书', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '选择对应的声音位置' })
    await expect(dialog).toContainText('这段文字对应多个声音位置')
    const before = await page
      .locator('audio')
      .evaluate((audio: HTMLAudioElement) => audio.currentTime)
    const removed = await page.evaluate(
      (bookId) => window.desktop.unlinkReadingBook({ bookId }),
      book.id,
    )
    expect(removed.ok).toBe(true)
    await dialog.getByRole('button', { name: /第2集/ }).click()
    await expect(dialog).toContainText('这段文字还没有声音同步点')
    expect(
      await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime),
    ).toBe(before)
    await dialog.getByRole('button', { name: '继续阅读' }).click()
  } finally {
    await closeOwnedElectron(app)
  }
})

test('unmatched original audio shows its actual transcript and supports filtering unresolved corrections', async ({}, info) => {
  const { app, page, book } = await fixture()
  try {
    const episode = book.episodes[0]!
    const result = await page.evaluate(
      async (target) => {
        const original = await window.desktop.getOriginalState(target)
        if (!original.ok || !original.value.info || !original.value.alignment)
          throw new Error('missing mapping')
        return window.desktop.correctOriginal({
          ...target,
          originalId: original.value.info.id,
          revision: original.value.alignment.revision,
          segmentId: 's0',
          selection: null,
          startMs: 1000,
          endMs: 3000,
        })
      },
      { episodeId: episode.id, audioHash: episode.contentHash },
    )
    expect(result.ok).toBe(true)
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    await useOriginalText(page)
    const fallback = page.getByLabel('当前声音的转写字幕', { exact: true })
    await expect(fallback).toContainText('第1封信从山间寄来')
    await expect(page.locator('.original-sentence[aria-current="true"]')).toHaveCount(0)
    await page.screenshot({
      path: info.outputPath('unmatched-transcript-fallback.png'),
      animations: 'disabled',
    })
    await fallback.getByRole('button', { name: '查看转写字幕' }).click()
    await expect(page.locator('.companion-page')).toHaveAttribute('data-source', 'transcript')
    await useOriginalText(page)
    await openOriginalTools(page)
    await page.locator('.original-review > summary').click()
    await page.getByRole('combobox', { name: '筛选原文校正片段' }).selectOption('unmatched')
    await expect(page.locator('.original-review > article')).toHaveCount(1)
    await expect(page.locator('.original-review > article')).toContainText('人工保留空缺')
  } finally {
    await closeOwnedElectron(app)
  }
})

test('a delayed reading switch is canceled after the playing episode changes', async () => {
  const { app, page } = await fixture()
  try {
    await app.evaluate(({ ipcMain }, channel) => {
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
        string,
        (...args: unknown[]) => unknown
      >
      const original = handlers.get(channel)!
      let first = true
      handlers.set(channel, async (...args) => {
        if (!first) return original(...args)
        first = false
        await new Promise<void>((resolve) =>
          Reflect.set(globalThis, 'releaseReadingSwitch', resolve),
        )
        const result = await original(...args)
        Reflect.set(globalThis, 'readingSwitchReleased', true)
        return result
      })
    }, CHANNELS.originalState)
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    await page.getByRole('button', { name: '从当前进度阅读', exact: true }).click()
    await expect
      .poll(() => app.evaluate(() => typeof Reflect.get(globalThis, 'releaseReadingSwitch')))
      .toBe('function')
    await menuAction(page, '播放选项', '下一集')
    await expect(page.locator('.companion-title')).toContainText('第2集')
    await app.evaluate(() => (Reflect.get(globalThis, 'releaseReadingSwitch') as () => void)())
    await expect
      .poll(() => app.evaluate(() => Reflect.get(globalThis, 'readingSwitchReleased')))
      .toBe(true)
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    await expect(page).toHaveURL(/#\/listening$/)
    await expect(page.locator('.ebook-reader-page')).toHaveCount(0)
  } finally {
    await app
      .evaluate(() => {
        const release = Reflect.get(globalThis, 'releaseReadingSwitch')
        if (typeof release === 'function') release()
      })
      .catch(() => {})
    await closeOwnedElectron(app)
  }
})
