import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { closeOwnedElectron } from '../model/electron-lifecycle'
import { LibraryStore } from '../../src/main/database'
import { createDataPaths } from '../../src/main/paths'
import { syntheticCredentials } from '../helpers/synthetic-auth'

const credentials = syntheticCredentials()
const expectedAuthorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`
const bookEntry = (title = '河岸来信') =>
  `<entry><id>urn:synthetic:river</id><title>${title}</title><author><name>合成测试作者</name></author><summary>此书为回归测试生成，不含下载作品。</summary><link rel="http://opds-spec.org/acquisition/open-access" type="text/plain" href="/books/river.txt" /></entry>`
const feed = (entries: string, extras = '') =>
  `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>urn:synthetic:catalog</id><title>本地测试书库</title><updated>2026-10-29T00:00:00Z</updated><link rel="search" type="application/atom+xml" href="/search?q={searchTerms}" />${extras}${entries}</feed>`

async function catalog() {
  const requests: { path: string; authorized: boolean }[] = []
  const held = new Set<ServerResponse>()
  let slowRequests = 0
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const authorized = request.headers.authorization === expectedAuthorization
    requests.push({ path: url.pathname + url.search, authorized })
    if (!authorized) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' })
      response.end('Credentials required')
      return
    }
    if (url.pathname === '/missing') {
      response.writeHead(503, { 'Content-Type': 'text/plain' })
      response.end('Synthetic unavailable source')
      return
    }
    if (url.pathname === '/books/river.txt') {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(
        `第1章 河岸来信\n${Array.from({ length: 200 }, (_, index) => `第${index + 1}封信沿着河流抵达村庄。清晨的阳光穿过树叶，河水映着远方的山。每个人的故事都在新的纸页上继续。`).join('\n')}\n第2章 清晨\n第二天，他们继续沿河前进。`,
      )
      return
    }
    if (
      url.pathname === '/search' &&
      ['slow', 'switch'].includes(url.searchParams.get('q') ?? '')
    ) {
      slowRequests++
      held.add(response)
      response.on('close', () => held.delete(response))
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/atom+xml; charset=utf-8' })
    if (url.pathname === '/catalog') {
      response.end(
        feed(
          '<entry><id>urn:synthetic:fiction</id><title>中文小说</title><link rel="subsection" type="application/atom+xml" href="/catalog/fiction" /></entry>',
        ),
      )
    } else if (url.pathname === '/catalog/fiction' || url.pathname === '/search') {
      response.end(feed(bookEntry()))
    } else {
      response.end(feed(''))
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No local OPDS listener')
  const baseUrl = `http://127.0.0.1:${address.port}`
  return {
    baseUrl,
    requests,
    slowRequests: () => slowRequests,
    release() {
      for (const response of held) {
        response.writeHead(200, { 'Content-Type': 'application/atom+xml; charset=utf-8' })
        response.end(feed(bookEntry('不应出现的旧结果')))
      }
      held.clear()
    },
    async close() {
      for (const response of held) response.destroy()
      server.closeAllConnections()
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      )
    },
  }
}

async function launch(root = mkdtempSync(join(tmpdir(), '听读来源中心 '))) {
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [resolve(process.env.RALB_APP_ROOT ?? '.')], env })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('button', { name: '在线书源', exact: true }).click()
  await expect(page.getByRole('region', { name: '来源中心', exact: true })).toBeVisible()
  return { app, page, errors }
}

