import { leaveCompanionPage, menuAction } from '../helpers/ui'
// Opt-in real Main/model acceptance. No worker, decoder, coordinator, or IPC replacement.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

import { closeOwnedElectron } from './electron-lifecycle'

const options: Record<string, string> = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i]!,
    value = process.argv[i + 1]
  assert(['--app-root', '--output'].includes(name) && value && !options[name])
  options[name] = value
}
assert(options['--app-root'], 'Use --app-root frozen-preview/app [--output new-directory]')
const appRoot = resolve(options['--app-root']),
  directory = resolve(
    options['--output'] ??
      `cache/optimization/offline-local-dev1-${new Date().toISOString().replaceAll(':', '-')}`,
  )
await mkdir(directory, { recursive: true })
await copyFile(resolve('tests/model/offline-local.ts'), join(directory, 'runner-started.ts'))
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex'),
  hash = async (path: string) => sha(await readFile(path))
const buildFile = resolve(appRoot, '../manifest.json'),
  build = JSON.parse(await readFile(buildFile, 'utf8'))
assert.equal(build.status, 'built')
assert.equal(build.appRoot, appRoot)
for (const [path, value] of Object.entries(build.outputHashes))
  assert.equal(await hash(join(appRoot, 'out', path)), value)
for (const [path, value] of Object.entries(build.pythonHashes))
  assert.equal(await hash(join(appRoot, 'python', path)), value)
const sourceManifest = resolve(
    'cache/asr-evaluation/public-reference/aishell4-continuous/manifest.json',
  ),
  source = JSON.parse(await readFile(sourceManifest, 'utf8'))
const sample = source.samples.find((value: { id: string }) => value.id === 'continuous-solo-first')
assert.equal(source.referenceKind, 'human-continuous')
assert.equal(sample.durationMs, 97177)
assert.equal(await hash(sample.path), sample.audioHash)
const componentFile = resolve('release/asr-component-0.7.1-cpu.1-win-x64/component.json'),
  componentRoot = resolve(componentFile, '..')
const userData = await mkdtemp(join(tmpdir(), '听读 离线真实本地 ')),
  paths = createDataPaths(userData),
  audioDirectory = join(userData, 'owned-audio')
assert(
  /^[cC]:/.test(userData),
  'Keep acceptance files on C, not the space-constrained component volume.',
)
await mkdir(audioDirectory)
const config = new AsrComponent(
  join(userData, 'asr-component.json'),
  join(appRoot, 'python/asr_worker.py'),
)
await config.configure(componentFile)
const runtime = config.runtime('paraformer', 'cpu'),
  inputPaths = [
    join(audioDirectory, '01-full-97s.wav'),
    join(audioDirectory, '02-middle-30s.wav'),
    join(audioDirectory, '03-later-30s.wav'),
  ]
await copyFile(sample.path, inputPaths[0]!)
const cuts = []
for (const [index, start] of [30, 60].entries()) {
  const argv = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-i',
    sample.path,
    '-ss',
    String(start),
    '-t',
    '30',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    '-threads',
    '1',
    inputPaths[index + 1]!,
  ]
  execFileSync(runtime.ffmpeg!, argv, { windowsHide: true, timeout: 30000 })
  cuts.push({ executable: runtime.ffmpeg, argv, sourceOffsetMs: start * 1000, durationMs: 30000 })
}
const store = new LibraryStore(paths.database)
store.importBook(await scanBook(audioDirectory, 'folder'))
const book = store.listBooks()[0]!,
  episodes = book.episodes
assert.equal(episodes.length, 3)
const savedSettings = {
  mode: 'manual',
  engine: 'whisperx',
  device: 'cpu',
  prepareNext: false,
} as const
store.setSubtitlePreparation(book.id, savedSettings)
store.setProcessingPolicy({
  revision: store.processingResources().revision,
  policy: { cpuThreads: 1, lowPriority: true, backgroundIdleOnly: false },
})
store.saveProgress({
  sessionId: '',
  episodeId: episodes[2]!.id,
  positionMs: 3210,
  durationMs: 30000,
  rate: 1.25,
  volume: 0,
})
const initialPlayer = store.getPlayerState(),
  initialPosition = store.getEpisode(episodes[2]!.id)!.positionMs
