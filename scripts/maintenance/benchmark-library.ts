// Explicit synthetic Main benchmark. No application user data, media or models are opened.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { cpus, freemem, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { LIBRARY_SCHEMA_VERSION } from '../../src/main/database-schema'
import { LibraryStore } from '../../src/main/database'

const script = fileURLToPath(import.meta.url),
  workspace = resolve(dirname(script), '../..')
const base = join(workspace, 'cache/library-benchmarks')
const DATE = '2026-11-02T00:00:00.000Z',
  HASH = 'a'.repeat(64)
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/
const help =
  'Usage: npm exec -- tsx scripts/maintenance/benchmark-library.ts --run --books <1..5000> --episodes-per-book <1..100000> --runs <1..3>\nTotal episodes must not exceed 1000000. No arguments only show this help. Each run creates a fresh cache/library-benchmarks/<UUID>; nothing is deleted.\n'
interface Fixture {
  schema: 1
  token: string
  books: number
  episodesPerBook: number
  runs: number
  sourceCommit: string
}
type Report = Record<string, unknown>
const writeJson = (path: string, value: unknown) =>
  writeFile(path, JSON.stringify(value, null, 2) + '\n')
const memory = () => ({
  ...process.memoryUsage(),
  maxRSSBytes: process.resourceUsage().maxRSS * 1024,
})
const id = (kind: 0 | 1 | 2, number: number) =>
  `${kind}0000000-0000-4000-8000-${String(number).padStart(12, '0')}`
