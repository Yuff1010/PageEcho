// Opt-in native Main acceptance. Uses the actual anonymous source and complete episodes.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import type { OfflinePlanDetail } from '../../src/shared/offline'
import type { AppState } from '../../src/shared/contracts'
import { createDataPaths } from '../../src/main/paths'
import { LibraryStore } from '../../src/main/database'
import { closeOwnedElectron } from './electron-lifecycle'

const args = process.argv.slice(2)
assert.equal(args.length, 2, 'Use --app-root isolated-preview-app')
assert.equal(args[0], '--app-root')
const appRoot = resolve(args[1]!),
  buildPath = resolve(appRoot, '../manifest.json'),
  build = JSON.parse(await readFile(buildPath, 'utf8'))
assert.equal(build.appRoot, appRoot)
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const hash = async (path: string) => sha(await readFile(path))
for (const [file, digest] of Object.entries(build.outputHashes))
  assert.equal(await hash(join(appRoot, 'out', file)), digest)
const directory = resolve(
  'cache/optimization',
  `offline-online-${build.previewVersion}-${new Date().toISOString().replaceAll(':', '-')}`,
)
await mkdir(directory)
await copyFile(resolve('tests/model/offline-online.ts'), join(directory, 'runner-started.ts'))
const userData = await mkdtemp(join(tmpdir(), '听读 整集在线离线验收 ')),
  paths = createDataPaths(userData)
const componentRoot = resolve('release/asr-component-0.7.0-win-x64'),
  component: Record<string, unknown> = JSON.parse(
    await readFile(join(componentRoot, 'component.json'), 'utf8'),
  )
assert.equal(component.version, 2)
for (const key of ['python', 'models', 'resources', 'ffmpeg', 'ffprobe'])
  component[key] = resolve(componentRoot, String(component[key]))
await writeFile(join(userData, 'asr-component.json'), JSON.stringify(component, null, 2))
const setup = new LibraryStore(paths.database)
setup.setProcessingPolicy({
  revision: setup.processingResources().revision,
  policy: { cpuThreads: 4, lowPriority: true, backgroundIdleOnly: false },
})
setup.setProcessingPaused({ revision: setup.processingResources().revision, paused: true })
setup.close()
const environment: Record<string, string> = { RALB_USER_DATA: userData }
for (const [key, value] of Object.entries(process.env))
  if (
    value !== undefined &&
    ![
      'ralb_user_data',
      'electron_run_as_node',
      'electron_renderer_url',
      'ralb_executable',
    ].includes(key.toLowerCase())
  )
    environment[key] = value
const report: Record<string, unknown> = {
  status: 'running',
  appRoot,
  previewVersion: build.previewVersion,
  userData,
  startedAt: new Date().toISOString(),
  buildManifestSha256: await hash(buildPath),
  runnerSha256: await hash(join(directory, 'runner-started.ts')),
  sourceHashes: build.sourceHashes,
  outputHashes: build.outputHashes,
  pythonHashes: build.pythonHashes,
  componentManifestSha256: await hash(join(componentRoot, 'bundle-manifest.json')),
  stages: [],
  scope:
    'Actual Main IPC, fresh anonymous Ting13 downloads and Paraformer CUDA full generation for 3 complete episodes; current download preemption observation, persisted retention, temporary-cache clear protection, graceful restart, then all HTTP(S) and Node fetch denied while cached Range playback/seek work for each episode. No new manual accuracy or uninterrupted-duration claim.',
}
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
async function stage(name: string) {
  ;(report.stages as unknown[]).push({ name, at: new Date().toISOString() })
  await save()
  console.log(JSON.stringify({ stage: name, report: join(directory, 'report.json') }))
}
await save()
let app: ElectronApplication | undefined
let page: Page
const workerPids = new Set<number>()
const state = async (): Promise<AppState> => {
  const result = await page.evaluate(() => window.desktop.getState())
  assert.ok(result.ok, JSON.stringify(result))
  return result.value
}
const clock = () =>
  page.locator('audio').evaluate((audio: HTMLAudioElement) => ({
    positionMs: audio.currentTime * 1000,
    durationMs: audio.duration * 1000,
    paused: audio.paused,
    source: audio.currentSrc,
    error: audio.error?.message ?? null,
  }))
