import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LibraryStore } from '../../src/main/database'
import { parseOriginal } from '../../src/main/original/parse'
import { validateRequest } from '../../src/shared/validation'
import { zip, epub } from '../fixtures/original-epub'

function novel() {
  return parseOriginal(
    Buffer.from(
      `第1章 山路\n${Array.from({ length: 135 }, (_, i) => `少年沿着山路前进，第${i}次听见钟声。`).join('\n')}\n第2章 清晨\n第二天清晨，他们来到远方的村庄。`,
    ),
    '小说.txt',
  )
}
function audioBook(store: LibraryStore) {
  store.importBook({
    id: 'book',
    title: '音频书',
    sourcePath: 'D:/fixture',
    kind: 'folder',
    episodes: [
      {
        id: 'episode',
        path: 'D:/fixture/a.mp3',
        name: 'a.mp3',
        sizeBytes: 10,
        modifiedAt: 1,
        contentHash: 'a'.repeat(64),
      },
    ],
  })
  return { episodeId: 'episode', audioHash: 'a'.repeat(64) }
}

test('standalone TXT reading needs no audio, persists exact location and reimport does not reset progress', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ralb-reading-')), 'library.sqlite3')
  let store = new LibraryStore(file)
  const parsed = novel(),
    book = store.reading.import(parsed)
  assert.equal(store.listBooks().length, 0)
  assert.equal(store.reading.list().length, 1)
  assert.equal(store.reading.page(book.id, 60).sentences.length, 60)
  assert.equal(
    store.reading.page(book.id, 120).sentences.at(-1)?.text,
    '第二天清晨，他们来到远方的村庄。',
  )
  for (const position of [-1, 0.5, NaN, parsed.sentences.length]) {
    assert.throws(() => store.reading.savePosition(book.id, position), /超出/)
    assert.throws(() => store.reading.page(book.id, position), /超出/)
  }
  store.reading.savePosition(book.id, 93)
  const before = store.reading.get(book.id)
  assert.ok(before.lastReadAt)
  assert.equal(store.reading.import(parsed).position, 93)
  assert.equal(store.reading.list().length, 1)
  store.close()
  store = new LibraryStore(file)
  assert.deepEqual(store.reading.get(book.id), before)
  assert.equal(store.reading.page(book.id, 60).sentences[33]?.ordinal, 93)
  store.close()
})

test('removing a standalone book revokes cached access and preserves companion text and audio', () => {
  const store = new LibraryStore(':memory:'),
    target = audioBook(store),
    parsed = novel()
  const companion = store.originals.import(target, parsed)
  assert.throws(() => store.reading.document(companion.info!.id), /已移除/)
  const book = store.reading.import(parsed)
  assert.equal(companion.info!.id, book.id)
  store.reading.document(book.id)
  store.reading.remove(book.id)
  assert.throws(() => store.reading.document(book.id), /已移除/)
  assert.throws(() => store.reading.savePosition(book.id, 0), /已移除/)
  assert.equal(
    store.originals.page(target, book.id, 0).sentences[0]?.text,
    parsed.sentences[0]?.text,
  )
  assert.equal(store.listBooks().length, 1)
  store.reading.import(parsed)
  store.removeBook('book')
  assert.equal(store.reading.document(book.id).sentences.length, parsed.sentences.length)
  store.close()
})

test('EPUB follows spine order and changed file content is imported as a separate book', () => {
  const store = new LibraryStore(':memory:')
  const book = store.reading.import(parseOriginal(zip(epub), '小说.epub'))
  assert.equal(book.format, 'epub')
  assert.equal(store.reading.page(book.id, 0).sentences[0]?.text, '这是阅读顺序中的第一段正文。')
  const changed = store.reading.import(
    parseOriginal(Buffer.from('第一章 新版\n这是新版本的正文。'), '小说.epub.txt'),
  )
  assert.notEqual(changed.id, book.id)
  store.reading.remove(changed.id)
  assert.equal(store.reading.list().length, 1)
  store.reading.remove(book.id)
  assert.equal(store.reading.list().length, 0)
  assert.throws(() => store.reading.page(book.id, 0), /已移除/)
  store.close()
})

test('schema 9 upgrades in place while retaining audio and the companion original', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ralb-reading-v9-')), 'library.sqlite3')
  let store = new LibraryStore(file)
  const target = audioBook(store),
    before = store.originals.import(target, novel())
  store.close()
  const old = new DatabaseSync(file)
  old.exec(
    'DROP TABLE online_pending_progress; DROP TABLE subtitle_import_commands; DROP TABLE subtitle_import_sources; DROP TABLE transcript_edit_commands; DROP TABLE transcript_edit_members; DROP TABLE transcript_edit_heads; DROP TABLE transcript_edit_groups; DROP TABLE offline_media_refs; DROP TABLE offline_plan_items; DROP TABLE offline_job_owners; DROP TABLE offline_plans; DROP TABLE processing_resources; ALTER TABLE transcription_jobs DROP COLUMN cpu_threads; DROP TABLE book_subtitle_settings; DROP TABLE reading_books; PRAGMA user_version=9;',
  )
  old.close()
  store = new LibraryStore(file)
  assert.deepEqual(store.originals.state(target), before)
  assert.equal(store.listBooks().length, 1)
  assert.deepEqual(store.reading.list(), [])
  assert.equal(store.reading.import(novel()).id, before.info!.id)
  store.close()
  const db = new DatabaseSync(file)
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 18)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  db.close()
})

test('standalone reading IPC only accepts bounded positions and native import, never renderer paths', () => {
  const id = '3cbe1132-cc94-4658-9594-9defea45fc8c'
  validateRequest('reading:list', [])
  validateRequest('reading:import', [])
  validateRequest('reading:page', [{ id, start: 60 }])
  validateRequest('reading:progress', [{ id, position: 93 }])
  validateRequest('reading:find', [{ id, query: '山路', offset: 0 }])
  validateRequest('reading:remove', [{ id }])
  for (const [channel, args] of [
    ['reading:import', [{ path: 'D:/arbitrary.txt' }]],
    ['reading:list', [null]],
    ['reading:page', [{ id, start: 250000 }]],
    ['reading:progress', [{ id, position: -1 }]],
    ['reading:progress', [{ id, position: 1.5 }]],
    ['reading:find', [{ id, query: '一', offset: 0 }]],
    ['reading:find', [{ id, query: '山路', offset: -1 }]],
    ['reading:remove', [{ id, path: 'D:/arbitrary.txt' }]],
  ] as [string, unknown[]][])
    assert.throws(() => validateRequest(channel, args), /无效/)
})