async function digest(path: string) {
  const sum = createHash('sha256')
  for await (const chunk of createReadStream(path)) sum.update(chunk)
  return sum.digest('hex')
}
function sizes(books: number, episodes: number, runs: number) {
  assert(Number.isSafeInteger(books) && books >= 1 && books <= 5000, 'Invalid book count')
  assert(
    Number.isSafeInteger(episodes) && episodes >= 1 && episodes <= 100000,
    'Invalid episodes per book',
  )
  assert(books * episodes <= 1000000, 'Synthetic fixture exceeds one million episodes')
  assert(Number.isSafeInteger(runs) && runs >= 1 && runs <= 3, 'Invalid repetition count')
}
function parse(args: string[]) {
  assert(
    args.length === 7 &&
      args[0] === '--run' &&
      args[1] === '--books' &&
      args[3] === '--episodes-per-book' &&
      args[5] === '--runs',
    help,
  )
  const values = [args[2]!, args[4]!, args[6]!]
  assert(
    values.every((value) => /^[1-9]\d{0,6}(?![\s\S])/.test(value)),
    'Counts must be explicit positive decimal integers',
  )
  const [books, episodesPerBook, runs] = values.map(Number) as [number, number, number]
  sizes(books, episodesPerBook, runs)
  return { books, episodesPerBook, runs }
}
async function ordinaryDirectory(path: string) {
  const info = await lstat(path)
  assert(
    info.isDirectory() && !info.isSymbolicLink() && (await realpath(path)) === resolve(path),
    'Benchmark directory must not traverse aliases or links',
  )
}
async function fixtureAt(
  uuid: string,
): Promise<{ fixture: Fixture; directory: string; database: string }> {
  assert(ID.test(uuid), 'Invalid benchmark receipt')
  const directory = join(base, uuid)
  await ordinaryDirectory(base)
  await ordinaryDirectory(directory)
  const metadata = join(directory, 'fixture.json'),
    info = await lstat(metadata)
  assert(info.isFile() && !info.isSymbolicLink() && info.size < 4096)
  const fixture = JSON.parse(await readFile(metadata, 'utf8')) as Fixture
  assert(
    fixture.schema === 1 &&
      fixture.token === process.env.PAGEECHO_LIBRARY_BENCHMARK_CHILD &&
      ID.test(fixture.token),
    "Only this invocation's synthetic child may open its receipt",
  )
  sizes(fixture.books, fixture.episodesPerBook, fixture.runs)
  return { fixture, directory, database: join(directory, 'synthetic.sqlite') }
}
async function sqlCounter() {
  const original = DatabaseSync.prototype.prepare
  const counts = { prepares: 0, executions: 0, statements: {} as Record<string, number> }
  DatabaseSync.prototype.prepare = function (sql: string): StatementSync {
    counts.prepares++
    const statement = original.call(this, sql),
      key = sql.replace(/\s+/g, ' ').trim()
    return new Proxy(statement, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target)
        if (
          ['all', 'get', 'run', 'iterate'].includes(String(property)) &&
          typeof value === 'function'
        )
          return (...bindings: SQLInputValue[]) => {
            counts.executions++
            counts.statements[key] = (counts.statements[key] ?? 0) + 1
            return value.apply(target, bindings)
          }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
  return {
    counts,
    reset() {
      counts.prepares = 0
      counts.executions = 0
      counts.statements = {}
    },
    restore() {
      DatabaseSync.prototype.prepare = original
    },
  }
}
async function seed(uuid: string) {
  const { fixture: f, directory, database } = await fixtureAt(uuid)
  const report: Report = {
    status: 'incomplete',
    stage: 'create-schema',
    startedAt: new Date().toISOString(),
    memoryBefore: memory(),
  }
  const path = join(directory, 'seed.json'),
    started = performance.now()
  let db: DatabaseSync | undefined
  await writeJson(path, report)
  try {
    await assert.rejects(lstat(database), { code: 'ENOENT' })
    const schemaStart = performance.now(),
      store = new LibraryStore(database)
    store.close()
    report.schemaCreationMs = performance.now() - schemaStart
    db = new DatabaseSync(database)
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, LIBRARY_SCHEMA_VERSION)
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;')
    const book = db.prepare(
      "INSERT INTO books(id,title,source_locator,kind,imported_at,last_played_at,current_episode_id) VALUES (?,?,?,'folder',?,?,?)",
    )
    const episode = db.prepare(
      'INSERT INTO episodes(id,book_id,title,sort_order,locator,size_bytes,modified_at,content_hash,duration_ms,position_ms) VALUES (?,?,?,?,?,?,?,?,?,?)',
    )
    const history = db.prepare(
      'INSERT INTO selected_files(id,locator,name,size_bytes,modified_at,selected_at) VALUES (?,?,?,?,?,?)',
    )
    const seedStart = performance.now()
    report.stage = 'seed-transaction'
    await writeJson(path, report)
    db.exec('BEGIN IMMEDIATE')
    // Equal recency/import dates and reverse insertion deliberately put the current book last.
    for (let number = f.books; number >= 1; number--)
      book.run(
        id(0, number),
        `合成书籍${String(number).padStart(6, '0')}`,
        `synthetic://local-book-${number}`,
        DATE,
        DATE,
        id(1, number * f.episodesPerBook),
      )
    for (let number = 1; number <= f.books; number++)
      for (let ordinal = 0; ordinal < f.episodesPerBook; ordinal++) {
        const serial = (number - 1) * f.episodesPerBook + ordinal + 1
        const title = `第${String(ordinal + 1).padStart(6, '0')}集合成章节`
        const locator = `C:\\PageEchoSyntheticMissing\\book-${String(number).padStart(6, '0')}\\episode-${String(ordinal + 1).padStart(6, '0')}.wav`
        episode.run(
          id(1, serial),
          id(0, number),
          title,
          ordinal,
          locator,
          8388608,
          1793577600000,
          HASH,
          480000,
          ordinal === f.episodesPerBook - 1 ? 12345 : 0,
        )
        if (number === f.books && ordinal >= f.episodesPerBook - 20)
          history.run(id(2, serial), locator, title + '.wav', 8388608, 1793577600000, DATE)
      }
    db.prepare(
      'UPDATE player_settings SET current_episode_id=?,rate=1.25,volume=0.37 WHERE singleton=1',
    ).run(id(1, f.books * f.episodesPerBook))
    db.exec('COMMIT')
    report.transactionSeedMs = performance.now() - seedStart
    assert.equal(db.prepare('SELECT count(*) AS n FROM books').get()?.n, f.books)
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM episodes').get()?.n,
      f.books * f.episodesPerBook,
    )
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(db.prepare('PRAGMA quick_check').get()?.quick_check, 'ok')
    const checkpoint = performance.now()
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    report.checkpointMs = performance.now() - checkpoint
    db.close()
    db = undefined
    report.databaseBytes = (await stat(database)).size
    report.databaseSha256 = await digest(database)
    report.totalSetupMs = performance.now() - started
    report.status = 'complete'
    report.stage = 'complete'
  } catch (error) {
    report.error = error instanceof Error ? error.stack : String(error)
    process.exitCode = 1
  } finally {
    if (db) {
      if (db.isTransaction) db.exec('ROLLBACK')
      db.close()
    }
    report.memoryAfter = memory()
    report.finishedAt = new Date().toISOString()
    await writeJson(path, report)
  }
}
async function measure(uuid: string, attempt: number) {
  const { fixture: f, directory, database } = await fixtureAt(uuid)
  assert(Number.isInteger(attempt) && attempt >= 1 && attempt <= f.runs)
  const seed = JSON.parse(await readFile(join(directory, 'seed.json'), 'utf8')) as Report
  const info = await lstat(database)
  assert(
    info.isFile() &&
      !info.isSymbolicLink() &&
      seed.status === 'complete' &&
      seed.databaseSha256 === (await digest(database)),
  )
  const path = join(directory, `measure-${attempt}.json`)
  const report: Report = {
    status: 'incomplete',
    stage: 'open-store',
    attempt,
    startedAt: new Date().toISOString(),
    processCold: true,
    osDiskCacheCold: false,
    sqlInstrumentationIncluded: true,
  }
  let store: LibraryStore | undefined, counter: Awaited<ReturnType<typeof sqlCounter>> | undefined
  await writeJson(path, report)
  try {
    const opening = performance.now()
    store = new LibraryStore(database)
    report.storeOpeningMs = performance.now() - opening
    global.gc?.()
    report.memoryBeforeRead = memory()
    counter = await sqlCounter()
    report.stage = 'listBooks'
    await writeJson(path, report)
    const start = performance.now(),
      books = store.listBooks()
    report.firstListBooksMs = performance.now() - start
    report.memoryAfterListBooks = memory()
    report.listBooksSql = structuredClone(counter.counts)
    counter.reset()
    assert.equal(books.length, f.books)
    assert.equal(
      books.reduce((sum, value) => sum + value.episodes.length, 0),
      f.books * f.episodesPerBook,
    )
    assert.equal(books.at(-1)?.id, id(0, f.books))
    assert.equal(books.at(-1)?.episodes.at(-1)?.positionMs, 12345)
    report.selectedBookAtLastPosition = true
    report.listBooksComplete = true
    const envelopeStart = performance.now()
    const state = {
      version: f.sourceCommit,
      dataLocation: directory,
      files: store.listFiles(),
      books,
      ...store.getPlayerState(),
    }
    report.stateEnvelopeOnlyMs = performance.now() - envelopeStart
    report.envelopeSql = structuredClone(counter.counts)
    assert.equal(state.currentEpisodeId, id(1, f.books * f.episodesPerBook))
    assert.deepEqual(state.preferences, { rate: 1.25, volume: 0.37 })
    assert.equal(state.files.length, Math.min(20, f.episodesPerBook))
    report.stage = 'serialize-state'
    await writeJson(path, report)
    const encodingStart = performance.now()
    let encoded: string | null = JSON.stringify(state)
    report.jsonStringifyMs = performance.now() - encodingStart
    report.jsonUtf16CodeUnits = encoded.length
    const bytesStart = performance.now()
    report.jsonUtf8Bytes = Buffer.byteLength(encoded, 'utf8')
    report.countUtf8BytesMs = performance.now() - bytesStart
    report.memoryWithJsonAndObjects = memory()
    // Separate bounded-chunk hash avoids a second full UTF-8 allocation at the memory checkpoint.
    const sum = createHash('sha256'),
      hashStart = performance.now()
    for (let offset = 0; offset < encoded.length;) {
      let end = Math.min(encoded.length, offset + 65536)
      if (
        end < encoded.length &&
        encoded.charCodeAt(end - 1) >= 0xd800 &&
        encoded.charCodeAt(end - 1) <= 0xdbff
      )
        end--
      sum.update(encoded.slice(offset, end), 'utf8')
      offset = end
    }
    report.jsonSha256 = sum.digest('hex')
    report.jsonDigestMs = performance.now() - hashStart
    encoded = null
    global.gc?.()
    report.memoryAfterJsonReleasedGc = memory()
    report.status = 'complete'
    report.stage = 'complete'
  } catch (error) {
    report.error = error instanceof Error ? error.stack : String(error)
    process.exitCode = 1
  } finally {
    counter?.restore()
    store?.close()
    report.memoryAtExit = memory()
    report.finishedAt = new Date().toISOString()
    await writeJson(path, report)
  }
}
async function child(uuid: string, mode: 'seed' | 'measure', attempt: number, token: string) {
  const directory = join(base, uuid),
    output = join(directory, mode === 'seed' ? 'seed.json' : `measure-${attempt}.json`)
  const processChild = spawn(
    process.execPath,
    [
      '--expose-gc',
      '--max-old-space-size=2048',
      '--import',
      'tsx',
      script,
      '--child',
      uuid,
      mode,
      String(attempt),
    ],
    {
      cwd: workspace,
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: '', PAGEECHO_LIBRARY_BENCHMARK_CHILD: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = '',
    stderr = '',
    timedOut = false
  const timeoutMs = mode === 'seed' ? 120000 : 60000,
    started = performance.now()
  const timer = setTimeout(() => {
    timedOut = true
    processChild.kill()
  }, timeoutMs)
  processChild.stdout.on('data', (chunk) => {
    stdout += String(chunk)
  })
  processChild.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const exit = await new Promise<{ code?: number | null; signal?: string | null; error?: string }>(
    (done) => {
      processChild.once('error', (error) => done({ error: error.message }))
      processChild.once('close', (code, signal) => done({ code, signal }))
    },
  )
  clearTimeout(timer)
  await writeFile(output + '.stdout.log', stdout)
  await writeFile(output + '.stderr.log', stderr)
  let result: Report
  try {
    result = JSON.parse(await readFile(output, 'utf8')) as Report
  } catch {
    result = { status: 'incomplete', stage: mode }
  }
  result.execution = {
    ...exit,
    timedOut,
    timeoutMs,
    childWallMs: performance.now() - started,
    heapOutOfMemory: /heap out of memory|allocation failed.*heap/i.test(stderr),
  }
  if (timedOut || exit.code !== 0 || exit.signal || exit.error) result.status = 'incomplete'
  await writeJson(output, result)
  return result
}
async function main(args: string[]) {
  if (!args.length || (args.length === 1 && args[0] === '--help')) {
    process.stdout.write(help)
    return
  }
  const dimensions = parse(args)
  // Reject linked/aliased cache parents before allocating the new receipt; no deletes are used.
  await ordinaryDirectory(workspace)
  await mkdir(join(workspace, 'cache'), { recursive: true })
  await ordinaryDirectory(join(workspace, 'cache'))
  await mkdir(base, { recursive: true })
  await ordinaryDirectory(base)
  const uuid = randomUUID(),
    directory = join(base, uuid),
    token = randomUUID()
  await mkdir(directory)
  await ordinaryDirectory(directory)
  const source = join(workspace, 'src/main/database.ts'),
    sourceHash = await digest(source)
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: workspace,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8 * 1024 ** 2,
      timeout: 10000,
    }).trim()
  const sourceCommit = git(['rev-parse', 'HEAD'])
  const fixture: Fixture = { schema: 1, token, ...dimensions, sourceCommit }
  await writeFile(join(directory, 'fixture.json'), JSON.stringify(fixture, null, 2) + '\n', {
    flag: 'wx',
  })
  await copyFile(script, join(directory, 'runner-started.ts'))
  const gitStatus = git(['status', '--porcelain=v1', '--untracked-files=all'])
  const report: Report = {
    status: 'running',
    startedAt: new Date().toISOString(),
    directory,
    ...dimensions,
    totalEpisodes: dimensions.books * dimensions.episodesPerBook,
    sourceCommit,
    databaseSourceSha256: sourceHash,
    benchmarkSourceSha256: await digest(script),
    gitDirty: gitStatus.length > 0,
    gitStatus,
    node: process.version,
    platform: process.platform,
    cpu: cpus()[0]?.model,
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesBefore: freemem(),
    heapLimitMiBPerChild: 2048,
    syntheticOnly: true,
    externalLocalLoad:
      'Not automatically controlled. Do not compare timings under concurrent model/build/test load.',
    scope:
      'Synchronous Main LibraryStore + AppState-shaped JSON only; no actual Electron IPC, renderer, first paint, audio decoding or model measurement.',
    protocol:
      'Fixed synthetic strings/dates/order/position/rate/volume match the 0.42 local baseline. Fresh process for each first listBooks call; OS caches not flushed; SQL wrapper overhead included. Setup separately timed. Counts below 20 intentionally have fewer history rows. Receipt paths and version can change JSON length/hash between runs, so historical exact-byte equality is not claimed by this entry.',
    memoryScope:
      'memoryAfterListBooks is the read checkpoint. memoryWithJsonAndObjects/maxRSS includes extra JSON/UTF-8 sizing. Neither serialization peaks nor timings represent actual IPC. JSON digest separately timed after those checkpoints.',
    measurements: [] as Report[],
  }
  const reportPath = join(directory, 'report.json')
  await writeJson(reportPath, report)
  try {
    report.seed = await child(uuid, 'seed', 0, token)
    if ((report.seed as Report).status === 'complete') {
      for (let attempt = 1; attempt <= dimensions.runs; attempt++) {
        const measurement = await child(uuid, 'measure', attempt, token)
        ;(report.measurements as Report[]).push(measurement)
        await writeJson(reportPath, report)
        if (measurement.status !== 'complete') break
      }
      report.databaseUnchanged =
        (await digest(join(directory, 'synthetic.sqlite'))) ===
        (report.seed as Report).databaseSha256
    }
    const completed = (report.measurements as Report[]).filter(
      (value) => value.status === 'complete',
    )
    report.repeatedDtoIdentical =
      completed.length === dimensions.runs &&
      new Set(completed.map((value) => `${value.jsonUtf8Bytes}:${value.jsonSha256}`)).size === 1
    report.databaseSourceUnchanged = sourceHash === (await digest(source))
    report.status =
      (report.seed as Report).status === 'complete' &&
      report.databaseUnchanged &&
      report.databaseSourceUnchanged &&
      report.repeatedDtoIdentical &&
      (report.measurements as Report[]).length === dimensions.runs &&
      (report.measurements as Report[]).every((value) => value.status === 'complete')
        ? 'complete'
        : 'incomplete'
    if (report.status !== 'complete') process.exitCode = 1
  } catch (error) {
    report.status = 'incomplete'
    report.error = error instanceof Error ? error.stack : String(error)
    process.exitCode = 1
  } finally {
    report.finishedAt = new Date().toISOString()
    report.freeMemoryBytesAfter = freemem()
    await writeJson(reportPath, report)
    process.stdout.write(JSON.stringify({ status: report.status, report: reportPath }) + '\n')
  }
}
const args = process.argv.slice(2)
if (args[0] === '--child') {
  assert(
    args.length === 4 && ID.test(args[1]!) && ['seed', 'measure'].includes(args[2]!),
    'Invalid private benchmark child',
  )
  if (args[2] === 'seed') {
    assert(args[3] === '0')
    await seed(args[1]!)
  } else await measure(args[1]!, Number(args[3]))
} else await main(args)
