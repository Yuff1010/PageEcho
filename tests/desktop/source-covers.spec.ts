import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { pluginFiles } from '../fixtures/source-plugin'
import { zip } from '../fixtures/original-epub'
import { closeOwnedElectron } from '../model/electron-lifecycle'
import { setVolume } from '../helpers/ui'

function png() {
  const chunk = (kind: string, bytes: Buffer) => {
    const name = Buffer.from(kind),
      header = Buffer.alloc(4),
      crc = Buffer.alloc(4)
    header.writeUInt32BE(bytes.length)
    crc.writeUInt32BE(crc32(Buffer.concat([name, bytes])))
    return Buffer.concat([header, name, bytes, crc])
  }
  const info = Buffer.alloc(13)
  info.writeUInt32BE(24, 0)
  info.writeUInt32BE(36, 4)
  info[8] = 8
  info[9] = 2
  const rows = Buffer.alloc(36 * (24 * 3 + 1))
  for (let row = 0; row < 36; row++)
    for (let col = 0; col < 24; col++) rows.set([93, 138, 112], row * 73 + 1 + col * 3)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', info),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

async function fixture() {
  const foreignRequests: string[] = [],
    imageRequests: string[] = []
  const foreign = createServer((req, res) => {
    foreignRequests.push(req.url!)
    res.writeHead(200, { 'Content-Type': 'image/png' })
    res.end(png())
  })
  await new Promise<void>((done) => foreign.listen(0, '127.0.0.1', done))
  const foreignAddress = foreign.address()
  if (!foreignAddress || typeof foreignAddress === 'string')
    throw new Error('No foreign fixture listener')
  let origin = ''
  const foreignOrigin = `http://127.0.0.1:${foreignAddress.port}`
  const book = (kind: 'audio' | 'text', type = 'valid') => ({
    id: `${kind}-${type}`,
    title: `${kind === 'audio' ? '声音' : '正文'}${type === 'valid' ? '原封面' : type === 'broken' ? '失效封面' : '越权封面'}`,
    authors: ['合成作者'],
    narrators: [],
    description: '合成书目，验证封面与播放互不干扰。',
    pageUrl: `${origin}/${kind}/book`,
    coverUrl:
      type === 'foreign'
        ? `${foreignOrigin}/foreign.png`
        : `${origin}/covers/${type === 'broken' ? 'broken.png' : `${kind}.png`}`,
  })
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const json = (value: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (url.pathname.startsWith('/covers/')) {
      imageRequests.push(url.pathname)
      if (url.pathname.endsWith('broken.png')) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html>unavailable</html>')
      } else {
        res.writeHead(200, { 'Content-Type': 'image/png' })
        res.end(png())
      }
    } else if (url.pathname.endsWith('/search')) {
      const kind = url.pathname.startsWith('/audio') ? 'audio' : 'text'
      json({
        items: ['valid', 'broken', 'foreign'].map((type) => book(kind, type)),
        nextCursor: null,
      })
    } else if (url.pathname.endsWith('/book'))
      json(book(url.pathname.startsWith('/audio') ? 'audio' : 'text'))
    else if (url.pathname === '/audio/chapters')
      json({
        items: [
          {
            id: 'chapter-a',
            title: '合成播放第一集',
            order: 1,
            pageUrl: `${origin}/audio/chapter`,
          },
        ],
        nextCursor: null,
      })
    else if (url.pathname === '/audio/resolve')
      json({
        url: `${origin}/tone.mp3`,
        pageUrl: `${origin}/audio/chapter`,
        headers: {},
        expiresAt: null,
      })
    else if (url.pathname === '/tone.mp3') {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
      res.end(readFileSync(resolve('tests/fixtures/tone.mp3')))
    } else if (url.pathname === '/text/chapters')
      json({ items: [{ id: 'chapter-t', title: '合成正文第一章' }], nextCursor: null })
    else if (url.pathname === '/text/chapter') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('这是一段合成正文，用于封面测试。')
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No cover fixture listener')
  origin = `http://127.0.0.1:${address.port}`
  const files = pluginFiles(origin, { id: 'synthetic.covers', name: '封面合成插件' })
  const manifest = JSON.parse(files['manifest.json'])
  manifest.sources.forEach((source: { coverOrigins?: string[] }) => {
    source.coverOrigins = [origin]
  })
  files['manifest.json'] = JSON.stringify(manifest)
  const root = mkdtempSync(join(tmpdir(), '听读来源封面 ')),
    path = join(root, 'covers.zip')
  writeFileSync(path, zip(files))
  return {
    path,
    imageRequests,
    foreignRequests,
    close: async () => {
      server.closeAllConnections()
      foreign.closeAllConnections()
      await Promise.all([
        new Promise<void>((done) => server.close(() => done())),
        new Promise<void>((done) => foreign.close(() => done())),
      ])
    },
  }
}

async function choose(app: ElectronApplication, file: string) {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
}
async function search(page: Page, kind: 'audio' | 'text') {
  await page.getByRole('tab', { name: kind === 'audio' ? '有声书' : '电子书', exact: true }).click()
  await page
    .getByRole('combobox', { name: kind === 'audio' ? '有声书来源' : '电子书来源', exact: true })
    .selectOption(`plugin:synthetic.covers:${kind}`)
  await page
    .getByRole('searchbox', { name: kind === 'audio' ? '搜索书籍' : '搜索电子书', exact: true })
    .fill('原封面')
  await page
    .getByRole('button', { name: kind === 'audio' ? '搜索' : '搜索电子书', exact: true })
    .click()
}

async function resize(app: ElectronApplication, width: number) {
  await app.evaluate(
    ({ BrowserWindow }, nextWidth) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(nextWidth, 720),
    width,
  )
}

async function expectCoverGeometry(image: Locator, width: number) {
  await expect
    .poll(() => image.evaluate((element) => element.getBoundingClientRect().width))
    .toBeCloseTo(width, 1)
  const geometry = await image.evaluate((element) => {
    const image = element.getBoundingClientRect(),
      frame = element.parentElement!.getBoundingClientRect()
    return {
      image: { x: image.x, y: image.y, width: image.width, height: image.height },
      frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
      fit: getComputedStyle(element).objectFit,
    }
  })
  expect(geometry.image.height).toBeCloseTo(width / 0.7, 0)
  expect(geometry.frame).toEqual(geometry.image)
  expect(geometry.fit).toBe('cover')
  await expect(image).toBeInViewport()
}

async function expectSourceContentFits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(
    await page
      .locator('.source-book-result, .source-center-detail-heading')
      .evaluateAll((items) => items.every((element) => element.scrollWidth <= element.clientWidth)),
  ).toBe(true)
  expect(
    await page
      .locator('.source-book-result-copy')
      .evaluateAll((items) =>
        items.every((element) => element.getBoundingClientRect().width >= 100),
      ),
  ).toBe(true)
}

