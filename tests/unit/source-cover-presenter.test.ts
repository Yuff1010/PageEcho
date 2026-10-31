import assert from 'node:assert/strict'
import test from 'node:test'
import type { PluginService } from '../../src/main/plugins/service'
import type { TextSourceService } from '../../src/main/sources/text-service'
import { SourceCoverPresenter } from '../../src/main/sources/source-cover-presenter'
import { SourceCoverService } from '../../src/main/sources/source-covers'
import { isSourceCoverUrl } from '../../src/shared/source-covers'
import type { TextBookSummary } from '../../src/shared/text-sources'

const summary = (sourceId: string, coverUrl: string | null): TextBookSummary => ({
  sourceId,
  workId: 'fixture',
  title: '合成封面书',
  author: null,
  description: null,
  pageUrl: 'https://books.example/book',
  coverUrl,
})
function presenter(
  sources: Array<{
    id: string
    baseUrl: string
    allowedOrigins?: string[]
    coverOrigins?: string[]
  }>,
) {
  const covers = new SourceCoverService()
  const plugins = { list: () => ({ sources }) } as unknown as PluginService
  const text = { state: () => ({ sources }) } as unknown as TextSourceService
  return { covers, value: new SourceCoverPresenter(covers, plugins, text) }
}

test('only approved source results become local cover tokens without rewriting stable book identity', () => {
  const sourceId = 'plugin:fixture:text'
  const { value, covers } = presenter([
    {
      id: sourceId,
      baseUrl: 'https://books.example/',
      allowedOrigins: ['https://books.example'],
      coverOrigins: ['https://covers.example'],
    },
  ])
  try {
    const book = summary(sourceId, 'https://covers.example/fixture.png')
    const visible = value.ebook(book)
    assert.ok(isSourceCoverUrl(visible.coverUrl))
    assert.equal(
      book.coverUrl,
      'https://covers.example/fixture.png',
      'source metadata is not mutated before storage',
    )
    assert.deepEqual({ ...visible, coverUrl: book.coverUrl }, book)
    assert.equal(value.ebook(summary(sourceId, 'https://foreign.example/no.png')).coverUrl, null)
    assert.equal(
      value.ebook(summary(sourceId, 'https://books.example/no.png')).coverUrl,
      null,
      'page permissions do not replace explicit cover permissions',
    )
    assert.equal(
      value.ebook(summary('plugin:uninstalled:text', 'https://covers.example/no.png')).coverUrl,
      null,
    )
  } finally {
    covers.close()
  }
})

test('private-library images use public configured origin and broken source metadata never prevents readable search results', () => {
  const { value, covers } = presenter([{ id: 'my-opds', baseUrl: 'https://books.example/opds' }])
  try {
    assert.ok(
      isSourceCoverUrl(value.ebook(summary('my-opds', 'https://books.example/cover.png')).coverUrl),
    )
    assert.equal(
      value.ebook(summary('my-opds', 'https://unapproved.example/cover.png')).coverUrl,
      null,
    )
    const broken = new SourceCoverPresenter(
      covers,
      {
        list: () => {
          throw new Error('fixture registry unavailable')
        },
      } as unknown as PluginService,
      {} as TextSourceService,
    )
    const readable = summary('plugin:fixture:text', 'https://books.example/cover.png')
    assert.deepEqual(broken.ebook(readable), { ...readable, coverUrl: null })
    assert.equal(broken.ebook(summary('plugin:fixture:text', null)).coverUrl, null)
  } finally {
    covers.close()
  }
})
