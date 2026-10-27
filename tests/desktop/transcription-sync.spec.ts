import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { createDataPaths } from '../../src/main/paths'
import { scanBook } from '../../src/main/files'
import { CHANNELS, type Result } from '../../src/shared/contracts'
import type { TranscriptDocument, TranscriptRequest } from '../../src/shared/transcript'
import type {
  TranscriptionSyncRequest,
  TranscriptionSyncState,
} from '../../src/shared/transcription'
import { closeOwnedElectron } from '../model/electron-lifecycle'
import { openCompanionSearch } from '../helpers/ui'

interface SyncReply {
  status: string
  revision: number | null
  knownRevision: number | null
  segmentCount: number
  delivered: boolean
}
interface Traffic {
  sync: SyncReply[]
  summary: { hasSegments: boolean }[]
  legacy: number
  holdNextSync: boolean
  held: boolean
  release?: () => void
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), '听读文稿条件同步 ')),
    path = join(root, '同步验收.wav'),
    pcm = Buffer.alloc(44 + 60 * 16000)
  pcm.write('RIFF')
  pcm.writeUInt32LE(pcm.length - 8, 4)
  pcm.write('WAVEfmt ', 8)
  pcm.writeUInt32LE(16, 16)
  pcm.writeUInt16LE(1, 20)
  pcm.writeUInt16LE(1, 22)
  pcm.writeUInt32LE(8000, 24)
  pcm.writeUInt32LE(16000, 28)
  pcm.writeUInt16LE(2, 32)
  pcm.writeUInt16LE(16, 34)
  pcm.write('data', 36)
  pcm.writeUInt32LE(pcm.length - 44, 40)
  writeFileSync(path, pcm)
  const store = new LibraryStore(createDataPaths(root).database)
  try {
    store.importBook(await scanBook(path, 'file'))
    const episode = store.listBooks()[0]!.episodes[0]!,
      target = { episodeId: episode.id, audioHash: episode.contentHash },
      document: TranscriptDocument = {
        version: 1,
        kind: 'manual',
        audioHash: episode.contentHash,
        coverage: [{ startMs: 0, endMs: 60000 }],
        segments: Array.from({ length: 6000 }, (_, index) => ({
          id: `s${index}`,
          startMs: index * 10,
          endMs: index * 10 + 10,
          text: index === 5999 ? '末句同步更新验证，故事还在继续。' : `第${index}句，山路继续。`,
        })),
      }
    store.saveTranscript(episode.id, document)
    store.saveProgress({
      sessionId: '',
      episodeId: episode.id,
      positionMs: 1500,
      durationMs: 60000,
      rate: 1,
      volume: 0,
    })
    return { root, target }
  } finally {
    store.close()
  }
}

async function launch(root: string) {
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  return electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
}

async function settledPage(app: ElectronApplication) {
  const page = await app.firstWindow()
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  await expect(page.locator('.transcript-sentence[data-segment-id="s150"]')).toContainText(
    '第150句，山路继续。',
  )
  return page
}

async function observe(app: ElectronApplication, holdFirst = false) {
  // The guarded production handlers execute without alteration. Instrumentation
  // records small response facts and may delay delivery of one actual response;
  // no document, version, error, timing boundary or mutation result is fabricated.
  await app.evaluate(
    ({ ipcMain }, { sync, summary, legacy, holdFirst }) => {
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
          string,
          (...args: unknown[]) => unknown
        >,
        traffic: Traffic = {
          sync: [],
          summary: [],
          legacy: 0,
          holdNextSync: holdFirst,
          held: false,
        }
      Reflect.set(globalThis, 'transcriptSyncTraffic', traffic)
      for (const channel of [sync, summary, legacy]) {
        const original = handlers.get(channel)
        if (!original) throw new Error(`Missing production handler: ${channel}`)
        handlers.set(channel, async (...args) => {
          const result = await original(...args)
          if (channel === legacy) traffic.legacy++
          if (channel === summary)
            traffic.summary.push({ hasSegments: JSON.stringify(result).includes('"segments"') })
          if (channel !== sync) return result
          const request = args[1] as TranscriptionSyncRequest,
            response = result as Result<TranscriptionSyncState>,
            transcript = response.ok ? response.value.transcript : null,
            item: SyncReply = {
              status: transcript?.status ?? 'error',
              revision:
                transcript?.status === 'ready'
                  ? transcript.transcript.revision
                  : transcript?.status === 'unchanged'
                    ? transcript.version.revision
                    : null,
              knownRevision: request.knownTranscript?.revision ?? null,
              segmentCount:
                transcript?.status === 'ready' ? transcript.transcript.document.segments.length : 0,
              delivered: false,
            }
          traffic.sync.push(item)
          if (traffic.holdNextSync) {
            traffic.holdNextSync = false
            traffic.held = true
            await new Promise<void>((resolve) => {
              traffic.release = resolve
            })
          }
          item.delivered = true
          return result
        })
      }
    },
    {
      sync: CHANNELS.transcriptionSync,
      summary: CHANNELS.transcriptionSummary,
      legacy: CHANNELS.transcriptionState,
      holdFirst,
    },
  )
}

