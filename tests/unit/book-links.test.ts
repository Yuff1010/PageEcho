import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { parseOriginal } from '../../src/main/original/parse'
import { validateRequest } from '../../src/shared/validation'

async function fixture(t: { after: (callback: () => void) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'book-links-'))
  const folder = join(root, '同作品')
  await mkdir(folder)
  await writeFile(join(folder, '第1集.wav'), Buffer.alloc(100, 1))
  await writeFile(join(folder, '第2集.wav'), Buffer.alloc(100, 2))
  const store = new LibraryStore(join(root, 'library.sqlite'))
  t.after(() => store.close())
  store.importBook(await scanBook(folder, 'folder'))
  const book = store.listBooks()[0]!
  const parsed = parseOriginal(
    Buffer.from('第1章 山路\n清晨的风吹过树梢。\n少年推开了沉重的木门。\n远处传来了悠长的钟声。'),
    '同作品.txt',
  )
  const ebook = store.reading.import(parsed)
  const target = (index: number) => ({
    episodeId: book.episodes[index]!.id,
    audioHash: book.episodes[index]!.contentHash,
  })
  const align = (index: number, ordinal: number) => {
    const input = target(index)
    const text = parsed.sentences[ordinal]!.text
    const document = {
      version: 1 as const,
      kind: 'manual' as const,
      audioHash: input.audioHash,
      coverage: [{ startMs: 0, endMs: 10000 }],
      segments: [{ id: 's0', startMs: 1000, endMs: 3000, text }],
    }
    store.saveTranscript(input.episodeId, document)
    const transcript = store.getTranscript(input.episodeId, input.audioHash)
    assert.equal(transcript.status, 'ready')
    if (transcript.status !== 'ready') throw new Error('missing transcript')
    store.originals.saveAlignment(
      input,
      ebook.id,
      transcript.transcript.id,
      transcript.transcript.revision,
      0,
      [
        {
          segmentId: 's0',
          startMs: 1000,
          endMs: 3000,
          asrText: text,
          candidates: [],
          selected: { first: ordinal, last: ordinal, method: 'auto' },
          reviewed: false,
        },
      ],
    )
  }
  return { store, book, ebook, parsed, target, align, databasePath: join(root, 'library.sqlite') }
}

test('links share immutable documents, preserve progress and revisions, and survive unlink/relink', async (t) => {
  const { store, book, ebook, target, align } = await fixture(t)
  assert.deepEqual(store.bookLinks.list(), [])
  store.reading.savePosition(ebook.id, 2)
  store.bookLinks.link({ bookId: book.id, readingBookId: ebook.id })
  align(0, 1)
  const alignment = store.originals.state(target(0)).alignment
  assert.equal(store.bookLinks.list()[0]?.readingBookId, ebook.id)
  assert.equal(store.reading.get(ebook.id).position, 2)
  store.bookLinks.unlink(book.id)
  assert.equal(store.bookLinks.list().length, 0)
  assert.equal(store.reading.get(ebook.id).position, 2)
  store.bookLinks.link({ bookId: book.id, readingBookId: ebook.id })
  assert.deepEqual(store.originals.state(target(0)).alignment, alignment)
})

test('the same imported original and ebook are linked by content identity without title guessing', async (t) => {
  const { store, book, ebook, parsed, target } = await fixture(t)
  store.originals.import(target(0), parsed)
  assert.deepEqual(
    store.bookLinks.list().map((link) => [link.audioBookId, link.readingBookId]),
    [[book.id, ebook.id]],
  )
  const other = store.reading.import(
    parseOriginal(Buffer.from('第1章 山路\n这是另一个完全不同的正文版本。'), '同作品.txt'),
  )
  assert.notEqual(other.id, ebook.id)
  assert.equal(store.bookLinks.list()[0]?.readingBookId, ebook.id)
  store.reading.remove(ebook.id)
  assert.equal(store.bookLinks.list().length, 0)
  assert.equal(store.originals.state(target(0)).info?.id, ebook.id)
})

test('forward and reverse switches locate valid mapped ranges across episodes without guessing gaps', async (t) => {
  const { store, book, ebook, target, align } = await fixture(t)
  store.bookLinks.link({ bookId: book.id, readingBookId: ebook.id })
  align(0, 0)
  align(1, 2)
  assert.equal(store.bookLinks.openReading({ ...target(1), positionMs: 1500 }).position, 2)
  const reverse = store.bookLinks.resolveListening({ readingBookId: ebook.id, position: 0 })
  assert.equal(reverse.status, 'mapped')
  assert.equal(reverse.candidates[0]?.episodeId, target(0).episodeId)
  assert.equal(reverse.candidates[0]?.positionMs, 1000)
  const gap = store.bookLinks.openReading({ ...target(0), positionMs: 4000 })
  assert.equal(gap.status, 'unmapped')
  assert.equal(gap.book.position, 2)
  assert.equal(
    store.bookLinks.resolveListening({ readingBookId: ebook.id, position: 1 }).status,
    'unmapped',
  )
})

