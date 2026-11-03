// Opt-in stock-preview acceptance against one real, anonymously accessed source.
// No source-policy edits, transport replacements, throttling, or ASR components.
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AppState, PlaybackSource, Result } from '../../src/shared/contracts'
import { closeOwnedElectron } from './electron-lifecycle'

const args = process.argv.slice(2)
const options = new Map<string, string>()
for (let index = 0; index < args.length; index += 2) {
  const name = args[index]!,
    value = args[index + 1]
  if (!['--app-root', '--book-id', '--output'].includes(name) || !value || options.has(name))
    throw Error(
      'Usage: tsx tests/model/progressive-source.ts --app-root <preview app> [--book-id 38229] --output <new cache directory>',
    )
  options.set(name, value)
}
assert(
  options.has('--app-root') && options.has('--output'),
  'An app root and fresh output directory are required',
)
const appRoot = await realpath(resolve(options.get('--app-root')!))
const bookId = options.get('--book-id') ?? '38229'
assert(
  /^[1-9]\d{0,8}$/.test(bookId) && bookId !== '39941',
  'Choose a valid current source sample, not the obsolete 39941 sample',
)
const directory = resolve(options.get('--output')!),
  cache = await realpath(resolve('cache'))
const local = relative(cache, directory)
assert(
  local &&
    !isAbsolute(local) &&
    local !== '..' &&
    !local.startsWith('..\\') &&
    !local.startsWith('../'),
  'Output must be a fresh directory inside cache/',
)
await mkdir(directory, { recursive: false })
const userData = join(directory, 'user-data')
const hash = async (filename: string) => {
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(filename)) digest.update(bytes)
  return digest.digest('hex')
}
const manifestPath = resolve(appRoot, '../manifest.json')
const build = JSON.parse(await readFile(manifestPath, 'utf8')) as {
  appRoot: string
  previewVersion: string
  outputHashes: Record<string, string>
}
assert.equal(await realpath(build.appRoot), appRoot)
for (const [name, digest] of Object.entries(build.outputHashes))
  assert.equal(
    await hash(join(appRoot, 'out', name)),
    digest,
    'Preview output differs from its build manifest',
  )
const env: Record<string, string> = { RALB_USER_DATA: userData }
for (const [name, value] of Object.entries(process.env))
  if (
    value !== undefined &&
    ![
      'ralb_user_data',
      'ralb_executable',
      'electron_run_as_node',
      'electron_renderer_url',
      'node_options',
      'debug',
      'pwdebug',
    ].includes(name.toLowerCase())
  )
    env[name] = value
const report: Record<string, unknown> = {
  status: 'running',
  startedAt: new Date().toISOString(),
  appRoot,
  userData,
  productVersion: build.previewVersion,
  sourceId: 'ting13',
  sourceBookId: bookId,
  buildManifestSha256: await hash(manifestPath),
  runnerSha256: await hash(resolve('tests/model/progressive-source.ts')),
  earlyPlaybackProven: false,
  scope:
    'One real anonymous public source in an unmodified stock preview, a fresh isolated data directory, real shelf playback, natural network speed, no ASR components. The observer wraps only the existing open-episode IPC handler to retain its legitimate session ID and returns its original result. An early-play claim requires a Main pending snapshot with receivedBytes < totalBytes after native currentTime > 100ms. A fast complete download can pass playback without proving acceleration. No raw provider URL, query signature, Cookie, or authorization header is recorded.',
  stages: [],
}
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
let currentStage = 'starting'
async function stage(name: string) {
  currentStage = name
  ;(report.stages as unknown[]).push({ name, at: new Date().toISOString() })
  await save()
  console.log(JSON.stringify({ stage: name }))
}
async function within<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function state(page: Page): Promise<AppState> {
  const result = await within(
    page.evaluate(() => window.desktop.getState()),
    5000,
    'State observation timed out',
  )
  if (!result.ok)
    throw Object.assign(new Error('State observation failed'), { code: result.error.code })
  return result.value
}
const clock = (page: Page) =>
  page.locator('audio[data-player="persistent"]').evaluate((audio: HTMLAudioElement) => ({
    positionMs: audio.currentTime * 1000,
    durationMs: Number.isFinite(audio.duration) ? audio.duration * 1000 : null,
    paused: audio.paused,
    readyState: audio.readyState,
    mediaErrorCode: audio.error?.code ?? null,
    source: audio.currentSrc,
    elementId: Reflect.get(audio, 'pageEchoSourceProbeIdentity') as string | undefined,
  }))
