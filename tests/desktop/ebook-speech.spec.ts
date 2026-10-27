import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { createDataPaths } from '../../src/main/paths'
import { parseOriginal } from '../../src/main/original/parse'
import { closeOwnedElectron } from '../model/electron-lifecycle'
import { zip, epub } from '../fixtures/original-epub'
import { scanBook } from '../../src/main/files'

test.skip(process.platform !== 'win32', 'Uses the actual installed Windows offline voices.')

async function fixture(format: 'txt' | 'epub' = 'txt', withRecordedAudio = false) {
  const root = mkdtempSync(join(tmpdir(), '电子书 实际朗读 '))
  const store = new LibraryStore(createDataPaths(root).database)
  const book = store.reading.import(
    parseOriginal(
      format === 'epub'
        ? zip(epub)
        : Buffer.from(
            '第一章 山间来信\n' +
              Array.from(
                { length: 80 },
                (_, index) =>
                  `第${index}封信从山间寄来，清晨的风穿过树梢，我们一起听见远处传来熟悉的声音。`,
              ).join('\n'),
          ),
      format === 'epub' ? '阅读顺序.epub' : '山间来信.txt',
    ),
  )
  store.reading.savePosition(book.id, format === 'epub' ? 0 : 1)
  if (withRecordedAudio) {
    const wav = Buffer.alloc(44 + 16000 * 30)
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
    const audio = join(root, '已有录音.wav')
    writeFileSync(audio, wav)
    store.importBook(await scanBook(audio, 'file'))
  }
  store.close()
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
  try {
    const page = await app.firstWindow()
    await page
      .getByRole('navigation', { name: '书籍类型', exact: true })
      .getByRole('button', { name: '电子书', exact: true })
      .click()
    return { app, page, book }
  } catch (error) {
    await closeOwnedElectron(app)
    throw error
  }
}

test('a plain ebook opens silently, then real Windows speech plays the current text with pause, voice, speed and stop controls', async ({}, info) => {
  const { app, page, book } = await fixture()
  try {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.getByRole('button', { name: `阅读 ${book.title}`, exact: true }).click()
    const reader = page.getByRole('main', { name: '独立阅读页' })
    await expect(reader).toHaveAttribute('data-speech-status', 'idle')
    await page
      .getByRole('region', { name: '电子书正文', exact: true })
      .hover({ position: { x: 5, y: 5 } })
    await page.mouse.move(300, 20)
    await reader.getByRole('button', { name: '朗读电子书', exact: true }).click()
    await expect(reader).toHaveAttribute('data-speech-status', 'playing', { timeout: 20000 })
    const controls = page.getByRole('complementary', { name: '电子书朗读', exact: true })
    await expect(controls.getByRole('status')).toContainText('正在朗读原文')
    await expect(page.locator('[data-speech-current="true"]')).toHaveAttribute('data-sentence', '1')
    await expect(
      controls.getByRole('combobox', { name: '电子书朗读声音', exact: true }),
    ).toContainText('Microsoft Huihui Desktop')
    await controls.getByRole('button', { name: '暂停电子书朗读', exact: true }).click()
    await expect(reader).toHaveAttribute('data-speech-status', 'paused')
    await controls
      .getByRole('combobox', { name: '电子书朗读语速', exact: true })
      .selectOption('1.5')
    await controls.getByRole('button', { name: '继续电子书朗读', exact: true }).click()
    await expect(reader).toHaveAttribute('data-speech-status', 'playing')
    const voice = controls.getByRole('combobox', { name: '电子书朗读声音', exact: true })
    await voice.selectOption('Microsoft Zira Desktop')
    await expect(reader).toHaveAttribute('data-speech-status', 'playing', { timeout: 20000 })
    await expect(voice).toHaveValue('Microsoft Zira Desktop')
    await voice.selectOption('Microsoft Huihui Desktop')
    await expect(reader).toHaveAttribute('data-speech-status', 'playing', { timeout: 20000 })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 600))
    await expect(
      controls.getByRole('button', { name: '停止电子书朗读', exact: true }),
    ).toBeInViewport()
    await page.screenshot({
      path: info.outputPath('real-ebook-speech-small.png'),
      animations: 'disabled',
    })
    await controls.getByRole('button', { name: '停止电子书朗读', exact: true }).click()
    await expect(reader).toHaveAttribute('data-speech-status', 'idle')
    const state = await page.evaluate(() => window.desktop.getReadingBooks())
    expect(state.ok && state.value.find((item) => item.id === book.id)?.position).toBe(1)
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
  }
})

test('the shelf narration action starts real speech and manual progress movement pauses it before continuing at the new text', async () => {
  const { app, page, book } = await fixture()
  try {
    await page.getByRole('button', { name: `更多 ${book.title} 的操作`, exact: true }).click()
    await page.getByRole('menuitem', { name: '朗读电子书', exact: true }).click()
    const reader = page.getByRole('main', { name: '独立阅读页' })
    await expect(reader).toHaveAttribute('data-speech-status', 'playing', { timeout: 20000 })
    await page.mouse.move(400, 580)
    const progress = page.getByRole('slider', { name: '阅读进度', exact: true })
    await progress.fill('40')
    await progress.dispatchEvent('pointerup')
    await expect(reader).toHaveAttribute('data-speech-status', 'paused')
    const controls = page.getByRole('complementary', { name: '电子书朗读', exact: true })
    await controls.getByRole('button', { name: '继续电子书朗读', exact: true }).click()
    await expect(reader).toHaveAttribute('data-speech-status', 'playing', { timeout: 20000 })
    await expect(page.locator('[data-speech-current="true"]')).toHaveAttribute(
      'data-sentence',
      '40',
    )
    await page.mouse.move(300, 20)
    await page.getByRole('button', { name: '返回阅读书架', exact: true }).click()
    await expect(reader).toHaveCount(0)
    await page.getByRole('button', { name: `阅读 ${book.title}`, exact: true }).click()
    await expect(page.getByRole('main', { name: '独立阅读页' })).toHaveAttribute(
      'data-speech-status',
      'idle',
    )
  } finally {
    await closeOwnedElectron(app)
  }
})