test('original covers load through registered local URLs, fail to a shared fallback and never interrupt audio while browsing text', async ({}, info) => {
  test.setTimeout(90_000)
  const source = await fixture()
  const env = { ...process.env, RALB_USER_DATA: mkdtempSync(join(tmpdir(), '听读封面桌面 ')) }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const launch = () =>
    electron.launch({
      ...(process.env.RALB_EXECUTABLE
        ? { executablePath: resolve(process.env.RALB_EXECUTABLE), args: [] }
        : { args: [resolve(process.env.RALB_APP_ROOT ?? '.')] }),
      env,
    })
  let app = await launch()
  let page = await app.firstWindow()
  let sourceClosed = false
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    await page.getByRole('button', { name: '在线书源', exact: true }).click()
    await page.getByRole('tab', { name: '插件', exact: true }).click()
    await choose(app, source.path)
    await page.getByRole('button', { name: '从 ZIP 导入插件', exact: true }).click()
    await page.getByRole('button', { name: '确认安装插件', exact: true }).click()
    await expect(
      page.getByRole('article', { name: '插件 封面合成插件', exact: true }),
    ).toBeVisible()
    await search(page, 'audio')
    const original = page
      .locator('.source-book-result')
      .filter({ has: page.getByRole('heading', { name: '声音原封面', exact: true }) })
    const image = original.getByRole('img', { name: '声音原封面的封面', exact: true })
    await expect(image).toBeVisible()
    await expect
      .poll(() =>
        image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 24),
      )
      .toBe(true)
    await expect(image).toHaveAttribute('src', /^readlisten:\/\/app\/covers\/[\w-]+$/)
    const broken = page
      .locator('.source-book-result')
      .filter({ has: page.getByRole('heading', { name: '声音失效封面', exact: true }) })
    await expect(broken.locator('.source-book-image[data-cover-state="fallback"]')).toBeVisible()
    await expect(broken.locator('img')).toHaveCount(0)
    const denied = page
      .locator('.source-book-result')
      .filter({ has: page.getByRole('heading', { name: '声音越权封面', exact: true }) })
    await expect(denied.locator('.source-book-image[data-cover-state="fallback"]')).toBeVisible()
    expect(source.foreignRequests).toEqual([])
    for (const width of [1360, 720]) {
      await resize(app, width)
      await expectCoverGeometry(image, width > 800 ? 96 : 84)
      await expectSourceContentFits(page)
      await page.mouse.move(5, 5)
      await page.screenshot({
        path: info.outputPath(`source-audio-results-${width}.png`),
        animations: 'disabled',
      })
    }
    await original.getByRole('button', { name: '查看 声音原封面 的详情', exact: true }).click()
    const audioDetailImage = page
      .locator('.source-center-detail-heading')
      .getByRole('img', { name: '声音原封面的封面', exact: true })
    await expect(audioDetailImage).toBeVisible()
    for (const width of [1360, 720]) {
      await resize(app, width)
      await expectCoverGeometry(audioDetailImage, width > 800 ? 120 : 96)
      await expectSourceContentFits(page)
      await page.mouse.move(5, 5)
      await page.screenshot({
        path: info.outputPath(`source-audio-detail-${width}.png`),
        animations: 'disabled',
      })
    }
    await page.getByRole('button', { name: '加入书架', exact: true }).click()
    // Native click dispatch is not completion of the asynchronous artwork save.
    await expect(page.getByRole('button', { name: '更新书架目录', exact: true })).toBeEnabled()
    const state = await page.evaluate(() => window.desktop.getState())
    expect(state.ok).toBe(true)
    if (!state.ok) throw new Error(state.error.message)
    const book = state.value.books.find(
      (book) => book.online?.sourceId === 'plugin:synthetic.covers:audio',
    )!
    expect(book.coverUrl).toMatch(/^readlisten:\/\/app\/book-covers\/[a-f0-9]{64}$/)
    await page.evaluate(
      (id) =>
        window.desktop.setSubtitlePreparation({
          id,
          settings: { mode: 'manual', engine: 'paraformer', device: 'cpu', prepareNext: false },
        }),
      book.id,
    )
    await setVolume(page, '0')
    await page.getByRole('button', { name: '缓存并播放 合成播放第一集', exact: true }).click()
    const audio = page.locator('audio[data-player="persistent"]')
    await expect
      .poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime))
      .toBeGreaterThan(0.1)
    const playerCover = page.locator('.player-cover img.cover-original')
    await expect(playerCover).toHaveAttribute('src', book.coverUrl!)
    await expect
      .poll(() => playerCover.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBeGreaterThan(0)
    const before = await audio.evaluate((element: HTMLAudioElement) => {
      Reflect.set(element, 'coverTestIdentity', true)
      return { src: element.currentSrc, time: element.currentTime }
    })
    await search(page, 'text')
    const textImage = page.getByRole('img', { name: '正文原封面的封面', exact: true })
    await expect
      .poll(() =>
        textImage.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 24),
      )
      .toBe(true)
    for (const width of [1360, 720])
      for (const theme of ['light', 'dark']) {
        await resize(app, width)
        await page.evaluate(
          (nextTheme) => document.documentElement.setAttribute('data-ui-theme', nextTheme),
          theme,
        )
        await expectCoverGeometry(textImage, width > 800 ? 96 : 84)
        await expectSourceContentFits(page)
        await page.mouse.move(5, 5)
        await page.screenshot({
          path: info.outputPath(`source-covers-${width}-${theme}.png`),
          animations: 'disabled',
        })
      }
    const after = await audio.evaluate((element: HTMLAudioElement) => ({
      same: Reflect.get(element, 'coverTestIdentity'),
      src: element.currentSrc,
      time: element.currentTime,
      paused: element.paused,
    }))
    expect(after.same).toBe(true)
    expect(after.src).toBe(before.src)
    expect(after.time).toBeGreaterThan(before.time)
    expect(after.paused).toBe(false)
    expect(source.imageRequests).toContain('/covers/audio.png')
    expect(source.imageRequests).toContain('/covers/text.png')
    expect(source.foreignRequests).toEqual([])
    await page.getByRole('button', { name: '查看 正文原封面 的电子书详情', exact: true }).click()
    const textDetailImage = page
      .locator('.source-center-detail-heading')
      .getByRole('img', { name: '正文原封面的封面', exact: true })
    for (const width of [1360, 720]) {
      await resize(app, width)
      await expectCoverGeometry(textDetailImage, width > 800 ? 120 : 96)
      await expectSourceContentFits(page)
      await page.mouse.move(5, 5)
      await page.screenshot({
        path: info.outputPath(`source-text-detail-${width}.png`),
        animations: 'disabled',
      })
    }
    await page.getByRole('checkbox', { name: '合成正文第一章', exact: true }).check()
    await page.getByRole('button', { name: '导入并阅读所选正文', exact: true }).click()
    await expect(page).toHaveURL(/#\/read\//)
    const reading = await page.evaluate(() => window.desktop.getReadingBooks())
    if (!reading.ok) throw new Error(reading.error.message)
    const ebook = reading.value[0]!
    expect(ebook.coverUrl).toMatch(/^readlisten:\/\/app\/book-covers\/[a-f0-9]{64}$/)
    const fetchedImages = source.imageRequests.length
    await source.close()
    sourceClosed = true
    await closeOwnedElectron(app)
    app = await launch()
    page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await page.evaluate(() => {
      window.location.hash = '#/library/audiobooks'
    })
    const shelfCover = page
      .locator('.shelf-card')
      .filter({ has: page.getByRole('heading', { name: '声音原封面', exact: true }) })
      .locator('img.cover-original')
    await expect(shelfCover).toHaveAttribute('src', book.coverUrl!)
    await expect
      .poll(() => shelfCover.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBeGreaterThan(0)
    await expect(page.locator('.player-cover img.cover-original')).toHaveAttribute(
      'src',
      book.coverUrl!,
    )
    await page
      .getByRole('navigation', { name: '书籍类型', exact: true })
      .getByRole('button', { name: '电子书', exact: true })
      .click()
    const ebookCover = page.locator('.ebook-shelf img.cover-original')
    await expect(ebookCover).toHaveAttribute('src', ebook.coverUrl!)
    await expect
      .poll(() => ebookCover.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBeGreaterThan(0)
    expect(source.imageRequests).toHaveLength(fetchedImages)
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
    if (!sourceClosed) await source.close()
  }
})
