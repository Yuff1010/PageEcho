import { leaveCompanionPage, menuAction } from '../helpers/ui'
// Opt-in real CPU model integration. Only this launch's reported worker PID and
// descendants are observed; unrelated user workers are never changed or stopped.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { constants, getPriority } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { AsrComponent } from '../../src/main/asr-component'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import { createSubtitleStatusSnapshot } from '../../src/shared/subtitle-status'
import type { TranscriptRequest } from '../../src/shared/transcript'

import { closeOwnedElectron } from './electron-lifecycle'

const options: Record<string, string> = {}
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index],
    value = process.argv[index + 1]
  assert.ok(name && ['--app-root', '--component', '--output'].includes(name) && value)
  assert.equal(options[name], undefined)
  options[name] = value
}
assert.ok(options['--app-root'], 'Pass the frozen preview with --app-root.')
const appRoot = resolve(options['--app-root']),
  componentPath = resolve(
    options['--component'] ?? 'release/asr-component-0.7.0-win-x64/component.json',
  ),
  directory = resolve(
    options['--output'] ??
      join(
        'cache/optimization/processing-resources-main-runs',
        new Date().toISOString().replaceAll(':', '-'),
      ),
  )
await mkdir(directory, { recursive: true })
await copyFile(resolve('tests/model/processing-resources.ts'), join(directory, 'runner-started.ts'))
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex'),
  hash = async (path: string) => digest(await readFile(path))
const manifestPath = resolve(
    'cache/asr-evaluation/public-reference/aishell4-continuous/manifest.json',
  ),
  manifest = JSON.parse(await readFile(manifestPath, 'utf8')),
  sample = manifest.samples.find((value: { id: string }) => value.id === 'continuous-solo-first')
assert.equal(manifest.referenceKind, 'human-continuous')
assert.ok(sample && sample.durationMs > 90000 && sample.durationMs < 120000)
assert.equal(await hash(sample.path), sample.audioHash)
const buildManifestPath = resolve(appRoot, '../manifest.json'),
  build = JSON.parse(await readFile(buildManifestPath, 'utf8'))
assert.equal(build.status, 'built')
for (const [path, value] of Object.entries(build.outputHashes))
  assert.equal(await hash(join(appRoot, 'out', path)), value)
for (const [path, value] of Object.entries(build.pythonHashes))
  assert.equal(await hash(join(appRoot, 'python', path)), value)
const paths = createDataPaths(join(directory, 'user-data')),
  component = new AsrComponent(
    join(paths.root, 'asr-component.json'),
    join(appRoot, 'python/asr_worker.py'),
  )
await component.configure(componentPath)
const runtime = component.runtime('paraformer', 'cpu')
const store = new LibraryStore(paths.database)
store.importBook(await scanBook(sample.path, 'file'))
const episode = store.listBooks()[0]!.episodes[0]!,
  target: TranscriptRequest = { episodeId: episode.id, audioHash: episode.contentHash }
store.recordSourceDuration(episode.id, episode.contentHash, sample.durationMs)
store.setProcessingPolicy({
  revision: store.processingResources().revision,
  policy: { cpuThreads: 1, lowPriority: true, backgroundIdleOnly: false },
})
store.saveProgress({
  sessionId: '',
  episodeId: episode.id,
  positionMs: 0,
  durationMs: sample.durationMs,
  rate: 1,
  volume: 0,
})
store.close()
const protectedPaths = [
    componentPath,
    runtime.models,
    buildManifestPath,
    manifestPath,
    sample.path,
  ],
  protectedBefore = Object.fromEntries(
    await Promise.all(protectedPaths.map(async (path) => [path, await hash(path)])),
  )
