import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { PluginService, type PluginExecutor } from '../../src/main/plugins/service'
import { PluginRuntime } from '../../src/main/plugins/runtime'
import { parsePluginPackage } from '../../src/main/plugins/package'
import { parsePluginManifest, MAX_PLUGIN_ZIP_BYTES } from '../../src/main/plugins/manifest'
import { validatePluginArgs } from '../../src/main/plugins/validation'
import { PLUGIN_CHANNELS } from '../../src/shared/plugins'
import { pluginFiles, pluginPackage } from '../fixtures/source-plugin'
import { zip } from '../fixtures/original-epub'
import { syntheticCredentials, syntheticToken } from '../helpers/synthetic-auth'

const origin = 'https://plugin.example'
const signal = () => new AbortController().signal
const code = (value: string) => (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === value

function temp(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ralb-plugin-packages-'))
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.match(basename(directory), /^ralb-plugin-packages-/)
    rmSync(directory, { recursive: true, force: true })
  })
  return directory
}

async function http(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  })
  return `http://127.0.0.1:${address.port}`
}

function fakeRuntime() {
  let inspected = 0
  const executor: PluginExecutor = {
    inspect: async () => {
      inspected++
      return [
        { id: 'audio', methods: ['search', 'getBook', 'getEpisodes', 'resolveAudio'] },
        { id: 'text', methods: ['search', 'getBook', 'getChapters', 'getChapterText'] },
      ]
    },
    execute: async () => {
      throw new Error('Not used by package-only tests')
    },
  }
  return { executor, inspected: () => inspected }
}

test('ZIP package preview reads data only; installed multi-source package persists, updates and rolls back atomically', async (t) => {
  const directory = temp(t),
    fake = fakeRuntime()
  const service = new PluginService({ directory, runtime: fake.executor })
  t.after(() => service.close())
  const first = service.previewFile(pluginPackage(origin))
  assert.equal(fake.inspected(), 0)
  assert.equal(service.list().plugins.length, 0)
  assert.deepEqual(
    first.sources.map((source) => source.id),
    ['plugin:synthetic.books:audio', 'plugin:synthetic.books:text'],
  )
  await service.install(first.previewId)
  assert.equal(fake.inspected(), 1)
  assert.equal(service.list().sources.length, 2)
  const registry = readFileSync(join(directory, 'plugins.json'), 'utf8')
  assert.ok(!registry.includes('main.js'))
  assert.ok(!registry.includes('registerSource'))
  const reopened = new PluginService({ directory, runtime: fake.executor })
  t.after(() => reopened.close())
  assert.equal(reopened.list().plugins[0]!.version, '1.0.0')
  assert.equal(reopened.audioSources()[0]!.id, first.sources[0]!.id)
  const update = service.previewFile(pluginPackage(origin, { version: '1.1.0' }))
  assert.equal(update.previousVersion, '1.0.0')
  assert.equal(
    service.list().plugins[0]!.version,
    '1.0.0',
    'preview must not activate or execute code',
  )
  await service.install(update.previewId)
  assert.equal(service.list().plugins[0]!.version, '1.1.0')
  assert.equal(service.list().plugins[0]!.previousVersion, '1.0.0')
  assert.throws(
    () => service.previewFile(pluginPackage(origin, { version: '1.1.0' })),
    code('INVALID_SOURCE_REQUEST'),
  )
  assert.equal(service.rollback('synthetic.books').plugins[0]!.version, '1.0.0')
  assert.equal(service.toggle('synthetic.books', false).sources.length, 0)
  assert.throws(() => service.audioAdapter(first.sources[0]!.id), code('SOURCE_UNAVAILABLE'))
  assert.equal(service.toggle('synthetic.books', true).sources.length, 2)
  assert.equal(service.remove('synthetic.books').plugins.length, 0)
  assert.equal(
    readFileSync(join(directory, 'packages', `${first.sha256}.zip`)).length,
    first.bytes,
    'removal retains version archives and never deletes user books',
  )
})

