import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { LibraryStore } from '../../src/main/database'
import type { Book, Episode } from '../../src/shared/contracts'
import { DEFAULT_SOURCE_PREPARATION } from '../../src/shared/sources'
import { validateRequest } from '../../src/shared/validation'

const uuid = (kind: number, number: number) =>
  `${kind}0000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const bookId = (number: number) => uuid(0, number)
const episodeId = (number: number) => uuid(1, number)
const earlier = '2026-01-01T00:00:00.000Z'
const later = '2026-02-01T00:00:00.000Z'
const lastPlayed = '2026-03-01T00:00:00.000Z'
const session = uuid(2, 1)
const manual = { mode: 'manual', engine: 'whisperx', device: 'cpu', prepareNext: false }
const ahead = { mode: 'ahead', engine: 'paraformer', device: 'cuda', prepareNext: true }
const legacy = { cacheNext: false, transcribeNext: true, engine: 'paraformer', device: 'cuda' }

/** Independent copy of the pre-batching SELECT/projection. Do not use new queries as the oracle. */
function originalEpisodes(db: DatabaseSync, field: 'id' | 'bookId', value: string): Episode[] {
  const rows = db
    .prepare(
      `SELECT * FROM (
      SELECT e.id, e.book_id AS bookId, e.title, e.sort_order AS 'order',
        e.size_bytes AS sizeBytes, e.modified_at AS modifiedAt, e.content_hash AS contentHash,
        e.duration_ms AS durationMs, e.position_ms AS positionMs,
        NULL AS sourceBookId, NULL AS sourceEpisodeId, 1 AS cacheAvailable, NULL AS sourceId
      FROM episodes e WHERE NOT EXISTS (SELECT 1 FROM online_episodes o WHERE o.id=e.id)
      UNION ALL
      SELECT o.id, o.book_id, o.title, o.sort_order, coalesce(e.size_bytes,0),
        coalesce(e.modified_at,0), coalesce(e.content_hash,''),
        CASE WHEN e.id IS NULL THEN p.duration_ms ELSE e.duration_ms END,
        coalesce(e.position_ms,p.position_ms,0), b.source_book_id, o.source_episode_id, o.cache_available, b.source_id
      FROM online_episodes o JOIN online_books b ON b.book_id=o.book_id
        LEFT JOIN episodes e ON e.id=o.id
        LEFT JOIN online_pending_progress p ON p.episode_id=o.id
    ) WHERE ${field}=? ORDER BY "order"`,
    )
    .all(value)
  return rows.map(
    ({ sourceBookId, sourceEpisodeId, cacheAvailable, sourceId, ...row }) =>
      ({
        ...row,
        ...(sourceEpisodeId
          ? {
              online: {
                sourceId,
                bookId: String(sourceBookId),
                episodeId: String(sourceEpisodeId),
                cached: Boolean(cacheAvailable),
              },
            }
          : {}),
      }) as unknown as Episode,
  )
}

function originalBooks(db: DatabaseSync): Book[] {
  const rows = db
    .prepare(
      `SELECT b.id, b.title, b.imported_at AS importedAt,
      b.last_played_at AS lastPlayedAt, b.current_episode_id AS currentEpisodeId,
      coalesce(s.intro_ms,0) AS introMs, coalesce(s.outro_ms,0) AS outroMs
      FROM books b LEFT JOIN book_listening_settings s ON s.book_id=b.id
      ORDER BY b.last_played_at DESC, b.imported_at DESC, b.rowid DESC`,
    )
    .all()
  return rows.map((row) => {
    const online = db.prepare('SELECT * FROM online_books WHERE book_id=?').get(row.id!)
    const subtitle = db
      .prepare('SELECT settings_json FROM book_subtitle_settings WHERE book_id=?')
      .get(row.id!)
    const subtitlePreparation = subtitle ? JSON.parse(String(subtitle.settings_json)) : undefined
    return {
      ...row,
      episodes: originalEpisodes(db, 'bookId', String(row.id)),
      ...(subtitlePreparation ? { subtitlePreparation } : {}),
      ...(online
        ? {
            online: {
              sourceId: online.source_id,
              bookId: online.source_book_id,
              catalogComplete: Boolean(online.catalog_complete),
              preparation: online.preparation_json
                ? JSON.parse(String(online.preparation_json))
                : { ...DEFAULT_SOURCE_PREPARATION },
            },
          }
        : {}),
    } as unknown as Book
  })
}

type FocusedLibrary = LibraryStore & {
  listBookIds(): string[]
  getBookMetadata(id: string): Omit<Book, 'episodes'> | undefined
  getBook(id: string): Book | undefined
  getBookEpisodeAtOrder(bookId: string, order: number): Episode | undefined
  countBookEpisodes(bookId: string): number
  hasBookEpisodeAfter(bookId: string, order: number): boolean
}
interface QueryCall {
  sql: string
  bindings: SQLInputValue[]
}
function captureQueries(store: LibraryStore, afterRead?: (call: QueryCall) => void) {
  const db = Reflect.get(store, 'db') as DatabaseSync
  const original = db.prepare
  const calls: QueryCall[] = []
  db.prepare = function (sql: string) {
    const statement = original.call(this, sql)
    return new Proxy(statement, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          const call = { sql, bindings: args as SQLInputValue[] }
          if (['all', 'get', 'run', 'iterate'].includes(String(property))) calls.push(call)
          const result = Reflect.apply(value, target, args)
          if (property === 'all' || property === 'get') afterRead?.(call)
          return result
        }
      },
    })
  }
  return {
    calls,
    restore: () => {
      db.prepare = original
    },
  }
}

async function fixture(t: TestContext) {
  const parent = await realpath(tmpdir())
  const root = await mkdtemp(join(parent, 'pageecho-library-query-'))
  const filename = join(root, 'synthetic.sqlite')
  const store = new LibraryStore(filename) as FocusedLibrary
  const db = Reflect.get(store, 'db') as DatabaseSync
  const reference = new DatabaseSync(filename, { readOnly: true })
  t.after(async () => {
    reference.close()
    store.close()
    const local = relative(parent, resolve(root))
    assert(local && !isAbsolute(local) && local !== '..' && !local.startsWith('..' + sep))
    await rm(root, { recursive: true, force: true })
  })
  db.exec('BEGIN IMMEDIATE')
  const insertBook = db.prepare(
    `INSERT INTO books(id,title,source_locator,kind,imported_at,last_played_at,current_episode_id)
     VALUES (?,?,?,'folder',?,?,?)`,
  )
  for (let number = 1; number <= 5; number++)
    insertBook.run(
      bookId(number),
      `合成书籍${number}`,
      `D:/synthetic/query/book-${number}`,
      number === 4 ? later : earlier,
      number <= 3 ? lastPlayed : null,
      number === 1 ? episodeId(1) : number === 3 ? episodeId(11) : null,
    )
  const insertAudio = db.prepare(
    `INSERT INTO episodes(id,book_id,title,sort_order,locator,size_bytes,modified_at,content_hash,duration_ms,position_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  )
  for (const [number, order] of [0, 2, 5].entries())
    insertAudio.run(
      episodeId(number + 1),
      bookId(1),
      `本地第${order}集`,
      order,
      `D:/synthetic/query/local-${number}.wav`,
      1024,
      42,
      'a'.repeat(64),
      10000,
      number * 100,
    )
  // Legal same-order rows must retain the old locator-index tie order, not add id ordering.
  insertAudio.run(
    episodeId(5),
    bookId(1),
    '本地同序号第二集',
    2,
    'D:/synthetic/query/local-0-tie.wav',
    1024,
    42,
    'a'.repeat(64),
    10000,
    500,
  )
  insertAudio.run(
    episodeId(4),
    bookId(2),
    '另一本书第0集',
    0,
    'D:/synthetic/query/another.wav',
    1024,
    42,
    'b'.repeat(64),
    null,
    0,
  )
  const insertOnline = db.prepare(
    'INSERT INTO online_books(book_id,source_id,source_book_id,metadata_json,catalog_complete,preparation_json) VALUES (?,?,?,?,?,?)',
  )
  insertOnline.run(bookId(3), 'ting13', 'legacy-online', '{}', 0, null)
  insertOnline.run(
    bookId(4),
    'plugin:synthetic:query',
    'custom-online',
    '{}',
    1,
    JSON.stringify(legacy),
  )
  const insertCatalog = db.prepare(
    'INSERT INTO online_episodes(id,book_id,source_episode_id,title,sort_order,cache_available) VALUES (?,?,?,?,?,?)',
  )
  for (let order = 1; order <= 4; order++)
    insertCatalog.run(
      episodeId(10 + order),
      bookId(3),
      `remote-${order}`,
      `在线目录第${order}集`,
      order,
      order === 2 ? 1 : 0,
    )
  insertCatalog.run(episodeId(21), bookId(4), 'plugin-1', '插件第1集', 1, 0)
  // Cached metadata title/order intentionally differ: canonical catalog identity must win.
  insertAudio.run(
    episodeId(12),
    bookId(3),
    '旧缓存标题',
    99,
    'D:/synthetic/query/cache-verified.wav',
    2048,
    43,
    'c'.repeat(64),
    null,
    0,
  )
  insertAudio.run(
    episodeId(13),
    bookId(3),
    '另一个旧缓存标题',
    98,
    'D:/synthetic/query/cache-unavailable.wav',
    4096,
    44,
    'd'.repeat(64),
    5000,
    333,
  )
  // A saved online book can also own an ordinary local row. Equal ordinals keep
  // the old UNION's local-before-online precedence even though its id sorts later.
  insertAudio.run(
    episodeId(22),
    bookId(3),
    '混合书未注册本地章节',
    2,
    'D:/synthetic/query/hybrid-local.wav',
    8192,
    45,
    '9'.repeat(64),
    null,
    888,
  )
  const insertPending = db.prepare(
    `INSERT INTO online_pending_progress(episode_id,session_id,revision,position_ms,duration_ms,rate,volume,prefix_bytes,prefix_sha256,total_bytes,saved_at)
     VALUES (?,?,1,?,?,1.25,0.37,12,?,1000,42)`,
  )
  insertPending.run(episodeId(11), session, 1500, null, 'e'.repeat(64))
  insertPending.run(episodeId(12), session, 9000, 10000, 'f'.repeat(64))
  db.prepare('INSERT INTO book_listening_settings(book_id,intro_ms,outro_ms) VALUES (?,?,?)').run(
    bookId(1),
    250,
    400,
  )
  const subtitle = db.prepare(
    'INSERT INTO book_subtitle_settings(book_id,settings_json) VALUES (?,?)',
  )
  subtitle.run(bookId(1), JSON.stringify(manual))
  subtitle.run(bookId(4), JSON.stringify(ahead))
  db.exec('COMMIT')
  return { root, store, db, reference }
}

