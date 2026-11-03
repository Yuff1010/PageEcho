import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CHANNELS, type PlaybackSource, type Result } from '../../src/shared/contracts'
import { pluginPackage } from '../fixtures/source-plugin'
import { closeOwnedElectron } from '../model/electron-lifecycle'
import { setVolume } from '../helpers/ui'

const title = '渐进播放合成书',
  pluginId = 'synthetic.progressive'
const audioSelector = 'audio[data-player="persistent"]'
const PREFIX = 32 * 1024

async function sourceFixture() {
  const bytes = readFileSync(resolve('tests/fixtures/tone.mp3'))
  const changed = Buffer.from(bytes)
  changed[30] = changed[30]! ^ 1 // Change ID3 encoder metadata, retaining valid MP3 frames and length.
  const root = mkdtempSync(join(tmpdir(), 'pageecho progressive source '))
  let origin = '',
    differentPrefix = false
  const requests: {
    chapter: number
    sent: number
    finished: boolean
    aborted: boolean
    range?: string
  }[] = []
  const held = new Set<{
    response: ServerResponse
    bytes: Buffer
    entry: (typeof requests)[number]
  }>()
  const book = () => ({
    id: 'book-a',
    title,
    authors: ['合成作者'],
    narrators: [],
    description: '项目合成音频，仅本机回归。',
    pageUrl: `${origin}/audio/book`,
  })
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const json = (value: unknown) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (url.pathname === '/audio/search') return json({ items: [book()], nextCursor: null })
    if (url.pathname === '/audio/book') return json(book())
    if (url.pathname === '/audio/chapters')
      return json({
        items: [1, 2].map((index) => ({
          id: `chapter-${index}`,
          title: `渐进第${index}集`,
          order: index,
          pageUrl: `${origin}/audio/chapter-${index}`,
        })),
        nextCursor: null,
      })
    if (url.pathname === '/audio/resolve') {
      const chapter = url.searchParams.get('chapter')?.endsWith('2') ? 2 : 1
      return json({
        url: `${origin}/media/${chapter}.mp3`,
        pageUrl: `${origin}/audio/chapter-${chapter}`,
        headers: {},
        expiresAt: null,
      })
    }
    const media = /^\/media\/([12])\.mp3$/.exec(url.pathname)
    if (media) {
      const value = differentPrefix ? changed : bytes
      const entry = {
        chapter: Number(media[1]),
        sent: PREFIX,
        finished: false,
        aborted: false,
        range: request.headers.range,
      }
      requests.push(entry)
      response.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(value.length),
      })
      response.write(value.subarray(0, PREFIX))
      const item = { response, bytes: value, entry }
      held.add(item)
      response.on('close', () => {
        entry.aborted = !response.writableEnded
        held.delete(item)
      })
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Missing fixture server')
  origin = `http://127.0.0.1:${address.port}`
  const path = join(root, 'plugin.zip')
  writeFileSync(path, pluginPackage(origin, { id: pluginId, name: '渐进合成插件' }))
  return {
    path,
    requests,
    bytes,
    setDifferentPrefix() {
      differentPrefix = true
    },
    advance(chapter: number, end: number) {
      for (const item of held)
        if (item.entry.chapter === chapter && !item.response.destroyed) {
          item.response.write(item.bytes.subarray(item.entry.sent, end))
          item.entry.sent = end
        }
    },
    finish(chapter: number) {
      for (const item of held)
        if (item.entry.chapter === chapter && !item.response.destroyed) {
          item.response.end(item.bytes.subarray(item.entry.sent))
          item.entry.sent = item.bytes.length
          item.entry.finished = true
        }
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}
function database(root: string) {
  return join(root, 'data/library.sqlite3')
}
function sql(root: string, episodeId: string) {
  const db = new DatabaseSync(database(root), { readOnly: true })
  try {
    const audio = db
      .prepare('SELECT content_hash AS hash,position_ms AS position FROM episodes WHERE id=?')
      .get(episodeId)
    const pending = db
      .prepare(
        'SELECT position_ms AS position,prefix_bytes AS bytes,total_bytes AS total FROM online_pending_progress WHERE episode_id=?',
      )
      .get(episodeId)
    return {
      audio: audio ? { hash: String(audio.hash), position: Number(audio.position) } : null,
      pending: pending
        ? {
            position: Number(pending.position),
            bytes: Number(pending.bytes),
            total: Number(pending.total),
          }
        : null,
      jobs: Number(db.prepare('SELECT count(*) AS amount FROM transcription_jobs').get()!.amount),
      transcripts: Number(db.prepare('SELECT count(*) AS amount FROM transcripts').get()!.amount),
    }
  } finally {
    db.close()
  }
}
async function launch(root: string) {
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({
    ...(process.env.RALB_EXECUTABLE
      ? { executablePath: resolve(process.env.RALB_EXECUTABLE), args: [] }
      : { args: [resolve(process.env.RALB_APP_ROOT ?? '.')] }),
    env,
  })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.webContents.setAudioMuted(true),
  )
  return { app, page }
}
async function addBook(app: ElectronApplication, page: Page, path: string) {
  await page.getByRole('button', { name: '在线书源', exact: true }).click()
  await page.getByRole('tab', { name: '插件', exact: true }).click()
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, path)
  await page.getByRole('button', { name: '从 ZIP 导入插件', exact: true }).click()
  await page.getByRole('button', { name: '确认安装插件', exact: true }).click()
  await expect(page.getByRole('article', { name: '插件 渐进合成插件', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: '有声书', exact: true }).click()
  await page
    .getByRole('combobox', { name: '有声书来源', exact: true })
    .selectOption(`plugin:${pluginId}:audio`)
  await page.getByRole('searchbox', { name: '搜索书籍', exact: true }).fill('合成')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByRole('button', { name: `查看 ${title} 的详情`, exact: true }).click()
  await page.getByRole('button', { name: '加入书架', exact: true }).click()
  await expect(page.getByRole('button', { name: '更新书架目录', exact: true })).toBeEnabled()
  const result = await page.evaluate(() => window.desktop.getState())
  if (!result.ok) throw Error(result.error.message)
  const book = result.value.books.find(
    (book) => book.online?.sourceId === `plugin:${pluginId}:audio`,
  )!
  const settings = await page.evaluate(
    (id) =>
      window.desktop.setSubtitlePreparation({
        id,
        settings: { mode: 'auto', engine: 'paraformer', device: 'cpu', prepareNext: false },
      }),
    book.id,
  )
  expect(settings.ok).toBe(true)
  await setVolume(page, '0')
  return book
}
async function playChapter(page: Page, number: number) {
  await page.getByRole('button', { name: `缓存并播放 渐进第${number}集`, exact: true }).click()
}
async function position(page: Page) {
  return page.locator(audioSelector).evaluate((audio: HTMLAudioElement) => audio.currentTime)
}
async function releaseTestGates(app: ElectronApplication) {
  await app
    .evaluate(() => {
      for (const name of ['releaseProgressiveState', 'releaseProgressiveOpen'])
        (Reflect.get(globalThis, name) as (() => void) | undefined)?.()
    })
    .catch(() => {})
}

