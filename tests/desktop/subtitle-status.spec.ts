import { toggleCompanionGeneration } from '../helpers/ui'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import type { TranscriptDocument } from '../../src/shared/transcript'

// Saved documents and job previews are deterministic fixtures. All playback,
// status IPC, SQLite reads, adoption and media seeking execute in the real app.
function audio(path: string, seconds: number) {
  const bytes = 8000 * seconds * 2,
    wav = Buffer.alloc(44 + bytes)
  wav.write('RIFF')
  wav.writeUInt32LE(36 + bytes, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24)
  wav.writeUInt32LE(16000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(bytes, 40)
  writeFileSync(path, wav)
}
async function fixture(mode: 'disjoint' | 'preview') {
  const root = mkdtempSync(join(tmpdir(), '听读 字幕状态 ')),
    folder = join(root, '字幕状态样本')
  mkdirSync(folder)
  for (let i = 1; i <= (mode === 'disjoint' ? 102 : 1); i++)
    audio(join(folder, `第${String(i).padStart(3, '0')}集.wav`), i === 1 ? 90 : 1)
  const store = new LibraryStore(createDataPaths(root).database)
  store.importBook(await scanBook(folder, 'folder'))
  const book = store.listBooks()[0]!,
    episode = book.episodes[0]!
  store.recordSourceDuration(episode.id, episode.contentHash, 90000)
  const document: TranscriptDocument = {
    version: 1,
    audioHash: episode.contentHash,
    kind: 'manual',
    coverage:
      mode === 'disjoint'
        ? [
            { startMs: 0, endMs: 30000 },
            { startMs: 60000, endMs: 90000 },
          ]
        : [{ startMs: 0, endMs: 90000 }],
    segments: [
      { id: 'saved', startMs: 0, endMs: 4000, text: '当前已经保存的人工字幕。' },
      { id: 'later', startMs: 61000, endMs: 89000, text: '后段当前伴读字幕。' },
    ],
  }
  store.saveTranscript(episode.id, document)
  if (mode === 'preview') {
    const job = store.createJob({
      episodeId: episode.id,
      audioHash: episode.contentHash,
      engine: 'whisperx',
      device: 'cpu',
    })
    store.setJobStatus(job.id, job.attempt, 'running')
    store.acceptJobSnapshot(
      job.id,
      job.attempt,
      {
        document: {
          ...document,
          kind: 'transcript',
          coverage: [{ startMs: 60000, endMs: 90000 }],
          segments: [
            { id: 'preview', startMs: 61000, endMs: 64000, text: '尚未采用的新生成字幕。' },
          ],
        },
        processedUntilMs: 0,
        cacheKey: 'b'.repeat(64),
        cacheHits: 0,
        totalChunks: 3,
        issues: [],
      },
      1,
      true,
    )
  }
  store.saveProgress({
    sessionId: '',
    episodeId: episode.id,
    positionMs: mode === 'disjoint' ? 45000 : 0,
    durationMs: 90000,
    rate: 2,
    volume: 0,
  })
  store.close()
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({
    ...(process.env.RALB_EXECUTABLE
      ? { executablePath: resolve(process.env.RALB_EXECUTABLE), args: [] }
      : { args: [resolve(process.env.RALB_APP_ROOT ?? '.')] }),
    env,
  })
  return { app, book, episode }
}
async function countStatusRequests(app: ElectronApplication) {
  // Observe only traffic in this isolated app. The original guarded handlers
  // execute unchanged; no response, timing, document or media state is mocked.
  await app.evaluate(({ ipcMain }) => {
    const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
      string,
      (...args: unknown[]) => unknown
    >
    if (!(handlers instanceof Map))
      throw new Error('Electron invoke-handler instrumentation unavailable')
    const traffic = { batches: [] as number[], full: 0 }
    Reflect.set(globalThis, 'subtitleStatusTraffic', traffic)
    for (const channel of ['transcription:statuses', 'transcription:state']) {
      const original = handlers.get(channel)!
      handlers.set(channel, (...args) => {
        if (channel === 'transcription:state') traffic.full++
        else traffic.batches.push((args[1] as { episodes: unknown[] }).episodes.length)
        return original(...args)
      })
    }
  })
}

async function expectReadablePopup(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const popup = document.querySelector<HTMLElement>(
            '.subtitle-status-popup[data-positioned="true"]',
          ),
          current = document.querySelector<HTMLElement>(
            '[aria-label="同步伴读"] .transcript-sentence[aria-current="true"]',
          ),
          player = document.querySelector<HTMLElement>('.player-panel')
        if (!popup || !current || !player) return null
        const bounds = popup.getBoundingClientRect(),
          sentence = current.getBoundingClientRect(),
          controls = player.getBoundingClientRect()
        return {
          inside:
            bounds.left >= 0 &&
            bounds.top >= 0 &&
            bounds.right <= innerWidth &&
            bounds.bottom <= innerHeight,
          clearCurrent:
            bounds.bottom <= sentence.top ||
            bounds.top >= sentence.bottom ||
            bounds.right <= sentence.left ||
            bounds.left >= sentence.right,
          clearControls: bounds.bottom <= controls.top,
        }
      }),
    )
    .toEqual({ inside: true, clearCurrent: true, clearControls: true })
}

