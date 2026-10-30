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
import { pluginPackage } from '../fixtures/source-plugin'
import { closeOwnedElectron } from '../model/electron-lifecycle'
import { setVolume } from '../helpers/ui'

const pluginId = 'synthetic.books'
const audioId = `plugin:${pluginId}:audio`
const textId = `plugin:${pluginId}:text`

async function fixture() {
  const mp3 = readFileSync(resolve('tests/fixtures/tone.mp3'))
  let origin = ''
  const requests: string[] = []
  const held = new Set<ServerResponse>()
  const audioBook = () => ({
    id: 'book-a',
    title: '插件合成音频',
    authors: ['合成作者'],
    narrators: ['合成演播'],
    description: '本机生成的插件测试内容。',
    pageUrl: `${origin}/audio/book`,
  })
  const textBook = () => ({
    id: 'book-t',
    title: '插件合成正文',
    authors: ['合成作者'],
    description: '本机生成的正文插件测试。',
    pageUrl: `${origin}/text/book`,
  })
  const json = (response: ServerResponse, value: unknown) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(value))
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    requests.push(url.pathname + url.search)
    if (url.pathname === '/slow.zip') {
      held.add(response)
      response.on('close', () => held.delete(response))
      return
    }
    if (['/plugin.zip', '/plugin-v2.zip', '/broken.zip'].includes(url.pathname)) {
      const bytes = pluginPackage(origin, {
        version:
          url.pathname === '/plugin-v2.zip'
            ? '1.1.0'
            : url.pathname === '/broken.zip'
              ? '1.2.0'
              : '1.0.0',
        broken: url.pathname === '/broken.zip',
      })
      response.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': String(bytes.length),
      })
      response.end(bytes)
      return
    }
    if (url.pathname === '/audio/search') {
      json(response, { items: [audioBook()], nextCursor: null })
      return
    }
    if (url.pathname === '/audio/book') {
      json(response, audioBook())
      return
    }
    if (url.pathname === '/audio/chapters') {
      json(response, {
        items: [
          {
            id: 'chapter-a',
            bookId: 'book-a',
            title: '插件音频第一集',
            order: 1,
            pageUrl: `${origin}/audio/chapter`,
          },
        ],
        nextCursor: null,
      })
      return
    }
    if (url.pathname === '/audio/resolve') {
      json(response, {
        url: `${origin}/audio.mp3`,
        pageUrl: `${origin}/audio/chapter`,
        headers: {},
        expiresAt: null,
      })
      return
    }
    if (url.pathname === '/audio.mp3') {
      response.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(mp3.length),
      })
      response.end(mp3)
      return
    }
    if (url.pathname === '/text/search') {
      json(response, { items: [textBook()], nextCursor: null })
      return
    }
    if (url.pathname === '/text/book') {
      json(response, textBook())
      return
    }
    if (url.pathname === '/text/chapters') {
      json(response, { items: [{ id: 'chapter-t', title: '合成正文第一章' }], nextCursor: null })
      return
    }
    if (url.pathname === '/text/chapter') {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(
        Array.from(
          { length: 80 },
          (_, index) =>
            `第${index + 1}封信送到河边。清晨的风吹过村庄，每个人都在新的纸页上写下自己的故事。`,
        ).join('\n'),
      )
      return
    }
    response.writeHead(404)
    response.end('Unknown synthetic plugin route')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No plugin fixture listener')
  origin = `http://127.0.0.1:${address.port}`
  const directory = mkdtempSync(join(tmpdir(), '听读合成插件包 '))
  const path = join(directory, 'source.zip')
  writeFileSync(path, pluginPackage(origin))
  return {
    origin,
    path,
    requests,
    hash: createHash('sha256').update(mp3).digest('hex'),
    release() {
      for (const response of held) {
        response.writeHead(200, { 'Content-Type': 'application/zip' })
        response.end(pluginPackage(origin))
      }
      held.clear()
    },
    async close() {
      for (const response of held) response.destroy()
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

async function launch() {
  const root = mkdtempSync(join(tmpdir(), '听读插件桌面 '))
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({
    ...(process.env.RALB_EXECUTABLE
      ? { executablePath: resolve(process.env.RALB_EXECUTABLE), args: [] }
      : { args: [resolve(process.env.RALB_APP_ROOT ?? '.')] }),
    env,
  })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('button', { name: '在线书源', exact: true }).click()
  await page.getByRole('tab', { name: '插件', exact: true }).click()
  return { app, page, root, errors }
}
async function choose(app: ElectronApplication, page: Page, path: string) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, path)
  await page.getByRole('button', { name: '从 ZIP 导入插件', exact: true }).click()
  await expect(page.getByRole('region', { name: '插件安装预览', exact: true })).toBeVisible()
}
async function install(app: ElectronApplication, page: Page, path: string) {
  await choose(app, page, path)
  await page.getByRole('button', { name: '确认安装插件', exact: true }).click()
  await expect(page.getByRole('article', { name: '插件 合成来源插件', exact: true })).toBeVisible()
}
async function previewUrl(page: Page, url: string) {
  const input = page.getByRole('textbox', { name: '插件 ZIP 下载地址', exact: true })
  if (!(await input.count()))
    await page.getByRole('button', { name: '从网址导入插件', exact: true }).click()
  await input.fill(url)
  await page.getByRole('button', { name: '检查插件下载地址', exact: true }).click()
}
async function readLibrary(page: Page) {
  const result = await page.evaluate(() => window.desktop.getState())
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

test('plugin ZIP preview, keyboard tabs, atomic update failure, rollback and enablement use real IPC', async ({}, info) => {
  test.setTimeout(120_000)
  const source = await fixture()
  const { app, page, errors } = await launch()
  try {
    await page.getByRole('tab', { name: '插件', exact: true }).press('Home')
    await expect(page.getByRole('tab', { name: '有声书', exact: true })).toBeFocused()
    await page.getByRole('tab', { name: '有声书', exact: true }).press('End')
    await expect(page.getByRole('tab', { name: '插件', exact: true })).toBeFocused()
    await expect(page.getByRole('tabpanel')).toHaveCount(1)
    await expect(page.getByRole('combobox', { name: '有声书来源', exact: true })).toHaveCount(0)
    await choose(app, page, source.path)
    const permissions = page.getByRole('region', { name: '插件安装预览', exact: true })
    await expect(permissions).toContainText(source.origin)
    await expect(permissions).toContainText('合成音频来源')
    await expect(permissions).toContainText('合成正文来源')
    const uninstalled = await page.evaluate(() => window.desktop.pluginList())
    expect(uninstalled.ok && uninstalled.value.plugins).toHaveLength(0)
    await page.getByRole('button', { name: '确认安装插件', exact: true }).click()
    const card = page.getByRole('article', { name: '插件 合成来源插件', exact: true })
    await expect(card.locator('header p')).toContainText('1.0.0')
    await card.getByRole('button', { name: '测试 合成来源插件', exact: true }).click()
    await page.getByRole('textbox', { name: '插件测试关键词', exact: true }).fill('合成')
    await page.getByRole('button', { name: '运行插件测试', exact: true }).click()
    await expect(card.locator('.source-plugin-report')).toContainText('测试通过')
    await previewUrl(page, `${source.origin}/broken.zip`)
    await page.getByRole('button', { name: '确认更新插件', exact: true }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(card.locator('header p')).toContainText('1.0.0')
    const failedUpdate = await page.evaluate(() => window.desktop.pluginList())
    expect(failedUpdate.ok && failedUpdate.value.plugins[0]!.version).toBe('1.0.0')
    await previewUrl(page, `${source.origin}/plugin-v2.zip`)
    await page.getByRole('button', { name: '确认更新插件', exact: true }).click()
    await expect(card.locator('header p')).toContainText('1.1.0')
    await card.getByRole('button', { name: '将 合成来源插件 回滚到 1.0.0', exact: true }).click()
    await expect(card.locator('header p')).toContainText('1.0.0')
    await card.getByRole('button', { name: '停用 合成来源插件', exact: true }).click()
    await page.getByRole('tab', { name: '有声书', exact: true }).click()
    await expect(page.getByRole('combobox', { name: '有声书来源', exact: true })).not.toContainText(
      '合成音频来源',
    )
    await page.getByRole('tab', { name: '插件', exact: true }).click()
    await card.getByRole('button', { name: '启用 合成来源插件', exact: true }).click()
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(720, 600),
    )
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath('plugins-small.png'), animations: 'disabled' })
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
    await source.close()
  }
})