test('real Main starts gated MP3 before full download; pause retains caching and full hash handoff keeps the audio element and position', async ({}, info) => {
  test.setTimeout(60000)
  const source = await sourceFixture(),
    root = mkdtempSync(join(tmpdir(), 'pageecho progressive main '))
  const { app, page } = await launch(root)
  try {
    const book = await addBook(app, page, source.path),
      episode = book.episodes[0]!
    await page.evaluate(() =>
      window.desktop.onPlaybackSourceChanged((change) =>
        Reflect.set(window, 'progressiveLastChange', change),
      ),
    )
    await playChapter(page, 1)
    await expect.poll(() => position(page)).toBeGreaterThan(0.12)
    expect(source.requests).toHaveLength(1)
    expect(source.requests[0]!.finished).toBe(false)
    expect(source.requests[0]!.sent).toBe(PREFIX)
    const before = sql(root, episode.id)
    expect(before.audio).toBeNull()
    expect(before.jobs).toBe(0)
    expect(before.transcripts).toBe(0)
    const audio = page.locator(audioSelector),
      url = await audio.getAttribute('src')
    expect(url).toMatch(/^readlisten:\/\/app\/stream\/[0-9a-f-]+$/)
    await audio.evaluate((element) => {
      Reflect.set(window, 'progressiveOriginalAudio', element)
      Reflect.set(window, 'progressiveReloads', 0)
      element.addEventListener('loadstart', () =>
        Reflect.set(
          window,
          'progressiveReloads',
          Number(Reflect.get(window, 'progressiveReloads')) + 1,
        ),
      )
    })
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    const reader = page.getByRole('region', { name: '同步伴读', exact: true })
    const toolbar = reader.locator('.companion-toolbar')
    await expect(toolbar.getByRole('heading', { name: title, level: 2, exact: true })).toBeVisible()
    const chrome = () =>
      toolbar.evaluate((element) => {
        const heading = element.querySelector('.reader-toolbar-title > h2')!
        const style = getComputedStyle(heading)
        return {
          height: element.getBoundingClientRect().height,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
        }
      })
    const pendingChrome = await chrome()
    expect(sql(root, episode.id).jobs).toBe(0)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    const paused = await position(page)
    await expect.poll(() => sql(root, episode.id).pending?.position).toBeGreaterThan(0)
    source.advance(1, PREFIX + 8192)
    await expect
      .poll(() =>
        page.evaluate(() => {
          const change = Reflect.get(window, 'progressiveLastChange') as
            { status: string; receivedBytes?: number } | undefined
          return change?.status === 'pending' ? change.receivedBytes : 0
        }),
      )
      .toBeGreaterThan(PREFIX)
    expect(source.requests[0]!.aborted).toBe(false)
    source.finish(1)
    const expectedHash = createHash('sha256').update(source.bytes).digest('hex')
    await expect.poll(() => sql(root, episode.id).audio?.hash).toBe(expectedHash)
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (Reflect.get(window, 'progressiveLastChange') as { status?: string } | undefined)
              ?.status,
        ),
      )
      .toBe('ready')
    expect(await audio.getAttribute('src')).toBe(url)
    expect(
      await audio.evaluate(
        (element) => Reflect.get(window, 'progressiveOriginalAudio') === element,
      ),
    ).toBe(true)
    expect(await page.evaluate(() => Reflect.get(window, 'progressiveReloads'))).toBe(0)
    expect(await position(page)).toBeCloseTo(paused, 1)
    await expect
      .poll(() => Math.abs(sql(root, episode.id).audio!.position - paused * 1000))
      .toBeLessThan(5)
    await expect(toolbar.getByRole('button', { name: '伴读阅读设置', exact: true })).toBeVisible()
    await expect(toolbar.getByRole('heading', { name: title, level: 2, exact: true })).toBeVisible()
    const completeChrome = await chrome()
    expect(completeChrome.height).toBeCloseTo(pendingChrome.height, 1)
    expect(completeChrome.fontSize).toBe(pendingChrome.fontSize)
    expect(completeChrome.lineHeight).toBe(pendingChrome.lineHeight)
    expect(sql(root, episode.id).pending).toBeNull()
    expect(source.requests.every((item) => item.range === undefined)).toBe(true)
    await info.attach('real-progressive-handoff.json', {
      body: JSON.stringify({
        before,
        after: sql(root, episode.id),
        requests: source.requests,
        url,
        paused,
        pendingChrome,
        completeChrome,
      }),
      contentType: 'application/json',
    })
  } finally {
    await closeOwnedElectron(app)
    await source.close()
  }
})

