import { openCompanionTools } from '../helpers/ui'
// Opt-in actual Main/CPU/CUDA editing acceptance. The seeded coarse sentence
// bounds are not human timing labels; existing utterance text is human reference.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, appendFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import type { Result } from '../../src/shared/contracts'
import type { TranscriptRequest } from '../../src/shared/transcript'
import type { TranscriptReplacementRequest } from '../../src/shared/transcript-editing'
import { closeOwnedElectron } from './electron-lifecycle'

const args: Record<string, string> = {}
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]!,
    value = process.argv[index + 1]
  assert.ok(
    ['--app-root', '--device', '--component', '--request', '--output'].includes(name) && value,
  )
  assert.equal(args[name], undefined, `Duplicate ${name}`)
  args[name] = value
}
assert.ok(args['--app-root'] && ['cpu', 'cuda'].includes(args['--device']!))
const device = args['--device'] as 'cpu' | 'cuda',
  appRoot = resolve(args['--app-root']),
  componentFile = resolve(
    args['--component'] ??
      `release/asr-component-${device === 'cpu' ? '0.7.1-cpu.1' : '0.7.0'}-win-x64/component.json`,
  ),
  requestFile = resolve(
    args['--request'] ??
      'cache/optimization/original-acoustic-cli-2026-10-23/correct-cuda.request.json',
  ),
  manifestFile = resolve(appRoot, '../manifest.json'),
  build = JSON.parse(await readFile(manifestFile, 'utf8')),
  directory = resolve(
    args['--output'] ??
      `cache/optimization/transcript-editing-main-${build.previewVersion}-${device}-${new Date().toISOString().replaceAll(':', '-')}`,
  )
await mkdir(directory) // Existing evidence is never overwritten.
await copyFile(resolve('tests/model/transcript-editing.ts'), join(directory, 'runner-started.ts'))
async function hash(path: string) {
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(path)) digest.update(bytes)
  return digest.digest('hex')
}
assert.equal(build.status, 'built')
assert.equal(build.appRoot, appRoot)
for (const [path, digest] of Object.entries(build.outputHashes))
  assert.equal(await hash(join(appRoot, 'out', path)), digest)
for (const [path, digest] of Object.entries(build.pythonHashes))
  assert.equal(await hash(join(appRoot, 'python', path)), digest)
for (const [path, digest] of Object.entries(build.sourceHashes))
  assert.equal(await hash(resolve('src', path)), digest)
const request = JSON.parse(await readFile(requestFile, 'utf8')) as {
    audioPath: string
    audioHash: string
    text: string
    range: { startMs: number; endMs: number }
  },
  prior = JSON.parse(await readFile(join(dirname(requestFile), 'report.json'), 'utf8')),
  referenceFile = resolve(prior.manifest),
  reference = JSON.parse(await readFile(referenceFile, 'utf8')),
  sample = reference.samples.find(
    (value: { audioHash: string }) => value.audioHash === request.audioHash,
  )
assert.equal(await hash(referenceFile), prior.manifestSha256)
assert.ok(sample)
assert.equal(sample.reference.map((value: { text: string }) => value.text).join(''), request.text)
assert.equal(request.text, '太平洋商业中心')
assert.equal(await hash(request.audioPath), request.audioHash)
assert.deepEqual(request.range, { startMs: 0, endMs: 2780 })
const userData = await mkdtemp(join(tmpdir(), '听读 字幕真实编辑 ')),
  paths = createDataPaths(userData),
  audioDirectory = join(userData, 'owned-audio')
assert.match(userData, /^[cC]:/)
await mkdir(audioDirectory)
const component = JSON.parse(await readFile(componentFile, 'utf8'))
assert.equal(component.version, 2)
for (const name of ['python', 'models', 'resources', 'ffmpeg', 'ffprobe'])
  component[name] = resolve(dirname(componentFile), component[name])
