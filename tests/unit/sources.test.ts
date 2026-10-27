import assert from 'node:assert/strict'
import test from 'node:test'
import { SourceError } from '../../src/shared/sources'
import {
  Ting13Adapter,
  sourceMediaUrl,
  sourcePageUrl,
  type Ting13Load,
} from '../../src/main/sources/ting13'
import { allowTing13Request } from '../../src/main/sources/ting13-policy'
import type { Ting13Document } from '../../src/main/sources/ting13-dom'

const origin = 'https://www.ting13.cc'
function document(overrides: Partial<Ting13Document> = {}): Ting13Document {
  return {
    url: origin,
    title: '',
    ready: true,
    challenge: false,
    searchForm: true,
    searchResults: [],
    book: { title: '', authors: [], narrators: [], description: '', directory: '' },
    episodes: [],
    pages: [],
    media: [],
    ...overrides,
  }
}
function fixture(documents: Ting13Document[]) {
  const requests: Ting13Load[] = []
  const adapter = new Ting13Adapter({
    async read(request) {
      requests.push(request)
      const next = documents.shift()
      assert.ok(next, 'Unexpected extra source request')
      return structuredClone(next)
    },
  })
  return { adapter, requests }
}
const book = () =>
  document({
    url: `${origin}/youshengxiaoshuo/39941/`,
    book: {
      title: '测试有声书',
      authors: ['作者'],
      narrators: ['演播'],
      description: '简介',
      directory: '/tingdirs/UBuaPrGf/cbbhATacUFueSoEd.html',
    },
  })

test('source search keeps metadata and uses owned query-bound pagination', async () => {
  const first = document({
    url: `${origin}/novelsearch/search/result.html`,
    title: '“测试”相关搜索结果',
    searchResults: [
      {
        url: '/youshengxiaoshuo/39941/',
        title: '测试书',
        authors: ['作者'],
        narrators: ['甲', '甲'],
        description: '简介',
      },
    ],
    pages: [{ url: '/search/encoded/lastupdate/2.html', text: '2', title: '第2页' }],
  })
  const { adapter, requests } = fixture([
    first,
    document({ url: `${origin}/search/encoded/lastupdate/2.html`, title: '“测试”相关搜索结果' }),
  ])
  const page = await adapter.search(' 测试 ')
  assert.deepEqual(page.items[0]?.narrators, ['甲'])
  assert.equal(page.items[0]?.pageUrl, `${origin}/youshengxiaoshuo/39941/`)
  assert.ok(page.nextCursor)
  await assert.rejects(adapter.search('别的书', page.nextCursor), {
    code: 'INVALID_SOURCE_REQUEST',
  })
  await assert.rejects(adapter.search('测试', 'forged-url'), { code: 'INVALID_SOURCE_REQUEST' })
  assert.deepEqual(await adapter.search('测试', page.nextCursor), { items: [], nextCursor: null })
  assert.equal(requests.length, 2)
})

test('directory pages use declared episode order, not global media IDs or history links', async () => {
  const directory = '/tingdirs/UBuaPrGf/cbbhATacUFueSoEd.html'
  const { adapter } = fixture([
    book(),
    document({
      url: origin + directory,
      episodes: [
        { url: '/play/39941_1_999.html', text: '开篇', title: '测试有声小说 第1集' },
        { url: '/play/39941_1_2.html', text: '第二集', title: '测试有声小说 第2集' },
      ],
      pages: [{ url: directory + '?page=2&sort=asc', text: '下页', title: '下页' }],
    }),
    document({
      url: origin + directory + '?page=2&sort=asc',
      episodes: [{ url: '/play/39941_1_44.html', text: '第三集', title: '测试有声小说 第3集' }],
    }),
  ])
  assert.equal((await adapter.getBook('39941')).title, '测试有声书')
  const first = await adapter.getEpisodes('39941')
  assert.deepEqual(
    first.items.map((item) => item.order),
    [1, 2],
  )
  assert.equal(first.items[1]?.id, '39941_1_2')
  assert.ok(first.nextCursor)
  await assert.rejects(adapter.getEpisodes('123', first.nextCursor), {
    code: 'INVALID_SOURCE_REQUEST',
  })
  assert.equal((await adapter.getEpisodes('39941', first.nextCursor)).items[0]?.order, 3)
})