test('unbuffered far seek is not saved as confirmed progress; exit preserves the safe snapshot and a changed prefix restarts from zero', async ({}, info) => {
  test.setTimeout(60000)
  const source = await sourceFixture(),
    root = mkdtempSync(join(tmpdir(), 'pageecho progressive restart '))
  let { app, page } = await launch(root)
  let closed = false
  try {
    const book = await addBook(app, page, source.path),
      episode = book.episodes[0]!
    await playChapter(page, 1)
    await expect.poll(() => position(page)).toBeGreaterThan(0.45)
    await page.getByRole('slider', { name: '播放进度', exact: true }).fill('18000')
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await expect.poll(() => sql(root, episode.id).pending !== null).toBe(true)
    const paused = sql(root, episode.id).pending!
    expect(paused.position).toBeGreaterThan(0)
    expect(paused.position).toBeLessThan(3000)
    expect(paused.bytes).toBe(PREFIX)
    expect(
      await page
        .locator(audioSelector)
        .evaluate((audio: HTMLAudioElement) => audio.seeking || audio.currentTime >= 17),
    ).toBe(true)
    await closeOwnedElectron(app)
    closed = true
    const exited = sql(root, episode.id).pending!
    expect(exited.position).toBeLessThan(3000)
    expect(sql(root, episode.id).audio).toBeNull()
    source.setDifferentPrefix()
    ;({ app, page } = await launch(root))
    closed = false
    await expect.poll(() => source.requests.filter((item) => item.chapter === 1).length).toBe(2)
    source.finish(1)
    await expect.poll(() => sql(root, episode.id).audio?.hash).toMatch(/^[0-9a-f]{64}$/)
    await expect
      .poll(() =>
        page.locator(audioSelector).evaluate((audio: HTMLAudioElement) => audio.readyState),
      )
      .toBeGreaterThanOrEqual(1)
    expect(sql(root, episode.id).audio!.position).toBe(0)
    expect(sql(root, episode.id).pending).toBeNull()
    expect(await position(page)).toBeLessThan(0.2)
    await info.attach('pending-progress-restart.json', {
      body: JSON.stringify({
        paused,
        exited,
        resumed: sql(root, episode.id),
        requests: source.requests,
      }),
      contentType: 'application/json',
    })
  } finally {
    if (!closed) await closeOwnedElectron(app)
    await source.close()
  }
})