test('an EPUB uses its actual spine text for real Windows audio and follows the matching sentence without ASR', async () => {
  const { app, page, book } = await fixture('epub')
  try {
    expect(book.format).toBe('epub')
    await page.getByRole('button', { name: `更多 ${book.title} 的操作`, exact: true }).click()
    await page.getByRole('menuitem', { name: '朗读电子书', exact: true }).click()
    const reader = page.getByRole('main', { name: '独立阅读页' })
    await expect(reader).toHaveAttribute('data-speech-status', 'playing', { timeout: 20000 })
    const spoken = page.locator('[data-speech-current="true"]')
    await expect(spoken).toHaveAttribute('data-sentence', '0')
    await expect(spoken).toHaveText('这是阅读顺序中的第一段正文。')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 600))
    await expect(spoken).toHaveAttribute('data-sentence', '1', { timeout: 20000 })
    await expect(spoken).toHaveText('这是书中的第二段正文。')
    await expect(spoken).toBeInViewport()
    await expect
      .poll(async () => {
        const state = await page.evaluate(() => window.desktop.getReadingBooks())
        return state.ok && state.value.find((item) => item.id === book.id)?.position
      })
      .toBe(1)
    const controls = page.getByRole('complementary', { name: '电子书朗读', exact: true })
    await controls.getByRole('button', { name: '停止电子书朗读', exact: true }).click()
    const generated = await page.evaluate(async (id) => {
      const result = await window.desktop.synthesizeEbookSpeech({ id, ordinal: 0, offset: 0 })
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    }, book.id)
    const waveform = await app.evaluate(async ({ net }, url) => {
      const response = await net.fetch(url)
      const bytes = Buffer.from(await response.arrayBuffer())
      let data = 0
      for (let offset = 12; offset + 8 <= bytes.length;) {
        const size = bytes.readUInt32LE(offset + 4)
        if (bytes.toString('ascii', offset, offset + 4) === 'data') {
          data = offset + 8
          break
        }
        offset += 8 + size + (size % 2)
      }
      return {
        ok: response.ok,
        bytes: bytes.length,
        wave: bytes.toString('ascii', 8, 12),
        nonSilent: data > 0 && bytes.subarray(data).some((value) => value !== 0),
      }
    }, generated.url)
    expect(waveform.ok).toBe(true)
    expect(waveform.wave).toBe('WAVE')
    expect(waveform.bytes).toBeGreaterThan(10000)
    expect(waveform.nonSilent).toBe(true)
    await page.evaluate(() => window.desktop.releaseEbookSpeech())
    await page.mouse.move(300, 20)
    await page.getByRole('button', { name: '返回阅读书架', exact: true }).click()
    await page.getByRole('button', { name: `阅读 ${book.title}`, exact: true }).click()
    await expect(page.getByRole('main', { name: '独立阅读页' })).toHaveAttribute(
      'data-speech-status',
      'idle',
    )
  } finally {
    await closeOwnedElectron(app)
  }
})

test('starting ebook narration pauses a real recording and leaving the reader releases the speech service', async () => {
  const { app, page, book } = await fixture('txt', true)
  try {
    await app.evaluate(({ ipcMain }) => {
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
        string,
        (...args: unknown[]) => unknown
      >
      const release = handlers.get('ebook-speech:release')!
      Reflect.set(globalThis, 'ebookSpeechReleaseCount', 0)
      handlers.set('ebook-speech:release', (...args) => {
        Reflect.set(
          globalThis,
          'ebookSpeechReleaseCount',
          Reflect.get(globalThis, 'ebookSpeechReleaseCount') + 1,
        )
        return release(...args)
      })
    })
    const types = page.getByRole('navigation', { name: '书籍类型', exact: true })
    await types.getByRole('button', { name: '有声书', exact: true }).click()
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    const recording = page.locator('audio[data-player="persistent"]')
    await expect
      .poll(() => recording.evaluate((audio: HTMLAudioElement) => audio.paused))
      .toBe(false)
    await types.getByRole('button', { name: '电子书', exact: true }).click()
    await page.getByRole('button', { name: `阅读 ${book.title}`, exact: true }).click()
    await expect
      .poll(() => recording.evaluate((audio: HTMLAudioElement) => audio.paused))
      .toBe(false)
    await page.mouse.move(300, 20)
    await page.getByRole('button', { name: '朗读电子书', exact: true }).click()
    await expect(page.getByRole('main', { name: '独立阅读页' })).toHaveAttribute(
      'data-speech-status',
      'playing',
      { timeout: 20000 },
    )
    await expect
      .poll(() => recording.evaluate((audio: HTMLAudioElement) => audio.paused))
      .toBe(true)
    await page.mouse.move(300, 20)
    await page.getByRole('button', { name: '返回阅读书架', exact: true }).click()
    await expect
      .poll(() => app.evaluate(() => Reflect.get(globalThis, 'ebookSpeechReleaseCount')))
      .toBeGreaterThan(0)
    await page.getByRole('button', { name: `阅读 ${book.title}`, exact: true }).click()
    await expect(page.getByRole('main', { name: '独立阅读页' })).toHaveAttribute(
      'data-speech-status',
      'idle',
    )
    await expect
      .poll(() => recording.evaluate((audio: HTMLAudioElement) => audio.paused))
      .toBe(true)
  } finally {
    await closeOwnedElectron(app)
  }
})