test('incomplete, cross-book, duplicate or reversed directory identities fail explicitly', async () => {
  const valid = { url: '/play/39941_1_99.html', text: '第一集', title: '测试 第1集' }
  for (const episodes of [
    [],
    [{ ...valid, url: '/play/1_1_99.html' }],
    [{ ...valid, title: '无集数' }],
    [valid, valid],
    [
      { ...valid, title: '测试 第2集' },
      { ...valid, url: '/play/39941_1_98.html' },
    ],
  ]) {
    const { adapter } = fixture([
      book(),
      document({ url: origin + '/tingdirs/UBuaPrGf/cbbhATacUFueSoEd.html', episodes }),
    ])
    await assert.rejects(adapter.getEpisodes('39941'), { code: 'SOURCE_CHANGED' })
  }
})

test('source identifiers and public origins cannot turn requests into arbitrary URLs', async () => {
  const { adapter, requests } = fixture([])
  for (const id of ['0', '../etc', '39941?x=1', '1.2'])
    await assert.rejects(adapter.getBook(id), { code: 'INVALID_SOURCE_REQUEST' })
  for (const url of [
    'http://www.ting13.cc/',
    'https://www.ting13.cc.evil.test/',
    'https://localhost/',
    'file:///C:/secret',
    'https://user@www.ting13.cc/',
    '/#bad',
  ])
    assert.throws(() => sourcePageUrl(url), { code: 'INVALID_SOURCE_REQUEST' })
  await assert.rejects(adapter.resolveAudio('39941', '123_1_99'), {
    code: 'INVALID_SOURCE_REQUEST',
  })
  await assert.rejects(adapter.search('x'.repeat(21)), { code: 'INVALID_SOURCE_REQUEST' })
  assert.equal(requests.length, 0)
})

test('temporary audio URLs stay verbatim and have no invented expiration time', async () => {
  const pageUrl = `${origin}/play/39941_1_99.html`
  const url = 'https://car-lv.kuwo.cn/path/audio.mp3?expires=opaque&sign=public-media-token'
  const { adapter } = fixture([document({ url: pageUrl, media: [url] })])
  const actual = await adapter.resolveAudio('39941', '39941_1_99')
  assert.equal(actual.url, url)
  assert.equal(actual.expiresAt, null)
  assert.deepEqual(actual.headers, { Referer: pageUrl })
  assert.equal(
    sourceMediaUrl('https://mp3nn.ysxs.top/public/audio.mp3'),
    'https://mp3nn.ysxs.top/public/audio.mp3',
  )
  for (const bad of [
    'http://car-lv.kuwo.cn/x.mp3',
    'https://localhost/x.mp3',
    'https://kuwo.cn.evil.test/x.mp3',
    'https://mp3nn.ysxs.top.evil.test/x.mp3',
    'https://other.ysxs.top/x.mp3',
    'https://user@car-lv.kuwo.cn/x.mp3',
  ])
    assert.throws(() => sourceMediaUrl(bad), { code: 'SOURCE_MEDIA_UNAVAILABLE' })
})

test('source isolation permits ordinary required scripts and blocks privileged navigation, ads and automatic media', () => {
  assert.equal(allowTing13Request(origin + '/play/39941_1_99.html', 'mainFrame'), true)
  assert.equal(allowTing13Request(origin + '/api/play', 'xhr'), true)
  assert.equal(
    allowTing13Request(
      'https://cdnjs.cloudflare.com/ajax/libs/jquery/3.5.1/jquery.min.js',
      'script',
    ),
    true,
  )
  for (const [url, type] of [
    [origin, 'subFrame'],
    ['file:///C:/secret', 'mainFrame'],
    ['https://evil.test/', 'mainFrame'],
    ['https://pagead2.googlesyndication.com/a.js', 'script'],
    ['https://car-lv.kuwo.cn/audio.mp3', 'media'],
    ['https://localhost/api', 'xhr'],
    ['https://cdnjs.cloudflare.com/evil.js', 'script'],
  ])
    assert.equal(allowTing13Request(url!, type!), false)
})

test('network/cancellation errors propagate without fabricating an empty successful result', async () => {
  const controller = new AbortController()
  const adapter = new Ting13Adapter({
    async read(_request, signal) {
      assert.equal(signal, controller.signal)
      throw new SourceError('SOURCE_CANCELED', 'canceled')
    },
  })
  controller.abort()
  await assert.rejects(adapter.search('测试', undefined, controller.signal), {
    code: 'SOURCE_CANCELED',
  })
})