test('metadata can start playback while state IPC is held, and a source reply arriving after UI stop releases its opaque stream', async ({}, info) => {
  test.setTimeout(60000)
  const source = await sourceFixture(),
    root = mkdtempSync(join(tmpdir(), 'pageecho progressive races '))
  const { app, page } = await launch(root)
  try {
    const book = await addBook(app, page, source.path)
    await app.evaluate(({ ipcMain }, channel) => {
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
        string,
        (...args: unknown[]) => unknown
      >
      const original = handlers.get(channel)!
      let once = false
      handlers.set(channel, async (...args) => {
        const result = await original(...args)
        if (!once) {
          once = true
          await new Promise<void>((done) =>
            Reflect.set(globalThis, 'releaseProgressiveState', done),
          )
        }
        return result
      })
    }, CHANNELS.playbackSourceState)
    await playChapter(page, 1)
    await expect
      .poll(() => app.evaluate(() => typeof Reflect.get(globalThis, 'releaseProgressiveState')))
      .toBe('function')
    await expect.poll(() => position(page)).toBeGreaterThan(0.12)
    expect(source.requests[0]!.finished).toBe(false)
    await releaseTestGates(app)
    await app.evaluate(({ ipcMain }, channel) => {
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
        string,
        (...args: unknown[]) => unknown
      >
      const original = handlers.get(channel)!
      handlers.set(channel, async (...args) => {
        const result = (await original(...args)) as Result<PlaybackSource>
        if (result.ok) {
          Reflect.set(globalThis, 'heldProgressiveSource', {
            sessionId: result.value.sessionId,
            url: result.value.url,
          })
          await new Promise<void>((done) => Reflect.set(globalThis, 'releaseProgressiveOpen', done))
        }
        return result
      })
    }, CHANNELS.openEpisode)
    await playChapter(page, 2)
    await expect
      .poll(() => app.evaluate(() => typeof Reflect.get(globalThis, 'releaseProgressiveOpen')))
      .toBe('function')
    const held = await app.evaluate(
      () => Reflect.get(globalThis, 'heldProgressiveSource') as { sessionId: string; url: string },
    )
    expect(sql(root, book.episodes[0]!.id).pending?.bytes).toBe(PREFIX)
    expect(sql(root, book.episodes[0]!.id).audio).toBeNull()
    expect(source.requests.find((request) => request.chapter === 1)?.aborted).toBe(true)
    await page.getByRole('button', { name: '我的书架', exact: true }).click()
    await page.getByRole('button', { name: `更多 ${title} 的操作`, exact: true }).click()
    await page.getByRole('menuitem', { name: `移除 ${title} 的记录`, exact: true }).click()
    await page
      .getByRole('dialog', { name: '确认移除书籍', exact: true })
      .getByRole('button', { name: '确认移除记录', exact: true })
      .click()
    await expect(page.getByRole('dialog', { name: '确认移除书籍', exact: true })).toBeHidden()
    await releaseTestGates(app)
    await expect
      .poll(() =>
        app.evaluate(async ({ net }, url) => {
          const response = await net.fetch(url, { method: 'HEAD' })
          await response.body?.cancel()
          return response.status
        }, held.url),
      )
      .toBe(404)
    const latest = await page.evaluate(
      (sessionId) => window.desktop.getPlaybackSourceState({ sessionId }),
      held.sessionId,
    )
    expect(latest.ok && latest.value === null).toBe(true)
    await info.attach('late-source-released.json', {
      body: JSON.stringify({ held, requests: source.requests }),
      contentType: 'application/json',
    })
  } finally {
    await releaseTestGates(app)
    await closeOwnedElectron(app)
    await source.close()
  }
})
