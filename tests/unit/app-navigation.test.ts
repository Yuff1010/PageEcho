import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appRouteHash, parseAppRoute, type AppRoute } from '../../src/renderer/src/app-navigation'

test('all application destinations have refreshable routes that round trip', () => {
  const cases: [AppRoute, string][] = [
    [{ view: 'library' }, '#/library/audiobooks'],
    [{ view: 'ebook' }, '#/library/ebooks'],
    [{ view: 'reading' }, '#/listening'],
    [{ view: 'source' }, '#/sources'],
    [{ view: 'chapters', bookId: 'audio-123' }, '#/audiobooks/audio-123'],
    [{ view: 'reader', bookId: 'book-123' }, '#/read/book-123'],
    [
      { view: 'reader', bookId: '青山 第一卷' },
      '#/read/%E9%9D%92%E5%B1%B1%20%E7%AC%AC%E4%B8%80%E5%8D%B7',
    ],
    [{ view: 'chapters', bookId: '书名%20' }, '#/audiobooks/%E4%B9%A6%E5%90%8D%2520'],
  ]
  for (const [route, hash] of cases) {
    assert.equal(appRouteHash(route), hash)
    assert.deepEqual(parseAppRoute(hash), route)
  }
})

test('empty, legacy and unknown routes keep the audiobook library reachable', () => {
  for (const hash of ['', '#', '#library', '#/library', '#/unknown', '#/library/ebooks?x=1'])
    assert.deepEqual(parseAppRoute(hash), { view: 'library' }, hash)
})

test('book deep links reject malformed encoding, empty IDs, nested paths and queries', () => {
  for (const prefix of ['#/read/', '#/audiobooks/']) {
    for (const id of [
      '',
      ' ',
      '%20',
      '%ff',
      '%E9%9D',
      '%',
      'a/b',
      'a?b',
      'a#b',
      'a%2Fb',
      'a%3Fb',
      'a%23b',
      '%00',
      '%7F',
      '%C2%85',
      'a'.repeat(201),
    ])
      assert.deepEqual(parseAppRoute(`${prefix}${id}`), { view: 'library' }, `${prefix}${id}`)
  }
})

test('book IDs allow readable Unicode and spaces within the bounded route', () => {
  for (const view of ['reader', 'chapters'] as const) {
    const route: AppRoute = { view, bookId: '青'.repeat(200) }
    assert.deepEqual(parseAppRoute(appRouteHash(route)), route)
    for (const bookId of ['', ' ', 'a/b', 'a?b', 'a#b', '\u0000', 'a'.repeat(201)])
      assert.throws(() => appRouteHash({ view, bookId }), RangeError)
  }
})