try {
  app = await electron.launch({ args: [appRoot], env: environment })
  page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.webContents.setAudioMuted(true),
  )
  assert.equal((await state()).version, build.previewVersion)
  const detail = await page.evaluate(
    (id) => window.desktop.getSourceBook({ id, sourceId: 'ting13', bookId: '39941' }),
    randomUUID(),
  )
  assert.ok(detail.ok, JSON.stringify(detail))
  const added = await page.evaluate(
    (id) => window.desktop.addSourceBook({ id, sourceId: 'ting13', bookId: '39941' }),
    randomUUID(),
  )
  assert.ok(added.ok, JSON.stringify(added))
  const saved = await page.evaluate(
    (id) => window.desktop.getBookDetail({ id }),
    added.value.bookId!,
  )
  assert(saved.ok && saved.value)
  const book = saved.value
  assert.ok(book.episodes.length >= 3)
  const episodes = book.episodes.slice(0, 3)
  report.sourceBook = detail.value.book
  report.episodeIdentities = episodes
  report.originalBookSettings = book.subtitlePreparation
  const preview = await page.evaluate(
    (request) => window.desktop.previewOfflinePreparation(request),
    {
      requestId: randomUUID(),
      bookId: book.id,
      selection: { kind: 'range' as const, from: 1, to: 3 },
      profile: { engine: 'paraformer' as const, device: 'cuda' as const },
      audioBudgetBytes: 256 * 1024 ** 2,
    },
  )
  assert.ok(preview.ok, JSON.stringify(preview))
  assert.equal(preview.value.unknownAudioItems, 3)
  assert.equal(preview.value.existingAudioItems, 0)
  assert.equal(preview.value.knownAudioBytes, 0)
  report.preview = preview.value
  const created = await page.evaluate(
    (token) => window.desktop.createOfflinePreparation({ token }),
    preview.value.token,
  )
  assert.ok(created.ok, JSON.stringify(created))
  const id = created.value.id
  assert.equal(created.value.status, 'queued')
  assert.equal((await state()).currentEpisodeId, null)
  report.planId = id
  const plan = async (): Promise<OfflinePlanDetail> => {
    const result = await page.evaluate(
      (id) => window.desktop.getOfflinePreparation({ id, itemPage: 0 }),
      id,
    )
    assert.ok(result.ok, JSON.stringify(result))
    return result.value
  }
  await page.getByRole('button', { name: `打开 ${book.title} 的目录`, exact: true }).click()
  const resources = await page.evaluate(() => window.desktop.getProcessingResources())
  assert.ok(resources.ok)
  const resumed = await page.evaluate(
    (revision) => window.desktop.setProcessingPaused({ revision, paused: false }),
    resources.value.revision,
  )
  assert.ok(resumed.ok)
  await stage('three-unknown-full-episodes-explicitly-created-no-autoplay-or-profile-change')
  await expect
    .poll(async () => (await plan()).items.items[0]!.status, { timeout: 60000, intervals: [50] })
    .toBe('downloading')
  // A real current playback request replaces the in-progress plan download.
  await page.getByRole('button', { name: `播放第 3 集 ${episodes[2]!.title}`, exact: true }).click()
  await expect
    .poll(
      async () => {
        const value = await clock()
        return !value.paused && value.positionMs > 400 && !value.error
      },
      { timeout: 150000, intervals: [100] },
    )
    .toBe(true)
  report.foregroundClock = await clock()
  await stage('current-playback-request-preempted-plan-download-and-media-clock-advanced')
  await expect
    .poll(
      async () => {
        const value = await plan()
        const jobs = await page.evaluate(() =>
          window.desktop.getTranscriptionJobs({ page: 0, activeOnly: false }),
        )
        const processing = await page.evaluate(() => window.desktop.getProcessingResources())
        assert.ok(processing.ok)
        if (processing.value.worker) workerPids.add(processing.value.worker.pid)
        assert.ok(jobs.ok)
        const active = jobs.value.jobs.filter((job) =>
          ['queued', 'running', 'canceling'].includes(job.status),
        )
        assert.ok(active.length <= 1, 'Only one runnable planned ASR job is materialized')
        await appendFile(
          join(directory, 'observations.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), value, jobs: jobs.value.jobs }) + '\n',
        )
        report.latest = { value, jobs: jobs.value.jobs, processing: processing.value }
        await save()
        if (value.plan.status === 'blocked' || value.plan.status === 'completed-with-issues')
          throw new Error(JSON.stringify(value))
        return value.plan.status
      },
      { timeout: 900000, intervals: [500] },
    )
    .toBe('completed')
  const completed = await plan()
  assert.equal(completed.plan.counts.audioReady, 3)
  assert.equal(completed.plan.counts.subtitleReady, 3)
  assert.ok(
    completed.items.items[0]!.attempt > 1,
    'Current request actually interrupted first owned download',
  )
  const transcripts = []
  for (const item of completed.items.items) {
    const saved = await page.evaluate((request) => window.desktop.getTranscript(request), {
      episodeId: item.episodeId,
      audioHash: item.audioHash!,
    })
    assert.ok(saved.ok && saved.value.status === 'ready')
    assert.equal(saved.value.transcript.document.kind, 'transcript')
    assert.ok(item.durationMs! > 60000)
    transcripts.push({
      episodeId: item.episodeId,
      hash: item.audioHash,
      durationMs: item.durationMs,
      revision: saved.value.transcript.revision,
      documentSha256: sha(JSON.stringify(saved.value.transcript.document)),
      coverage: saved.value.transcript.document.coverage,
      segments: saved.value.transcript.document.segments.length,
    })
  }
  report.completed = completed
  report.transcripts = transcripts
  assert.deepEqual(
    (await state()).books.find((value) => value.id === book.id)!.subtitlePreparation,
    book.subtitlePreparation,
  )
  const cache = await page.evaluate(() => window.desktop.getSourceCacheState())
  assert.ok(cache.ok)
  assert.equal(cache.value.offlineFiles, 3)
  assert.equal(cache.value.bytes, 0)
  const clear = await page.evaluate(() => window.desktop.previewSourceCacheClear())
  assert.ok(clear.ok)
  assert.equal(clear.value.clearFiles, 0)
  const cleared = await page.evaluate(
    (token) => window.desktop.clearSourceCache({ token }),
    clear.value.token,
  )
  assert.ok(cleared.ok)
  assert.equal(cleared.value.offlineFiles, 3)
  report.cache = { before: cache.value, preview: clear.value, after: cleared.value }
  await page.screenshot({ path: join(directory, 'completed-chapters.png'), fullPage: true })
  await stage(
    'three-full-real-subtitles-completed-current-first-interruption-retained-and-cache-clear-kept-audio',
  )
  report.firstClose = await closeOwnedElectron(app)
  app = undefined
  app = await electron.launch({ args: [appRoot], env: environment })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await app.evaluate(({ BrowserWindow, session }) => {
    BrowserWindow.getAllWindows()[0]!.webContents.setAudioMuted(true)
    Reflect.set(globalThis, 'ralbOfflineAttempts', { node: 0, browser: 0 })
    Reflect.set(globalThis, 'fetch', async () => {
      Reflect.get(globalThis, 'ralbOfflineAttempts').node++
      throw new Error('Acceptance test: network offline')
    })
    session
      .fromPartition('persist:readlisten-source-ting13')
      .webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => {
        Reflect.get(globalThis, 'ralbOfflineAttempts').browser++
        callback({ cancel: true })
      })
  })
  const afterRestart = await plan()
  assert.equal(afterRestart.plan.status, 'completed')
  assert.equal(afterRestart.plan.counts.audioReady, 3)
  assert.equal(afterRestart.plan.counts.subtitleReady, 3)
  const rangeResponses: unknown[] = []
  page.on('response', (response) => {
    if (response.url().startsWith('readlisten://app/media/'))
      rangeResponses.push({
        url: response.url(),
        status: response.status(),
        headers: response.headers(),
      })
  })
  await page.getByRole('button', { name: `打开 ${book.title} 的目录`, exact: true }).click()
  const playback = []
  for (const [index, episode] of episodes.entries()) {
    await page
      .getByRole('button', { name: `播放第 ${index + 1} 集 ${episode.title}`, exact: true })
      .click()
    await expect
      .poll(
        async () => {
          const value = await clock()
          return (
            value.source.includes(episode.id) &&
            !value.paused &&
            value.positionMs > 300 &&
            !value.error
          )
        },
        { timeout: 15000, intervals: [100] },
      )
      .toBe(true)
    const before = await clock()
    await page.locator('audio').evaluate((audio: HTMLAudioElement) => {
      audio.currentTime = audio.duration / 2
    })
    await expect
      .poll(async () => (await clock()).positionMs, { timeout: 10000, intervals: [100] })
      .toBeGreaterThan(before.durationMs / 2 + 200)
    const after = await clock()
    assert.equal(after.error, null)
    playback.push({ episodeId: episode.id, before, after })
  }
  const attempts = await app.evaluate(() => Reflect.get(globalThis, 'ralbOfflineAttempts'))
  assert.deepEqual(attempts, { node: 0, browser: 0 })
  assert.ok(rangeResponses.some((value) => (value as { status: number }).status === 206))
  assert.deepEqual(errors, [])
  report.offline = { afterRestart, playback, attempts, rangeResponses, errors }
  await page.screenshot({ path: join(directory, 'offline-after-restart.png'), fullPage: true })
  await stage(
    'restart-http-and-fetch-denied-three-cached-episodes-play-and-seek-with-range-responses',
  )
  report.finalClose = await closeOwnedElectron(app)
  app = undefined
  report.ownedWorkerPids = [...workerPids]
  assert.ok(workerPids.size > 0, 'A real owned worker was observed')
  report.ownedProcessesRemaining = [...workerPids].filter((pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
      throw error
    }
  })
  assert.deepEqual(report.ownedProcessesRemaining, [])
  const stored = new LibraryStore(paths.database)
  try {
    report.retainedFiles = await Promise.all(
      stored.offlineRetainedFiles(id).map(async (file) => {
        assert.equal(await hash(file.path), file.contentHash)
        return { ...file, verifiedSha256: file.contentHash }
      }),
    )
    report.finalJobs = stored.listJobs({ page: 0, activeOnly: false }).jobs
    assert.ok((report.finalJobs as { status: string }[]).every((job) => job.status === 'completed'))
  } finally {
    stored.close()
  }
  for (const [file, digest] of Object.entries(build.outputHashes))
    assert.equal(await hash(join(appRoot, 'out', file)), digest)
  report.status = 'passed'
  report.finishedAt = new Date().toISOString()
  await save()
  console.log(JSON.stringify({ status: 'passed', report: join(directory, 'report.json') }))
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.stack : String(error)
  await save()
  throw error
} finally {
  if (app) {
    report.cleanup = await closeOwnedElectron(app)
    await save()
  }
}