const report: Record<string, unknown> = {
  status: 'running',
  startedAt: new Date().toISOString(),
  directory,
  appRoot,
  previewVersion: build.previewVersion,
  userData: paths.root,
  target,
  engine: 'paraformer',
  device: 'cpu',
  requestedCpuThreads: 1,
  buildManifestPath,
  buildManifestSha256: await hash(buildManifestPath),
  runnerSha256: await hash(join(directory, 'runner-started.ts')),
  protectedBefore,
  reference: {
    manifestPath,
    manifestSha256: await hash(manifestPath),
    sample,
    source: manifest.source,
    referenceKind: manifest.referenceKind,
    qualityScope: manifest.qualityScope,
  },
  runtime: { ...runtime, cacheIsolated: true },
  stages: [],
  cleanups: [],
  scope:
    'Real pinned Paraformer CPU with requested/reported Torch threads 1, OS priority read-back, one saved chunk then pause/release, durable paused restart, same-job/attempt resume with real checkpoint hits and completion, muted HTMLAudioElement clock during processing pause. Existing 97-second human-reference input only; no new recognition-quality, human timing, CPU-percent, memory-limit or performance benchmark claim. Other user processes and OS caches are not isolated and are never modified.',
}
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
async function stage(name: string, extra: Record<string, unknown> = {}) {
  ;(report.stages as unknown[]).push({ name, at: new Date().toISOString(), ...extra })
  await save()
  console.log(JSON.stringify({ stage: name, ...extra }))
}
const env = { ...process.env, RALB_USER_DATA: paths.root }
for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'RALB_EXECUTABLE'])
  Reflect.deleteProperty(env, name)
