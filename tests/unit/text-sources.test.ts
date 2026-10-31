import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { TextHttpClient } from '../../src/main/sources/text-http'
import { TextSourceService, parseRemoteManifest } from '../../src/main/sources/text-service'
import { WikisourceTextSource } from '../../src/main/sources/text-wikisource'
import { validateTextSourceArgs } from '../../src/main/sources/text-validation'
import { TEXT_SOURCE_CHANNELS } from '../../src/shared/text-source-api'
import { SourceError } from '../../src/shared/sources'
import type { ReadingBook } from '../../src/shared/reading'
import { parseOriginal } from '../../src/main/original/parse'
import type { TextLibraryConnector } from '../../src/main/sources/text-provider'
import { epub, zip } from '../fixtures/original-epub'
import { syntheticCredentials, syntheticToken } from '../helpers/synthetic-auth'

const atom = (content: string) =>
  `<feed xmlns="http://www.w3.org/2005/Atom"><id>urn:fixture</id><title>书库</title>${content}</feed>`
const free = `<entry><id>urn:book:one</id><title>测试小说</title><author><name>作者</name></author><summary>正文简介</summary><link rel="http://opds-spec.org/acquisition/open-access" href="/book.txt" type="text/plain"/><link rel="http://opds-spec.org/image/thumbnail" href="/cover.png" type="image/png"/></entry>`
const secretCodec = {
  encrypt: (value: string) => Buffer.from(value).toString('base64'),
  decrypt: (value: string) => Buffer.from(value, 'base64').toString('utf8'),
}
const code = (expected: string) => (error: unknown) =>
  error instanceof SourceError && error.code === expected

async function server(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
) {
  const instance = createServer(handler)
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve))
  const address = instance.address()
  assert.ok(address && typeof address !== 'string')
  t.after(async () => {
    instance.closeAllConnections()
    await new Promise<void>((resolve) => instance.close(() => resolve()))
  })
  return `http://127.0.0.1:${address.port}`
}

function setup(
  t: TestContext,
  extras: Partial<ConstructorParameters<typeof TextSourceService>[0]> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'ralb-text-source-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const books = new Map<string, ReadingBook>()
  const importedTexts: string[] = []
  let imports = 0
  const service = new TextSourceService({
    directory,
    secretCodec,
    getReadingBook: (id) => books.get(id) ?? null,
    importBook: (bytes, filename, signal) => {
      signal.throwIfAborted()
      const parsed = parseOriginal(bytes, filename)
      importedTexts.push(bytes.toString('utf8'))
      const { sentences, ...info } = parsed
      const book: ReadingBook = {
        ...info,
        id: `book-${++imports}`,
        sentenceCount: sentences.length,
        importedAt: new Date().toISOString(),
        position: 0,
        lastReadAt: null,
      }
      books.set(book.id, book)
      return book
    },
    ...extras,
  })
  t.after(() => service.close())
  return { service, books, directory, importedTexts, imports: () => imports }
}