test('gapped subtitles show exact saved coverage and 2x lead consistently; directory statuses use bounded page batches', async ({}, info) => {
  const { app, book, episode } = await fixture('disjoint')
  try {
    const page = await app.firstWindow(),
      panel = page.getByRole('region', { name: '播放器', exact: true })
    await expect(panel.locator('.subtitle-status-player > summary')).toHaveAccessibleName(
      /字幕部分已备/,
    )
    await panel.locator('.subtitle-status-player > summary').click()
    const status = panel.getByRole('group', { name: '字幕准备状态', exact: true })
    await expect(status).toContainText('已备 01:00 / 01:30')
    await expect(status).toContainText('从头连续 00:30')
    await expect(status).toContainText('当前位置连续领先 0 秒音频')
    await panel.getByRole('slider', { name: '播放进度', exact: true }).fill('65000')
    await expect(status).toContainText('25 秒音频，2×可听约 12 秒')
    await panel.locator('.subtitle-status-player > summary').click()
    await countStatusRequests(app)
    await page.getByRole('button', { name: `打开 ${book.title} 的目录`, exact: true }).click()
    const directory = page.getByRole('region', { name: '章节目录', exact: true })
    await expect(directory.getByRole('button', { name: /^播放第 / })).toHaveCount(100)
    await expect(
      directory
        .getByRole('button', { name: `播放第 1 集 ${episode.title}`, exact: true })
        .locator('.subtitle-status-badge'),
    ).toContainText('字幕部分已备 · 01:00')
    await directory.getByRole('button', { name: '下一页章节', exact: true }).click()
    await expect(directory.getByRole('button', { name: /^播放第 / })).toHaveCount(2)
    await expect
      .poll(() => app.evaluate(() => Reflect.get(globalThis, 'subtitleStatusTraffic').batches))
      .toContain(2)
    const traffic = await app.evaluate(
      () => Reflect.get(globalThis, 'subtitleStatusTraffic') as { batches: number[]; full: number },
    )
    expect(traffic.batches).toContain(100)
    expect(traffic.batches.every((count) => count <= 100)).toBe(true)
    expect(traffic.full).toBe(0)
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    const reader = page.getByRole('region', { name: '同步伴读', exact: true })
    await toggleCompanionGeneration(reader)
    await expect(reader.getByRole('group', { name: '字幕准备状态', exact: true })).toContainText(
      '25 秒音频，2×可听约 12 秒',
    )
    await toggleCompanionGeneration(reader)
    await page.screenshot({
      path: info.outputPath('disjoint-subtitle-status.png'),
      animations: 'disabled',
    })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 600))
    const current = reader.locator('.transcript-sentence[aria-current="true"]')
    await expect(current).toHaveAttribute('data-segment-id', 'later')
    await expect(current).toContainText('后段当前伴读字幕。')
    await panel.locator('.subtitle-status-player > summary').click()
    await expect(panel.getByRole('group', { name: '字幕准备状态', exact: true })).toBeVisible()
    await expectReadablePopup(page)
    await page.screenshot({
      path: info.outputPath('subtitle-status-minimum-open.png'),
      animations: 'disabled',
    })
    // Native window resizing and a real seek must reposition an already-open
    // panel without covering the next current sentence or the transport controls.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(800, 640))
    await expectReadablePopup(page)
    await panel.getByRole('slider', { name: '播放进度', exact: true }).fill('2000')
    await expect(current).toHaveAttribute('data-segment-id', 'saved')
    await expect(panel.locator('.subtitle-status-player')).toHaveAttribute('open', '')
    await expectReadablePopup(page)
    await panel.getByRole('slider', { name: '播放进度', exact: true }).fill('65000')
    await expect(current).toHaveAttribute('data-segment-id', 'later')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 600))
    await expectReadablePopup(page)
    await panel.getByRole('button', { name: '收起字幕状态', exact: true }).click()
    await expect(panel.locator('.subtitle-status-player')).not.toHaveAttribute('open', '')
    await toggleCompanionGeneration(reader)
    await current.scrollIntoViewIfNeeded()
    await panel.locator('.subtitle-status-player > summary').click()
    await expectReadablePopup(page)
    await page.screenshot({
      path: info.outputPath('subtitle-status-minimum-task-open.png'),
      animations: 'disabled',
    })
    await panel.getByRole('button', { name: '收起字幕状态', exact: true }).click()
    await toggleCompanionGeneration(reader)
    await current.click()
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
      .toBeCloseTo(61, 1)
    await panel.getByRole('button', { name: '播放', exact: true }).click()
    await expect(panel.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
    await panel.getByRole('button', { name: '暂停', exact: true }).click()
    await page.screenshot({
      path: info.outputPath('subtitle-status-minimum-closed.png'),
      animations: 'disabled',
    })
  } finally {
    await app.close()
  }
})