function safeClock(value: Awaited<ReturnType<typeof clock>>) {
  const { source, ...rest } = value
  return {
    ...rest,
    localSourceKind: source.startsWith('readlisten://app/stream/')
      ? 'stream'
      : source.startsWith('readlisten://app/media/')
        ? 'complete'
        : 'other',
    sourceSha256: createHash('sha256').update(source).digest('hex'),
  }
}
await save()
console.log(JSON.stringify({ stage: 'starting', report: join(directory, 'report.json') }))
let app: ElectronApplication | undefined, page: Page | undefined
const pageErrors: { name: string }[] = []
try {
  app = await electron.launch({ args: [appRoot], env, timeout: 20000 })
  page = await app.firstWindow()
  page.on('pageerror', (error) => pageErrors.push({ name: error.name }))
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), userData)
  await expect(page.getByRole('heading', { name: '我的书架', exact: true })).toBeVisible({
    timeout: 15000,
  })
  const requestId = randomUUID()
  report.sourceApi = await page.evaluate(() => ({
    add: typeof window.desktop.addSourceBook,
    cancel: typeof window.desktop.cancelSourceRequest,
  }))
  await stage('adding-one-real-source-book')
  const added = await within(
    page.evaluate(
      ({ id, bookId }) => window.desktop.addSourceBook({ id, sourceId: 'ting13', bookId }),
      { id: requestId, bookId },
    ),
    75000,
    'Source catalogue request timed out',
  ).catch(async (error: unknown) => {
    await page!
      .evaluate((id) => window.desktop.cancelSourceRequest({ id }), requestId)
      .catch(() => undefined)
    throw error
  })
  report.sourceRequestResult = added.ok ? { ok: true } : { ok: false, code: added.error.code }
  await save()
  if (!added.ok)
    throw Object.assign(new Error('Source catalogue unavailable'), { code: added.error.code })
  const book = added.value.books.find(
    (item) => item.online?.sourceId === 'ting13' && item.online.bookId === bookId,
  )
  assert(book?.episodes.length, 'Real source returned no episodes')
  const first = book.episodes[0]!
  assert.equal(
    first.contentHash,
    '',
    'The isolated episode must start without a verified audio identity',
  )
  const settings = await page.evaluate(
    (id) =>
      window.desktop.setSubtitlePreparation({
        id,
        settings: { mode: 'manual', engine: 'whisperx', device: 'cpu', prepareNext: false },
      }),
    book.id,
  )
  assert(settings.ok, 'Unable to disable ASR preparation for this source-only acceptance')
  report.identity = {
    libraryBookId: book.id,
    episodeId: first.id,
    nativeEpisodeId: first.online?.episodeId,
    title: book.title,
    loadedEpisodes: book.episodes.length,
  }
  await page.reload()
  const card = page
    .locator('.book-card[data-book-kind="audio"]')
    .filter({ has: page.getByRole('heading', { name: book.title, exact: true }) })
  await expect(card).toHaveCount(1)
  await app.evaluate(({ ipcMain }) => {
    type Handler = (...args: unknown[]) => unknown
    const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<string, Handler>
    const original = handlers?.get('player:open-episode')
    if (typeof original !== 'function') throw Error('Stock open-episode handler is unavailable')
    Reflect.set(globalThis, 'pageEchoSourceProbeSession', null)
    handlers.set('player:open-episode', async (...args: unknown[]) => {
      const result = (await original(...args)) as Result<PlaybackSource>
      if (
        result.ok &&
        /^[0-9a-f-]{36}$/i.test(result.value.sessionId) &&
        /^readlisten:\/\/app\/(stream|media)\//.test(result.value.url)
      )
        Reflect.set(globalThis, 'pageEchoSourceProbeSession', {
          sessionId: result.value.sessionId,
          episodeId: result.value.episode.id,
        })
      return result
    })
  })
  const elementId = randomUUID()
  await page.locator('audio[data-player="persistent"]').evaluate((audio: HTMLAudioElement, id) => {
    Reflect.set(audio, 'pageEchoSourceProbeIdentity', id)
    audio.muted = true
  }, elementId)
  await stage('real-shelf-play-requested')
  const clickedAt = Date.now()
  await card.getByRole('button', { name: '继续播放', exact: true }).click()
  await page.waitForFunction(
    () => {
      const audio = document.querySelector<HTMLAudioElement>('audio[data-player="persistent"]')
      return !!audio && audio.currentTime > 0.1 && !audio.paused
    },
    undefined,
    { timeout: 130000, polling: 'raf' },
  )
  const firstClock = await clock(page)
  const session = await app.evaluate(
    () =>
      Reflect.get(globalThis, 'pageEchoSourceProbeSession') as {
        sessionId: string
        episodeId: string
      } | null,
  )
  assert(
    session && session.episodeId === first.id,
    'The playing element must belong to the actual shelf IPC session',
  )
  const sourceResult = await page.evaluate(
    (sessionId) => window.desktop.getPlaybackSourceState({ sessionId }),
    session.sessionId,
  )
  assert(sourceResult.ok && sourceResult.value, 'Main source state must remain observable')
  const source = sourceResult.value
  report.firstPlayingObservation = {
    elapsedFromClickMs: Date.now() - clickedAt,
    clock: safeClock(firstClock),
    mainSourceState:
      source.status === 'pending'
        ? source
        : { sessionId: source.sessionId, episodeId: source.episodeId, status: source.status },
  }
  report.earlyPlaybackProven =
    source.status === 'pending' && source.receivedBytes < source.totalBytes
  report.earlyPlaybackConclusion = report.earlyPlaybackProven
    ? 'Native playback exceeded 100ms while Main still reported an incomplete single-response download.'
    : 'Playback succeeded, but the first Main snapshot was already complete; this run does not prove earlier playback.'
  assert.equal(firstClock.elementId, elementId)
  assert.equal(firstClock.mediaErrorCode, null)
  await stage(
    report.earlyPlaybackProven
      ? 'real-source-early-play-proven'
      : 'real-source-playing-without-acceleration-proof',
  )
  let completedState: AppState | undefined
  await expect
    .poll(
      async () => {
        completedState = await state(page!)
        const episode = completedState.books
          .find((item) => item.id === book.id)
          ?.episodes.find((item) => item.id === first.id)
        return !!episode?.online?.cached && /^[0-9a-f]{64}$/.test(episode.contentHash)
      },
      { timeout: 130000, intervals: [500] },
    )
    .toBe(true)
  const completed = completedState!.books
    .find((item) => item.id === book.id)!
    .episodes.find((item) => item.id === first.id)!
  const ready = await page.evaluate(
    (sessionId) => window.desktop.getPlaybackSourceState({ sessionId }),
    session.sessionId,
  )
  assert(
    ready.ok && ready.value?.status === 'ready',
    'Complete cache must produce a ready identity',
  )
  const after = await clock(page)
  assert.equal(after.elementId, elementId)
  assert.equal(
    after.source,
    firstClock.source,
    'The pending-to-ready handoff must keep the audio URL',
  )
  assert(!after.paused && after.positionMs >= firstClock.positionMs)
  report.completeCache = {
    contentHash: completed.contentHash,
    sizeBytes: completed.sizeBytes,
    clock: safeClock(after),
    sameElementAndUrl: true,
  }
  await stage('complete-cache-and-same-element-handoff')
  await page
    .getByRole('region', { name: '播放器', exact: true })
    .getByRole('button', { name: '暂停', exact: true })
    .click()
  const saved = await clock(page)
  report.savedPositionMs = saved.positionMs
  const closed = await closeOwnedElectron(app)
  app = undefined
  report.firstCleanup = closed
  assert.equal(closed.kind, 'graceful', 'Progress acceptance requires a graceful application close')
  const database = new DatabaseSync(join(userData, 'data', 'library.sqlite3'), { readOnly: true })
  try {
    const row = database
      .prepare(
        'SELECT locator, content_hash AS contentHash, position_ms AS positionMs FROM episodes WHERE id=?',
      )
      .get(first.id)
    assert(row && typeof row.locator === 'string')
    assert.equal(
      await hash(row.locator),
      completed.contentHash,
      'Complete cached file must match its committed SHA256',
    )
    assert.equal(row.contentHash, completed.contentHash)
    assert(
      Math.abs(Number(row.positionMs) - saved.positionMs) < 1000,
      'Graceful close must save the actual listening position',
    )
    report.databaseEvidence = {
      contentHash: row.contentHash,
      positionMs: row.positionMs,
      asrJobs: Number(
        database.prepare('SELECT count(*) AS count FROM transcription_jobs').get()?.count ?? 0,
      ),
    }
    assert.equal(Number((report.databaseEvidence as { asrJobs: number }).asrJobs), 0)
  } finally {
    database.close()
  }
  app = await electron.launch({ args: [appRoot], env, timeout: 20000 })
  page = await app.firstWindow()
  page.on('pageerror', (error) => pageErrors.push({ name: error.name }))
  await expect
    .poll(async () => Math.abs((await clock(page!)).positionMs - saved.positionMs), {
      timeout: 30000,
    })
    .toBeLessThan(100)
  const restarted = await clock(page)
  assert(restarted.paused, 'Restart must restore a paused position')
  const restored = (await state(page)).books
    .find((item) => item.id === book.id)!
    .episodes.find((item) => item.id === first.id)!
  assert.equal(restored.contentHash, completed.contentHash)
  report.restart = {
    clock: safeClock(restarted),
    contentHash: restored.contentHash,
    scope:
      'Verified-cache restart, with unchanged application network behavior; not a physical offline test.',
  }
  assert.deepEqual(pageErrors, [])
  await stage('verified-cache-hash-and-paused-restart')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  const message = error instanceof Error ? error.message : String(error)
  const categories: [RegExp, string][] = [
    [/Target page, context or browser has been closed|Page closed/i, 'automation-context-closed'],
    [/Execution context was destroyed/i, 'automation-context-destroyed'],
    [/__name is not defined/i, 'serialized-runner-helper-unavailable'],
    [/is not a function/i, 'api-function-unavailable'],
    [/No handler registered/i, 'ipc-handler-unavailable'],
    [/Source catalogue request timed out/i, 'source-request-deadline'],
    [/Source catalogue unavailable/i, 'structured-source-failure'],
    [/timeout|timed out/i, 'observation-deadline'],
  ]
  report.failure = {
    stage: currentStage,
    name: error instanceof Error ? error.name : 'Unknown',
    code:
      typeof (error as { code?: unknown })?.code === 'string'
        ? (error as { code: string }).code
        : null,
    category: categories.find(([pattern]) => pattern.test(message))?.[1] ?? 'unclassified',
    // Keep unrecognized transport text out of logs; it may contain signed URLs.
    messageSha256: createHash('sha256').update(message).digest('hex'),
    runnerLine:
      error instanceof Error
        ? (/progressive-source\.ts:(\d+):(\d+)/.exec(error.stack ?? '')?.slice(1) ?? null)
        : null,
  }
  process.exitCode = 1
} finally {
  if (app) {
    report.processBeforeCleanup = {
      exitCode: app.process().exitCode,
      signalCode: app.process().signalCode,
    }
    const cleanup = await closeOwnedElectron(app)
    report.finalCleanup = cleanup
    if (cleanup.kind !== 'graceful') {
      report.status = 'failed'
      process.exitCode = 1
    }
  }
  report.pageErrors = pageErrors
  report.finishedAt = new Date().toISOString()
  await save()
}
console.log(
  JSON.stringify({
    status: report.status,
    earlyPlaybackProven: report.earlyPlaybackProven,
    failure: report.failure,
    report: join(directory, 'report.json'),
  }),
)