test('personal OPDS search, navigation, next page and open-access TXT import use bounded authenticated requests', async (t) => {
  const credentials = syntheticCredentials()
  const requests: string[] = []
  const authorization: Array<string | undefined> = []
  const origin = await server(t, (req, res) => {
    requests.push(req.url!)
    authorization.push(req.headers.authorization)
    if (req.url === '/book.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('第一章 相逢\n这是第一句。这里是第二句。')
      return
    }
    if (req.url === '/search.xml') {
      res.writeHead(200, { 'content-type': 'application/opensearchdescription+xml' })
      res.end(
        '<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><Url type="application/atom+xml" template="/search?q={searchTerms}&amp;count={count?}"/></OpenSearchDescription>',
      )
      return
    }
    res.writeHead(200, { 'content-type': 'application/atom+xml' })
    res.end(
      atom(
        `${free}<link rel="next" href="/next"/><link rel="search" type="application/opensearchdescription+xml" href="/search.xml"/><entry><id>folder</id><title>分类</title><link rel="subsection" type="application/atom+xml" href="/folder"/></entry><entry><id>buy</id><title>需购买</title><link rel="http://opds-spec.org/acquisition/buy" type="text/html" href="/purchase"/></entry>`,
      ),
    )
  })
  const { service, books, imports, directory } = setup(t)
  const saved = service.save({
    id: 'personal',
    kind: 'opds',
    label: '我的书库',
    baseUrl: origin,
    enabled: true,
    username: credentials.username,
    password: credentials.password,
  })
  assert.equal(saved.hasCredentials, true)
  assert.equal(JSON.stringify(service.state()).includes(credentials.password), false)
  assert.equal(
    readFileSync(join(directory, 'text-libraries.json'), 'utf8').includes(credentials.password),
    false,
  )
  const page = await service.browse({ requestId: 'browse', sourceId: saved.id })
  assert.equal(page.books.length, 2)
  assert.equal(page.books[0]!.coverUrl, `${origin}/cover.png`)
  assert.equal(page.navigation[0]?.title, '分类')
  assert.equal(page.searchable, true)
  assert.ok(page.nextCursor)
  await service.browse({ requestId: 'next', sourceId: saved.id, cursor: page.nextCursor! })
  await service.browse({ requestId: 'search', sourceId: saved.id, query: '中文 空格' })
  assert.ok(requests.includes('/next'))
  assert.ok(
    requests.some((url) =>
      url.startsWith('/search?q=%E4%B8%AD%E6%96%87%20%E7%A9%BA%E6%A0%BC&count=20'),
    ),
  )
  const detail = await service.detail({
    requestId: 'detail',
    sourceId: saved.id,
    workId: page.books[0]!.workId,
  })
  assert.equal(detail.acquisitions[0]?.format, 'txt')
  const imported = await service.import({
    requestId: 'import',
    sourceId: saved.id,
    workId: detail.workId,
    acquisitionId: detail.acquisitions[0]!.id,
  })
  assert.equal(imported.reused, false)
  books.get(imported.book.id)!.position = 1
  service.save({ id: saved.id, baseUrl: saved.baseUrl, label: '改名', kind: 'opds', enabled: true })
  const duplicate = await service.import({
    requestId: 'again',
    sourceId: saved.id,
    workId: detail.workId,
    acquisitionId: detail.acquisitions[0]!.id,
  })
  assert.equal(duplicate.reused, true)
  assert.equal(duplicate.book.position, 1)
  assert.equal(imports(), 1)
  const restricted = await service.detail({
    requestId: 'restricted',
    sourceId: saved.id,
    workId: page.books[1]!.workId,
  })
  assert.equal(restricted.acquisitions.length, 0)
  assert.match(restricted.notice!, /购买或借阅/)
  assert.ok(
    authorization.every(
      (value) =>
        value ===
        `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`,
    ),
  )
})

test('connection manifests preview without side effects, accept pretty JSON, and protect secrets on updates', (t) => {
  const credentials = syntheticCredentials()
  const { service } = setup(t)
  const emptyExport = service.manifestExport()
  assert.equal(service.manifestPreview(emptyExport).manifest.libraries.length, 0)
  service.save({
    id: 'personal',
    kind: 'opds',
    label: '本地',
    baseUrl: 'https://library.example/opds',
    enabled: true,
    password: credentials.password,
  })
  const exported = service.manifestExport()
  assert.equal(exported.includes(credentials.password), false)
  validateTextSourceArgs(TEXT_SOURCE_CHANNELS.manifestPreview, [{ rawJson: exported }])
  const preview = service.manifestPreview(exported)
  assert.equal(preview.applicable, true)
  assert.deepEqual(preview.updates, ['personal'])
  assert.equal(service.state().libraries[0]!.hasCredentials, true)
  service.manifestApply(exported)
  assert.equal(service.state().libraries[0]!.hasCredentials, true)
  assert.throws(() => service.manifestApply(exported), code('INVALID_SOURCE_REQUEST'))
  const changed = JSON.parse(exported)
  changed.version++
  changed.libraries[0].kind = 'webdav'
  service.manifestApply(JSON.stringify(changed, null, 2))
  assert.equal(service.state().libraries[0]!.hasCredentials, false)
  changed.version++
  changed.libraries[0].password = syntheticToken()
  assert.throws(() => parseRemoteManifest(JSON.stringify(changed)), code('INVALID_SOURCE_REQUEST'))
  assert.throws(
    () =>
      parseRemoteManifest(
        '{"schemaVersion":1,"id":"bad","version":1,"libraries":[],"script":"process.exit()"}',
      ),
    code('INVALID_SOURCE_REQUEST'),
  )
})