async function traffic(app: ElectronApplication) {
  return app.evaluate(() => {
    const value = Reflect.get(globalThis, 'transcriptSyncTraffic') as Traffic
    return { sync: value.sync, summary: value.summary, legacy: value.legacy, held: value.held }
  })
}

async function notify(app: ElectronApplication, target: TranscriptRequest) {
  await app.evaluate(
    ({ BrowserWindow }, { channel, target }) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send(channel, target)
    },
    { channel: CHANNELS.transcriptionChanged, target },
  )
}

async function release(app: ElectronApplication) {
  await app.evaluate(() => {
    const value = Reflect.get(globalThis, 'transcriptSyncTraffic') as Traffic | undefined
    value?.release?.()
    if (value) delete value.release
  })
}

function clock(page: Page) {
  return page.locator('audio').evaluate((audio: HTMLAudioElement) => ({
    positionMs: audio.currentTime * 1000,
    paused: audio.paused,
    source: audio.src,
  }))
}

async function correct(page: Page, target: TranscriptRequest) {
  const result = await page.evaluate(
    (target) =>
      window.desktop.editTranscript({
        ...target,
        revision: 1,
        segmentId: 's150',
        text: '第150句，山路继续前进。',
      }),
    target,
  )
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.message)
  expect(result.value.status).toBe('ready')
  return result
}

