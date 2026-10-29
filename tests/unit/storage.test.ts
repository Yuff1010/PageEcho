import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { LibraryStore } from '../../src/main/database'
import { createDataPaths } from '../../src/main/paths'
import { inspectSelectedAudio } from '../../src/main/files'

test('creates separate directories and persists metadata across database reopen', () => {
  const root = mkdtempSync(join(tmpdir(), '听读 storage '))
  const paths = createDataPaths(root)
  assert.deepEqual(readdirSync(root).sort(), ['cache', 'chromium', 'data', 'logs', 'models'])
  let store = new LibraryStore(paths.database)
  const metadata = {
    path: join(root, '第一集.MP3'),
    name: '第一集.MP3',
    sizeBytes: 100,
    modifiedAt: 123,
  }
  store.rememberFile(metadata)
  const originalId = store.listFiles()[0]!.id
  store.close()
  store = new LibraryStore(paths.database)
  assert.equal(store.listFiles()[0]?.name, '第一集.MP3')
  assert.equal(store.listFiles()[0]?.sizeBytes, 100)
  assert.equal('path' in store.listFiles()[0]!, false)
  store.rememberFile({ ...metadata, sizeBytes: 200 })
  assert.equal(store.listFiles().length, 1)
  assert.equal(store.listFiles()[0]?.id, originalId)
  assert.equal(store.listFiles()[0]?.sizeBytes, 200)
  store.forgetFile(originalId)
  store.close()
  store = new LibraryStore(paths.database)
  assert.deepEqual(store.listFiles(), [])
  store.close()
  const db = new DatabaseSync(paths.database)
  assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 16)
  db.close()
})

test('rejects newer schemas without modifying user data', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ralb-future-')), 'future.sqlite3')
  const db = new DatabaseSync(file)
  db.exec(
    "CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('keep'); PRAGMA user_version = 99;",
  )
  db.close()
  assert.throws(() => new LibraryStore(file), /更新版本/)
  const reopened = new DatabaseSync(file)
  assert.equal(reopened.prepare('SELECT value FROM future_data').get()?.value, 'keep')
  assert.equal(reopened.prepare('PRAGMA user_version').get()?.user_version, 99)
  reopened.close()
})

test('failed metadata writes roll back and the recent list stays bounded', () => {
  const store = new LibraryStore(':memory:')
  for (let i = 0; i < 25; i++)
    store.rememberFile({
      path: `D:/books/${i}.mp3`,
      name: `${i}.mp3`,
      sizeBytes: 10,
      modifiedAt: 0,
    })
  assert.equal(store.listFiles().length, 20)
  assert.equal(
    store.listFiles().some((file) => file.name === '0.mp3'),
    false,
  )
  assert.throws(() =>
    store.rememberFile({ path: 'invalid', name: 'invalid', sizeBytes: 0, modifiedAt: 0 }),
  )
  assert.equal(store.listFiles().length, 20)
  store.rememberFile({ path: 'valid', name: 'valid', sizeBytes: 10, modifiedAt: 0 })
  assert.equal(store.listFiles()[0]?.name, 'valid')
  store.close()
})

test('inspects Chinese paths and rejects missing, empty, unsupported and directory selections', async () => {
  const root = mkdtempSync(join(tmpdir(), '听读 files '))
  const audio = join(root, '第一章 空格.MP3')
  writeFileSync(audio, Buffer.alloc(32))
  assert.equal((await inspectSelectedAudio(audio)).name, '第一章 空格.MP3')
  for (const file of ['empty.mp3', 'not-audio.txt'])
    writeFileSync(join(root, file), file === 'empty.mp3' ? '' : 'text')
  for (const candidate of [
    root,
    join(root, 'missing.mp3'),
    join(root, 'empty.mp3'),
    join(root, 'not-audio.txt'),
  ]) {
    await assert.rejects(inspectSelectedAudio(candidate), { code: 'FILE_UNAVAILABLE' })
  }
})