store.close()
const protectedPaths = [
  componentFile,
  join(componentRoot, 'models.json'),
  join(componentRoot, 'bundle-manifest.json'),
  sourceManifest,
  sample.path,
  ...inputPaths,
]
const protectedBefore = Object.fromEntries(
  await Promise.all(protectedPaths.map(async (path) => [path, await hash(path)])),
)
const report: Record<string, unknown> = {
  status: 'running',
  startedAt: new Date().toISOString(),
  appRoot,
  previewVersion: build.previewVersion,
  directory,
  userData,
  runnerSha256: await hash(join(directory, 'runner-started.ts')),
  buildManifestSha256: await hash(buildFile),
  reference: {
    manifest: sourceManifest,
    manifestSha256: await hash(sourceManifest),
    sampleId: sample.id,
    path: sample.path,
    audioHash: sample.audioHash,
    durationMs: sample.durationMs,
    sourceOffsetMs: sample.sourceOffsetMs,
    speaker: sample.speaker,
  },
  cuts,
  inputs: await Promise.all(
    inputPaths.map(async (path, index) => ({
      path,
      audioHash: await hash(path),
      episodeId: episodes[index]!.id,
    })),
  ),
  component: {
    path: componentFile,
    configSha256: await hash(join(userData, 'asr-component.json')),
    manifestSha256: protectedBefore[join(componentRoot, 'bundle-manifest.json')],
  },
  initialPlayer,
  initialPosition,
  savedSettings,
  stages: [],
  cleanups: [],
  scope:
    'Real frozen Main, IPC/UI, Chromium metadata, Paraformer CPU1 and fixed offline tools. Three local episodes, zero online budget, partial checkpoint pause/restart/resume, formal full coverage. Existing public human-reference audio reused only as a process sample; no new audiobook quality or human timing acceptance claim.',
}
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
const stage = async (name: string, extra: Record<string, unknown> = {}) => {
  ;(report.stages as unknown[]).push({ name, at: new Date().toISOString(), ...extra })
  await save()
  console.log(JSON.stringify({ stage: name, ...extra }))
}
await save()
const env = {
  ...process.env,
  RALB_USER_DATA: userData,
  PYTHONNOUSERSITE: '1',
  PYTHONDONTWRITEBYTECODE: '1',
  HF_HUB_OFFLINE: '1',
  TRANSFORMERS_OFFLINE: '1',
}
for (const name of [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_RENDERER_URL',
  'RALB_EXECUTABLE',
  'PYTHONHOME',
  'PYTHONPATH',
])
  Reflect.deleteProperty(env, name)
const rendererErrors: string[] = [],
  workerPids = new Set<number>()
let app: ElectronApplication | undefined,
  page: Page,
  planId = ''
const launch = async () => {
  const instance = await electron.launch({ args: [appRoot], env })
  instance
    .process()
    .stdout?.on('data', (bytes) => appendFileSync(join(directory, 'main-stdout.log'), bytes))
  instance
    .process()
    .stderr?.on('data', (bytes) => appendFileSync(join(directory, 'main-stderr.log'), bytes))
  page = await instance.firstWindow()
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  await expect(page.getByRole('button', { name: '应用设置', exact: true })).toBeVisible({
    timeout: 30000,
  })
  return instance
}
const state = async () =>
  page.evaluate(async () => {
    const result = await window.desktop.getState()
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  })
const snap = async () =>
  page.evaluate(
    async (input) => {
      const [detail, resources, library, ...states] = await Promise.all([
        window.desktop.getOfflinePreparation({ id: input.planId, itemPage: 0 }),
        window.desktop.getProcessingResources(),
        window.desktop.getState(),
        ...input.episodes.map((episode) =>
          window.desktop.getTranscriptionState({
            episodeId: episode.id,
            audioHash: episode.contentHash,
          }),
        ),
      ])
      if (!detail.ok || !resources.ok || !library.ok)
        throw new Error('Offline/resource/library IPC failed')
      const transcripts = states.map((result) => {
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      })
      const audio = document.querySelector<HTMLAudioElement>('audio[data-player="persistent"]')
      return {
        detail: detail.value,
        resources: resources.value,
        library: library.value,
        transcripts,
        media: audio
          ? {
              paused: audio.paused,
              positionMs: audio.currentTime * 1000,
              rate: audio.playbackRate,
              volume: audio.volume,
              source: audio.currentSrc,
            }
          : null,
      }
    },
    { planId, episodes },
  )