test('unchanged notifications share conditional reads, player summaries omit body, and a real correction refreshes all text', async ({}, info) => {
  const data = await fixture(),
    app = await launch(data.root)
  try {
    const page = await settledPage(app),
      errors: string[] = []
    await observe(app)
    page.on('pageerror', (error) => errors.push(error.message))
    // A fresh renderer guarantees an empty client cache after instrumentation.
    await page.reload()
    await expect(page.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
    const reader = page.getByRole('region', { name: '同步伴读', exact: true })
    await expect(reader).toBeVisible()
    await expect(reader.getByRole('region', { name: '播放器', exact: true })).toHaveAttribute(
      'data-reader-dock',
      'true',
    )
    const current = page.locator('.transcript-sentence[data-segment-id="s150"]')
    await expect(current).toContainText('第150句，山路继续。')
    const before = await clock(page)
    expect(before.paused).toBe(true)
    const initial = await traffic(app),
      firstFull = initial.sync.filter((item) => item.status === 'ready')
    expect(firstFull.length).toBeGreaterThanOrEqual(1)
    expect(firstFull.every((item) => item.segmentCount === 6000)).toBe(true)
    for (let index = 0; index < 4; index++) {
      const previous = await traffic(app)
      await notify(app, data.target)
      await expect
        .poll(async () => (await traffic(app)).sync.filter((item) => item.delivered).length)
        .toBeGreaterThan(previous.sync.length)
      await expect
        .poll(async () => (await traffic(app)).summary.length)
        .toBeGreaterThan(previous.summary.length)
    }
    const unchanged = await traffic(app),
      extra = unchanged.sync.slice(initial.sync.length)
    expect(extra.length).toBeGreaterThanOrEqual(4)
    expect(extra.every((item) => item.status === 'unchanged' && item.segmentCount === 0)).toBe(true)
    expect(extra.every((item) => item.knownRevision === 1 && item.revision === 1)).toBe(true)
    expect(unchanged.legacy).toBe(0)
    expect(unchanged.summary.every((item) => !item.hasSegments)).toBe(true)
    await correct(page, data.target)
    await expect(current).toContainText('第150句，山路继续前进。')
    const changed = await traffic(app)
    expect(
      changed.sync
        .slice(unchanged.sync.length)
        .some((item) => item.revision === 2 && item.segmentCount === 6000),
    ).toBe(true)
    const full = await page.evaluate((target) => window.desktop.getTranscript(target), data.target)
    expect(full.ok && full.value.status === 'ready').toBe(true)
    if (!full.ok || full.value.status !== 'ready') throw new Error('Full transcript unavailable')
    expect(full.value.transcript.document.segments).toHaveLength(6000)
    expect(full.value.transcript.document.segments[5999]!.text).toBe(
      '末句同步更新验证，故事还在继续。',
    )
    await openCompanionSearch(page)
    await page.getByRole('textbox', { name: '文稿搜索文字', exact: true }).fill('末句同步更新验证')
    await page.getByRole('button', { name: '搜索文稿', exact: true }).click()
    await expect(page.locator('.transcript-search-results li')).toHaveCount(1)
    await page.locator('.transcript-search-results button').click()
    const last = page.locator('.transcript-sentence[data-segment-id="s5999"]')
    await expect(last).toContainText('末句同步更新验证，故事还在继续。')
    await expect(last).toBeInViewport()
    expect(await clock(page)).toEqual(before)
    expect(errors).toEqual([])
    await info.attach('real-handler-traffic', {
      body: JSON.stringify(await traffic(app), null, 2),
      contentType: 'application/json',
    })
  } finally {
    await closeOwnedElectron(app)
  }
})

test('a real edit during the first pending sync prevents the late old document from being published', async ({}, info) => {
  const data = await fixture(),
    app = await launch(data.root)
  try {
    const page = await settledPage(app),
      errors: string[] = []
    await observe(app, true)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.reload()
    await expect(page.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
    const reader = page.getByRole('region', { name: '同步伴读', exact: true })
    await expect(reader).toBeVisible()
    await expect(reader.getByRole('region', { name: '播放器', exact: true })).toHaveAttribute(
      'data-reader-dock',
      'true',
    )
    await expect.poll(async () => (await traffic(app)).held).toBe(true)
    const before = await clock(page)
    expect(before.paused).toBe(true)
    await page.evaluate(() => {
      const texts: string[] = []
      Reflect.set(window, 'publishedSyncTexts', texts)
      const observer = new MutationObserver(() => {
        const text = document.querySelector(
          '.transcript-sentence[data-segment-id="s150"]',
        )?.textContent
        if (text) texts.push(text)
      })
      observer.observe(document.body, { subtree: true, childList: true, characterData: true })
      Reflect.set(window, 'syncTextObserver', observer)
    })
    const summariesBeforeEdit = (await traffic(app)).summary.length
    await correct(page, data.target)
    await expect
      .poll(async () => (await traffic(app)).summary.length)
      .toBeGreaterThan(summariesBeforeEdit)
    await expect(page.locator('.transcript-sentence[data-segment-id="s150"]')).toHaveCount(0)
    await release(app)
    const current = page.locator('.transcript-sentence[data-segment-id="s150"]')
    await expect(current).toContainText('第150句，山路继续前进。')
    const replies = (await traffic(app)).sync
    expect(replies.some((item) => item.revision === 1 && item.segmentCount === 6000)).toBe(true)
    expect(replies.some((item) => item.revision === 2 && item.segmentCount === 6000)).toBe(true)
    const texts = await page.evaluate(() => {
      const observer = Reflect.get(window, 'syncTextObserver') as MutationObserver
      observer.disconnect()
      return Reflect.get(window, 'publishedSyncTexts') as string[]
    })
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.every((text) => text.includes('山路继续前进。'))).toBe(true)
    expect(await clock(page)).toEqual(before)
    expect(errors).toEqual([])
    await info.attach('late-real-response-traffic', {
      body: JSON.stringify(await traffic(app), null, 2),
      contentType: 'application/json',
    })
  } finally {
    await release(app).catch(() => undefined)
    await closeOwnedElectron(app)
  }
})
