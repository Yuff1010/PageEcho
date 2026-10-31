import assert from 'node:assert/strict'
import { createHash, createDecipheriv } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PluginRuntime } from '../../src/main/plugins/runtime'
import { PluginService } from '../../src/main/plugins/service'
import { zip } from '../fixtures/original-epub'

test('bqg631 example uses public-client requests, original cover URLs and bounded synthetic chapter selection', async () => {
  const directory = 'examples/source-plugins/bqg631'
  const files = Object.fromEntries(
    ['manifest.json', 'main.js', 'crypto-js.js', 'LICENSE.txt'].map((name) => [
      name,
      readFileSync(join(directory, name), 'utf8'),
    ]),
  )
  const requests: string[] = []
  const chapters = Array.from({ length: 1002 }, (_, index) => `第${index + 1}章 合成测试`)
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost')
    requests.push(url.pathname + url.search)
    assert.equal(req.headers.authorization, undefined)
    assert.equal(req.headers.cookie, undefined)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (url.pathname === '/api/search') {
      res.end(
        JSON.stringify({
          data: Array.from({ length: 85 }, (_, index) => ({
            id: String(42 + index),
            title: `合成书目${index}`,
            author: '合成作者',
            intro: '<p>合成简介</p>',
          })),
        }),
      )
    } else if (url.pathname === '/api/book') {
      assert.equal(url.searchParams.get('id'), '42')
      res.end(
        JSON.stringify({
          id: '42',
          title: '合成书目0',
          author: '合成作者',
          intro: '<p>合成简介</p>',
          dirid: '125',
        }),
      )
    } else if (url.pathname === '/api/booklist') {
      assert.equal(url.searchParams.get('id'), '125')
      res.end(JSON.stringify({ list: chapters }))
    } else if (url.pathname === '/api/chapter') {
      assert.equal(req.headers.referer, 'https://www.bqg631.xyz/')
      const digest = createHash('md5').update(['book', 'token.html'].join('@')).digest('hex')
      const cipher = createDecipheriv(
        'aes-128-cbc',
        Buffer.from(digest.slice(16)),
        Buffer.from(digest.slice(0, 16)),
      )
      const encoded = url.searchParams.get('token')!
      const input = JSON.parse(
        Buffer.concat([cipher.update(Buffer.from(encoded, 'base64')), cipher.final()]).toString(
          'utf8',
        ),
      )
      assert.deepEqual(input, { id: 42, chapterid: 2 })
      res.end(
        JSON.stringify({
          id: 42,
          chapterid: 2,
          txt: '这一段是合成正文。只用于本机插件回归测试，没有下载网站作品。',
        }),
      )
    } else {
      res.end('{}')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const fixtureOrigin = `http://127.0.0.1:${address.port}`
  const originalFetch = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    assert.ok(['https://www.bqg631.xyz', 'https://apibi.cc'].includes(url.origin))
    return originalFetch(new URL(url.pathname + url.search, fixtureOrigin), init)
  }
  const runtime = new PluginRuntime()
  const service = new PluginService({
    directory: mkdtempSync(join(tmpdir(), 'ralb-bqg-example-')),
    runtime,
  })
  try {
    const preview = service.previewFile(zip(files))
    assert.deepEqual(preview.sources[0]!.coverOrigins, ['https://www.bqg631.xyz'])
    const state = await service.install(preview.previewId)
    const sourceId = state.sources[0]!.id
    const signal = new AbortController().signal
    const page = await service.textBrowse({ requestId: 'search', sourceId, query: '合成' }, signal)
    assert.equal(page.books.length, 80)
    assert.equal(page.nextCursor, '80')
    assert.equal(page.books[0]!.coverUrl, 'https://www.bqg631.xyz/bookimg/0/42.jpg')
    assert.equal(page.books[0]!.description, '合成简介')
    const next = await service.textBrowse(
      { requestId: 'next', sourceId, query: '合成', cursor: page.nextCursor! },
      signal,
    )
    assert.equal(next.books.length, 5)
    assert.equal(next.nextCursor, null)
    const detail = await service.textDetail({ requestId: 'detail', sourceId, workId: '42' }, signal)
    assert.equal(detail.chapters.length, 1000)
    assert.equal(detail.chapters[0]!.id, '1')
    assert.match(detail.notice!, /后续目录/)
    const content = await service.textDownload(
      { requestId: 'import', sourceId, workId: '42', chapterIds: ['2'] },
      signal,
    )
    assert.match(content.bytes.toString('utf8'), /合成正文/)
    assert.match(content.bytes.toString('utf8'), /来源：笔趣阁 bqg631/)
    assert.equal(requests.filter((url) => url.startsWith('/api/chapter?')).length, 1)
    await assert.rejects(
      service.textDownload(
        { requestId: 'invalid', sourceId, workId: '42', chapterIds: ['9999'] },
        signal,
      ),
      /不在插件当前目录/,
    )
    assert.equal(requests.filter((url) => url.startsWith('/api/chapter?')).length, 1)
  } finally {
    globalThis.fetch = originalFetch
    service.close()
    await runtime.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