test('complete saved subtitles stay complete while a separate preview awaits adoption, then all status surfaces update', async ({}, info) => {
  const { app } = await fixture('preview')
  try {
    const page = await app.firstWindow(),
      panel = page.getByRole('region', { name: '播放器', exact: true })
    await expect(panel.locator('.subtitle-status-player > summary')).toHaveAccessibleName(
      /整集字幕已备/,
    )
    await expect(panel.locator('.subtitle-status-player > summary')).toHaveAccessibleName(
      /新稿待采用/,
    )
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    const reader = page.getByRole('region', { name: '同步伴读', exact: true }),
      status = reader.getByRole('group', { name: '字幕准备状态', exact: true })
    await toggleCompanionGeneration(reader)
    await expect(status).toContainText('整集字幕已备 · 已备 01:30 / 01:30')
    await expect(status).toContainText('本次已处理 00:30')
    await expect(status).toContainText('本次覆盖 01:00–01:30；从头连续 00:00')
    await reader.getByRole('button', { name: '预览生成稿', exact: true }).click()
    await expect(reader.locator('.transcript-sentence')).toContainText(['尚未采用的新生成字幕。'])
    await toggleCompanionGeneration(reader)
    await expect(status).toContainText('整集字幕已备')
    await expect(panel.locator('.subtitle-status-player > summary')).toHaveAccessibleName(
      /整集字幕已备/,
    )
    await page.screenshot({
      path: info.outputPath('saved-versus-preview-status.png'),
      animations: 'disabled',
    })
    await reader.getByRole('button', { name: '使用生成稿', exact: true }).click()
    await expect(status).toContainText('字幕部分已备 · 已备 00:30 / 01:30')
    await expect(status).toContainText('从头连续 00:00')
    await expect(status).toContainText('当前位置连续领先 0 秒音频')
    await expect(panel.locator('.subtitle-status-player > summary')).toHaveAccessibleName(
      /字幕部分已备/,
    )
    await expect(panel.locator('.subtitle-status-player > summary')).not.toHaveAccessibleName(
      /新稿待采用/,
    )
    expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(
      true,
    )
  } finally {
    await app.close()
  }
})