await writeFile(join(userData, 'asr-component.json'), JSON.stringify(component, null, 2))
const inputPaths = [
  join(audioDirectory, '01-calibration.wav'),
  join(audioDirectory, '02-calibration.wav'),
]
for (const path of inputPaths) await copyFile(request.audioPath, path)
const store = new LibraryStore(paths.database)
store.importBook(await scanBook(audioDirectory, 'folder'))
const book = store.listBooks()[0]!,
  episodes = book.episodes,
  target: TranscriptRequest = { episodeId: episodes[0]!.id, audioHash: request.audioHash },
  settings = { mode: 'manual', engine: 'whisperx', device: 'cpu', prepareNext: false } as const
assert.equal(episodes.length, 2)
store.setSubtitlePreparation(book.id, settings)
store.setBookSkips(book.id, { introMs: 30, outroMs: 40 })
store.setProcessingPolicy({
  revision: store.processingResources().revision,
  policy: { cpuThreads: 1, lowPriority: true, backgroundIdleOnly: false },
})
for (const episode of episodes) {
  assert.equal(episode.contentHash, request.audioHash)
  store.recordSourceDuration(episode.id, episode.contentHash, 2780)
  store.saveTranscript(episode.id, {
    version: 1,
    kind: 'manual',
    audioHash: episode.contentHash,
    coverage: [{ startMs: 0, endMs: 2780 }],
    segments: [{ id: 'coarse-reference', startMs: 0, endMs: 2780, text: '太平洋商叶中心' }],
  })
}
const bookmark = store.saveBookmark({
    ...target,
    positionMs: 700,
    note: 'Keep this human bookmark.',
  }),
  regions = store.markTranscriptRegion({
    ...target,
    revision: 0,
    startMs: 0,
    endMs: 200,
    kind: 'intro',
  })
store.saveProgress({
  sessionId: '',
  episodeId: target.episodeId,
  positionMs: 150,
  durationMs: 2780,
  rate: 1.25,
  volume: 0,
})
store.close()
const protectedFiles = [
    request.audioPath,
    requestFile,
    referenceFile,
    componentFile,
    component.models,
    join(dirname(componentFile), 'bundle-manifest.json'),
    component.python,
    component.ffmpeg,
    component.ffprobe,
    ...inputPaths,
  ],
  protectedBefore = Object.fromEntries(
    await Promise.all(protectedFiles.map(async (path) => [path, await hash(path)])),
  )
const report: Record<string, unknown> = {
  status: 'running',
  startedAt: new Date().toISOString(),
  appRoot,
  previewVersion: build.previewVersion,
  device,
  directory,
  userData,
  target,
  runnerSha256: await hash(join(directory, 'runner-started.ts')),
  buildManifestSha256: await hash(manifestFile),
  sourceHashes: build.sourceHashes,
  outputHashes: build.outputHashes,
  pythonHashes: build.pythonHashes,
  reference: {
    manifest: referenceFile,
    manifestSha256: await hash(referenceFile),
    sample,
    requestFile,
    requestSha256: await hash(requestFile),
  },
  protectedBefore,
  seed: { text: '太平洋商叶中心', range: request.range, settings, bookmark, regions },
  stages: [],
  cleanups: [],
  scope:
    'Actual frozen Main/preload IPC, SQLite grouped editing/restart/history and pinned CPU/CUDA CTC. No original book is imported. Only existing published human utterance text is reused. Coarse seeded bounds and model proposals are not human timing labels; no novel model quality or performance conclusion.',
}
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
async function stage(name: string, extra: Record<string, unknown> = {}) {
  ;(report.stages as unknown[]).push({ name, at: new Date().toISOString(), ...extra })
  await save()
  console.log(JSON.stringify({ stage: name, ...extra }))
}
const env = { ...process.env, RALB_USER_DATA: userData }
for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'RALB_EXECUTABLE'])
  Reflect.deleteProperty(env, name)
let app: ElectronApplication | undefined
let page!: Page
const rendererErrors: string[] = [],
  ownedWorkers = new Set<number>(),
  ownedAlignments = new Set<number>()
async function value<T>(result: Promise<Result<T>>): Promise<T> {
  const resultValue = await result
  assert.ok(resultValue.ok, JSON.stringify(resultValue))
  return resultValue.value
}
const doc = (index = 0) =>
  page.evaluate(
    async (target) => {
      const result = await window.desktop.getTranscript(target)
      if (!result.ok || result.value.status !== 'ready') throw Error(JSON.stringify(result))
      return result.value.transcript
    },
    { episodeId: episodes[index]!.id, audioHash: request.audioHash },
  )
