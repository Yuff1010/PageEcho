import {
  closeCompanionPanel,
  leaveCompanionPage,
  openCompanionProofreading,
  openCompanionSearch,
  openCompanionSettings,
  openCompanionTools,
  openTranscriptImport,
  toggleCompanionGeneration,
} from '../helpers/ui'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
  type Locator,
} from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { createDataPaths } from '../../src/main/paths'
import { scanBook } from '../../src/main/files'
import type { TranscriptDocument } from '../../src/shared/transcript'

async function fixture(count = 3, preview = false) {
  const root = mkdtempSync(join(tmpdir(), '听读文稿搜索 ')),
    folder = join(root, '音频')
  mkdirSync(folder)
  const pcm = Buffer.alloc(101 * 16000 + 44)
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
  writeFileSync(join(folder, '第01集.wav'), pcm)
  copyFileSync(join(folder, '第01集.wav'), join(folder, '第02集.wav'))
  const store = new LibraryStore(createDataPaths(root).database)
  store.importBook(await scanBook(folder, 'folder'))
  const episodes = store.listBooks()[0]!.episodes
  const step = count > 6000 ? 1 : 1000
  const document: TranscriptDocument = {
    version: 1,
    audioHash: episodes[0]!.contentHash,
    kind: 'transcript',
    coverage: [{ startMs: 0, endMs: 101000 }],
    segments: Array.from({ length: count }, (_, index) => ({
      id: `s${index}`,
      startMs: index * step,
      endMs: index * step + Math.min(step, 800),
      text:
        count === 3
          ? ['山路的故事正在继续。', '窗外的风停了。', '明天再出发。'][index]!
          : `第${index}句，寻找故事。`,
    })),
  }
  if (count === 100000) {
    document.segments[59999]!.text = '第59999句，寻找故事，跨句'
    document.segments[60000]!.text = '链接，寻找故事，第60000句。'
  }
  store.saveTranscript(episodes[0]!.id, document)
  store.saveTranscript(episodes[1]!.id, {
    ...document,
    audioHash: episodes[1]!.contentHash,
    segments: [{ id: 'other', startMs: 0, endMs: 1000, text: '这是另一集专用的文稿。' }],
  })
  store.saveProgress({
    sessionId: '',
    episodeId: episodes[0]!.id,
    positionMs: 1500,
    durationMs: 101000,
    rate: 1,
    volume: 0,
  })
  if (count === 100000)
    store.markTranscriptRegion({
      episodeId: episodes[0]!.id,
      audioHash: episodes[0]!.contentHash,
      revision: 0,
      startMs: 99990,
      endMs: 100000,
      kind: 'advertisement',
    })
  if (preview) {
    const job = store.createJob({
      episodeId: episodes[0]!.id,
      audioHash: episodes[0]!.contentHash,
      engine: 'paraformer',
      device: 'cpu',
    })
    store.setJobStatus(job.id, 1, 'running')
    store.acceptJobSnapshot(
      job.id,
      1,
      {
        document: {
          ...document,
          segments: [{ id: 'preview', startMs: 0, endMs: 1000, text: '这是预览专用内容。' }],
        },
        processedUntilMs: 101000,
        cacheKey: 'a'.repeat(64),
        cacheHits: 0,
        totalChunks: 1,
        issues: [],
      },
      1,
      true,
    )
  }
  store.close()
  return {
    root,
    document,
    episodes,
    target: { episodeId: episodes[0]!.id, audioHash: episodes[0]!.contentHash },
  }
}
async function launch(root: string) {
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
  const page = await app.firstWindow()
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  await expect(page.locator('.transcript-sentence').first()).toBeVisible()
  return { app, page }
}
async function search(page: Page, query: string) {
  await openCompanionSearch(page)
  const details = page.locator('.transcript-search')
  await expect(details).toHaveAttribute('open', '')
  await page.getByRole('textbox', { name: '文稿搜索文字' }).fill(query)
  await expect(page.getByRole('button', { name: '搜索文稿', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '搜索文稿', exact: true }).click()
  await expect(page.getByRole('button', { name: '搜索文稿', exact: true })).toBeEnabled()
}
async function clock(page: Page) {
  return page.locator('audio').evaluate((audio: HTMLAudioElement) => ({
    positionMs: audio.currentTime * 1000,
    paused: audio.paused,
  }))
}
async function choose(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, path)
}

