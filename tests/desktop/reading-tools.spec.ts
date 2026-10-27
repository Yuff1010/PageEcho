import {
  closeOriginalPanel,
  openCompanionTools,
  openOriginalSearch,
  openOriginalTools,
  openTranscriptImport,
  useOriginalText,
  waitForOriginalReady,
} from '../helpers/ui'
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SubtitleExportRequest } from '../../src/shared/subtitles'

async function setup() {
  const root = mkdtempSync(join(tmpdir(), '听读搜索字幕 ')),
    env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
  const page = await app.firstWindow()
  const choose = async (path: string) =>
    app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
    }, path)
  await choose(resolve('tests/fixtures/第32集-伴读样本.wav'))
  await page.getByRole('button', { name: '选择音频文件', exact: true }).click()
  await page.getByRole('button', { name: '继续播放', exact: true }).click()
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  await choose(resolve('tests/fixtures/reading-manual.json'))
  await openTranscriptImport(page)
  await page.getByRole('button', { name: '导入 JSON 文稿', exact: true }).click()
  await expect(page.getByRole('button', { name: '导入 JSON 文稿', exact: true })).toBeHidden()
  await openCompanionTools(page)
  await page.locator('.subtitle-export-menu summary').click()
  await expect(page.getByRole('button', { name: '导出文稿字幕', exact: true })).toBeEnabled()
  const state = await page.evaluate(() => window.desktop.getState())
  if (!state.ok) throw new Error(state.error.message)
  const episode = state.value.books[0]!.episodes[0]!
  const target = { episodeId: episode.id, audioHash: episode.contentHash }
  return { root, app, page, choose, target }
}
async function saveTo(app: ElectronApplication, path: string | null) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showSaveDialog = async () => ({
      canceled: selected === null,
      filePath: selected ?? '',
    })
  }, path)
}