const launch = () => electron.launch({ args: [appRoot], env })
async function snapshot(page: Page) {
  return page.evaluate(async (input) => {
    const [state, resources] = await Promise.all([
      window.desktop.getTranscriptionState(input),
      window.desktop.getProcessingResources(),
    ])
    if (!state.ok) throw new Error(state.error.message)
    if (!resources.ok) throw new Error(resources.error.message)
    const audio = document.querySelector<HTMLAudioElement>('audio[data-player="persistent"]')!
    return {
      state: state.value,
      resources: resources.value,
      media: {
        positionMs: audio.currentTime * 1000,
        paused: audio.paused,
        ended: audio.ended,
        rate: audio.playbackRate,
        volume: audio.volume,
      },
    }
  }, target)
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>
async function until(
  page: Page,
  label: string,
  predicate: (value: Snapshot) => boolean,
  timeoutMs = 180000,
) {
  const deadline = Date.now() + timeoutMs
  do {
    const value = await snapshot(page)
    appendFileSync(
      join(directory, 'samples.jsonl'),
      JSON.stringify({
        label,
        at: new Date().toISOString(),
        media: value.media,
        resources: value.resources,
        job: value.state.job,
      }) + '\n',
    )
    if (value.state.job && ['failed', 'canceled'].includes(value.state.job.status))
      throw new Error(`${label}: ${value.state.job.status}: ${value.state.job.error}`)
    if (
      value.resources.worker?.cpuThreads !== null &&
      value.resources.worker?.cpuThreads !== undefined
    )
      assert.equal(value.resources.worker.cpuThreads, 1)
    if (predicate(value)) return value
    await delay(250)
  } while (Date.now() < deadline)
  throw new Error(`Timed out: ${label}`)
}
async function pause(page: Page, paused: boolean) {
  const current = await snapshot(page),
    result = await page.evaluate((input) => window.desktop.setProcessingPaused(input), {
      revision: current.resources.revision,
      paused,
    })
  assert.ok(result.ok)
  return result.value
}
interface ProcessInfo {
  id: number
  parentId: number
  name: string
  created: string
}
function ownedTree(pid: number): ProcessInfo[] {
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  assert.equal(process.platform, 'win32', 'This smoke verifies the Windows-owned process tree.')
  const script = `$rows=@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{id=[int]$_.ProcessId;parentId=[int]$_.ParentProcessId;name=$_.Name;created=[string]$_.CreationDate} }); $ids=[Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${pid}); do { $added=$false; foreach($row in $rows) { if($ids.Contains($row.parentId) -and $ids.Add($row.id)) { $added=$true } } } while($added); ConvertTo-Json -InputObject @($rows | Where-Object { $ids.Contains($_.id) }) -Compress`
  return JSON.parse(
    execFileSync(
      join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      ['-NoProfile', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 },
    ),
  ) as ProcessInfo[]
}
async function checkpoints() {
  const root = join(runtime.cache, 'jobs'),
    files: Record<string, string> = {}
  async function visit(path: string, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relative = join(prefix, entry.name),
        absolute = join(path, entry.name)
      if (entry.isDirectory()) await visit(absolute, relative)
      else if (/^(manifest|chunk-\d+)\.json$/u.test(entry.name))
        files[relative] = await hash(absolute)
    }
  }
  await visit(root)
  return files
}
let app: ElectronApplication | undefined
try {
  await stage('starting', { report: join(directory, 'report.json') })
  app = await launch()
  let page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.context().setOffline(true)
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
  const startTime = performance.now(),
    started = await page.evaluate((input) => window.desktop.startTranscription(input), {
      ...target,
      engine: 'paraformer' as const,
      device: 'cpu' as const,
    })
  assert.ok(started.ok && started.value.job)
  const jobId = started.value.job.id
  assert.equal(started.value.job.cpuThreads, 1)
  await stage('job-started', { jobId, cpuThreads: started.value.job.cpuThreads })
  const first = await until(
    page,
    'first-real-chunk',
    (value) =>
      !!value.state.job &&
      value.state.job.completedChunks >= 1 &&
      value.state.job.status === 'running',
  )
  assert.equal(first.resources.worker?.cpuThreads, 1)
  assert.equal(first.resources.worker.priority, 'low')
  const workerPid = first.resources.worker.pid,
    treeBeforePause = ownedTree(workerPid)
  assert.equal(getPriority(workerPid), constants.priority.PRIORITY_BELOW_NORMAL)
  await writeFile(join(directory, 'first-chunk.json'), JSON.stringify(first, null, 2))
  report.firstChunkWallMs = performance.now() - startTime
  report.ownedWorkerTreeBeforePause = treeBeforePause
  await page.getByRole('button', { name: '播放', exact: true }).click()
  const mediaBeforePause = (await snapshot(page)).media
  assert.equal(mediaBeforePause.paused, false)
  assert.equal(mediaBeforePause.volume, 0)
  await pause(page, true)
  const paused = await until(
    page,
    'paused-worker-released',
    (value) =>
      value.resources.paused &&
      value.resources.worker === null &&
      value.state.job?.id === jobId &&
      value.state.job.status === 'queued' &&
      value.state.job.attempt === first.state.job!.attempt + 1,
    15000,
  )
  const exitDeadline = Date.now() + 10000
  let remaining = ownedTree(workerPid)
  while (remaining.length && Date.now() < exitDeadline) {
    await delay(200)
    remaining = ownedTree(workerPid)
  }
  assert.deepEqual(
    remaining,
    [],
    'This launch owned worker or its descendants survived processing pause.',
  )
  const frozenTranscript = paused.state.transcript,
    checkpointHashes = await checkpoints()
  assert.ok(Object.keys(checkpointHashes).some((path) => /chunk-\d+\.json$/u.test(path)))
  report.paused = {
    snapshot: paused,
    ownedWorkerTreeAfterPause: remaining,
    checkpointHashes,
    transcriptSha256: digest(JSON.stringify(frozenTranscript)),
  }
  await writeFile(join(directory, 'paused-prefix.json'), JSON.stringify(paused, null, 2))
  const advancing = await until(
    page,
    'media-keeps-playing-while-processing-paused',
    (value) => !value.media.paused && value.media.positionMs > mediaBeforePause.positionMs + 250,
    5000,
  )
  report.pausePlayback = { before: mediaBeforePause, after: advancing.media }
  assert.deepEqual(advancing.state.transcript, frozenTranscript)
  await leaveCompanionPage(page)
  await menuAction(page, '应用设置', '缓存与任务')
  const dialog = page.getByRole('dialog', { name: '缓存与任务', exact: true })
  await dialog.getByRole('tab', { name: /^转写任务/ }).click()
  await page.screenshot({
    path: join(directory, 'processing-paused-audio-playing.png'),
    animations: 'disabled',
  })
  await dialog.getByRole('button', { name: '关闭缓存与任务', exact: true }).click()
  await stage('paused-owned-worker-exited-media-continues', {
    workerPid,
    attempt: paused.state.job!.attempt,
    completedChunks: paused.state.job!.completedChunks,
    firstChunkWallMs: report.firstChunkWallMs,
  })
  ;(report.cleanups as unknown[]).push(await closeOwnedElectron(app))
  app = undefined
  app = await launch()
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.context().setOffline(true)
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
  const restartSamples: unknown[] = []
  for (let i = 0; i < 5; i++) {
    const value = await snapshot(page)
    assert.equal(value.resources.paused, true)
    assert.equal(value.resources.worker, null)
    assert.equal(value.state.job?.status, 'queued')
    assert.equal(value.state.job.id, jobId)
    assert.equal(value.state.job.attempt, paused.state.job!.attempt)
    assert.equal(value.state.job.cpuThreads, 1)
    assert.deepEqual(value.state.transcript, frozenTranscript)
    restartSamples.push({
      at: new Date().toISOString(),
      resources: value.resources,
      job: value.state.job,
    })
    await delay(250)
  }
  assert.deepEqual(await checkpoints(), checkpointHashes)
  report.pausedRestartSamples = restartSamples
  await stage('restart-remains-paused-prefix-and-cache-unchanged')
  await page.getByRole('button', { name: '播放', exact: true }).click()
  const resumeTime = performance.now()
  await pause(page, false)
  const replay = await until(
    page,
    'resumed-real-cache-prefix',
    (value) =>
      value.state.job?.id === jobId &&
      value.state.job.attempt === paused.state.job!.attempt &&
      value.state.job.cacheHits >= 1,
  )
  assert.equal(replay.state.job!.cpuThreads, 1)
  assert.ok(replay.resources.worker)
  assert.notEqual(replay.resources.worker.pid, workerPid)
  await writeFile(join(directory, 'resumed-cache-prefix.json'), JSON.stringify(replay, null, 2))
  report.resumedWorkerPid = replay.resources.worker.pid
  await stage('same-job-resumed-with-real-checkpoint-hit', {
    jobId,
    attempt: replay.state.job!.attempt,
    cacheHits: replay.state.job!.cacheHits,
    workerPid: replay.resources.worker.pid,
    reportedCpuThreads: replay.resources.worker.cpuThreads,
  })
  // Checkpoint replay precedes lazy model loading. A truthful null here is not
  // a thread-policy failure; require the live model's subsequent actual report.
  const resumedModel = await until(
    page,
    'resumed-model-reports-one-thread',
    (value) => value.resources.worker?.cpuThreads === 1,
  )
  assert.equal(resumedModel.resources.worker!.pid, replay.resources.worker.pid)
  assert.equal(resumedModel.resources.worker!.cpuThreads, 1)
  report.resumedModelRuntime = resumedModel.resources.worker
  await stage('resumed-live-model-reported-one-thread', {
    workerPid: resumedModel.resources.worker!.pid,
    cpuThreads: resumedModel.resources.worker!.cpuThreads,
  })
  const completed = await until(
    page,
    'resumed-job-completed',
    (value) => value.state.job?.status === 'completed',
  )
  assert.equal(completed.state.job!.id, jobId)
  assert.equal(completed.state.job!.attempt, paused.state.job!.attempt)
  assert.equal(completed.state.job!.cpuThreads, 1)
  assert.ok(completed.state.job!.cacheHits >= 1)
  assert.equal(completed.state.transcript.status, 'ready')
  if (completed.state.transcript.status !== 'ready') throw new Error('Completed transcript missing')
  const status = createSubtitleStatusSnapshot({
    ...target,
    positionMs: 0,
    durationMs: sample.durationMs,
    savedStatus: 'ready',
    coverage: completed.state.transcript.transcript.document.coverage,
    job: null,
  })
  assert.equal(status.savedCoverage.complete, true)
  await writeFile(join(directory, 'completed.json'), JSON.stringify(completed, null, 2))
  report.completed = {
    job: completed.state.job,
    resources: completed.resources,
    media: completed.media,
    transcriptSha256: digest(JSON.stringify(completed.state.transcript)),
    coverage: status.savedCoverage,
    resumeWallMs: performance.now() - resumeTime,
  }
  report.rendererErrors = errors
  assert.deepEqual(errors, [])
  for (const [path, value] of Object.entries(protectedBefore)) assert.equal(await hash(path), value)
  ;(report.cleanups as unknown[]).push(await closeOwnedElectron(app))
  app = undefined
  assert.ok((report.cleanups as { kind: string }[]).every((value) => value.kind === 'graceful'))
  assert.deepEqual(ownedTree(replay.resources.worker.pid), [])
  report.status = 'passed'
  report.finishedAt = new Date().toISOString()
  await stage('passed')
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
  report.finishedAt = new Date().toISOString()
  await save()
  throw error
} finally {
  if (app) {
    ;(report.cleanups as unknown[]).push(await closeOwnedElectron(app))
    await save()
  }
}