async function expectSentenceFullyReadable(sentence: Locator) {
  await expect(sentence).toBeVisible()
  // Inline text can have fractional line bounds. Check every line against the
  // actual reader and window, tolerating at most one CSS pixel rather than
  // requiring IntersectionObserver's rounded area ratio to equal exactly 1.
  await expect
    .poll(() =>
      sentence.evaluate((node) => {
        const viewport = node.closest('.companion-flow-viewport')!
        const bounds = viewport.getBoundingClientRect()
        const lines = Array.from(node.getClientRects()).filter((rect) => rect.width && rect.height)
        if (!lines.length) return Number.POSITIVE_INFINITY
        return Math.max(
          0,
          ...lines.flatMap((rect) => [
            Math.max(0, bounds.left) - rect.left,
            rect.right - Math.min(innerWidth, bounds.right),
            Math.max(0, bounds.top) - rect.top,
            rect.bottom - Math.min(innerHeight, bounds.bottom),
          ]),
        )
      }),
    )
    .toBeLessThanOrEqual(1)
}

test('100,000-sentence search reaches the last result, expands folded text and locates across pages without moving media', async ({}, info) => {
  test.setTimeout(90000)
  const t = await fixture(100000),
    { app, page } = await launch(t.root)
  try {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const before = await clock(page)
    await openCompanionSettings(page)
    await page.getByRole('checkbox', { name: '折叠已标注片段' }).check()
    await closeCompanionPanel(page)
    await search(page, '寻找')
    await expect(page.locator('.transcript-search')).toContainText('共 100000 处结果')
    await expect(page.locator('.transcript-search-results li')).toHaveCount(20)
    await page.getByRole('button', { name: '文稿搜索末页', exact: true }).click()
    await expect(page.locator('.transcript-search')).toContainText('第 5000 / 5000 页')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 600))
    await expect(page.getByRole('button', { name: '播放', exact: true })).toBeInViewport({
      ratio: 1,
    })
    await page.screenshot({ path: info.outputPath('search-open-small.png') })
    await page.locator('.transcript-search-results button').last().click()
    const last = page.locator('.transcript-sentence[data-segment-id="s99999"]')
    await expect(last).toHaveAttribute('data-search-hit', 'true')
    await expectSentenceFullyReadable(last)
    await expect(page.locator('.transcript-sentence')).toHaveCount(40)
    await expect(page.locator('.transcript-sentence').first()).toHaveAttribute(
      'data-segment-id',
      's99960',
    )
    await expect(page.locator('.folded-region')).toHaveCount(0)
    await expect(last.locator('.sentence-number')).not.toBeVisible()
    expect(await clock(page)).toEqual(before)
    await expect(page.locator('.follow-state')).toHaveText('自由阅读')
    await page.screenshot({ path: info.outputPath('last-hit-small.png') })
    await search(page, '跨句链接')
    await expect(page.locator('.transcript-search')).toContainText('共 1 处结果')
    await page.locator('.transcript-search-results button').click()
    await expect(page.locator('.transcript-sentence[data-segment-id="s59999"]')).toHaveAttribute(
      'data-search-hit',
      'true',
    )
    await expect(page.locator('.transcript-sentence[data-segment-id="s59999"]')).toBeInViewport()
    const nextScreen = page
      .getByRole('navigation', { name: '文稿翻页', exact: true })
      .getByRole('button', { name: '下一页', exact: true })
    const screens = Number(
      await page
        .getByRole('region', { name: '文稿阅读区', exact: true })
        .getAttribute('data-pages'),
    )
    // The search range straddles a data-window boundary. Advance actual screens,
    // allowing the first sentence itself to occupy the last screen of its window.
    for (
      let screen = 0;
      screen <= screens &&
      (await page.locator('.transcript-sentence').first().getAttribute('data-segment-id')) !==
        's60000';
      screen++
    )
      await nextScreen.click()
    await expect(page.locator('.transcript-sentence').first()).toHaveAttribute(
      'data-segment-id',
      's60000',
    )
    await expect(page.locator('.transcript-sentence')).toHaveCount(60)
    await expect(page.locator('.transcript-sentence[data-segment-id="s60000"]')).toHaveAttribute(
      'data-search-hit',
      'true',
    )
    await expect(page.locator('.transcript-sentence[data-segment-id="s60000"]')).toBeInViewport()
    expect(await clock(page)).toEqual(before)
    await page.getByRole('button', { name: '回到当前播放位置', exact: true }).click()
    await expect(page.locator('.transcript-sentence[aria-current="true"]')).toBeInViewport({
      ratio: 1,
    })
    await expect(page.locator('.transcript-sentence[data-search-hit]')).toHaveCount(0)
    const stored = await page.evaluate((target) => window.desktop.getTranscript(target), t.target)
    expect(stored.ok && stored.value.status === 'ready' && stored.value.transcript.revision).toBe(1)
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('correction, generated preview, import and episode switching invalidate transcript search snapshots', async () => {
  const t = await fixture(3, true),
    { app, page } = await launch(t.root)
  try {
    await search(page, '继续')
    await expect(page.locator('.transcript-search')).toContainText('共 1 处结果')
    await page.locator('.transcript-search-results button').click()
    await openCompanionProofreading(page)
    await page.getByRole('button', { name: '编辑第 1 句', exact: true }).click()
    await page.getByRole('textbox', { name: '纠正这句文字' }).fill('山路的故事正在开始。')
    await page.getByRole('button', { name: '保存纠错', exact: true }).click()
    await openCompanionTools(page)
    await expect(page.locator('.companion-drawer[data-panel=tools]')).toContainText('版本 2')
    await closeCompanionPanel(page)
    await expect(page.locator('.transcript-search')).not.toBeVisible()
    await expect(page.locator('.transcript-sentence[data-search-hit]')).toHaveCount(0)
    await search(page, '继续')
    await expect(page.locator('.transcript-search')).toContainText('共 0 处结果')
    await search(page, '开始')
    await expect(page.locator('.transcript-search')).toContainText('共 1 处结果')
    await toggleCompanionGeneration(page)
    await page.getByRole('button', { name: '预览生成稿', exact: true }).click()
    await openCompanionTools(page)
    await expect(page.locator('.companion-drawer[data-panel=tools]')).toContainText('生成稿预览')
    await closeCompanionPanel(page)
    await expect(page.locator('.transcript-search-results li')).toHaveCount(0)
    await search(page, '预览专用')
    await expect(page.locator('.transcript-search')).toContainText('共 1 处结果')
    await openCompanionTools(page)
    await page.getByRole('button', { name: '返回当前文稿', exact: true }).click()
    await closeCompanionPanel(page)
    await expect(page.locator('.transcript-search-results li')).toHaveCount(0)
    await search(page, '开始')
    const replacement = join(t.root, '替换文稿.json')
    writeFileSync(
      replacement,
      JSON.stringify({
        ...t.document,
        segments: [{ id: 'new', startMs: 0, endMs: 1000, text: '重新导入后的专用文字。' }],
      }),
    )
    await choose(app, replacement)
    await openTranscriptImport(page)
    await page.getByRole('button', { name: '重新导入文稿', exact: true }).click()
    await openCompanionTools(page)
    await expect(page.locator('.companion-drawer[data-panel=tools]')).toContainText('版本 3')
    await closeCompanionPanel(page)
    await expect(page.locator('.transcript-search-results li')).toHaveCount(0)
    await search(page, '专用文字')
    await expect(page.locator('.transcript-search')).toContainText('共 1 处结果')
    await leaveCompanionPage(page)
    await page.getByRole('button', { name: /^我的书架/ }).click()
    await page.getByRole('button', { name: /^打开 .+ 的目录$/ }).click()
    await page
      .getByRole('button', { name: `播放第 2 集 ${t.episodes[1]!.title}`, exact: true })
      .click()
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    await expect(page.locator('.companion-title > span')).toHaveText(t.episodes[1]!.title)
    await expect(page.locator('.transcript-search-results li')).toHaveCount(0)
    await search(page, '另一集')
    await expect(page.locator('.transcript-search')).toContainText('共 1 处结果')
  } finally {
    await app.close()
  }
})

test('late real-worker responses are ignored after cancellation and a document revision', async () => {
  const t = await fixture(),
    { app, page } = await launch(t.root)
  try {
    // Hold actual computed worker results at the event boundary; never fabricate result data.
    await page.evaluate(() => {
      const NativeWorker = window.Worker
      window.Worker = new Proxy(NativeWorker, {
        construct(constructor, args) {
          const engine = Reflect.construct(constructor, args) as Worker
          engine.addEventListener('message', (event) => {
            if (event.data?.type !== 'result' || !Reflect.get(window, 'deferTranscriptSearch'))
              return
            event.stopImmediatePropagation()
            const result = event.data
            Reflect.set(window, 'deferredSearchQuery', result.page.query)
            Reflect.set(window, 'releaseDeferredSearch', () => {
              Reflect.set(window, 'deferTranscriptSearch', false)
              engine.dispatchEvent(new MessageEvent('message', { data: result }))
              Reflect.deleteProperty(window, 'releaseDeferredSearch')
            })
          })
          return engine
        },
      })
    })
    const holdSearch = async () => {
      await openCompanionSearch(page)
      await page.evaluate(() => Reflect.set(window, 'deferTranscriptSearch', true))
      const details = page.locator('.transcript-search')
      await expect(details).toHaveAttribute('open', '')
      await page.getByRole('textbox', { name: '文稿搜索文字' }).fill('继续')
      await expect(page.getByRole('button', { name: '搜索文稿', exact: true })).toBeEnabled()
      await page.getByRole('button', { name: '搜索文稿', exact: true }).click()
      await expect
        .poll(() => page.evaluate(() => typeof Reflect.get(window, 'releaseDeferredSearch')))
        .toBe('function')
      expect(await page.evaluate(() => Reflect.get(window, 'deferredSearchQuery'))).toBe('继续')
    }
    const release = () => page.evaluate(() => Reflect.get(window, 'releaseDeferredSearch')())
    await holdSearch()
    await page.getByRole('button', { name: '取消文稿搜索', exact: true }).click()
    await expect(page.getByRole('button', { name: '搜索文稿', exact: true })).toBeEnabled()
    await release()
    await expect(page.locator('.transcript-search-results li')).toHaveCount(0)
    await search(page, '窗外')
    await expect(page.locator('.transcript-search')).toContainText('共 1 处结果')
    await holdSearch()
    await openCompanionProofreading(page)
    await page.getByRole('button', { name: '编辑第 1 句', exact: true }).click()
    await page.getByRole('textbox', { name: '纠正这句文字' }).fill('山路的故事正在开始。')
    await page.getByRole('button', { name: '保存纠错', exact: true }).click()
    await openCompanionTools(page)
    await expect(page.locator('.companion-drawer[data-panel=tools]')).toContainText('版本 2')
    await closeCompanionPanel(page)
    await release()
    await expect(page.locator('.transcript-search-results li')).toHaveCount(0)
    await search(page, '继续')
    await expect(page.locator('.transcript-search')).toContainText('共 0 处结果')
    await search(page, '开始')
    await expect(page.locator('.transcript-search')).toContainText('共 1 处结果')
  } finally {
    await app.close()
  }
})

test('worker load failure can be retried while ordinary playback and search navigation retain the media clock', async () => {
  const t = await fixture(),
    { app, page } = await launch(t.root)
  try {
    await app.evaluate(({ session }) => {
      session.defaultSession.webRequest.onBeforeRequest((details, done) =>
        done({ cancel: details.url.includes('transcript-search-worker') }),
      )
    })
    await openCompanionSearch(page)
    await expect(page.getByRole('button', { name: '重试文稿搜索', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '播放', exact: true }).click()
    const before = await clock(page)
    await app.evaluate(({ session }) => {
      session.defaultSession.webRequest.onBeforeRequest(null)
    })
    await page.getByRole('button', { name: '重试文稿搜索', exact: true }).click()
    await search(page, '山路')
    await page.locator('.transcript-search-results button').click()
    const after = await clock(page)
    expect(after.paused).toBe(false)
    expect(after.positionMs).toBeGreaterThan(before.positionMs)
    expect(after.positionMs - before.positionMs).toBeLessThan(5000)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
  } finally {
    await app.close()
  }
})