const history = () =>
  value(page.evaluate((target) => window.desktop.getTranscriptEditingState(target), target))
const alignment = () =>
  value(page.evaluate((target) => window.desktop.getTranscriptAlignment(target), target))
const clock = () =>
  page.locator('audio').evaluate((audio: HTMLAudioElement) => ({
    positionMs: audio.currentTime * 1000,
    paused: audio.paused,
    rate: audio.playbackRate,
    volume: audio.volume,
    source: audio.currentSrc,
  }))
async function preserved() {
  const state = await value(page.evaluate(() => window.desktop.getState())),
    currentBook = state.books.find((value) => value.id === book.id)!
  return {
    settings: currentBook.subtitlePreparation,
    introMs: currentBook.introMs,
    outroMs: currentBook.outroMs,
    bookmarks: await value(page.evaluate((id) => window.desktop.getBookmarks({ id }), book.id)),
    regions: await value(
      page.evaluate((target) => window.desktop.getTranscriptRegions(target), target),
    ),
    preferences: state.preferences,
    original: await value(
      page.evaluate((target) => window.desktop.getOriginalState(target), target),
    ),
  }
}
function processes() {
  const escaped = userData.replaceAll("'", "''"),
    script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $ownedData='${escaped}'; ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -and $_.CommandLine.Contains($ownedData) -and $_.Name -match '^(python|ffmpeg|ffprobe|electron)\\.exe$'} | ForEach-Object {[pscustomobject]@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;name=$_.Name;command=$_.CommandLine;created=$_.CreationDate.ToUniversalTime().ToString('o')}}) -Compress`
  return JSON.parse(
    execFileSync(
      join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      ['-NoProfile', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 },
    ),
  ) as { pid: number; parent: number; name: string; command: string; created: string }[]
}
async function launch() {
  app = await electron.launch({ args: [appRoot], env })
  app
    .process()
    .stderr?.on('data', (chunk) => appendFileSync(join(directory, 'main-stderr.log'), chunk))
  page = await app.firstWindow()
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  await page.context().setOffline(true)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.webContents.setAudioMuted(true),
  )
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
  assert.equal(
    (await value(page.evaluate(() => window.desktop.getState()))).version,
    build.previewVersion,
  )
}
async function close() {
  assert(app)
  const closed = await closeOwnedElectron(app, 20000)
  app = undefined
  ;(report.cleanups as unknown[]).push(closed)
  await save()
  assert.equal(closed.kind, 'graceful')
}
async function waitReady(id: string) {
  const deadline = Date.now() + 180000
  for (;;) {
    const state = await alignment(),
      job = state.job
    assert.ok(job && job.id === id)
    const owned = processes()
    for (const process of owned)
      if (process.name.toLowerCase() === 'python.exe') {
        assert.notEqual(process.pid, 31988)
        ownedWorkers.add(process.pid)
        if (process.command.includes('asr_original_alignment.py')) ownedAlignments.add(process.pid)
      }
    appendFileSync(
      join(directory, 'observations.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), job, processes: owned }) + '\n',
    )
    if (['failed', 'rejected', 'canceled'].includes(job.status))
      throw Error(
        `Actual ${device} alignment ${job.status}: ${job.error ?? JSON.stringify(job.result?.reasons)}`,
      )
    if (job.status === 'ready') return job
    assert.ok(Date.now() < deadline, 'Actual model proposal timed out')
    await delay(350)
  }
}
try {
  await stage('seeded-isolated-two-episode-book-no-original-import')
  await launch()
  const before = await Promise.all(episodes.map((_e, index) => doc(index))),
    kept = await preserved(),
    initialClock = await clock()
  assert.equal(kept.original.info, null)
  assert.equal(initialClock.paused, true)
  report.before = { transcripts: before, preserved: kept, clock: initialClock }
  const replacement: TranscriptReplacementRequest = {
    ...target,
    revision: before[0]!.revision,
    requestId: randomUUID(),
    scope: { kind: 'book', bookId: book.id, episodeIds: episodes.map((value) => value.id) },
    find: '商叶',
    replacement: '商业',
  }
  const canceledPreview = await value(
    page.evaluate((request) => window.desktop.previewTranscriptReplacement(request), replacement),
  )
  assert.equal(canceledPreview.episodes, 2)
  await value(
    page.evaluate(
      (requestId) => window.desktop.cancelTranscriptReplacement({ requestId }),
      replacement.requestId,
    ),
  )
  assert.deepEqual(await Promise.all(episodes.map((_e, index) => doc(index))), before)
  const staleToken = await page.evaluate(
    (token) => window.desktop.applyTranscriptReplacement({ token, commandId: crypto.randomUUID() }),
    canceledPreview.token,
  )
  assert.ok(!staleToken.ok && staleToken.error.code === 'CONFLICT')
  const preview = await value(
    page.evaluate((request) => window.desktop.previewTranscriptReplacement(request), {
      ...replacement,
      requestId: randomUUID(),
    }),
  )
  const bulkCommand = { token: preview.token, commandId: randomUUID() },
    applied = await value(
      page.evaluate((request) => window.desktop.applyTranscriptReplacement(request), bulkCommand),
    )
  assert.equal(applied.changed.length, 2)
  const corrected = await Promise.all(episodes.map((_e, index) => doc(index)))
  assert.ok(corrected.every((value) => value.document.segments[0]!.text === request.text))
  assert.equal(
    (
      await value(
        page.evaluate((request) => window.desktop.applyTranscriptReplacement(request), bulkCommand),
      )
    ).replayed,
    true,
  )
  await value(
    page.evaluate((request) => window.desktop.undoTranscriptEdit(request), {
      ...target,
      revision: corrected[0]!.revision,
      historyId: applied.history.undo!.id,
      commandId: randomUUID(),
    }),
  )
  const undone = await Promise.all(episodes.map((_e, index) => doc(index)))
  assert.deepEqual(
    undone.map((value) => value.document),
    before.map((value) => value.document),
  )
  report.bulk = { canceledPreview, preview, applied, corrected, undone }
  await stage('literal-book-preview-cancel-apply-and-group-undo')
  await close()
  await launch()
  const restartedHistory = await history()
  assert.equal(restartedHistory.redo?.id, applied.history.undo!.id)
  const redone = await value(
    page.evaluate((request) => window.desktop.redoTranscriptEdit(request), {
      ...target,
      revision: (await doc()).revision,
      historyId: restartedHistory.redo!.id,
      commandId: randomUUID(),
    }),
  )
  assert.deepEqual((await doc()).document, corrected[0]!.document)
  assert.deepEqual((await doc(1)).document, corrected[1]!.document)
  report.restartedRedo = redone
  await stage('group-redo-survived-graceful-restart')
  const coarse = await doc(),
    split = await value(
      page.evaluate((request) => window.desktop.changeTranscript(request), {
        ...target,
        revision: coarse.revision,
        commandId: randomUUID(),
        operation: { kind: 'split' as const, segmentId: 'coarse-reference', offset: 3, atMs: 1000 },
      }),
    )
  const splitDoc = await doc(),
    segments = splitDoc.document.segments
  assert.equal(segments.length, 2)
  assert.deepEqual(
    segments.map(({ text, startMs, endMs }) => ({ text, startMs, endMs })),
    [
      { text: '太平洋', startMs: 0, endMs: 1000 },
      { text: '商业中心', startMs: 1000, endMs: 2780 },
    ],
  )
  assert.equal(new Set(segments.map((value) => value.id)).size, 2)
  assert.ok(
    segments.every((value) => value.id !== 'coarse-reference' && /^[0-9a-f-]{36}$/.test(value.id)),
  )
  assert.deepEqual(splitDoc.document.coverage, coarse.document.coverage)
  assert.deepEqual(await preserved(), kept)
  const afterEditsClock = await clock()
  assert.equal(afterEditsClock.paused, true)
  assert.ok(Math.abs(afterEditsClock.positionMs - initialClock.positionMs) < 20)
  report.split = { result: split, transcript: splitDoc, clock: afterEditsClock }
  await stage('split-created-two-fresh-ids-and-preserved-original-media-coverage')
  const alignRequest = () => ({
    ...target,
    revision: splitDoc.revision,
    requestId: randomUUID(),
    segmentIds: segments.map((value) => value.id),
    device,
  })
  const firstStart = await value(
    page.evaluate((request) => window.desktop.startTranscriptAlignment(request), alignRequest()),
  )
  assert.equal(firstStart.job!.status, 'running')
  const deadline = Date.now() + 60000
  let runningProcesses: ReturnType<typeof processes> = []
  while (!runningProcesses.length) {
    const owned = processes()
    for (const process of owned)
      if (process.name.toLowerCase() === 'python.exe') ownedWorkers.add(process.pid)
    runningProcesses = owned.filter(
      (process) =>
        process.command.includes('asr_original_alignment.py') &&
        process.name.toLowerCase() === 'python.exe',
    )
    if (!runningProcesses.length) {
      assert.ok(Date.now() < deadline, 'Actual alignment PID never appeared before cancellation')
      const state = await alignment()
      assert.equal(state.job!.status, 'running', JSON.stringify(state.job))
      await delay(200)
    }
  }
  assert.ok(
    runningProcesses.every(
      (process) => process.pid !== 31988 && process.command.includes('--cpu-threads 1'),
    ),
  )
  runningProcesses.forEach((process) => ownedAlignments.add(process.pid))
  const cancelAt = performance.now()
  await value(
    page.evaluate((id) => window.desktop.cancelTranscriptAlignment({ id }), firstStart.job!.id),
  )
  assert.equal((await alignment()).job!.status, 'canceled')
  assert.deepEqual(
    processes().filter((process) => runningProcesses.some((owned) => owned.pid === process.pid)),
    [],
  )
  assert.deepEqual(await doc(), splitDoc)
  report.cancellation = {
    job: firstStart.job,
    observedRunningProcesses: runningProcesses,
    awaitedMs: performance.now() - cancelAt,
    after: await alignment(),
    remaining: processes(),
  }
  await stage('actual-alignment-child-observed-then-canceled-and-drained-without-writing')
  const secondStart = await value(
      page.evaluate((request) => window.desktop.startTranscriptAlignment(request), alignRequest()),
    ),
    ready = await waitReady(secondStart.job!.id)
  assert.ok(ready.result?.status === 'accepted' && ready.ranges.length === 2)
  assert.deepEqual(await doc(), splitDoc)
  await writeFile(join(directory, 'real-proposal.json'), JSON.stringify(ready, null, 2))
  report.proposal = ready
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  await expect(page.locator('.transcript-sentence')).toHaveCount(2)
  await openCompanionTools(page)
  await page.getByRole('button', { name: '字幕编辑与撤销', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '字幕编辑', exact: true })
  await editor.getByRole('button', { name: '按声音重对齐', exact: true }).click()
  await expect(editor.getByRole('region', { name: '字幕时间建议', exact: true })).toContainText(
    '建议',
  )
  await expect(editor.getByRole('button', { name: '采用字幕时间建议', exact: true })).toBeEnabled()
  await page.screenshot({ path: join(directory, 'real-proposal.png'), fullPage: true })
  await stage('actual-model-ready-proposal-visible-before-explicit-adoption')
  const adoptionCommand = { id: ready.id, revision: splitDoc.revision, commandId: randomUUID() },
    adopted = await value(
      page.evaluate((request) => window.desktop.applyTranscriptAlignment(request), adoptionCommand),
    ),
    adoptedDoc = await doc()
  assert.deepEqual(
    adoptedDoc.document.segments.map(({ id, startMs, endMs }) => ({
      segmentId: id,
      startMs,
      endMs,
    })),
    ready.ranges,
  )
  assert.deepEqual(
    adoptedDoc.document.segments.map((value) => value.text),
    segments.map((value) => value.text),
  )
  assert.deepEqual(adoptedDoc.document.coverage, splitDoc.document.coverage)
  assert.equal(
    (
      await value(
        page.evaluate(
          (request) => window.desktop.applyTranscriptAlignment(request),
          adoptionCommand,
        ),
      )
    ).replayed,
    true,
  )
  await editor.getByRole('button', { name: '关闭字幕编辑', exact: true }).click()
  await expect(page.locator('.transcript-sentence').first()).toContainText('太平洋')
  const mediaChecks = []
  for (const range of ready.ranges) {
    const middle = Math.floor((range.startMs + range.endMs) / 2)
    await page.getByRole('slider', { name: '播放进度', exact: true }).fill(String(middle))
    const current = page.locator('.transcript-sentence[aria-current="true"]')
    await expect(current).toHaveCount(1)
    await expect(current).toHaveAttribute('data-segment-id', range.segmentId)
    await page.locator(`.transcript-sentence[data-segment-id="${range.segmentId}"]`).click()
    await expect.poll(async () => (await clock()).positionMs).toBeCloseTo(range.startMs, 1)
    mediaChecks.push({ range, midpointMs: middle, actual: await clock() })
  }
  const clockBeforeUndo = await clock(),
    finalUndo = await value(
      page.evaluate((request) => window.desktop.undoTranscriptEdit(request), {
        ...target,
        revision: adoptedDoc.revision,
        historyId: adopted.history.undo!.id,
        commandId: randomUUID(),
      }),
    )
  assert.deepEqual((await doc()).document, splitDoc.document)
  assert.ok((await doc()).revision > adoptedDoc.revision)
  assert.deepEqual(await preserved(), kept)
  assert.ok(Math.abs((await clock()).positionMs - clockBeforeUndo.positionMs) < 20)
  assert.equal((await clock()).paused, true)
  report.adoption = {
    result: adopted,
    transcript: adoptedDoc,
    mediaChecks,
    undo: finalUndo,
    restored: await doc(),
    clockBeforeUndo,
    clockAfterUndo: await clock(),
  }
  await page.screenshot({ path: join(directory, 'restored-subtitle-clock.png'), fullPage: true })
  await stage('explicit-apply-replay-sentence-clock-and-undo-restored-coarse-split-document')
  assert.deepEqual(rendererErrors, [])
  report.rendererErrors = rendererErrors
  await close()
  const database = new DatabaseSync(paths.database, { readOnly: true })
  try {
    report.postclose = {
      schema: database.prepare('PRAGMA user_version').get(),
      originals: database.prepare('SELECT count(*) AS n FROM original_documents').get(),
      jobs: database.prepare('SELECT count(*) AS n FROM transcription_jobs').get(),
      history: database
        .prepare(
          'SELECT id,label,status,episodes,segments FROM transcript_edit_groups ORDER BY sequence',
        )
        .all(),
    }
    assert.equal(database.prepare('SELECT count(*) AS n FROM original_documents').get()!.n, 0)
    assert.equal(database.prepare('SELECT count(*) AS n FROM transcription_jobs').get()!.n, 0)
  } finally {
    database.close()
  }
  report.ownedWorkerPids = [...ownedWorkers]
  report.ownedAlignmentPids = [...ownedAlignments]
  assert.ok(ownedAlignments.size >= 2)
  report.ownedProcessesRemaining = processes()
  assert.deepEqual(report.ownedProcessesRemaining, [])
  for (const [path, digest] of Object.entries(protectedBefore))
    assert.equal(await hash(path), digest)
  for (const [path, digest] of Object.entries(build.outputHashes))
    assert.equal(await hash(join(appRoot, 'out', path)), digest)
  for (const [path, digest] of Object.entries(build.pythonHashes))
    assert.equal(await hash(join(appRoot, 'python', path)), digest)
  report.databaseSha256 = await hash(paths.database)
  report.status = 'passed'
  report.finishedAt = new Date().toISOString()
  await stage('passed')
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
  report.finishedAt = new Date().toISOString()
  if (page!)
    await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {})
  await save()
  throw error
} finally {
  if (app)
    await close().catch(async (error) => {
      report.cleanupError = String(error)
      await save()
    })
  report.ownedProcessesRemaining = processes()
  await save()
}
