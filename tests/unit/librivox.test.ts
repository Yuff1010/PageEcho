import assert from 'node:assert/strict'
import test from 'node:test'
import { LibriVoxAdapter, librivoxMediaUrl, librivoxPageUrl } from '../../src/main/sources/librivox'
import { syntheticCredentials } from '../helpers/synthetic-auth'

// Small synthetic fixture follows the documented API fields and the live id=52 response.
function catalog() {
  return {
    books: [
      {
        id: '52',
        title: 'Example &amp; Letters',
        description: '<p>A public domain example.</p>',
        authors: [{ first_name: 'A.', last_name: 'Writer' }],
        num_sections: '2',
        url_librivox: 'https://librivox.org/example-letters/',
        coverart_thumbnail: 'https://www.archive.org/download/example_covers/letters_thumb.jpg',
        sections: [
          {
            id: '121136',
            section_number: '1',
            title: 'Letter 1',
            listen_url: 'https://www.archive.org/download/example_librivox/letter_01.mp3',
            readers: [{ display_name: 'Reader A' }],
          },
          {
            id: '121137',
            section_number: '2',
            title: 'Letter 2',
            listen_url: 'https://archive.org/download/example_librivox/letter_02.mp3',
            readers: [{ display_name: 'Reader B' }],
          },
        ],
      },
    ],
  }
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
test('LibriVox resolves stable catalog identities through the official JSON API', async () => {
  const urls: URL[] = []
  const adapter = new LibriVoxAdapter(async (input, init) => {
    const url = new URL(String(input))
    urls.push(url)
    assert.equal(url.origin, 'https://librivox.org')
    assert.equal(url.pathname, '/api/feed/audiobooks/')
    assert.equal(url.searchParams.get('format'), 'json')
    assert.equal(url.searchParams.get('coverart'), '1')
    assert.equal(init!.redirect, 'manual')
    return json(catalog())
  })
  const book = await adapter.getBook('52'),
    page = await adapter.getEpisodes('52')
  assert.equal(urls.length, 1, 'details and directory share the same bounded snapshot')
  assert.equal(book.sourceId, 'librivox')
  assert.equal(book.title, 'Example & Letters')
  assert.equal(book.description, 'A public domain example.')
  assert.equal(book.coverUrl, 'https://www.archive.org/download/example_covers/letters_thumb.jpg')
  assert.deepEqual(book.authors, ['A. Writer'])
  assert.deepEqual(book.narrators, ['Reader A', 'Reader B'])
  assert.deepEqual(
    page.items.map((episode) => [episode.id, episode.order]),
    [
      ['121136', 1],
      ['121137', 2],
    ],
  )
  assert.equal(page.nextCursor, null)
  const audio = await adapter.resolveAudio('52', '121137')
  assert.equal(audio.url, 'https://archive.org/download/example_librivox/letter_02.mp3')
  assert.equal(audio.sourceId, 'librivox')
  assert.equal(urls.length, 2, 'playback rechecks the current official catalog')
  await assert.rejects(adapter.resolveAudio('52', '999'), { code: 'SOURCE_MEDIA_UNAVAILABLE' })
})
test('LibriVox exact no-result 404 is empty search, while missing details and other failures stay visible', async () => {
  const adapter = new LibriVoxAdapter(async () =>
    json({ error: 'Audiobooks could not be found' }, 404),
  )
  assert.deepEqual(await adapter.search('不存在'), { items: [], nextCursor: null })
  assert.deepEqual(await adapter.search('A longer title with more than twenty characters'), {
    items: [],
    nextCursor: null,
  })
  await assert.rejects(adapter.search('a'.repeat(201)), { code: 'INVALID_SOURCE_REQUEST' })
  await assert.rejects(adapter.getBook('52'), { code: 'SOURCE_UNAVAILABLE' })
  for (const response of [
    json({ error: 'other' }, 404),
    json({ books: [] }, 503),
    new Response('<html>verification</html>'),
    new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }),
  ]) {
    const failing = new LibriVoxAdapter(async () => response)
    await assert.rejects(
      failing.search('Example'),
      (error: unknown) => error instanceof Error && 'code' in error,
    )
  }
})
test('LibriVox keeps query-bound cursors and rejects malformed or incomplete catalogs', async () => {
  const many = catalog()
  many.books = Array.from({ length: 20 }, (_, index) => ({
    ...many.books[0]!,
    id: String(index + 1),
  }))
  const adapter = new LibriVoxAdapter(async () => json(many))
  const first = await adapter.search('Example')
  assert.ok(first.nextCursor)
  await assert.rejects(adapter.search('Other', first.nextCursor), {
    code: 'INVALID_SOURCE_REQUEST',
  })
  await assert.rejects(adapter.search('Example', 'forged'), { code: 'INVALID_SOURCE_REQUEST' })
  await assert.rejects(adapter.getBook('http://127.0.0.1/'), { code: 'INVALID_SOURCE_REQUEST' })
  for (const change of [
    (c: ReturnType<typeof catalog>) => {
      c.books[0]!.num_sections = '3'
    },
    (c: ReturnType<typeof catalog>) => {
      c.books[0]!.sections[1]!.id = c.books[0]!.sections[0]!.id
    },
    (c: ReturnType<typeof catalog>) => {
      c.books[0]!.sections[1]!.section_number = '3'
    },
    (c: ReturnType<typeof catalog>) => {
      c.books[0]!.id = '53'
    },
    (c: ReturnType<typeof catalog>) => {
      c.books[0]!.sections[0]!.listen_url = 'https://example.org/letter.mp3'
    },
  ]) {
    const value = catalog()
    change(value)
    await assert.rejects(new LibriVoxAdapter(async () => json(value)).getEpisodes('52'))
  }
})
test('Archive MP3 redirects remain within the same file on verified storage nodes', () => {
  const credentials = syntheticCredentials()
  const initial = 'https://www.archive.org/download/example_librivox/letter_01.mp3'
  for (const url of [
    initial,
    'https://archive.org/download/example_librivox/letter_01.mp3',
    'https://dn721501.ca.archive.org/0/items/example_librivox/letter_01.mp3',
    'https://ia800201.us.archive.org/12/items/example_librivox/letter_01.mp3',
  ])
    assert.equal(librivoxMediaUrl(url, initial), url)
  for (const url of [
    'http://archive.org/download/example_librivox/letter_01.mp3',
    'https://archive.org.attacker.invalid/download/example_librivox/letter_01.mp3',
    'https://127.0.0.1/download/example_librivox/letter_01.mp3',
    `https://${credentials.username}:${credentials.password}@archive.org/download/example_librivox/letter_01.mp3`,
    'https://archive.org:444/download/example_librivox/letter_01.mp3',
    'https://archive.org/download/example_librivox/letter_01.mp3#fragment',
    'https://blog.archive.org/0/items/example_librivox/letter_01.mp3',
    'https://archive.org/download/example_librivox/letter_02.mp3',
    'https://dn721501.ca.archive.org/0/items/another_book/letter_01.mp3',
    'https://archive.org/download/example_librivox/letter_01.html',
  ])
    assert.throws(() => librivoxMediaUrl(url, initial), { code: 'SOURCE_MEDIA_UNAVAILABLE' })
  assert.throws(() => librivoxPageUrl('https://example.org/'), { code: 'INVALID_SOURCE_REQUEST' })
})
test('LibriVox cancels an in-flight metadata request without publishing a late result', async () => {
  const controller = new AbortController()
  const adapter = new LibriVoxAdapter(async (_url, init) => {
    controller.abort()
    init!.signal!.throwIfAborted()
    return json(catalog())
  })
  await assert.rejects(adapter.getBook('52', controller.signal), { code: 'SOURCE_CANCELED' })
})
