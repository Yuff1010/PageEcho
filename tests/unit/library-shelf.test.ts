import assert from 'node:assert/strict'
import test from 'node:test'
import { readingShelfPosition, visibleShelfBooks } from '../../src/renderer/src/library-shelf'

test('both shelf formats share search, natural title sorting, recent activity and added order without mutating data', () => {
  const rows = [
    { title: '故事10', importedAt: '2026-10-02', activity: null },
    { title: '故事2', importedAt: '2026-10-03', activity: '2026-10-04' },
    { title: 'Forest', importedAt: '2026-10-01', activity: '2026-10-05' },
  ]
  for (const key of ['lastReadAt', 'lastPlayedAt'] as const) {
    const books = rows.map((row) => ({
      ...row,
      lastReadAt: key === 'lastReadAt' ? row.activity : null,
      lastPlayedAt: key === 'lastPlayedAt' ? row.activity : null,
    }))
    const activity = (book: (typeof books)[number]) => book[key] ?? null
    assert.deepEqual(
      visibleShelfBooks(books, '  FOREST ', 'title', false, activity).map((book) => book.title),
      ['Forest'],
    )
    assert.deepEqual(
      visibleShelfBooks(books, '故事', 'title', false, activity).map((book) => book.title),
      ['故事2', '故事10'],
    )
    assert.deepEqual(
      visibleShelfBooks(books, '', 'added', false, activity).map((book) => book.title),
      ['故事2', '故事10', 'Forest'],
    )
    assert.deepEqual(
      visibleShelfBooks(books, '', 'recent', true, activity).map((book) => book.title),
      ['Forest', '故事2'],
    )
    assert.deepEqual(
      books.map((book) => book.title),
      rows.map((book) => book.title),
    )
  }
})

test('ebook cards display saved reading progress safely for first and last sentences and empty metadata', () => {
  assert.equal(
    readingShelfPosition({ position: 0, sentenceCount: 100, lastReadAt: null }),
    '尚未开始阅读',
  )
  assert.equal(
    readingShelfPosition({ position: 0, sentenceCount: 100, lastReadAt: '2026-10-01' }),
    '已读至 1%',
  )
  assert.equal(
    readingShelfPosition({ position: 99, sentenceCount: 100, lastReadAt: '2026-10-01' }),
    '已读至 100%',
  )
  assert.equal(
    readingShelfPosition({ position: 999, sentenceCount: 100, lastReadAt: '2026-10-01' }),
    '已读至 100%',
  )
  assert.equal(
    readingShelfPosition({ position: 0, sentenceCount: 0, lastReadAt: '2026-10-01' }),
    '已读至 0%',
  )
})