test('HTTP rejects DTD feeds, foreign acquisition URLs, foreign redirects and streamed oversize bodies', async (t) => {
  let leaked = false
  const other = await server(t, (_req, res) => {
    leaked = true
    res.end('never')
  })
  const origin = await server(t, (req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `${other}/credential` })
      res.end()
      return
    }
    if (req.url === '/large') {
      res.writeHead(200)
      res.write('12345')
      res.end('67890')
      return
    }
    if (req.url === '/foreign') {
      res.writeHead(200, { 'content-type': 'application/atom+xml' })
      res.end(
        atom(
          `<entry><id>foreign</id><title>超域下载</title><link rel="http://opds-spec.org/acquisition" type="text/plain" href="${other}/credential"/></entry>`,
        ),
      )
      return
    }
    res.writeHead(200, { 'content-type': 'application/atom+xml' })
    res.end(
      '<!DOCTYPE feed [<!ENTITY xxe SYSTEM "file:///secret">]><feed xmlns="http://www.w3.org/2005/Atom">&xxe;</feed>',
    )
  })
  const http = new TextHttpClient({ baseUrl: origin, ...syntheticCredentials() })
  await assert.rejects(
    http.get(`${origin}/redirect`, new AbortController().signal),
    code('INVALID_SOURCE_REQUEST'),
  )
  assert.equal(leaked, false)
  await assert.rejects(
    http.get(`${origin}/large`, new AbortController().signal, { maxBytes: 8 }),
    code('SOURCE_UNAVAILABLE'),
  )
  const { service } = setup(t)
  service.save({ id: 'dtd', kind: 'opds', label: 'malformed', baseUrl: origin, enabled: true })
  await assert.rejects(
    service.browse({ requestId: 'dtd', sourceId: 'dtd' }),
    code('SOURCE_CHANGED'),
  )
  service.save({
    id: 'foreign',
    kind: 'opds',
    label: 'foreign',
    baseUrl: `${origin}/foreign`,
    enabled: true,
  })
  const page = await service.browse({ requestId: 'foreign-browse', sourceId: 'foreign' })
  const detail = await service.detail({
    requestId: 'foreign-detail',
    sourceId: 'foreign',
    workId: page.books[0]!.workId,
  })
  assert.equal(detail.acquisitions.length, 0)
  await assert.rejects(
    service.import({
      requestId: 'foreign-import',
      sourceId: 'foreign',
      workId: detail.workId,
      acquisitionId: 'forged',
    }),
    code('INVALID_SOURCE_REQUEST'),
  )
  assert.equal(leaked, false)
})

test('network cancellation and timeout remain distinct, and path validators run before a redirect target is fetched', async (t) => {
  let outsideRequested = false
  const origin = await server(t, (req, res) => {
    if (req.url === '/books/redirect') {
      res.writeHead(302, { location: '/outside/file.txt' })
      res.end()
      return
    }
    if (req.url === '/outside/file.txt') {
      outsideRequested = true
      res.end('outside')
      return
    }
    setTimeout(() => {
      if (!res.destroyed) res.end('slow')
    }, 300)
  })
  const http = new TextHttpClient({ baseUrl: origin, timeoutMs: 15 })
  await assert.rejects(http.get(origin, new AbortController().signal), code('SOURCE_TIMEOUT'))
  const cancellation = new AbortController()
  const pending = new TextHttpClient({ baseUrl: origin }).get(origin, cancellation.signal)
  cancellation.abort()
  await assert.rejects(pending, code('SOURCE_CANCELED'))
  const confined = new TextHttpClient({
    baseUrl: `${origin}/books/`,
    validateUrl: (url) => {
      if (!decodeURIComponent(url.pathname).startsWith('/books/'))
        throw new SourceError('INVALID_SOURCE_REQUEST', 'outside')
    },
  })
  await assert.rejects(
    confined.get(`${origin}/books/redirect`, new AbortController().signal),
    code('INVALID_SOURCE_REQUEST'),
  )
  assert.equal(outsideRequested, false)
})

