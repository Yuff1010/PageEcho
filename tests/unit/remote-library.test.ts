import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { AudiobookshelfLibraryConnector } from '../../src/main/sources/audiobookshelf-library'
import { WebdavLibraryConnector, webdavUrl } from '../../src/main/sources/webdav-library'
import { TextHttpClient } from '../../src/main/sources/text-http'
import type { TextLibraryContext } from '../../src/main/sources/text-provider'
import { syntheticToken } from '../helpers/synthetic-auth'

async function server(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const instance = createServer(handler)
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(instance.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        instance.closeAllConnections()
        instance.close(() => resolve())
      }),
  }
}

function context(
  baseUrl: string,
  kind: 'webdav' | 'audiobookshelf',
  token?: string,
): TextLibraryContext {
  const connection = {
    id: 'personal-test',
    kind,
    label: '测试书库',
    baseUrl,
    enabled: true,
    hasCredentials: Boolean(token),
    lastCheckedAt: null,
    lastCheckError: null,
    ...(token ? { token } : {}),
  }
  return { connection, http: new TextHttpClient(connection), signal: new AbortController().signal }
}

function dav(items: Array<[string, string, boolean]>) {
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${items.map(([href, name, folder]) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:displayname>${name}</d:displayname><d:resourcetype>${folder ? '<d:collection/>' : ''}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('')}</d:multistatus>`
}

test('WebDAV traverses one directory at a time, filters formats, searches and imports a real TXT response', async () => {
  const token = syntheticToken()
  const requests: string[] = []
  const fixture = await server((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    assert.equal(req.headers.authorization, `Bearer ${token}`)
    if (req.method === 'PROPFIND') {
      assert.equal(req.headers.depth, '1')
      res.writeHead(207, { 'Content-Type': 'application/xml' })
      res.end(
        req.url === '/dav/'
          ? dav([
              ['/dav/', '根目录', true],
              ['/dav/fiction/', '小说', true],
              ['/dav/readme.pdf', '说明.pdf', false],
              ['/dav/fiction/deep.txt', '深层内容.txt', false],
            ])
          : req.url === '/dav/fiction/'
            ? dav([
                ['/dav/fiction/', '小说', true],
                ['/dav/fiction/one.txt', '第一本.txt', false],
                ['/dav/fiction/two.epub', '第二本.epub', false],
              ])
            : dav([['/dav/fiction/one.txt', '第一本.txt', false]]),
      )
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('第一章 测试\n这是个人书库的合成文本。')
    }
  })
  try {
    const c = context(`${fixture.url}/dav/`, 'webdav', token)
    const source = new WebdavLibraryConnector()
    const root = await source.browse(c, { requestId: 'one', sourceId: c.connection.id })
    assert.equal(root.books.length, 0)
    assert.deepEqual(
      root.navigation.map((item) => item.title),
      ['小说'],
    )
    const children = await source.browse(c, {
      requestId: 'two',
      sourceId: c.connection.id,
      cursor: root.navigation[0]!.cursor,
    })
    assert.equal(children.books.length, 2)
    assert.equal(children.navigation[0]!.title, '上一级')
    const filtered = await source.browse(c, {
      requestId: 'three',
      sourceId: c.connection.id,
      cursor: root.navigation[0]!.cursor,
      query: '第一',
    })
    assert.deepEqual(
      filtered.books.map((item) => item.title),
      ['第一本.txt'],
    )
    const detail = await source.detail(c, filtered.books[0]!.workId)
    const file = await source.download(c, {
      requestId: 'four',
      sourceId: c.connection.id,
      workId: detail.workId,
      acquisitionId: detail.acquisitions[0]!.id,
    })
    assert.equal(file.filename, '第一本.txt')
    assert.match(file.bytes.toString('utf8'), /合成文本/)
    assert.equal(requests.at(-1), 'GET /dav/fiction/one.txt')
  } finally {
    await fixture.close()
  }
})

test('WebDAV rejects traversal, DTDs and out-of-directory redirects before credentials reach the target', async () => {
  const leaked: string[] = []
  const fixture = await server((req, res) => {
    if (req.url?.startsWith('/other')) {
      leaked.push(req.url)
      res.end('secret target')
      return
    }
    if (req.url === '/dav/bad/') {
      res.writeHead(207, { 'Content-Type': 'text/xml' })
      res.end(
        '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///C:/secret">]><d:multistatus xmlns:d="DAV:"/>',
      )
    } else if (req.url === '/dav/jump/') {
      res.writeHead(302, { Location: '/other/' })
      res.end()
    } else {
      res.writeHead(207, { 'Content-Type': 'text/xml' })
      res.end(dav([]))
    }
  })
  try {
    const c = context(`${fixture.url}/dav/`, 'webdav', syntheticToken())
    for (const path of [
      '/other/a.txt',
      '/dav/%252e%252e/a.txt',
      '/dav/%2f../a.txt',
      '/dav/a%5cb.txt',
      '/dav/a.txt?q=1',
    ])
      assert.throws(() => webdavUrl(c, `${fixture.url}${path}`))
    const source = new WebdavLibraryConnector()
    await assert.rejects(
      source.browse(
        { ...c, connection: { ...c.connection, baseUrl: `${fixture.url}/dav/bad/` } },
        { requestId: 'bad', sourceId: c.connection.id },
      ),
      /有效目录/,
    )
    await assert.rejects(
      source.browse(
        { ...c, connection: { ...c.connection, baseUrl: `${fixture.url}/dav/jump/` } },
        { requestId: 'jump', sourceId: c.connection.id },
      ),
      /超出配置目录/,
    )
    assert.deepEqual(leaked, [])
  } finally {
    await fixture.close()
  }
})

test('Audiobookshelf uses library navigation, paged item APIs, search and primary ebook acquisition without playback writes', async () => {
  const token = syntheticToken()
  const requests: string[] = []
  const book = {
    id: 'item_1',
    mediaType: 'book',
    media: {
      metadata: {
        title: '测试电子书',
        authors: [{ name: '测试作者' }],
        description: '<p>合成简介</p>',
      },
      ebookFile: { ino: '123', ebookFormat: 'txt', metadata: { filename: 'test.txt' } },
    },
  }
  const fixture = await server((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    assert.equal(req.headers.authorization, `Bearer ${token}`)
    assert.equal(req.method, 'GET')
    if (req.url === '/abs/api/items/item_1/ebook') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('第一章 本地测试\n这一段是合成内容。')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify(
        req.url === '/abs/api/libraries'
          ? {
              libraries: [
                { id: 'library_1', name: '我的书', mediaType: 'book' },
                { id: 'podcast', name: '播客', mediaType: 'podcast' },
              ],
            }
          : req.url?.startsWith('/abs/api/libraries/library_1/search?')
            ? { book: [{ libraryItem: book }] }
            : req.url?.startsWith('/abs/api/libraries/library_1/items?')
              ? {
                  results: [
                    book,
                    { id: 'audio-only', media: { metadata: { title: '仅音频' }, ebookFile: null } },
                  ],
                  total: 51,
                }
              : book,
      ),
    )
  })
  try {
    const c = context(`${fixture.url}/abs`, 'audiobookshelf', token)
    const source = new AudiobookshelfLibraryConnector()
    const root = await source.browse(c, { requestId: 'root', sourceId: c.connection.id })
    assert.equal(root.searchable, false)
    assert.deepEqual(
      root.navigation.map((item) => item.title),
      ['我的书'],
    )
    const list = await source.browse(c, {
      requestId: 'list',
      sourceId: c.connection.id,
      cursor: root.navigation[0]!.cursor,
    })
    assert.equal(list.books.length, 1)
    assert.ok(list.nextCursor)
    await source.browse(c, {
      requestId: 'more',
      sourceId: c.connection.id,
      cursor: list.nextCursor!,
    })
    assert.match(requests.at(-1)!, /page=1/)
    const search = await source.browse(c, {
      requestId: 'search',
      sourceId: c.connection.id,
      cursor: root.navigation[0]!.cursor,
      query: '测试',
    })
    assert.equal(search.books[0]!.author, '测试作者')
    assert.equal(search.nextCursor, null)
    const detail = await source.detail(c, 'item_1')
    assert.equal(detail.description, '合成简介')
    const file = await source.download(c, {
      requestId: 'download',
      sourceId: c.connection.id,
      workId: 'item_1',
      acquisitionId: detail.acquisitions[0]!.id,
    })
    assert.equal(file.filename, '测试电子书.txt')
    assert.match(file.bytes.toString(), /合成内容/)
    await assert.rejects(source.detail(c, '../secret'), /编号无效/)
    await assert.rejects(
      source.download(c, {
        requestId: 'invalid',
        sourceId: c.connection.id,
        workId: 'item_1',
        acquisitionId: 'https://evil.example/secret',
      }),
      /请选择/,
    )
    assert.ok(requests.every((request) => request.startsWith('GET /abs/api/')))
  } finally {
    await fixture.close()
  }
})