test('ZIP rejects traversal, duplicate normalized names, links, huge files, unsupported API and unsafe declarations', () => {
  const files = pluginFiles(origin)
  const manifest = JSON.parse(files['manifest.json'])
  const invalid: Record<string, string>[] = [
    { ...files, '../escape.js': 'never write' },
    { ...files, 'Main.js': 'never execute' },
    { ...files, 'plugin.dll': 'not a loadable module' },
    { ...files, 'huge.txt': 'x'.repeat(2 * 1024 * 1024 + 1) },
    {
      ...files,
      'manifest.json': JSON.stringify({
        ...manifest,
        scripts: ['main.js', 'extra-a.js', 'extra-b.js'],
      }),
      'extra-a.js': ' '.repeat(2 * 1024 * 1024),
      'extra-b.js': ' '.repeat(2 * 1024 * 1024),
    },
    { ...files, 'manifest.json': JSON.stringify({ ...manifest, apiVersion: 2 }) },
    { ...files, 'manifest.json': JSON.stringify({ ...manifest, scripts: ['../main.js'] }) },
    { ...files, 'manifest.json': JSON.stringify({ ...manifest, scripts: ['missing.js'] }) },
    {
      ...files,
      'manifest.json': JSON.stringify({
        ...manifest,
        sources: [manifest.sources[0], manifest.sources[0]],
      }),
    },
    {
      ...files,
      'manifest.json': JSON.stringify({
        ...manifest,
        sources: [{ ...manifest.sources[0], allowedOrigins: ['https://*.example'] }],
      }),
    },
  ]
  for (const value of invalid)
    assert.throws(() => parsePluginPackage(zip(value)), code('INVALID_SOURCE_REQUEST'))
  const linked = zip(files)
  const central = linked.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  linked.writeUInt32LE((0xa1ff << 16) >>> 0, central + 38)
  assert.throws(() => parsePluginPackage(linked), code('INVALID_SOURCE_REQUEST'))
  const corrupt = zip(files)
  corrupt[50] = corrupt[50]! ^ 1
  assert.throws(() => parsePluginPackage(corrupt), code('INVALID_SOURCE_REQUEST'))
  assert.throws(
    () => parsePluginPackage(Buffer.alloc(MAX_PLUGIN_ZIP_BYTES + 1)),
    code('INVALID_SOURCE_REQUEST'),
  )
  const credentials = syntheticCredentials()
  assert.throws(
    () =>
      parsePluginManifest({
        ...manifest,
        sources: [
          {
            ...manifest.sources[0],
            baseUrl: `https://${credentials.username}:${credentials.password}@plugin.example/`,
          },
        ],
      }),
    code('INVALID_SOURCE_REQUEST'),
  )
  const nested = Object.fromEntries(
    Object.entries(files).map(([key, value]) => [`bundle/${key}`, value]),
  )
  assert.equal(parsePluginPackage(zip(nested)).manifest.id, manifest.id)
})

test('failed script inspection and incompatible source updates preserve the current plugin version', async (t) => {
  const runtime = new PluginRuntime()
  const directory = temp(t)
  const service = new PluginService({ directory, runtime })
  t.after(async () => {
    service.close()
    await runtime.close()
  })
  const first = service.previewFile(pluginPackage(origin))
  await service.install(first.previewId)
  const bad = service.previewFile(pluginPackage(origin, { version: '1.2.0', broken: true }))
  await assert.rejects(service.install(bad.previewId))
  assert.equal(service.list().plugins[0]!.version, '1.0.0')
  assert.equal(service.list().plugins[0]!.previousVersion, null)
  const files = pluginFiles(origin, { version: '1.3.0' })
  const manifest = JSON.parse(files['manifest.json'])
  manifest.sources[0].kind = 'text'
  delete manifest.sources[0].mediaOrigins
  files['manifest.json'] = JSON.stringify(manifest)
  assert.throws(() => service.previewFile(zip(files)), code('INVALID_SOURCE_REQUEST'))
  const missing = pluginFiles(origin, { version: '1.3.0' })
  missing['main.js'] =
    "registerSource({id:'audio',search:function(){return {items:[],nextCursor:null}},getBook:function(){},getEpisodes:function(){},resolveAudio:function(){}});"
  const missingPreview = service.previewFile(zip(missing))
  await assert.rejects(service.install(missingPreview.previewId), code('INVALID_SOURCE_REQUEST'))
  assert.equal(service.list().plugins[0]!.version, '1.0.0')
})