async function personal(page: Page) {
  await page.getByRole('tab', { name: '我的书库', exact: true }).click()
}
async function connect(page: Page, baseUrl: string, name = '本地 OPDS') {
  await page.getByRole('button', { name: '连接书库', exact: true }).click()
  await page.getByRole('textbox', { name: '名称', exact: true }).fill(name)
  await page.getByRole('textbox', { name: '地址', exact: true }).fill(baseUrl)
  await page.getByRole('textbox', { name: '用户名', exact: true }).fill(credentials.username)
  await page.getByLabel('密码', { exact: true }).fill(credentials.password)
  await page.getByRole('button', { name: '保存书库连接', exact: true }).click()
  await expect(page.getByRole('heading', { name: '连接个人书库', exact: true })).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: '个人书库', exact: true })).toContainText(name)
  await expect(page.getByRole('button', { name: '浏览书库', exact: true })).toBeEnabled()
}
async function readerReady(page: Page) {
  await expect(page).toHaveURL(/#\/read\//)
  await expect(page.getByRole('region', { name: '电子书正文', exact: true })).toHaveAttribute(
    'aria-busy',
    'false',
  )
}
async function returnSources(page: Page) {
  await page.mouse.move(80, 15)
  await expect(page.locator('.reader-toolbar')).toHaveAttribute('data-visible', 'true')
  await page.getByRole('button', { name: '返回阅读书架', exact: true }).click()
  await page.getByRole('button', { name: '在线书源', exact: true }).click()
  await personal(page)
}
async function close(app: ElectronApplication, source: Awaited<ReturnType<typeof catalog>>) {
  try {
    await closeOwnedElectron(app)
  } finally {
    await source.close()
  }
}

test('source center uses exclusive keyboard tabs, accessible icon actions and write-only personal credentials', async ({}, info) => {
  const source = await catalog()
  const root = mkdtempSync(join(tmpdir(), '听读来源凭据恢复 '))
  const { app, page, errors } = await launch(root)
  let appClosed = false
  try {
    const panel = page.getByRole('tabpanel')
    await expect(panel).toHaveCount(1)
    await expect(panel.getByRole('combobox', { name: '有声书来源' })).toHaveCount(1)
    await expect(panel.getByRole('combobox', { name: '有声书来源' })).toContainText('LibriVox')
    const audio = page.getByRole('tab', { name: '有声书', exact: true })
    await audio.focus()
    await audio.press('ArrowRight')
    await expect(page.getByRole('tab', { name: '电子书', exact: true })).toBeFocused()
    await expect(panel.getByRole('combobox', { name: '电子书来源' })).toHaveCount(1)
    await expect(panel.getByRole('combobox', { name: '有声书来源' })).toHaveCount(0)
    await page.getByRole('tab', { name: '电子书', exact: true }).press('ArrowRight')
    await expect(page.getByRole('tab', { name: '我的书库', exact: true })).toBeFocused()
    await expect(panel.getByRole('combobox', { name: '个人书库' })).toHaveCount(1)
    await expect(panel.getByRole('combobox', { name: '电子书来源' })).toHaveCount(0)
    await connect(page, `${source.baseUrl}/catalog`)
    const privateConfig = readFileSync(join(root, 'data/text-libraries.json'), 'utf8')
    expect(privateConfig).not.toContain(credentials.password)
    expect(privateConfig).not.toContain(credentials.username)
    await expect(page.getByRole('button', { name: '编辑书库连接', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '书库管理', exact: true }).click()
    await page.getByRole('button', { name: '编辑书库连接', exact: true }).click()
    await expect(page.getByLabel('密码', { exact: true })).toHaveValue('')
    await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute(
      'placeholder',
      '已保存；留空保留',
    )
    await expect(page.getByRole('textbox', { name: '用户名', exact: true })).toHaveValue('')
    const publicState = await page.evaluate(() => window.desktop.textSources())
    expect(publicState.ok).toBe(true)
    expect(JSON.stringify(publicState)).not.toContain(credentials.password)
    expect(JSON.stringify(publicState)).not.toContain(credentials.username)
    if (publicState.ok) expect(publicState.value.libraries[0]?.hasCredentials).toBe(true)
    await page.getByRole('button', { name: '保存书库连接', exact: true }).click()
    await expect(page.getByRole('button', { name: '浏览书库', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '检测书库连接', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('连接可用')
    expect(
      source.requests.some((request) => request.path === '/catalog' && request.authorized),
    ).toBe(true)
    await page.getByRole('button', { name: '导入或更新来源清单', exact: true }).click()
    await page.getByRole('button', { name: '导出无凭据的来源清单', exact: true }).click()
    const manifestInput = page.getByRole('textbox', { name: '来源清单 JSON', exact: true })
    await expect(manifestInput).not.toHaveValue('')
    const exported = await manifestInput.inputValue()
    expect(exported).not.toContain(credentials.password)
    expect(exported).not.toContain(credentials.username)
    const manifest = JSON.parse(exported) as {
      libraries: { label: string }[]
    }
    manifest.libraries[0]!.label = '本地 OPDS（清单更新）'
    await manifestInput.fill(JSON.stringify(manifest))
    await page.getByRole('button', { name: '检查清单', exact: true }).click()
    await expect(page.getByRole('button', { name: '确认应用', exact: true })).toBeEnabled()
    await expect(page.getByRole('combobox', { name: '个人书库', exact: true })).not.toContainText(
      '本地 OPDS（清单更新）',
    )
    await page.getByRole('button', { name: '确认应用', exact: true }).click()
    await expect(page.getByRole('combobox', { name: '个人书库', exact: true })).toContainText(
      '本地 OPDS（清单更新）',
    )
    await page.getByRole('button', { name: '检测书库连接', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('连接可用')
    await page.getByRole('button', { name: '导入或更新来源清单', exact: true }).click()
    await page.getByRole('button', { name: '检查清单', exact: true }).click()
    await expect(page.getByRole('button', { name: '确认应用', exact: true })).toBeDisabled()
    await expect(page.getByText('此清单版本未高于已保存版本，不能覆盖。')).toBeVisible()
    await page.getByRole('button', { name: '导入或更新来源清单', exact: true }).click()
    await page.getByRole('button', { name: '书库管理', exact: true }).click()
    await page.getByRole('button', { name: '浏览书库', exact: true }).focus()
    await expect(page.getByRole('tooltip', { name: '浏览书库', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '浏览书库', exact: true })).toHaveText('')
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(720, 600),
    )
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({
      path: info.outputPath('source-center-personal-small.png'),
      animations: 'disabled',
    })
    expect(errors).toEqual([])
    await closeOwnedElectron(app)
    appClosed = true
    const restored = await launch(root)
    try {
      await personal(restored.page)
      await expect(
        restored.page.getByRole('combobox', { name: '个人书库', exact: true }),
      ).toContainText('本地 OPDS（清单更新）')
      const previousRequests = source.requests.length
      await restored.page.getByRole('button', { name: '浏览书库', exact: true }).click()
      await restored.page.getByRole('button', { name: '中文小说', exact: true }).click()
      await expect(
        restored.page.getByRole('button', { name: '查看 河岸来信 的电子书详情', exact: true }),
      ).toBeVisible()
      expect(
        source.requests
          .slice(previousRequests)
          .some((request) => request.path === '/catalog' && request.authorized),
      ).toBe(true)
      expect(restored.errors).toEqual([])
    } finally {
      await closeOwnedElectron(restored.app)
    }
  } finally {
    if (appClosed) await source.close()
    else await close(app, source)
  }
})

test('real OPDS browse, cancel, failed-source recovery and import preserve the same resource reading anchor', async ({}, info) => {
  test.setTimeout(120_000)
  const source = await catalog()
  const { app, page, errors } = await launch()
  try {
    await personal(page)
    await connect(page, `${source.baseUrl}/catalog`)
    await page.getByRole('button', { name: '浏览书库', exact: true }).click()
    await page.getByRole('button', { name: '中文小说', exact: true }).click()
    await expect(page.getByRole('heading', { name: '河岸来信', exact: true })).toBeVisible()
    const search = page.getByRole('searchbox', { name: '搜索电子书', exact: true })
    await search.fill('slow')
    await page.getByRole('button', { name: '搜索电子书', exact: true }).click()
    await expect.poll(source.slowRequests).toBe(1)
    await page.getByRole('button', { name: '取消读取', exact: true }).click()
    await expect(
      page.getByRole('region', { name: '来源中心', exact: true }).getByRole('status'),
    ).toContainText('已取消读取')
    source.release()
    await expect(page.getByRole('heading', { name: '不应出现的旧结果', exact: true })).toHaveCount(
      0,
    )
    await search.fill('switch')
    await page.getByRole('button', { name: '搜索电子书', exact: true }).click()
    await expect.poll(source.slowRequests).toBe(2)
    await page.getByRole('tab', { name: '有声书', exact: true }).click()
    source.release()
    await expect(
      page.getByRole('tabpanel').getByRole('combobox', { name: '有声书来源' }),
    ).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await personal(page)
    await connect(page, `${source.baseUrl}/missing`, '暂时不可用')
    await page.getByRole('button', { name: '浏览书库', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('503')
    await page
      .getByRole('combobox', { name: '个人书库', exact: true })
      .selectOption({ label: '本地 OPDS' })
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.getByRole('button', { name: '浏览书库', exact: true }).click()
    await page.getByRole('button', { name: '中文小说', exact: true }).click()
    await page.getByRole('button', { name: '查看 河岸来信 的电子书详情', exact: true }).click()
    await page.getByRole('button', { name: '导入并阅读所选正文', exact: true }).click()
    await readerReady(page)
    const readerUrl = page.url()
    await page.locator('.book-viewport').press('ArrowRight')
    const position = () =>
      page.locator('.reader-progress-label').getAttribute('data-position').then(Number)
    await expect.poll(position).toBeGreaterThan(0)
    const saved = await position()
    await expect
      .poll(async () => {
        const result = await page.evaluate(() => window.desktop.getReadingBooks())
        return result.ok ? result.value[0]?.position : -1
      })
      .toBe(saved)
    await returnSources(page)
    await page
      .getByRole('combobox', { name: '个人书库', exact: true })
      .selectOption({ label: '本地 OPDS' })
    await page.getByRole('button', { name: '浏览书库', exact: true }).click()
    await page.getByRole('button', { name: '中文小说', exact: true }).click()
    await page.getByRole('button', { name: '查看 河岸来信 的电子书详情', exact: true }).click()
    await page.getByRole('button', { name: '导入并阅读所选正文', exact: true }).click()
    await readerReady(page)
    expect(page.url()).toBe(readerUrl)
    expect(await position()).toBe(saved)
    const imported = await page.evaluate(() => window.desktop.getReadingBooks())
    expect(imported.ok && imported.value).toHaveLength(1)
    expect(
      source.requests.some((request) => request.path === '/books/river.txt' && request.authorized),
    ).toBe(true)
    await page.screenshot({
      path: info.outputPath('opds-import-restored-reader.png'),
      animations: 'disabled',
    })
    expect(errors).toEqual([])
  } finally {
    await close(app, source)
  }
})

async function audioCatalog() {
  const bytes = readFileSync(resolve('tests/fixtures/tone.mp3'))
  const requests: { path: string; referer: string }[] = []
  const held = new Set<ServerResponse>()
  let slowRequests = 0
  const record = (id = '52', title = 'LibriVox 合成书目') => ({
    id,
    title,
    description: '只用于回归的合成书目与合成静音。',
    authors: [{ first_name: 'Synthetic', last_name: 'Author' }],
    url_librivox: 'https://librivox.org/synthetic-source-center/',
    num_sections: '1',
    sections: [
      {
        id: '701',
        section_number: '1',
        title: '合成音频第一集',
        listen_url: 'https://archive.org/download/ralb_synthetic/tone.mp3',
        readers: [{ display_name: 'Synthetic Reader' }],
      },
    ],
  })
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    requests.push({
      path: url.pathname + url.search,
      referer: String(request.headers.referer ?? ''),
    })
    if (url.pathname === '/download/ralb_synthetic/tone.mp3') {
      response.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(bytes.length),
      })
      response.end(bytes)
      return
    }
    if (url.pathname === '/api/feed/audiobooks/' && url.searchParams.get('title') === 'slow') {
      slowRequests++
      held.add(response)
      response.on('close', () => held.delete(response))
      return
    }
    if (url.pathname === '/api/feed/audiobooks/') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ books: [record()] }))
      return
    }
    response.writeHead(404)
    response.end('Unknown synthetic fixture')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No synthetic audio listener')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    slowRequests: () => slowRequests,
    hash: createHash('sha256').update(bytes).digest('hex'),
    release() {
      for (const response of held) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ books: [record('99', '不可覆盖的旧搜索结果')] }))
      }
      held.clear()
    },
    async close() {
      for (const response of held) response.destroy()
      server.closeAllConnections()
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      )
    },
  }
}

