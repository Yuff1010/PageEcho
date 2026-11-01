import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { crc32, deflateSync } from 'node:zlib'
import { PersistentBookCovers } from '../../src/main/sources/persistent-book-covers'
import {
  BOOK_COVER_PREFIX,
  SOURCE_COVER_PREFIX,
  isBookCoverUrl,
} from '../../src/shared/source-covers'

function png(tone = 60) {
  const chunk = (kind: string, value: Buffer) => {
    const name = Buffer.from(kind),
      header = Buffer.alloc(4),
      crc = Buffer.alloc(4)
    header.writeUInt32BE(value.length)
    crc.writeUInt32BE(crc32(Buffer.concat([name, value])))
    return Buffer.concat([header, name, value, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(16, 0)
  header.writeUInt32BE(24, 4)
  header[8] = 8
  header[9] = 2
  const rows = Buffer.alloc(24 * 49)
  for (let row = 0; row < 24; row++)
    for (let col = 0; col < 16; col++) rows.set([tone, 120, 170], row * 49 + 1 + col * 3)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const candidate = () => SOURCE_COVER_PREFIX + randomUUID()
const directory = () => mkdtemp(join(tmpdir(), 'ralb-persistent-covers-'))

test('book artwork is content-addressed, deduplicated and available offline after restart', async () => {
  const path = await directory(),
    bytes = png()
  let requests = 0
  const sourceCovers = {
    serve: async () => {
      requests++
      return new Response(bytes)
    },
  }
  const store = new PersistentBookCovers({ directory: path, sourceCovers })
  const url = candidate()
  assert.equal(await store.remember('audio', 'book-one', url), true)
  assert.equal(await store.remember('ebook', 'book-two', url), true)
  const audio = store.decorate('audio', { id: 'book-one', title: '书名' })
  assert.ok(isBookCoverUrl(audio.coverUrl))
  assert.equal(store.decorate('ebook', { id: 'book-two' }).coverUrl, audio.coverUrl)
  assert.equal(store.decorate('ebook', { id: 'book-one' }).coverUrl, undefined)
  assert.equal(audio.title, '书名')
  assert.equal(store.stats().books, 2)
  assert.equal(store.stats().bytes, bytes.length)
  assert.equal((await readdir(path)).filter((name) => name.endsWith('.img')).length, 1)
  const response = await store.serve(new Request(audio.coverUrl))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  assert.equal((await store.serve(new Request(audio.coverUrl, { method: 'HEAD' }))).status, 200)
  await store.close()
  const restarted = new PersistentBookCovers({
    directory: path,
    sourceCovers: {
      serve: async () => {
        throw new Error('Network is offline')
      },
    },
  })
  assert.equal(restarted.decorate('audio', { id: 'book-one' }).coverUrl, audio.coverUrl)
  assert.equal((await restarted.serve(new Request(audio.coverUrl))).status, 200)
  assert.equal(requests, 2, 'serving and restart never fetch a website')
  await restarted.close()
})

test('persistent artwork quota evicts old generated images without touching unrelated files', async () => {
  const path = await directory()
  let tone = 50
  const store = new PersistentBookCovers({
    directory: path,
    maxBooks: 1,
    sourceCovers: { serve: async () => new Response(png(tone)) },
  })
  await writeFile(join(path, 'notes.txt'), 'unrelated retained file')
  assert.equal(await store.remember('audio', 'older', candidate()), true)
  const oldUrl = store.decorate('audio', { id: 'older' }).coverUrl!
  tone = 100
  assert.equal(await store.remember('audio', 'newer', candidate()), true)
  assert.equal(store.decorate('audio', { id: 'older' }).coverUrl, undefined)
  assert.equal((await store.serve(new Request(oldUrl))).status, 404)
  assert.equal(store.stats().books, 1)
  assert.equal((await readdir(path)).filter((name) => name.endsWith('.img')).length, 1)
  assert.equal(await readFile(join(path, 'notes.txt'), 'utf8'), 'unrelated retained file')
  await store.close()
  const bounded = new PersistentBookCovers({
    directory: await directory(),
    maxBytes: png().length - 1,
    sourceCovers: { serve: async () => new Response(png()) },
  })
  assert.equal(await bounded.remember('audio', 'too-large', candidate()), false)
  assert.equal(bounded.stats().bytes, 0)
  await bounded.close()
})

test('bad candidate URLs, corrupted bytes and foreign requests degrade to default artwork', async () => {
  const path = await directory()
  let requests = 0
  const store = new PersistentBookCovers({
    directory: path,
    sourceCovers: {
      serve: async () => {
        requests++
        return new Response(png())
      },
    },
  })
  assert.equal(await store.remember('audio', '../escape', candidate()), false)
  assert.equal(await store.remember('audio', 'book', 'https://foreign.example/book.png'), false)
  assert.equal(requests, 0)
  assert.equal(await store.remember('audio', 'book', candidate()), true)
  const url = store.decorate('audio', { id: 'book' }).coverUrl!
  assert.equal(
    (await store.serve(new Request(url, { headers: { Origin: 'https://foreign.example' } })))
      .status,
    404,
  )
  assert.equal((await store.serve(new Request(url, { method: 'POST' }))).status, 405)
  assert.equal((await store.serve(new Request(BOOK_COVER_PREFIX + '0'.repeat(64)))).status, 404)
  const filename = join(path, url.slice(BOOK_COVER_PREFIX.length) + '.img')
  const corrupt = Buffer.from(png())
  corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1
  await writeFile(filename, corrupt)
  assert.equal((await store.serve(new Request(url))).status, 404)
  assert.equal(await store.remember('audio', 'book', candidate()), true)
  assert.equal(
    (await store.serve(new Request(url))).status,
    200,
    'a fresh validated image repairs a corrupt cache file',
  )
  await store.close()
  const invalid = new PersistentBookCovers({
    directory: await directory(),
    sourceCovers: { serve: async () => new Response('<html>not an image</html>') },
  })
  assert.equal(await invalid.remember('ebook', 'bad', candidate()), false)
  assert.equal(invalid.decorate('ebook', { id: 'bad' }).coverUrl, undefined)
  await invalid.close()
})

test('backup snapshots serialize artwork mutations and retain a stable index', async () => {
  const path = await directory()
  const store = new PersistentBookCovers({
    directory: path,
    sourceCovers: { serve: async () => new Response(png()) },
  })
  await store.remember('audio', 'first', candidate())
  let release!: () => void, started!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const snapshot = store.withSnapshot(async () => {
    started()
    await held
    const index = JSON.parse(await readFile(join(path, 'index.json'), 'utf8'))
    assert.deepEqual(
      index.bindings.map((row: { id: string }) => row.id),
      ['first'],
    )
  })
  await ready
  const late = store.remember('ebook', 'second', candidate())
  assert.equal(store.decorate('ebook', { id: 'second' }).coverUrl, undefined)
  release()
  await snapshot
  assert.equal(await late, true)
  assert.ok(isBookCoverUrl(store.decorate('ebook', { id: 'second' }).coverUrl))
  await store.close()
})