test('whole-original search paginates, locates distant text and preserves paused media position', async ({}, testInfo) => {
  const { root, app, page, choose } = await setup()
  try {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const text = join(root, '全文.txt')
    writeFileSync(
      text,
      '第19章 山路\n' +
        Array.from({ length: 137 }, (_, i) => `这是第${i}处寻找的原文。`).join('\n'),
    )
    await useOriginalText(page)
    await choose(text)
    await page.getByRole('button', { name: '导入 TXT / EPUB 原文', exact: true }).click()
    await waitForOriginalReady(page)
    await openOriginalTools(page, '原文来源')
    await expect(page.locator('.original-summary')).toContainText('137 句')
    await closeOriginalPanel(page)
    await page.getByRole('slider', { name: '播放进度', exact: true }).fill('1500')
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
      .toBe(1.5)
    await openOriginalSearch(page)
    await page.getByRole('textbox', { name: '全文搜索文字' }).fill('寻找')
    await page.getByRole('button', { name: '搜索原文', exact: true }).click()
    await expect(page.locator('.original-search')).toContainText('共 137 处结果')
    await expect(page.locator('.original-search-results li')).toHaveCount(20)
    for (let i = 0; i < 6; i++) {
      await page.getByRole('button', { name: '搜索下一页', exact: true }).click()
      await expect(page.locator('.original-search')).toContainText(`第 ${i + 2} / 7 页`)
    }
    await expect(page.locator('.original-search-results li')).toHaveCount(17)
    await page.locator('.original-search-results button').last().click()
    await expect(page.locator('.original-sentence[data-search-hit="true"]')).toContainText(
      '第136处',
    )
    await expect(page.locator('.original-sentence[data-search-hit="true"]')).toBeInViewport({
      ratio: 1,
    })
    await expect(page.getByRole('dialog', { name: '搜索小说原文', exact: true })).toBeHidden()
    const media = await page.locator('audio').evaluate((audio: HTMLAudioElement) => ({
      position: audio.currentTime,
      paused: audio.paused,
    }))
    expect(media).toEqual({ position: 1.5, paused: true })
    await openOriginalSearch(page)
    await page.getByRole('textbox', { name: '全文搜索文字' }).fill('不存在的内容')
    await page.getByRole('button', { name: '搜索原文', exact: true }).click()
    await expect(page.locator('.original-search')).toContainText('共 0 处结果')
    await page.getByRole('textbox', { name: '全文搜索文字' }).fill('寻找')
    await page.getByRole('button', { name: '搜索原文', exact: true }).click()
    await expect(page.locator('.original-search')).toContainText('第 1 / 7 页')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 600))
    await expect(page.getByRole('button', { name: '播放', exact: true })).toBeInViewport({
      ratio: 1,
    })
    await page.screenshot({ path: testInfo.outputPath('whole-original-search-small.png') })
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('SRT/VTT export handles cancellation, write errors, manual original gaps and revision races', async ({}, testInfo) => {
  const { root, app, page, choose, target } = await setup()
  try {
    const transcript = await page.evaluate((input) => window.desktop.getTranscript(input), target)
    if (!transcript.ok || transcript.value.status !== 'ready') throw new Error('Missing transcript')
    const before = transcript.value.transcript
    const srt = join(root, '文稿.srt'),
      vtt = join(root, '文稿.vtt')
    await saveTo(app, null)
    await page.getByRole('button', { name: '导出文稿字幕', exact: true }).click()
    await expect(page.getByRole('button', { name: '导出文稿字幕', exact: true })).toBeEnabled()
    expect(existsSync(srt)).toBe(false)
    await saveTo(app, srt)
    await page.getByRole('button', { name: '导出文稿字幕', exact: true }).click()
    await expect(page.locator('.subtitle-export')).toContainText('已导出 3 条字幕')
    expect(readFileSync(srt, 'utf8')).toContain(
      '00:00:01,000 --> 00:00:04,635\n第十九章，故事从这里继续。',
    )
    await page.getByRole('combobox', { name: '文稿字幕格式' }).selectOption('vtt')
    await saveTo(app, vtt)
    await page.getByRole('button', { name: '导出文稿字幕', exact: true }).click()
    await expect(page.locator('.subtitle-export')).toContainText('文稿.vtt')
    // Keep the product CSP intact; parse the exported file in an isolated sandbox.
    const parserReady = app.waitForEvent('window')
    await app.evaluate(async ({ BrowserWindow }) => {
      const parser = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
          partition: 'subtitle-parser-test',
        },
      })
      await parser.loadURL('data:text/html,<title>WebVTT parser verification</title>')
    })
    const parser = await parserReady
    const parsedCues = await parser.evaluate(
      async (contents) => {
        const video = document.createElement('video'),
          track = document.createElement('track')
        const url = URL.createObjectURL(new Blob([contents], { type: 'text/vtt' }))
        track.src = url
        video.append(track)
        document.body.append(video)
        track.track.mode = 'hidden'
        try {
          await new Promise<void>((done, reject) => {
            track.onload = () => done()
            track.onerror = () => reject(new Error('WebVTT load failed'))
            setTimeout(() => reject(new Error('WebVTT parse timed out')), 5000)
          })
          return [...track.track.cues!].map((cue) => ({
            start: cue.startTime,
            end: cue.endTime,
            text: (cue as VTTCue).text,
          }))
        } finally {
          video.remove()
          URL.revokeObjectURL(url)
        }
      },
      readFileSync(vtt, 'utf8'),
    )
    await parser.close()
    expect(parsedCues).toEqual([
      { start: 1, end: 4.635, text: '第十九章，故事从这里继续。' },
      { start: 5.335, end: 10.125, text: '窗外的风停了，屋里只剩下翻书的声音。' },
      { start: 10.825, end: 14.66, text: '他合上书，决定明天再出发。' },
    ])
    const directory = join(root, '不能替换.vtt')
    mkdirSync(directory)
    writeFileSync(join(directory, '保留.txt'), '保留')
    await saveTo(app, directory)
    await page.getByRole('button', { name: '导出文稿字幕', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('字幕未保存')
    expect(readFileSync(join(directory, '保留.txt'), 'utf8')).toBe('保留')
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([])

    const original = join(root, '小说.txt')
    writeFileSync(original, '第19章\n第十九章，故事从这里继续。\n这一句未在声音中出现。')
    await useOriginalText(page)
    await choose(original)
    await page.getByRole('button', { name: '导入 TXT / EPUB 原文', exact: true }).click()
    await waitForOriginalReady(page)
    await openOriginalTools(page)
    await expect
      .poll(async () => {
        const state = await page.evaluate((input) => window.desktop.getOriginalState(input), target)
        return state.ok && !!state.value.alignment
      })
      .toBe(true)
    await page.locator('.original-review summary').click()
    await page.getByRole('button', { name: '校正原文与同步点', exact: true }).first().click()
    await page.getByRole('spinbutton', { name: '原文起句', exact: true }).fill('1')
    await page.getByRole('spinbutton', { name: '原文止句', exact: true }).fill('1')
    await page.getByRole('spinbutton', { name: '起始秒', exact: true }).fill('1.25')
    await page.getByRole('spinbutton', { name: '结束秒', exact: true }).fill('4.5')
    await page.getByRole('button', { name: '保存原文校正', exact: true }).click()
    await openOriginalTools(page, '字幕导出')
    await page
      .getByRole('dialog', { name: '原文工具', exact: true })
      .locator('.subtitle-export-menu summary')
      .click()
    await expect(page.getByRole('button', { name: '导出原文字幕', exact: true })).toBeEnabled()
    const originalSrt = join(root, '原文.srt')
    await saveTo(app, originalSrt)
    await page.getByRole('button', { name: '导出原文字幕', exact: true }).click()
    await expect(page.locator('.subtitle-export')).toContainText('已导出 1 条字幕')
    await expect(page.locator('.subtitle-export')).toContainText('2 段未映射')
    expect(readFileSync(originalSrt, 'utf8')).not.toContain('窗外')
    expect(readFileSync(originalSrt, 'utf8')).toContain('00:00:01,250 --> 00:00:04,500')
    const unchanged = await page.evaluate((input) => window.desktop.getTranscript(input), target)
    expect(unchanged).toEqual(transcript)
    await page.screenshot({ path: testInfo.outputPath('original-subtitle-export.png') })

    // A real renderer IPC edit while the native save dialog is outstanding must abort the stale export.
    writeFileSync(srt, '旧文件必须保留')
    await app.evaluate(({ dialog }, destination) => {
      dialog.showSaveDialog = async () => {
        await new Promise<void>((release) => {
          Reflect.set(globalThis, 'releaseSubtitleSave', release)
        })
        return { canceled: false, filePath: destination }
      }
    }, srt)
    const request: SubtitleExportRequest = {
      ...target,
      source: 'transcript',
      format: 'srt',
      transcriptId: before.id,
      transcriptRevision: before.revision,
    }
    const pending = page.evaluate((input) => window.desktop.exportSubtitles(input), request)
    await expect
      .poll(() => app.evaluate(() => typeof Reflect.get(globalThis, 'releaseSubtitleSave')))
      .toBe('function')
    const edit = await page.evaluate((input) => window.desktop.editTranscript(input), {
      ...target,
      segmentId: 's1',
      revision: before.revision,
      text: '第十九章，故事从这里开始。',
    })
    expect(edit.ok).toBe(true)
    await app.evaluate(() => {
      Reflect.get(globalThis, 'releaseSubtitleSave')()
      Reflect.deleteProperty(globalThis, 'releaseSubtitleSave')
    })
    const rejected = await pending
    expect(rejected.ok ? 'saved' : rejected.error.code).toBe('CONFLICT')
    expect(readFileSync(srt, 'utf8')).toBe('旧文件必须保留')
  } finally {
    await app.close()
  }
})