test('real isolated plugin adapters fetch audio/text, validate domains and retain version snapshots', async (t) => {
  const requests: string[] = []
  let firstOrigin = ''
  firstOrigin = await http(t, (req, res) => {
    requests.push(req.url!)
    if (req.url?.startsWith('/text/chapter?')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('这是选择章节的合成正文。另一个句子继续。')
      return
    }
    const base = req.url?.startsWith('/text') ? 'text' : 'audio'
    const book = {
      id: `${base}-book`,
      title: '合成书籍',
      authors: ['合成作者'],
      narrators: [],
      description: '测试简介',
      pageUrl: firstOrigin,
    }
    const data = req.url?.includes('/search')
      ? { items: [book], nextCursor: null }
      : req.url?.includes('/book')
        ? book
        : req.url?.includes('/chapters')
          ? {
              items: [
                { id: 'chapter-1', title: '第一章', order: 1, pageUrl: firstOrigin },
                { id: 'chapter-2', title: '第二章', order: 2, pageUrl: firstOrigin },
              ],
              nextCursor: null,
            }
          : {
              url: `${firstOrigin}/tone.mp3?signature=${syntheticToken()}`,
              headers: { Referer: firstOrigin },
              pageUrl: firstOrigin,
            }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  })
  const runtime = new PluginRuntime(),
    service = new PluginService({ directory: temp(t), runtime })
  t.after(async () => {
    service.close()
    await runtime.close()
  })
  await service.install(service.previewFile(pluginPackage(firstOrigin)).previewId)
  const sourceId = 'plugin:synthetic.books:audio'
  const adapter = service.audioAdapter(sourceId)
  assert.equal(service.audioAdapter(sourceId), adapter)
  const found = await adapter.search('合成书', undefined, signal())
  assert.equal(found.items[0]!.sourceId, sourceId)
  const book = await adapter.getBook('audio-book', signal())
  const episodes = await adapter.getEpisodes(book.id, undefined, signal())
  assert.equal(episodes.items[0]!.bookId, book.id)
  const resolved = await adapter.resolveAudio(book.id, episodes.items[0]!.id, signal())
  assert.equal(new URL(resolved.url).origin, firstOrigin)
  assert.equal(resolved.headers.Referer, firstOrigin)
  assert.throws(
    () => adapter.urlPolicy!.mediaUrl('https://other.example/track.mp3'),
    code('SOURCE_MEDIA_UNAVAILABLE'),
  )
  assert.throws(
    () => adapter.urlPolicy!.pageUrl('file:///C:/sensitive'),
    code('INVALID_SOURCE_REQUEST'),
  )
  const textSource = 'plugin:synthetic.books:text'
  const texts = await service.textBrowse(
    { requestId: 'browse', sourceId: textSource, query: '合成' },
    signal(),
  )
  const detail = await service.textDetail(
    { requestId: 'detail', sourceId: textSource, workId: texts.books[0]!.workId },
    signal(),
  )
  assert.equal(detail.chapters.length, 2)
  const downloaded = await service.textDownload(
    { requestId: 'read', sourceId: textSource, workId: detail.workId, chapterIds: ['chapter-1'] },
    signal(),
  )
  assert.match(downloaded.bytes.toString('utf8'), /选择章节的合成正文/)
  assert.ok(!requests.some((url) => url.includes('/text/chapter?id=chapter-2')))
  await assert.rejects(
    service.textDownload(
      { requestId: 'forged', sourceId: textSource, workId: detail.workId, chapterIds: ['unknown'] },
      signal(),
    ),
    code('INVALID_SOURCE_REQUEST'),
  )
  const updated = pluginPackage(firstOrigin, { version: '2.0.0' })
  await service.install(service.previewFile(updated).previewId)
  assert.notEqual(service.audioAdapter(sourceId), adapter)
  assert.equal(
    (await adapter.getBook('audio-book', signal())).id,
    'audio-book',
    'captured version remains callable after update',
  )
  const report = await service.test({
    requestId: 'test',
    id: 'synthetic.books',
    sourceId,
    query: '测试',
  })
  assert.equal(report.passed, true)
  assert.deepEqual(
    report.steps.map((step) => step.name),
    ['搜索', '详情', '目录', '音频解析'],
  )
})

test('URL package import supports preview, cancellation and rejects foreign or partial downloads', async (t) => {
  const fake = fakeRuntime(),
    service = new PluginService({ directory: temp(t), runtime: fake.executor })
  t.after(() => service.close())
  let foreign = 0
  const other = await http(t, (_req, res) => {
    foreign++
    res.end('never')
  })
  const bytes = pluginPackage(origin)
  let held: ServerResponse | undefined
  const address = await http(t, (req, res) => {
    if (req.url === '/redirect.zip') {
      res.writeHead(302, { Location: `${other}/foreign.zip` })
      res.end()
      return
    }
    if (req.url === '/slow.zip') {
      held = res
      return
    }
    res.writeHead(req.url === '/partial.zip' ? 206 : 200, {
      'Content-Type': 'application/zip',
      ...(req.url === '/partial.zip' ? { 'Content-Range': 'bytes 0-9/9999' } : {}),
    })
    res.end(bytes)
  })
  const preview = await service.previewUrl({ requestId: 'download', url: `${address}/good.zip` })
  assert.equal(preview.id, 'synthetic.books')
  assert.equal(fake.inspected(), 0)
  await assert.rejects(
    service.previewUrl({ requestId: 'redirect', url: `${address}/redirect.zip` }),
    code('INVALID_SOURCE_REQUEST'),
  )
  assert.equal(foreign, 0)
  await assert.rejects(
    service.previewUrl({ requestId: 'partial', url: `${address}/partial.zip` }),
    code('SOURCE_UNAVAILABLE'),
  )
  const pending = service.previewUrl({ requestId: 'cancel', url: `${address}/slow.zip` })
  while (!held) await new Promise((done) => setTimeout(done, 2))
  service.cancel('cancel')
  await assert.rejects(pending, code('SOURCE_CANCELED'))
  held.destroy()
  assert.equal(service.list().plugins.length, 0)
})