test('LibriVox selection routes real search, catalog, cache and playback independently of identical Ting13 IDs', async () => {
  test.setTimeout(90_000)
  const root = mkdtempSync(join(tmpdir(), '听读多音频来源 '))
  const source = await audioCatalog()
  const fixturePath = resolve('tests/fixtures/tone.mp3')
  const fixtureStat = statSync(fixturePath)
  const store = new LibraryStore(createDataPaths(root).database)
  const seedId = store.rememberSourceBook(
    {
      sourceId: 'ting13',
      id: '52',
      title: '同号 Ting13 原书',
      authors: [],
      narrators: [],
      description: '',
      pageUrl: 'https://www.ting13.cc/youshengxiaoshuo/52/',
    },
    [
      {
        sourceId: 'ting13',
        bookId: '52',
        id: '701',
        title: '同号原书第一集',
        order: 1,
        pageUrl: 'https://www.ting13.cc/youshengxiaoshuo/52/',
      },
    ],
    true,
  )
  const seedEpisode = store.listBooks()[0]!.episodes[0]!
  store.cacheSourceEpisode(seedEpisode.id, {
    path: fixturePath,
    name: seedEpisode.title,
    sizeBytes: fixtureStat.size,
    modifiedAt: fixtureStat.mtimeMs,
    contentHash: source.hash,
  })
  store.setSubtitlePreparation(seedId, {
    mode: 'manual',
    engine: 'paraformer',
    device: 'cpu',
    prepareNext: false,
  })
  store.saveProgress({
    episodeId: seedEpisode.id,
    sessionId: '',
    positionMs: 3700,
    durationMs: 20000,
    rate: 1,
    volume: 0,
  })
  store.close()
  const { app, page, errors } = await launch(root)
  try {
    // The adapters, registry, IPC, cache and media protocol remain production code.
    // Only the two providers' network transport is replaced with a local HTTP fixture.
    await app.evaluate(({ session }, fixtureBaseUrl) => {
      const originalFetch = globalThis.fetch.bind(globalThis)
      Reflect.set(globalThis, 'sourceCenterOriginalFetch', originalFetch)
      Reflect.set(globalThis, 'sourceCenterBlockedTing13Requests', 0)
      globalThis.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (['librivox.org', 'archive.org'].includes(url.hostname)) {
          return originalFetch(new URL(url.pathname + url.search, fixtureBaseUrl).href, init)
        }
        return originalFetch(input, init)
      }
      session
        .fromPartition('persist:readlisten-source-ting13')
        .webRequest.onBeforeSendHeaders(
          { urls: ['https://www.ting13.cc/*'] },
          (_details, callback) => {
            Reflect.set(
              globalThis,
              'sourceCenterBlockedTing13Requests',
              Number(Reflect.get(globalThis, 'sourceCenterBlockedTing13Requests')) + 1,
            )
            callback({ cancel: true })
          },
        )
    }, source.baseUrl)
    const select = page.getByRole('combobox', { name: '有声书来源', exact: true })
    await select.selectOption('librivox')
    await expect(page.getByRole('searchbox', { name: '搜索书籍', exact: true })).toHaveAttribute(
      'maxlength',
      '200',
    )
    await page
      .getByRole('searchbox', { name: '搜索书籍', exact: true })
      .fill('A longer title with more than twenty characters')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await page.getByRole('button', { name: '查看 LibriVox 合成书目 的详情', exact: true }).click()
    await expect(
      page.getByText('Synthetic Author · Synthetic Reader', { exact: true }),
    ).toBeVisible()
    await expect(page.getByText('已读取 1 集', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '加入书架', exact: true }).click()
    await expect(page.getByRole('button', { name: '更新书架目录', exact: true })).toBeVisible()
    const added = await page.evaluate(() => window.desktop.getState())
    expect(added.ok).toBe(true)
    if (!added.ok) throw new Error(added.error.message)
    const libri = added.value.books.find((book) => book.online?.sourceId === 'librivox')!
    const original = added.value.books.find((book) => book.online?.sourceId === 'ting13')!
    expect(added.value.books).toHaveLength(2)
    expect(libri.online?.bookId).toBe('52')
    expect(original.online?.bookId).toBe('52')
    expect(libri.id).not.toBe(seedId)
    expect(libri.episodes[0]!.id).not.toBe(seedEpisode.id)
    expect(libri.episodes[0]!.online?.sourceId).toBe('librivox')
    expect(libri.episodes[0]!.online?.episodeId).toBe('701')
    expect(original.episodes[0]!.positionMs).toBe(3700)
    const preparation = await page.evaluate(
      (id) =>
        window.desktop.setSubtitlePreparation({
          id,
          settings: { mode: 'manual', engine: 'paraformer', device: 'cpu', prepareNext: false },
        }),
      libri.id,
    )
    expect(preparation.ok).toBe(true)
    await page.getByRole('searchbox', { name: '搜索书籍', exact: true }).fill('slow')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await expect.poll(source.slowRequests).toBe(1)
    await page.getByRole('button', { name: '取消读取', exact: true }).click()
    await expect(
      page.getByRole('region', { name: '来源中心', exact: true }).getByRole('status'),
    ).toContainText('已取消读取')
    source.release()
    await select.selectOption('ting13')
    await expect(page.getByRole('searchbox', { name: '搜索书籍', exact: true })).toHaveValue('')
    await expect(page.getByRole('heading', { name: 'LibriVox 合成书目', exact: true })).toHaveCount(
      0,
    )
    await expect(
      page.getByRole('button', { name: '缓存并播放 合成音频第一集', exact: true }),
    ).toHaveCount(0)
    await select.selectOption('librivox')
    await expect(
      page.getByRole('heading', { name: 'LibriVox 合成书目', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('heading', { name: '不可覆盖的旧搜索结果', exact: true }),
    ).toHaveCount(0)
    await page.getByRole('button', { name: '缓存并播放 合成音频第一集', exact: true }).click()
    const audio = page.locator('audio[data-player="persistent"]')
    await expect
      .poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentSrc))
      .toMatch(/^readlisten:\/\/app\/(?:stream\/|media\/)/)
    await expect
      .poll(async () => {
        const current = await page.evaluate(() => window.desktop.getLibraryOverview())
        return current.ok ? current.value.currentEpisodeId : null
      })
      .toBe(libri.episodes[0]!.id)
    await expect
      .poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime))
      .toBeGreaterThan(0.2)
    await expect(audio).toHaveJSProperty('paused', false)
    await expect(audio).toHaveJSProperty('volume', 0)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    const played = await page.evaluate(() => window.desktop.getState())
    expect(played.ok).toBe(true)
    if (!played.ok) throw new Error(played.error.message)
    const cached = played.value.books.find((book) => book.id === libri.id)!.episodes[0]!
    expect(cached.online?.sourceId).toBe('librivox')
    expect(cached.online?.cached).toBe(true)
    expect(cached.contentHash).toBe(source.hash)
    expect(played.value.currentEpisodeId).toBe(cached.id)
    expect(played.value.books.find((book) => book.id === seedId)!.episodes[0]!.positionMs).toBe(
      3700,
    )
    expect(
      source.requests.some(
        (request) =>
          new URL(request.path, source.baseUrl).searchParams.get('title') ===
          'A longer title with more than twenty characters',
      ),
    ).toBe(true)
    expect(
      source.requests.some(
        (request) => request.path.includes('id=52') && request.path.includes('extended=1'),
      ),
    ).toBe(true)
    expect(
      source.requests.some(
        (request) =>
          request.path === '/download/ralb_synthetic/tone.mp3' &&
          request.referer === 'https://librivox.org/synthetic-source-center/',
      ),
    ).toBe(true)
    expect(
      await app.evaluate(() => Reflect.get(globalThis, 'sourceCenterBlockedTing13Requests')),
    ).toBe(0)
    await page.reload()
    const persisted = await page.evaluate(() => window.desktop.getState())
    expect(
      persisted.ok && persisted.value.books.find((book) => book.id === libri.id)?.online?.sourceId,
    ).toBe('librivox')
    expect(
      persisted.ok && persisted.value.books.find((book) => book.id === seedId)?.online?.sourceId,
    ).toBe('ting13')
    expect(errors).toEqual([])
  } finally {
    await app
      .evaluate(() => {
        const originalFetch = Reflect.get(globalThis, 'sourceCenterOriginalFetch') as
          typeof fetch | undefined
        if (originalFetch) globalThis.fetch = originalFetch
      })
      .catch(() => undefined)
    try {
      await closeOwnedElectron(app)
    } finally {
      await source.close()
    }
  }
})