test('batch library reads preserve the complete old mixed-library DTO and sort order', async (t) => {
  const f = await fixture(t)
  const expected = originalBooks(f.reference)
  assert.deepEqual(
    expected.map((book) => book.id),
    [3, 2, 1, 4, 5].map(bookId),
  )
  assert.deepEqual(f.store.listBooks(), expected)
  assert.deepEqual(
    f.store.listBookIds(),
    expected.map((book) => book.id),
  )
  const local = f.store.listBooks().find((book) => book.id === bookId(1))!
  assert.deepEqual(
    local.episodes.map((episode) => episode.order),
    [0, 2, 2, 5],
  )
  assert.deepEqual(
    local.episodes.filter((episode) => episode.order === 2).map((episode) => episode.id),
    [episodeId(5), episodeId(2)],
  )
  assert.deepEqual(local.subtitlePreparation, manual)
  assert.deepEqual([local.introMs, local.outroMs], [250, 400])
  const online = f.store.listBooks().find((book) => book.id === bookId(3))!
  assert.deepEqual(online.online?.preparation, DEFAULT_SOURCE_PREPARATION)
  assert.equal(online.online?.catalogComplete, false)
  assert.deepEqual(
    online.episodes.map((episode) => episode.order),
    [1, 2, 2, 3, 4],
  )
  assert.deepEqual(
    online.episodes.filter((episode) => episode.order === 2).map((episode) => episode.id),
    [episodeId(22), episodeId(12)],
  )
  assert.equal(
    online.episodes.find((episode) => episode.id === episodeId(12))!.title,
    '在线目录第2集',
  )
  assert.equal(online.episodes.find((episode) => episode.id === episodeId(22))!.online, undefined)
  const custom = f.store.listBooks().find((book) => book.id === bookId(4))!
  assert.equal(custom.online?.sourceId, 'plugin:synthetic:query')
  assert.deepEqual(custom.online?.preparation, legacy)
  assert.deepEqual(custom.subtitlePreparation, ahead)
  assert.equal(custom.online?.catalogComplete, true)
})