test('multiple matching performances require a choice and stale transcripts cannot drive position switches', async (t) => {
  const { store, book, ebook, target, align } = await fixture(t)
  store.bookLinks.link({ bookId: book.id, readingBookId: ebook.id })
  align(0, 1)
  align(1, 1)
  assert.equal(
    store.bookLinks.resolveListening({ readingBookId: ebook.id, position: 1 }).status,
    'ambiguous',
  )
  const input = target(0)
  store.saveTranscript(input.episodeId, {
    version: 1,
    kind: 'manual',
    audioHash: input.audioHash,
    coverage: [{ startMs: 0, endMs: 10000 }],
    segments: [{ id: 'replacement', text: '全新字幕内容。', startMs: 0, endMs: 2000 }],
  })
  assert.equal(store.bookLinks.openReading({ ...input, positionMs: 1500 }).status, 'unmapped')
  const remaining = store.bookLinks.resolveListening({ readingBookId: ebook.id, position: 1 })
  assert.equal(remaining.status, 'mapped')
  assert.equal(remaining.candidates[0]?.episodeId, target(1).episodeId)
  assert.throws(
    () => store.bookLinks.link({ bookId: randomUUID(), readingBookId: ebook.id }),
    /已移除/,
  )
  assert.throws(
    () => store.bookLinks.openReading({ ...input, audioHash: 'f'.repeat(64), positionMs: 1000 }),
    /版本已变化/,
  )
})

test('book link IPC accepts only bounded identities and locations', () => {
  const id = randomUUID(),
    other = randomUUID(),
    hash = 'a'.repeat(64)
  for (const [channel, request] of [
    ['book-links:link', { bookId: id, readingBookId: other }],
    ['book-links:unlink', { bookId: id }],
    ['book-links:reading', { episodeId: id, audioHash: hash, positionMs: 1200 }],
    ['book-links:listening', { readingBookId: other, position: 2, bookId: id }],
  ] as const) {
    assert.doesNotThrow(() => validateRequest(channel, [request]))
    assert.throws(() => validateRequest(channel, [{ ...request, path: 'C:\\secret' }]))
  }
  assert.doesNotThrow(() => validateRequest('book-links:list', []))
  assert.throws(() => validateRequest('book-links:list', [{}]))
  assert.throws(() =>
    validateRequest('book-links:listening', [{ readingBookId: other, position: -1 }]),
  )
})

test('legacy and retained manual timings are not used for automatic position switches', async (t) => {
  const { store, book, ebook, target, align, databasePath } = await fixture(t)
  store.bookLinks.link({ bookId: book.id, readingBookId: ebook.id })
  align(0, 1)
  const db = new DatabaseSync(databasePath)
  try {
    for (const kind of ['legacy', 'retained']) {
      db.prepare(
        `UPDATE original_alignments SET alignment_json=json_set(alignment_json,'$.matches[0].reviewed',json('true'),'$.matches[0].sourceState',?)`,
      ).run(kind)
      assert.equal(
        store.bookLinks.openReading({ ...target(0), positionMs: 1500 }).status,
        'unmapped',
      )
      assert.equal(
        store.bookLinks.resolveListening({ readingBookId: ebook.id, position: 1 }).status,
        'unmapped',
      )
    }
  } finally {
    db.close()
  }
})

test('adopted sentence timings preserve acoustic gaps instead of extending a neighbouring sentence', async (t) => {
  const { store, book, ebook, target, align, databasePath } = await fixture(t)
  store.bookLinks.link({ bookId: book.id, readingBookId: ebook.id })
  align(0, 1)
  const db = new DatabaseSync(databasePath)
  try {
    db.prepare(
      `UPDATE original_alignments SET alignment_json=json_set(alignment_json,'$.matches[0].selected.last',2,'$.matches[0].acoustic',json(?))`,
    ).run(
      JSON.stringify({
        sentenceTimes: [
          { ordinal: 1, startMs: 1000, endMs: 1500 },
          { ordinal: 2, startMs: 2000, endMs: 3000 },
        ],
      }),
    )
    assert.equal(store.bookLinks.openReading({ ...target(0), positionMs: 1200 }).position, 1)
    assert.equal(store.bookLinks.openReading({ ...target(0), positionMs: 1700 }).status, 'unmapped')
    assert.equal(store.reading.get(ebook.id).position, 1)
    assert.equal(
      store.bookLinks.resolveListening({ readingBookId: ebook.id, position: 2 }).candidates[0]
        ?.positionMs,
      2000,
    )
  } finally {
    db.close()
  }
})
