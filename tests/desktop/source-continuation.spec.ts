import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pluginPackage } from '../fixtures/source-plugin'
import { closeOwnedElectron } from '../model/electron-lifecycle'

const sourceId = 'plugin:synthetic.books:text'

async function fixture() {
  let origin = ''
  let holdNext = false
  const chaptersRequested: string[] = []
  const held = new Set<ServerResponse>()
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture')
    const book = {
      id: 'source-work',
      title: '合成连载阅读',
      authors: ['合成作者'],
      pageUrl: `${origin}/text/book`,
    }
    const json = (value: unknown) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (url.pathname === '/text/search') json({ items: [book], nextCursor: null })
    else if (url.pathname === '/text/book') json(book)
    else if (url.pathname === '/text/chapters')
      json({
        items: [0, 1, 2].map((index) => ({
          id: `chapter-${index}`,
          title: `连载第${index + 1}章`,
        })),
        nextCursor: null,
      })
    else if (url.pathname === '/text/chapter') {
      const id = url.searchParams.get('id') ?? ''
      chaptersRequested.push(id)
      if (holdNext && id === 'chapter-2') {
        held.add(response)
        response.once('close', () => held.delete(response))
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(
        Array.from(
          { length: 18 },
          (_, index) => `这是${id}的第${index + 1}段正文，少年来到远方的村庄。`,
        ).join('\n'),
      )
    } else {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No synthetic server listener')
  origin = `http://127.0.0.1:${address.port}`
  const directory = mkdtempSync(join(tmpdir(), '听读来源连载插件 '))
  const file = join(directory, 'source.zip')
  writeFileSync(file, pluginPackage(origin))
  return {
    file,
    chaptersRequested,
    hold: () => {
      holdNext = true
    },
    async close() {
      for (const response of held) response.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
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
  return { app, page: await app.firstWindow() }
}
async function books(page: Page) {
  const result = await page.evaluate(() => window.desktop.getReadingBooks())
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
async function reveal(page: Page) {
  await page.mouse.move(80, 15)
  await expect(page.locator('.reader-toolbar')).toHaveAttribute('data-visible', 'true')
}
async function ready(page: Page) {
  await expect(page.getByRole('region', { name: '电子书正文', exact: true })).toHaveAttribute(
    'aria-busy',
    'false',
  )
}

test('source search and selection survive navigation; real chapter continuation preserves the reading anchor and cancel leaves saved text intact', async ({}, info) => {
  test.setTimeout(120_000)
  const source = await fixture()
  const root = mkdtempSync(join(tmpdir(), '听读来源连续阅读 '))
  const launched = await launch(root)
  let app = launched.app
  let page = launched.page
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    await page.getByRole('button', { name: '在线书源', exact: true }).click()
    await page.getByRole('tab', { name: '插件', exact: true }).click()
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, source.file)
    await page.getByRole('button', { name: '从 ZIP 导入插件', exact: true }).click()
    await page.getByRole('button', { name: '确认安装插件', exact: true }).click()
    await expect(
      page.getByRole('article', { name: '插件 合成来源插件', exact: true }),
    ).toBeVisible()
    await page.getByRole('tab', { name: '电子书', exact: true }).click()
    await page.getByRole('combobox', { name: '电子书来源', exact: true }).selectOption(sourceId)
    const search = page.getByRole('searchbox', { name: '搜索电子书', exact: true })
    await search.fill('合成连载')
    await page.getByRole('button', { name: '搜索电子书', exact: true }).click()
    const result = page.getByRole('button', { name: '查看 合成连载阅读 的电子书详情', exact: true })
    await expect(result).toBeVisible()
    await page.getByRole('tab', { name: '有声书', exact: true }).click()
    await expect(page.getByRole('tabpanel')).toHaveCount(1)
    await expect(search).toHaveCount(0)
    await page.getByRole('tab', { name: '电子书', exact: true }).click()
    await expect(search).toHaveValue('合成连载')
    await expect(result).toBeVisible()
    await result.click()
    const selected = page.getByRole('checkbox', { name: '连载第1章', exact: true })
    await selected.check()
    await page.getByRole('tab', { name: '我的书库', exact: true }).click()
    await expect(selected).toHaveCount(0)
    await page.getByRole('tab', { name: '电子书', exact: true }).click()
    await expect(selected).toBeChecked()
    await page.getByRole('button', { name: '我的书架', exact: true }).click()
    await page.getByRole('button', { name: '在线书源', exact: true }).click()
    await expect(page.getByRole('tab', { name: '电子书', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(search).toHaveValue('合成连载')
    await expect(selected).toBeChecked()
    await page.getByRole('button', { name: '导入并阅读所选正文', exact: true }).click()
    await ready(page)
    const [initial] = await books(page)
    expect(initial).toBeTruthy()
    expect(initial!.chapters).toHaveLength(1)
    expect(initial!.source).toEqual({ sourceId, workId: 'source-work' })
    expect(source.chaptersRequested).toEqual(['chapter-0'])
    await reveal(page)
    await page.getByRole('slider', { name: '阅读进度', exact: true }).fill('5')
    await page.getByRole('slider', { name: '阅读进度', exact: true }).dispatchEvent('pointerup')
    await ready(page)
    await expect.poll(async () => (await books(page))[0]!.position).toBe(5)
    const location = await page.locator('.reader-progress-label').getAttribute('data-position')
    await page.getByRole('button', { name: '获取下一章', exact: true }).click()
    await expect.poll(async () => (await books(page))[0]!.chapters.length).toBe(2)
    await ready(page)
    const [appended] = await books(page)
    expect(appended!.id).toBe(initial!.id)
    expect(appended!.position).toBe(5)
    expect(appended!.sentenceCount).toBeGreaterThan(initial!.sentenceCount)
    expect(await page.locator('.reader-progress-label').getAttribute('data-position')).toBe(
      location,
    )
    expect(await books(page)).toHaveLength(1)
    expect(source.chaptersRequested).toEqual(['chapter-0', 'chapter-1'])
    await reveal(page)
    await page.getByRole('button', { name: '返回阅读书架', exact: true }).click()
    await page.getByRole('button', { name: '在线书源', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: /^连载第2章/ })).toBeDisabled()
    await page.getByRole('button', { name: '选择后续20章', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: /^连载第2章/ })).not.toBeChecked()
    await expect(page.getByRole('checkbox', { name: '连载第3章', exact: true })).toBeChecked()
    await page.getByRole('button', { name: '继续阅读已下载章节', exact: true }).click()
    await ready(page)
    await expect(page.locator('.reader-progress-label')).toHaveAttribute('data-position', location!)
    await reveal(page)
    await page.getByRole('button', { name: '打开目录', exact: true }).click()
    await page.getByRole('button', { name: '连载第2章', exact: true }).click()
    await ready(page)
    await expect(page.locator(`[data-sentence="${initial!.sentenceCount}"]`)).toBeInViewport()
    await expect.poll(async () => (await books(page))[0]!.position).toBe(initial!.sentenceCount)
    source.hold()
    await reveal(page)
    await page.getByRole('button', { name: '获取下一章', exact: true }).click()
    await expect.poll(() => source.chaptersRequested.includes('chapter-2')).toBe(true)
    await page.getByRole('button', { name: '取消获取下一章', exact: true }).click()
    await expect(page.getByRole('button', { name: '获取下一章', exact: true })).toBeEnabled()
    await expect(page.locator('.reader-save-status')).toContainText('已取消获取')
    expect((await books(page))[0]!.sentenceCount).toBe(appended!.sentenceCount)
    await page.screenshot({ path: info.outputPath('source-continuation-canceled.png') })
    await closeOwnedElectron(app)
    ;({ app, page } = await launch(root))
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.getByRole('button', { name: '我的书架', exact: true })).toBeVisible()
    const [restored] = await books(page)
    expect(restored!.id).toBe(initial!.id)
    expect(restored!.chapters).toHaveLength(2)
    expect(restored!.position).toBe(initial!.sentenceCount)
    expect(errors).toEqual([])
  } finally {
    await closeOwnedElectron(app)
    await source.close()
  }
})