test('Wikisource imports only selected catalog chapters and reuses the same selected reading scope', async (t) => {
  const fetched: string[] = []
  const origin = await server(t, (req, res) => {
    const url = new URL(req.url!, 'http://fixture')
    res.writeHead(200, { 'content-type': 'application/json' })
    if (url.searchParams.get('action') === 'query') {
      res.end(
        JSON.stringify({
          query: { search: [{ pageid: 10, title: '示例作品', snippet: '<span>命中</span>简介' }] },
        }),
      )
      return
    }
    const title = url.searchParams.get('page')
    if (title) fetched.push(title)
    res.end(
      JSON.stringify({
        parse: {
          pageid: 10,
          title: title ?? '示例作品',
          links: [
            { ns: 0, title: '第一篇', exists: true },
            { ns: 0, title: '第二篇', exists: true },
          ],
          text: title
            ? '<div><div id="headerContainer">不该导入的导航</div><p>这是所选章节正文。还有第二句内容。</p><script>notContent()</script><div class="licenseContainer">许可说明</div></div>'
            : '<div><div id="headerContainer"><a href="/wiki/第二篇" title="第二篇">导航不能当目录</a></div><ul><li><a href="/wiki/第一篇" title="第一篇">第一篇</a></li><li><a href="/wiki/第二篇" title="第二篇">第二篇</a></li></ul></div>',
        },
      }),
    )
  })
  const { service, imports, books, importedTexts } = setup(t, {
    wikisource: new WikisourceTextSource(origin),
  })
  const page = await service.browse({
    requestId: 'wiki-search',
    sourceId: 'wikisource',
    query: '示例作品',
  })
  const detail = await service.detail({
    requestId: 'wiki-detail',
    sourceId: 'wikisource',
    workId: page.books[0]!.workId,
  })
  assert.deepEqual(
    detail.chapters.map((chapter) => chapter.title),
    ['本页正文', '第一篇', '第二篇'],
  )
  assert.deepEqual(fetched, [])
  const request = {
    requestId: 'wiki-import',
    sourceId: 'wikisource',
    workId: '10',
    chapterIds: ['title:第一篇'],
  }
  const imported = await service.import(request)
  assert.deepEqual(fetched, ['第一篇'])
  assert.equal('sentences' in imported.book, false)
  assert.match(importedTexts[0]!, /这是所选章节正文/)
  assert.doesNotMatch(importedTexts[0]!, /不该导入|notContent|许可说明/)
  books.get(imported.book.id)!.position = 1
  const same = await service.import({ ...request, requestId: 'wiki-repeat' })
  assert.equal(same.book.position, 1)
  assert.equal(same.reused, true)
  assert.equal(imports(), 1)
  await service.import({ ...request, requestId: 'wiki-other-scope', chapterIds: ['title:第二篇'] })
  assert.equal(imports(), 2)
  await assert.rejects(
    service.import({ ...request, requestId: 'wiki-forged', chapterIds: ['title:未列出的页面'] }),
    code('INVALID_SOURCE_REQUEST'),
  )
})

test('same connection id on a different endpoint does not reuse a previous reading book or credentials', async (t) => {
  const connector: TextLibraryConnector = {
    browse: async ({ connection }) => ({
      sourceId: connection.id,
      books: [],
      navigation: [],
      nextCursor: null,
      searchable: false,
    }),
    detail: async () => {
      throw new Error('unused')
    },
    download: async ({ connection }) => ({
      bytes: Buffer.from(`第一章 开始\n正文来自${connection.baseUrl}。`),
      filename: '独立来源.txt',
    }),
  }
  const { service, imports } = setup(t, { connectors: { opds: connector } })
  service.save({
    id: 'stable',
    kind: 'opds',
    label: '书库一',
    baseUrl: 'https://one.example/opds',
    enabled: true,
    token: syntheticToken(),
  })
  const request = { requestId: 'first', sourceId: 'stable', workId: 'item_1', acquisitionId: 'txt' }
  await service.import(request)
  service.save({
    id: 'stable',
    kind: 'opds',
    label: '书库二',
    baseUrl: 'https://two.example/opds',
    enabled: true,
  })
  assert.equal(service.state().libraries[0]!.hasCredentials, false)
  const second = await service.import({ ...request, requestId: 'second' })
  assert.equal(second.reused, false)
  assert.equal(imports(), 2)
})

test('IPC validation rejects script URLs, extra fields, oversized text and malformed import selections', () => {
  assert.throws(
    () =>
      validateTextSourceArgs(TEXT_SOURCE_CHANNELS.save, [
        { kind: 'opds', label: 'x', baseUrl: 'javascript:alert(1)', enabled: true },
      ]),
    code('INVALID_SOURCE_REQUEST'),
  )
  assert.throws(
    () =>
      validateTextSourceArgs(TEXT_SOURCE_CHANNELS.browse, [
        { requestId: 'a', sourceId: 'wikisource', query: 'x'.repeat(201) },
      ]),
    code('INVALID_SOURCE_REQUEST'),
  )
  assert.throws(
    () =>
      validateTextSourceArgs(TEXT_SOURCE_CHANNELS.import, [
        { requestId: 'a', sourceId: 'wikisource', workId: '1', chapterIds: [null] },
      ]),
    code('INVALID_SOURCE_REQUEST'),
  )
  assert.throws(
    () => validateTextSourceArgs(TEXT_SOURCE_CHANNELS.cancel, [{ requestId: 'a', hidden: true }]),
    code('INVALID_SOURCE_REQUEST'),
  )
})