test('whole-library SQL read count stays bounded as empty books are added', async (t) => {
  const f = await fixture(t),
    captured = captureQueries(f.store)
  try {
    assert.equal(f.store.listBooks().length, 5)
    const first = captured.calls.length
    assert.equal(first, 5, 'Two snapshot reads plus metadata/local/online must stay bounded')
    captured.calls.length = 0
    const insert = f.db.prepare(
      "INSERT INTO books(id,title,source_locator,kind,imported_at) VALUES (?,?,?,'folder',?)",
    )
    for (let number = 6; number <= 106; number++)
      insert.run(bookId(number), `合成空书${number}`, `D:/synthetic/query/empty-${number}`, earlier)
    captured.calls.length = 0
    assert.equal(f.store.listBooks().length, 106)
    assert.equal(captured.calls.length, first)
    f.db.exec('DELETE FROM books')
    captured.calls.length = 0
    assert.deepEqual(f.store.listBooks(), [])
    assert.equal(
      captured.calls.length,
      3,
      'An empty library needs only snapshot reads and metadata',
    )
  } finally {
    captured.restore()
  }
})

test('batch metadata and episodes use one WAL snapshot across another writer committing changes', async (t) => {
  const f = await fixture(t),
    expected = originalBooks(f.reference)
  const writer = new DatabaseSync(join(f.root, 'synthetic.sqlite'))
  let wrote = false
  const captured = captureQueries(f.store, (call) => {
    if (wrote || !/FROM\s+books\s+b\b/i.test(call.sql)) return
    wrote = true
    writer.exec('BEGIN IMMEDIATE')
    writer.prepare('UPDATE books SET title=? WHERE id=?').run('外部提交后的标题', bookId(1))
    writer.prepare('DELETE FROM episodes WHERE id=?').run(episodeId(3))
    writer
      .prepare(
        `INSERT INTO episodes(id,book_id,title,sort_order,locator,size_bytes,modified_at,content_hash,duration_ms,position_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        episodeId(6),
        bookId(1),
        '外部新增章节',
        9,
        'D:/synthetic/query/replacement.wav',
        1024,
        45,
        'f'.repeat(64),
        12000,
        0,
      )
    writer.exec('COMMIT')
  })
  try {
    assert.deepEqual(f.store.listBooks(), expected)
    assert.equal(wrote, true, 'The second writer must commit between metadata and episode reads')
    assert.equal(f.db.isTransaction, false)
    captured.restore()
    const after = originalBooks(f.reference)
    assert.notDeepEqual(after, expected)
    assert.deepEqual(f.store.listBooks(), after)
  } finally {
    captured.restore()
    writer.close()
  }
})

test('invalid settings roll back the composite read and a repaired row is readable again', async (t) => {
  const f = await fixture(t)
  f.db
    .prepare('UPDATE book_subtitle_settings SET settings_json=? WHERE book_id=?')
    .run('{"mode":', bookId(1))
  assert.throws(() => f.store.listBooks(), SyntaxError)
  assert.equal(f.db.isTransaction, false)
  f.db
    .prepare('UPDATE book_subtitle_settings SET settings_json=? WHERE book_id=?')
    .run(JSON.stringify(manual), bookId(1))
  assert.deepEqual(f.store.listBooks(), originalBooks(f.reference))
  f.db
    .prepare('UPDATE online_books SET preparation_json=? WHERE book_id=?')
    .run('{"cacheNext":', bookId(4))
  assert.throws(() => f.store.getBook(bookId(4)), SyntaxError)
  assert.equal(f.db.isTransaction, false)
  f.db
    .prepare('UPDATE online_books SET preparation_json=? WHERE book_id=?')
    .run(JSON.stringify(legacy), bookId(4))
  assert.deepEqual(
    f.store.getBook(bookId(4)),
    originalBooks(f.reference).find((book) => book.id === bookId(4)),
  )
})

test('focused book queries keep full single-book episodes, metadata and missing identities distinct', async (t) => {
  const f = await fixture(t)
  for (const expected of originalBooks(f.reference)) {
    assert.deepEqual(f.store.getBook(expected.id), expected)
    const { episodes, ...metadata } = expected
    assert.deepEqual(f.store.getBookMetadata(expected.id), metadata)
    assert(!Object.hasOwn(f.store.getBookMetadata(expected.id)!, 'episodes'))
    assert.equal(f.store.countBookEpisodes(expected.id), episodes.length)
  }
  assert.equal(f.store.getBook(bookId(999)), undefined)
  assert.equal(f.store.getBookMetadata(bookId(999)), undefined)
  assert.equal(f.store.countBookEpisodes(bookId(999)), 0)
  assert.deepEqual(f.store.getBook(bookId(5))!.episodes, [])
})

test('focused episode queries preserve pending empty identity and registered zero/null precedence', async (t) => {
  const f = await fixture(t)
  for (const book of originalBooks(f.reference)) {
    for (const episode of book.episodes) {
      assert.deepEqual(f.store.getEpisode(episode.id), episode)
    }
    for (const order of new Set(book.episodes.map((episode) => episode.order)))
      assert.deepEqual(
        f.store.getBookEpisodeAtOrder(book.id, order),
        book.episodes.find((episode) => episode.order === order),
      )
  }
  const pending = f.store.getEpisode(episodeId(11))!
  assert.deepEqual(
    [pending.positionMs, pending.durationMs, pending.contentHash, pending.sizeBytes],
    [1500, null, '', 0],
  )
  assert.equal(f.store.getAudio(pending.id), undefined)
  const verified = f.store.getEpisode(episodeId(12))!
  assert.deepEqual(
    [verified.positionMs, verified.durationMs, verified.contentHash, verified.order],
    [0, null, 'c'.repeat(64), 2],
  )
  const unavailable = f.store.getEpisode(episodeId(13))!
  assert.equal(unavailable.online?.cached, false)
  assert.equal(unavailable.contentHash, 'd'.repeat(64))
  assert.equal(f.store.getBookEpisodeAtOrder(bookId(1), 1), undefined)
  assert.equal(f.store.getBookEpisodeAtOrder(bookId(3), 0), undefined)
  assert.equal(f.store.getBookEpisodeAtOrder(bookId(999), 0), undefined)
  assert.equal(f.store.getEpisode(episodeId(999)), undefined)
})

test('exact-order and greater-order queries preserve local gaps and ties without assuming a common order base', async (t) => {
  const f = await fixture(t)
  assert.equal(f.store.getBookEpisodeAtOrder(bookId(1), 1), undefined)
  assert.equal(f.store.getBookEpisodeAtOrder(bookId(1), 2)?.id, episodeId(5))
  assert.equal(f.store.getBookEpisodeAtOrder(bookId(3), 1)?.id, episodeId(11))
  assert.equal(f.store.getBookEpisodeAtOrder(bookId(3), 2)?.id, episodeId(22))
  assert.equal(f.store.hasBookEpisodeAfter(bookId(1), 0), true)
  assert.equal(f.store.hasBookEpisodeAfter(bookId(1), 1), true)
  assert.equal(f.store.hasBookEpisodeAfter(bookId(1), 5), false)
  assert.equal(f.store.hasBookEpisodeAfter(bookId(3), 3), true)
  assert.equal(f.store.hasBookEpisodeAfter(bookId(3), 4), false)
  assert.equal(f.store.hasBookEpisodeAfter(bookId(5), -1), false)
  assert.equal(f.store.hasBookEpisodeAfter(bookId(999), -1), false)
})

test('focused queries do not retain stale book or pending membership after removal', async (t) => {
  const f = await fixture(t)
  f.store.getBook(bookId(3))
  f.store.getEpisode(episodeId(11))
  f.store.removeBook(bookId(3))
  assert.equal(f.store.getBook(bookId(3)), undefined)
  assert.equal(f.store.getBookMetadata(bookId(3)), undefined)
  assert.equal(f.store.getEpisode(episodeId(11)), undefined)
  assert.equal(f.store.getPendingOnlineProgress(episodeId(11)), null)
  assert.equal(f.store.countBookEpisodes(bookId(3)), 0)
  assert.deepEqual(f.store.listBooks(), originalBooks(f.reference))
})

test('focused read query plans search episode identity and book indexes rather than scan unrelated books', async (t) => {
  const f = await fixture(t),
    captured = captureQueries(f.store)
  try {
    f.store.getEpisode(episodeId(11))
    f.store.getBookMetadata(bookId(3))
    f.store.getBookEpisodeAtOrder(bookId(3), 2)
    f.store.hasBookEpisodeAfter(bookId(3), 2)
    f.store.countBookEpisodes(bookId(3))
    f.store.getBook(bookId(3))
    assert(captured.calls.length > 0)
    // Composite getBook also establishes a snapshot; these checks concern the
    // actual data reads, not its sqlite_schema/PRAGMA snapshot control statements.
    const calls = captured.calls.filter((call) =>
      /\bFROM\s+(?:episodes|online_episodes|books)\b/i.test(call.sql),
    )
    assert(calls.length > 0)
    captured.restore()
    for (const call of calls) {
      const plan = f.reference.prepare('EXPLAIN QUERY PLAN ' + call.sql).all(...call.bindings)
      const details = plan.map((row) => String(row.detail))
      assert(
        details.some((detail) => /SEARCH\b.*(?:INDEX|PRIMARY KEY)/i.test(detail)),
        JSON.stringify(details),
      )
      assert(
        !details.some((detail) =>
          /SCAN\s+(?:episodes|online_episodes|books|e|o|b)\b/i.test(detail),
        ),
        JSON.stringify(details),
      )
    }
  } finally {
    captured.restore()
  }
})

test('composite reads keep a caller-owned transaction open until its caller rolls it back', async (t) => {
  const f = await fixture(t),
    expected = originalBooks(f.reference)
  f.db.exec('BEGIN')
  try {
    assert.deepEqual(
      f.store.getBook(bookId(3)),
      expected.find((book) => book.id === bookId(3)),
    )
    assert.equal(f.db.isTransaction, true)
    assert.deepEqual(f.store.listBooks(), expected)
    assert.equal(f.db.isTransaction, true)
    assert.equal(f.store.getBook(bookId(999)), undefined)
    assert.equal(f.db.isTransaction, true)
  } finally {
    assert.equal(f.db.isTransaction, true)
    f.db.exec('ROLLBACK')
  }
  assert.equal(f.db.isTransaction, false)
})

test('overview summaries project complete legacy metadata, counts and resume identities without episode arrays', async (t) => {
  const f = await fixture(t),
    expected = originalBooks(f.reference)
  f.store.listBooks = () => assert.fail('summaries must not materialize full books')
  f.store.getBook = () => assert.fail('summaries must not materialize a full book')
  assert.deepEqual(
    f.store.listBookSummaries(),
    expected.map((book) => {
      const { episodes, ...metadata } = book
      const resume = episodes.find((episode) => episode.id === book.currentEpisodeId)
      return {
        ...metadata,
        episodeCount: episodes.length,
        firstEpisodeId: episodes[0]?.id ?? null,
        resumeEpisode: resume
          ? {
              id: resume.id,
              title: resume.title,
              positionMs: resume.positionMs,
              durationMs: resume.durationMs,
            }
          : null,
      }
    }),
  )
  for (const book of f.store.listBookSummaries()) {
    assert.equal(Object.hasOwn(book, 'episodes'), false)
    assert.deepEqual(f.store.getBookSummary(book.id), book)
  }
  assert.equal(f.store.getBookSummary(bookId(999)), undefined)
})

test('bounded chapter pages preserve canonical gap and hybrid tie order without changing full book semantics', async (t) => {
  const f = await fixture(t),
    expected = originalBooks(f.reference)
  f.store.listBooks = () => assert.fail('chapter pages must not materialize the library')
  f.store.getBook = () => assert.fail('chapter pages must not materialize the full book')
  for (const book of expected) {
    for (const offset of [0, 1, 2, 100]) {
      const page = f.store.getBookEpisodes(book.id, offset, 2)
      assert.deepEqual(page.episodes, book.episodes.slice(offset, offset + 2))
      assert.equal(page.total, book.episodes.length)
      assert.equal(page.offset, offset)
      assert.equal(Object.hasOwn(page.book, 'episodes'), false)
    }
  }
  assert.throws(() => f.store.getBookEpisodes(bookId(999), 0, 100), { code: 'FILE_UNAVAILABLE' })
  for (const [offset, limit] of [
    [-1, 1],
    [0, 0],
    [0, 101],
    [0.5, 2],
    [0, Infinity],
  ])
    assert.throws(() => f.store.getBookEpisodes(bookId(1), offset!, limit!), {
      code: 'INVALID_REQUEST',
    })
})

test('playback contexts use true sorted neighbors including duplicate ordinals without full-book reads', async (t) => {
  const f = await fixture(t),
    expected = originalBooks(f.reference)
  f.store.listBooks = () => assert.fail('playback context must not expand the library')
  f.store.getBook = () => assert.fail('playback context must not materialize a whole book')
  for (const book of expected) {
    const { episodes, ...metadata } = book
    for (const [index, episode] of episodes.entries())
      assert.deepEqual(f.store.getPlaybackContext(episode.id), {
        book: metadata,
        episode,
        previousEpisodeId: episodes[index - 1]?.id ?? null,
        nextEpisodeId: episodes[index + 1]?.id ?? null,
        episodeIndex: index,
      })
  }
  assert.equal(f.store.getPlaybackContext(episodeId(999)), undefined)
})

test('summary, chapter and context IPC permits only bounded explicit identities', () => {
  validateRequest('library:overview', [])
  for (const channel of ['library:book-detail', 'reading:book']) {
    validateRequest(channel, [{ id: bookId(1) }])
    assert.throws(() => validateRequest(channel, [{ id: bookId(1), episodes: [] }]))
  }
  validateRequest('player:context', [{ episodeId: episodeId(1) }])
  validateRequest('library:book-episodes', [{ id: bookId(1), offset: 100000, limit: 100 }])
  for (const args of [
    [{}],
    [{ id: bookId(1), offset: -1, limit: 1 }],
    [{ id: bookId(1), offset: 0, limit: 101 }],
    [{ id: bookId(1), offset: 0, limit: 1, path: 'D:/injected' }],
  ])
    assert.throws(() => validateRequest('library:book-episodes', args))
  assert.throws(() => validateRequest('library:overview', [{}]))
  assert.throws(() => validateRequest('player:context', [{ episodeId: 'D:/injected' }]))
  validateRequest('source:add', [
    { id: session, sourceId: 'ting13', bookId: '38229', episodeId: '38229_1_123' },
  ])
  assert.throws(() =>
    validateRequest('source:book', [
      { id: session, sourceId: 'ting13', bookId: '38229', episodeId: '38229_1_123' },
    ]),
  )
  assert.throws(() =>
    validateRequest('source:add', [
      { id: session, sourceId: 'ting13', bookId: '38229', episodeId: 'bad\u0000' },
    ]),
  )
})

test('overview, page and playback context remain coherent across a concurrent WAL writer', async (t) => {
  for (const kind of ['overview', 'page', 'context'] as const) {
    const f = await fixture(t)
    const read = () =>
      kind === 'overview'
        ? f.store.listBookSummaries()
        : kind === 'page'
          ? f.store.getBookEpisodes(bookId(3), 0, 100)
          : f.store.getPlaybackContext(episodeId(12))
    const before = read(),
      writer = new DatabaseSync(join(f.root, 'synthetic.sqlite'))
    let wrote = false
    const capture = captureQueries(f.store, (call) => {
      if (wrote || !/FROM books b\b/.test(call.sql)) return
      wrote = true
      writer.exec('BEGIN IMMEDIATE')
      writer.prepare('UPDATE books SET title=? WHERE id=?').run('已并发改名', bookId(3))
      writer.prepare('DELETE FROM online_episodes WHERE id=?').run(episodeId(14))
      writer.exec('COMMIT')
    })
    try {
      assert.deepEqual(read(), before)
      assert.equal(wrote, true)
      assert.equal(f.db.isTransaction, false)
      capture.restore()
      assert.notDeepEqual(read(), before)
    } finally {
      capture.restore()
      writer.close()
    }
  }
})

test('chapter page hard limit materializes only the requested hundred entries and neighbors cross that boundary', async (t) => {
  const f = await fixture(t)
  f.db
    .prepare(
      `WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<205)
    INSERT INTO episodes(id,book_id,title,sort_order,locator,size_bytes,modified_at,content_hash)
    SELECT 'bounded-'||value,?, '有限测试'||value,value,'D:/synthetic/page/'||value,1,1,? FROM n`,
    )
    .run(bookId(5), '8'.repeat(64))
  f.store.getBook = () => assert.fail('a page or context cannot read a complete chapter array')
  f.store.listBooks = () => assert.fail('a page or context cannot read the whole library')
  const page = f.store.getBookEpisodes(bookId(5), 100, 100)
  assert.equal(page.total, 205)
  assert.equal(page.episodes.length, 100)
  assert.equal(page.episodes[0]!.id, 'bounded-101')
  assert.equal(page.episodes.at(-1)!.id, 'bounded-200')
  assert.equal(f.store.getPlaybackContext('bounded-100')!.nextEpisodeId, 'bounded-101')
  assert.equal(f.store.getPlaybackContext('bounded-101')!.previousEpisodeId, 'bounded-100')
  assert.equal(f.store.getPlaybackContext('bounded-101')!.episodeIndex, 100)
})

test('path targeting preserves exact remembered-path matching and includes cached source ownership', async (t) => {
  const f = await fixture(t),
    path = f.store.getAudio(episodeId(12))!.path
  f.db
    .prepare(
      `INSERT INTO episodes(id,book_id,title,sort_order,locator,size_bytes,modified_at,content_hash)
    VALUES (?,?,?,7,?,1,1,?)`,
    )
    .run(episodeId(31), bookId(1), '同路径其他书', path, '7'.repeat(64))
  assert.deepEqual(
    f.store.getBookIdsReferencingAudioPath(path).sort(),
    [bookId(1), bookId(3)].sort(),
  )
  assert.deepEqual(f.store.getBookIdsReferencingAudioPath(path.toUpperCase()), [])
  assert.deepEqual(f.store.getBookIdsReferencingAudioPath('D:/missing'), [])
})