test('plugin IPC validation rejects extra arguments, scripts, credentials and mismatched request shapes', () => {
  validatePluginArgs(PLUGIN_CHANNELS.list, [])
  validatePluginArgs(PLUGIN_CHANNELS.previewUrl, [
    { requestId: 'request', url: `${origin}/plugin.zip` },
  ])
  validatePluginArgs(PLUGIN_CHANNELS.test, [
    {
      requestId: 'test',
      id: 'synthetic.books',
      sourceId: 'plugin:synthetic.books:audio',
      query: '书',
    },
  ])
  for (const [channel, args] of [
    [PLUGIN_CHANNELS.list, [{}]],
    [PLUGIN_CHANNELS.choose, ['C:/arbitrary/file']],
    [PLUGIN_CHANNELS.previewUrl, [{ requestId: 'request', url: 'file:///C:/secret.zip' }]],
    [
      PLUGIN_CHANNELS.previewUrl,
      [{ requestId: 'request', url: `${origin}/plugin.zip`, script: 'arbitrary()' }],
    ],
    [PLUGIN_CHANNELS.toggle, [{ id: 'synthetic.books', enabled: 'yes' }]],
    [PLUGIN_CHANNELS.install, [{ previewId: '../arbitrary' }]],
    [PLUGIN_CHANNELS.test, [{ requestId: 'test', id: 'x', sourceId: 'arbitrary' }]],
  ] as Array<[string, unknown[]]>)
    assert.throws(() => validatePluginArgs(channel, args), code('INVALID_SOURCE_REQUEST'))
})

test('adapters reject forged identities, duplicate directories, unsafe headers and oversized cursors without losing valid signed media', async (t) => {
  const fake = fakeRuntime()
  let value: unknown
  const executor: PluginExecutor = { ...fake.executor, execute: async () => value }
  const service = new PluginService({ directory: temp(t), runtime: executor })
  t.after(() => service.close())
  await service.install(service.previewFile(pluginPackage(origin)).previewId)
  const adapter = service.audioAdapter('plugin:synthetic.books:audio')
  const book = {
    id: 'one',
    title: '合成书目',
    authors: [],
    narrators: [],
    description: '',
    pageUrl: origin,
  }
  value = { ...book, id: 'different' }
  await assert.rejects(adapter.getBook('one', signal()), code('INVALID_SOURCE_REQUEST'))
  value = { items: [book, book], nextCursor: null }
  await assert.rejects(adapter.search('one', undefined, signal()), code('INVALID_SOURCE_REQUEST'))
  value = { items: [{ id: 'chapter', bookId: 'wrong', title: '章节', order: 1 }], nextCursor: null }
  await assert.rejects(
    adapter.getEpisodes('one', undefined, signal()),
    code('INVALID_SOURCE_REQUEST'),
  )
  value = { url: 'https://outside.example/tone.mp3' }
  await assert.rejects(
    adapter.resolveAudio('one', 'chapter', signal()),
    code('SOURCE_MEDIA_UNAVAILABLE'),
  )
  value = { url: `${origin}/tone.mp3`, headers: { Cookie: syntheticToken() } }
  await assert.rejects(
    adapter.resolveAudio('one', 'chapter', signal()),
    code('INVALID_SOURCE_REQUEST'),
  )
  value = { url: `${origin}/tone.mp3`, headers: { Referer: 'https://outside.example/' } }
  await assert.rejects(
    adapter.resolveAudio('one', 'chapter', signal()),
    code('INVALID_SOURCE_REQUEST'),
  )
  const signed = `${origin}/tone.mp3?token=${syntheticToken()}`
  value = { url: signed }
  assert.equal((await adapter.resolveAudio('one', 'chapter', signal())).url, signed)
  assert.throws(
    () =>
      service.textBrowse(
        { requestId: 'cursor', sourceId: 'plugin:synthetic.books:text', cursor: 'x'.repeat(2049) },
        signal(),
      ),
    code('INVALID_SOURCE_REQUEST'),
  )
  value = { items: [], nextCursor: null }
  const noResult = await service.test({
    requestId: 'no-result',
    id: 'synthetic.books',
    sourceId: adapter.id,
  })
  assert.equal(noResult.passed, false)
  assert.equal(noResult.steps.at(-1)?.status, 'skipped')
})