type Snapshot = Awaited<ReturnType<typeof snap>>
const observed = (label: string, value: Snapshot) => {
  if (value.resources.worker) {
    workerPids.add(value.resources.worker.pid)
    if (value.resources.worker.cpuThreads !== null)
      assert.equal(value.resources.worker.cpuThreads, 1)
    assert.equal(value.resources.worker.priority, 'low')
  }
  appendFileSync(
    join(directory, 'observations.jsonl'),
    JSON.stringify({
      label,
      at: new Date().toISOString(),
      plan: value.detail.plan,
      items: value.detail.items.items,
      resources: value.resources,
      jobs: value.transcripts.map((t) => t.job),
      media: value.media,
    }) + '\n',
  )
}
const until = async (label: string, predicate: (value: Snapshot) => boolean, timeout = 240000) => {
  const deadline = Date.now() + timeout
  do {
    const value = await snap()
    observed(label, value)
    if (
      value.detail.plan.status === 'blocked' ||
      value.detail.plan.status === 'completed-with-issues'
    )
      throw new Error(
        `${label}: plan ${value.detail.plan.status}: ${value.detail.plan.error}; ${value.detail.items.items
          .map((i) => i.error)
          .filter(Boolean)
          .join('; ')}`,
      )
    if (value.transcripts.some((t) => t.job?.status === 'failed'))
      throw new Error(
        `${label}: ${value.transcripts.find((t) => t.job?.status === 'failed')!.job!.error}`,
      )
    if (predicate(value)) return value
    await delay(250)
  } while (Date.now() < deadline)
  throw new Error(`Timed out: ${label}`)
}
const checkpoints = async () => {
  const files: Record<string, string> = {}
  const visit = async (path: string, prefix = '') => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const rel = join(prefix, entry.name),
        full = join(path, entry.name)
      if (entry.isDirectory()) await visit(full, rel)
      else if (/^(manifest|chunk-\d+)\.json$/.test(entry.name)) files[rel] = await hash(full)
    }
  }
  await visit(join(runtime.cache, 'jobs'))
  return files
}
const processes = (pids: readonly number[]) => {
  if (!pids.length) return []
  const script = `$ids=@(${pids.join(',')}); ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object { $ids -contains [int]$_.ProcessId } | ForEach-Object { [pscustomobject]@{id=[int]$_.ProcessId;parentId=[int]$_.ParentProcessId;name=$_.Name;created=[string]$_.CreationDate} }) -Compress`
  return JSON.parse(
    execFileSync(
      join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      ['-NoProfile', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 },
    ),
  ) as { id: number; parentId: number; name: string; created: string }[]
}
const close = async () => {
  assert(app)
  const result = await closeOwnedElectron(app, 20000)
  ;(report.cleanups as unknown[]).push(result)
  app = undefined
  await save()
  assert.equal(result.kind, 'graceful')
}
try {
  app = await launch()
  const before = await state()
  assert.deepEqual(before.books.find((b) => b.id === book.id)!.subtitlePreparation, savedSettings)
  await leaveCompanionPage(page!)
  await menuAction(page!, '应用设置', '离线准备计划')
  let dialog = page!.getByRole('dialog', { name: '离线准备计划', exact: true })
  await dialog.getByRole('tab', { name: '新建计划', exact: true }).click()
  await dialog.getByRole('combobox', { name: '离线准备书籍', exact: true }).selectOption(book.id)
  await dialog
    .getByRole('combobox', { name: '离线计划引擎', exact: true })
    .selectOption('paraformer')
  await dialog.getByRole('combobox', { name: '离线计划设备', exact: true }).selectOption('cpu')
  await dialog.getByRole('spinbutton', { name: '离线音频预算 GiB', exact: true }).fill('0')
  await dialog.getByRole('button', { name: '预览离线准备', exact: true }).click()
  await expect(dialog.getByRole('region', { name: '离线准备预览', exact: true })).toContainText(
    '预览 3 集',
  )
  await page!.screenshot({ path: join(directory, '01-preview.png'), fullPage: true })
  await dialog.getByRole('button', { name: '确认创建离线计划', exact: true }).click()
  const list = await page!.evaluate(async () => {
    const result = await window.desktop.listOfflinePreparations({ page: 0, activeOnly: false })
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  })
  assert.equal(list.total, 1)
  planId = list.plans[0]!.id
  assert.equal(list.plans[0]!.audioBudgetBytes, 0)
  await stage('created-through-real-ui', { planId })
  const partial = await until(
    'first-real-checkpoint',
    (s) =>
      s.transcripts[0]!.job?.status === 'running' &&
      s.transcripts[0]!.job.completedChunks > 0 &&
      s.transcripts[0]!.job.completedChunks < s.transcripts[0]!.job.totalChunks,
  )
  const firstJob = partial.transcripts[0]!.job!
  assert.equal(firstJob.cpuThreads, 1)
  assert(partial.transcripts[0]!.transcript.status === 'ready')
  report.partial = partial
  await writeFile(join(directory, 'partial.json'), JSON.stringify(partial, null, 2))
  await page!.screenshot({ path: join(directory, '02-partial.png'), fullPage: true })
  await dialog.getByRole('button', { name: '暂停计划', exact: true }).click()
  const paused = await until(
    'plan-paused',
    (s) => s.detail.plan.status === 'paused' && s.transcripts[0]!.job?.status === 'queued',
    30000,
  )
  assert.equal(paused.transcripts[0]!.job!.id, firstJob.id)
  assert(paused.transcripts[0]!.job!.attempt > firstJob.attempt)
  const checkpointBefore = await checkpoints()
  assert(Object.keys(checkpointBefore).some((path) => /chunk-\d+\.json$/.test(path)))
  report.paused = {
    snapshot: paused,
    checkpointHashes: checkpointBefore,
    workerProcesses: processes([...workerPids]),
  }
  await page!.screenshot({ path: join(directory, '03-paused.png'), fullPage: true })
  await stage('partial-plan-paused-before-close', {
    jobId: firstJob.id,
    completedChunks: paused.transcripts[0]!.job!.completedChunks,
  })
  await close()
  assert.deepEqual(processes([...workerPids]), [])
  app = await launch()
  await delay(3500)
  const restarted = await snap()
  observed('restart-remains-paused', restarted)
  assert.equal(restarted.detail.plan.status, 'paused')
  assert.equal(restarted.detail.plan.revision, paused.detail.plan.revision)
  assert.equal(restarted.transcripts[0]!.job!.id, firstJob.id)
  assert.equal(
    restarted.transcripts[0]!.job!.completedChunks,
    paused.transcripts[0]!.job!.completedChunks,
  )
  assert.deepEqual(await checkpoints(), checkpointBefore)
  assert.equal(restarted.resources.worker, null)
  report.restarted = restarted
  await stage('restart-preserved-paused-intent-and-checkpoint', { jobId: firstJob.id })
  await leaveCompanionPage(page!)
  await menuAction(page!, '应用设置', '离线准备计划')
  dialog = page!.getByRole('dialog', { name: '离线准备计划', exact: true })
  await dialog
    .locator(`[data-offline-plan-id="${planId}"]`)
    .getByRole('button', { name: '查看详情', exact: true })
    .click()
  await dialog.getByRole('button', { name: '恢复计划', exact: true }).click()
  const completed = await until(
    'all-three-real-episodes-completed',
    (s) => s.detail.plan.status === 'completed',
    420000,
  )
  await writeFile(join(directory, 'completed-observed.json'), JSON.stringify(completed, null, 2))
  report.completedObserved = completed
  assert.equal(completed.detail.plan.counts.audioReady, 3)
  assert.equal(completed.detail.plan.counts.subtitleReady, 3)
  for (const [index, value] of completed.transcripts.entries()) {
    assert(value.job)
    assert.equal(value.job.status, 'completed')
    assert.equal(value.job.cpuThreads, 1)
    assert.equal(value.job.engine, 'paraformer')
    assert.equal(value.job.device, 'cpu')
    assert.equal(value.transcript.status, 'ready')
    if (value.transcript.status !== 'ready') throw new Error('Formal transcript missing')
    const episode = completed.library.books
      .find((b) => b.id === book.id)!
      .episodes.find((e) => e.id === episodes[index]!.id)!
    const coverage = createSubtitleStatusSnapshot({
      episodeId: episode.id,
      audioHash: episode.contentHash,
      positionMs: 0,
      durationMs: episode.durationMs,
      savedStatus: 'ready',
      coverage: value.transcript.transcript.document.coverage,
      job: value.job,
    }).savedCoverage
    assert.equal(coverage.complete, true)
    assert(
      episode.durationMs !== null &&
        Math.abs(episode.durationMs - (index === 0 ? 97177 : 30000)) < 3,
    )
  }
  assert.equal(completed.transcripts[0]!.job!.id, firstJob.id)
  assert(completed.transcripts[0]!.job!.cacheHits >= 1)
  const finalBook = completed.library.books.find((b) => b.id === book.id)!
  assert.deepEqual(finalBook.subtitlePreparation, savedSettings)
  assert.equal(completed.library.currentEpisodeId, initialPlayer.currentEpisodeId)
  assert.deepEqual(completed.library.preferences, initialPlayer.preferences)
  assert(
    Math.abs(
      finalBook.episodes.find((e) => e.id === episodes[2]!.id)!.positionMs - initialPosition,
    ) < 250,
  )
  assert.equal(completed.media?.paused, true)
  assert.deepEqual(rendererErrors, [])
  await page!.screenshot({ path: join(directory, '04-completed.png'), fullPage: true })
  await writeFile(join(directory, 'completed.json'), JSON.stringify(completed, null, 2))
  report.completed = { snapshot: completed, checkpointHashes: await checkpoints() }
  report.rendererErrors = rendererErrors
  for (const [path, value] of Object.entries(protectedBefore)) assert.equal(await hash(path), value)
  await close()
  assert.deepEqual(processes([...workerPids]), [])
  report.closedWorkers = [...workerPids]
  report.status = 'passed'
  report.finishedAt = new Date().toISOString()
  await stage('passed')
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
  report.finishedAt = new Date().toISOString()
  if (page!)
    await page
      .screenshot({ path: join(directory, 'failure.png'), fullPage: true })
      .catch(() => undefined)
  await save()
  throw error
} finally {
  if (app)
    await close().catch(async (error) => {
      report.cleanupError = String(error)
      await save()
    })
  await save()
}