test('one installed package supplies actual plugin audio playback and selected text import, and uninstall preserves saved resources', async () => {
  test.setTimeout(120_000)
  const source = await fixture()
  const { app, page, errors } = await launch()
  try {
    await install(app, page, source.path)
    await page.getByRole('tab', { name: '有声书', exact: true }).click()
    await page.getByRole('combobox', { name: '有声书来源', exact: true }).selectOption(audioId)
    await page.getByRole('searchbox', { name: '搜索书籍', exact: true }).fill('合成')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await page.getByRole('button', { name: '查看 插件合成音频 的详情', exact: true }).click()
    await page.getByRole('button', { name: '加入书架', exact: true }).click()
    await expect(page.getByRole('button', { name: '更新书架目录', exact: true })).toBeVisible()
    const initial = await readLibrary(page)
    const book = initial.books.find((item) => item.online?.sourceId === audioId)!
    expect(book.online?.bookId).toBe('book-a')
    expect(book.episodes[0]!.online?.episodeId).toBe('chapter-a')
    const manual = await page.evaluate(
      (id) =>
        window.desktop.setSubtitlePreparation({
          id,
          settings: { mode: 'manual', engine: 'paraformer', device: 'cpu', prepareNext: false },
        }),
      book.id,
    )
    expect(manual.ok).toBe(true)
    await setVolume(page, '0')
    await page.getByRole('button', { name: '缓存并播放 插件音频第一集', exact: true }).click()
    const audio = page.locator('audio[data-player="persistent"]')
    await expect
      .poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime))
      .toBeGreaterThan(0.2)
    await expect(audio).toHaveJSProperty('paused', false)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await readLibrary(page)).books.find((item) => item.id === book.id)!.episodes[0]!
            .positionMs,
      )
      .toBeGreaterThan(0)
    const cached = (await readLibrary(page)).books.find((item) => item.id === book.id)!.episodes[0]!
    expect(cached.online?.cached).toBe(true)
    expect(cached.contentHash).toBe(source.hash)
    await page.getByRole('tab', { name: '电子书', exact: true }).click()
    await page.getByRole('combobox', { name: '电子书来源', exact: true }).selectOption(textId)
    await page.getByRole('searchbox', { name: '搜索电子书', exact: true }).fill('合成')
    await page.getByRole('button', { name: '搜索电子书', exact: true }).click()
    await expect(page.locator('.source-center-panel')).toHaveAttribute('aria-busy', 'false')
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.getByRole('button', { name: '查看 插件合成正文 的电子书详情', exact: true }).click()
    await page.getByRole('checkbox', { name: '合成正文第一章', exact: true }).check()
    await page.getByRole('button', { name: '导入并阅读所选正文', exact: true }).click()
    await expect(page).toHaveURL(/#\/read\//)
    await expect(page.getByRole('region', { name: '电子书正文', exact: true })).toHaveAttribute(
      'aria-busy',
      'false',
    )
    const reading = await page.evaluate(() => window.desktop.getReadingBooks())
    expect(reading.ok && reading.value).toHaveLength(1)
    if (!reading.ok) throw new Error(reading.error.message)
    const readingId = reading.value[0]!.id
    await page.locator('.book-viewport').press('ArrowRight')
    const readingPosition = () =>
      page.locator('.reader-progress-label').getAttribute('data-position').then(Number)
    await expect.poll(readingPosition).toBeGreaterThan(0)
    const savedReadingPosition = await readingPosition()
    await expect
      .poll(async () => {
        const result = await page.evaluate(() => window.desktop.getReadingBooks())
        return result.ok ? result.value.find((item) => item.id === readingId)?.position : -1
      })
      .toBe(savedReadingPosition)
    await page.mouse.move(80, 15)
    await page.getByRole('button', { name: '返回阅读书架', exact: true }).click()
    await page.getByRole('button', { name: '在线书源', exact: true }).click()
    await page.getByRole('tab', { name: '插件', exact: true }).click()
    await page.getByRole('button', { name: '卸载 合成来源插件', exact: true }).click()
    await expect(page.getByText('已保存的书籍、进度和字幕会保留。', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '确认卸载插件', exact: true }).click()
    await expect(page.getByRole('article', { name: '插件 合成来源插件', exact: true })).toHaveCount(
      0,
    )
    const finalAudio = (await readLibrary(page)).books.find((item) => item.id === book.id)!
      .episodes[0]!
    expect(finalAudio.contentHash).toBe(cached.contentHash)
    expect(finalAudio.positionMs).toBe(cached.positionMs)
    const finalReading = await page.evaluate(() => window.desktop.getReadingBooks())
    expect(
      finalReading.ok && finalReading.value.find((item) => item.id === readingId)?.position,
    ).toBe(savedReadingPosition)
    const mediaRequests = source.requests.filter(
      (path) => path.startsWith('/audio/resolve?') || path === '/audio.mp3',
    ).length
    await page.reload()
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await expect
      .poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime))
      .toBeGreaterThan(cached.positionMs / 1000 + 0.2)
    await expect(audio).toHaveJSProperty('paused', false)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    expect(
      source.requests.filter((path) => path.startsWith('/audio/resolve?') || path === '/audio.mp3'),
    ).toHaveLength(mediaRequests)
    await page.getByRole('tab', { name: '电子书', exact: true }).click()
    await expect(page.getByRole('combobox', { name: '电子书来源', exact: true })).not.toContainText(
      '合成正文来源',
    )
    expect(source.requests.some((path) => path === '/audio.mp3')).toBe(true)
    expect(source.requests.some((path) => path.startsWith('/text/chapter?'))).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
    await source.close()
  }
})

test('canceling a plugin URL preview cannot install or show a late package', async () => {
  const source = await fixture()
  const { app, page, errors } = await launch()
  try {
    await previewUrl(page, `${source.origin}/slow.zip`)
    await expect.poll(() => source.requests.some((path) => path === '/slow.zip')).toBe(true)
    await page.getByRole('button', { name: '取消插件操作', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('已取消')
    source.release()
    await expect(page.getByRole('region', { name: '插件安装预览', exact: true })).toHaveCount(0)
    const state = await page.evaluate(() => window.desktop.pluginList())
    expect(state.ok && state.value.plugins).toHaveLength(0)
    await previewUrl(page, `${source.origin}/plugin.zip`)
    await expect(page.getByRole('region', { name: '插件安装预览', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '取消插件预览', exact: true }).click()
    await expect(page.getByRole('region', { name: '插件安装预览', exact: true })).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
    await source.close()
  }
})