test('partial entry details acquire EPUB through the existing safe parser and reject HTML, partial HTTP and ZIP traversal', async (t) => {
  const payload = zip(epub)
  const origin = await server(t, (req, res) => {
    if (req.url === '/good.epub') {
      res.writeHead(200, { 'content-type': 'application/epub+zip' })
      res.end(payload)
      return
    }
    if (req.url === '/escape.epub') {
      res.writeHead(200, { 'content-type': 'application/epub+zip' })
      res.end(zip({ ...epub, '../escape': 'never extract' }))
      return
    }
    if (req.url === '/partial.txt') {
      res.writeHead(206, { 'content-type': 'text/plain', 'content-range': 'bytes 0-9/100' })
      res.end('这是部分正文。')
      return
    }
    if (req.url === '/html.txt') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>login</html>')
      return
    }
    res.writeHead(200, { 'content-type': 'application/atom+xml' })
    const entries = [
      ['good', 'good.epub', 'application/epub+zip'],
      ['escape', 'escape.epub', 'application/epub+zip'],
      ['partial', 'partial.txt', 'text/plain'],
      ['html', 'html.txt', 'text/plain'],
    ].map(
      ([id, path, type]) =>
        `<entry xmlns="http://www.w3.org/2005/Atom"><id>urn:${id}</id><title>${id}</title><link rel="http://opds-spec.org/acquisition" href="/${path}" type="${type}"/></entry>`,
    )
    if (req.url === '/complete') {
      res.end(entries[0])
      return
    }
    res.end(
      atom(
        `<entry><id>urn:good</id><title>good</title><link rel="alternate" href="/complete" type="application/atom+xml;type=entry"/></entry>${entries.slice(1).join('')}`,
      ),
    )
  })
  const { service, imports } = setup(t)
  service.save({ id: 'epub', kind: 'opds', label: 'EPUB fixture', baseUrl: origin, enabled: true })
  const page = await service.browse({ requestId: 'epub-browse', sourceId: 'epub' })
  assert.equal(page.books.length, 4)
  assert.equal(page.navigation.length, 0)
  for (let index = 0; index < page.books.length; index++) {
    const detail = await service.detail({
      requestId: `epub-detail-${index}`,
      sourceId: 'epub',
      workId: page.books[index]!.workId,
    })
    const pending = service.import({
      requestId: `epub-import-${index}`,
      sourceId: 'epub',
      workId: detail.workId,
      acquisitionId: detail.acquisitions[0]!.id,
    })
    if (index === 0) assert.equal((await pending).book.format, 'epub')
    else if (index === 1) await assert.rejects(pending, /路径/)
    else await assert.rejects(pending, (error: unknown) => error instanceof SourceError)
  }
  assert.equal(imports(), 1)
})

test('canceling a prepared import before the reading transaction leaves no imported book', async (t) => {
  let finish!: () => void
  let started!: () => void
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve
  })
  const ready = new Promise<void>((resolve) => {
    finish = resolve
  })
  const connector: TextLibraryConnector = {
    browse: async () => {
      throw new Error('unused')
    },
    detail: async () => {
      throw new Error('unused')
    },
    download: async () => {
      started()
      await ready
      return { bytes: Buffer.from('第一章 开始\n取消后不能导入。'), filename: 'cancel.txt' }
    },
  }
  const { service, imports } = setup(t, { connectors: { opds: connector } })
  service.save({
    id: 'cancel',
    kind: 'opds',
    label: 'cancel',
    baseUrl: 'https://personal.example/opds',
    enabled: true,
  })
  const pending = service.import({
    requestId: 'cancel-import',
    sourceId: 'cancel',
    workId: 'item',
    acquisitionId: 'txt',
  })
  await startedPromise
  service.cancel('cancel-import')
  finish()
  await assert.rejects(pending, code('SOURCE_CANCELED'))
  assert.equal(imports(), 0)
})
