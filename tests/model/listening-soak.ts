import {
  closeCompanionPanel,
  leaveCompanionPage,
  menuAction,
  openCompanionTools,
  setSubtitleProfile,
  setVolume,
  toggleCompanionGeneration,
} from '../helpers/ui'
// Opt-in real-source decoding and natural continuous-playback/ASR measurement.
// Private audio and all reports stay outside version control. No synthesized media clock.
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'
import { mkdir, mkdtemp, readFile, writeFile, copyFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import type { AppState, Episode } from '../../src/shared/contracts'
import type { TranscriptionJob } from '../../src/shared/transcription'
import { inspectListeningSources } from './listening-inventory'
import { analyzeListening, type ListeningSample } from './listening-analysis'

const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--component')
  throw new Error('用法：npm run asr:soak -- --component <便携 v2 component.json>')
const selected = resolve(args[1]!)
const component = JSON.parse(await readFile(selected, 'utf8')) as Record<string, string | number>
if (component.version !== 2) throw new Error('验收需要独立组件 v2。')
for (const key of ['python', 'models', 'resources', 'ffmpeg', 'ffprobe'])
  component[key] = resolve(dirname(selected), String(component[key]))
const manifest = JSON.parse(
  await readFile(resolve('cache/asr-evaluation/samples.json'), 'utf8'),
) as {
  sourceDirectory: string
  samples: { id: string; sourcePath: string; durationMs: number }[]
}
if (manifest.samples.length < 3) throw new Error('自然连播验收需要准备至少三个源音频。')
const inventory = await inspectListeningSources(manifest.sourceDirectory, String(component.ffprobe))
const directory = resolve(
  'cache/asr-evaluation/listening-runs',
  new Date().toISOString().replaceAll(':', '-'),
)
await mkdir(directory, { recursive: true })
await writeFile(join(directory, 'inventory.json'), JSON.stringify(inventory, null, 2))
const root = await mkdtemp(join(tmpdir(), '听读 实时连续验收 ')),
  matrixFolder = join(root, '编码兼容'),
  playlistFolder = join(root, '连续收听')
await mkdir(matrixFolder)
await mkdir(playlistFolder)
const names = inventory.tracks.map((track) => track.name)
const matrixPath = (index: number) =>
  join(matrixFolder, `第${String(index + 1).padStart(2, '0')}集${extname(names[index]!)}`)
const originals = await Promise.all(
  names.map(async (name) => ({
    path: join(manifest.sourceDirectory, name),
    info: await stat(join(manifest.sourceDirectory, name)),
  })),
)
for (const [index, source] of originals.entries()) await copyFile(source.path, matrixPath(index))
for (const [index, source] of manifest.samples.slice(0, 3).entries())
  await copyFile(
    source.sourcePath,
    join(playlistFolder, `第${String(index + 1).padStart(2, '0')}集${extname(source.sourcePath)}`),
  )
const settings = join(directory, 'component.json')
await writeFile(settings, JSON.stringify(component, null, 2))
const env: Record<string, string> = {}
for (const [key, value] of Object.entries(process.env))
  if (
    value !== undefined &&
    !['electron_run_as_node', 'ralb_executable', 'pythonhome', 'pythonpath', 'path'].includes(
      key.toLowerCase(),
    )
  )
    env[key] = value
env.RALB_USER_DATA = root
env.PATH = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32;${process.env.SystemRoot ?? 'C:\\Windows'}`
const report: {
  status: string
  startedAt: string
  userData: string
  codecChecks: unknown[]
  jobs: Record<string, unknown>[]
  transitions: unknown[]
  clockSummary?: unknown
  responsiveness?: unknown
  resources?: unknown
  applicationPid?: number
  nativeWindowEvents: { operation: string; wallMs: number; visible: boolean }[]
  error?: string
  checks: string[]
} = {
  status: 'running',
  startedAt: new Date().toISOString(),
  userData: root,
  codecChecks: [],
  jobs: [],
  transitions: [],
  checks: [],
  nativeWindowEvents: [],
}
const saveReport = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2))
async function stage(message: string) {
  report.checks.push(message)
  await saveReport()
  console.log(message)
}
async function hash(path: string) {
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(path)) digest.update(bytes)
  return digest.digest('hex')
}
let app: ElectronApplication | undefined, sampler: ChildProcess | undefined
let samplerDone: Promise<number | null> | undefined
const stopFile = join(directory, 'stop-sampler'),
  resourceFile = join(directory, 'resources.json')
try {
  app = await electron.launch({ args: [resolve('.')], env })
  let page = await app.firstWindow()
  await page.context().setOffline(true)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const choose = (path: string) =>
    app!.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, path)
  const state = async (): Promise<AppState> => {
    const result = await page.evaluate(() => window.desktop.getState())
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  const importFolder = async (folder: string) => {
    await leaveCompanionPage(page)
    await page.getByRole('button', { name: /我的书架/ }).click()
    await choose(folder)
    await menuAction(page, '更多导入方式', '导入文件夹')
    await page.getByRole('button', { name: '确认导入', exact: true }).click()
    await page.getByRole('button', { name: `打开 ${basename(folder)} 的目录`, exact: true }).click()
  }
  await importFolder(matrixFolder)
  const matrixBook = (await state()).books.find((book) => book.title === basename(matrixFolder))!
  await setVolume(page, '0.05')
  for (const [index, episode] of matrixBook.episodes.entries()) {
    await page
      .getByRole('button', { name: `播放第 ${index + 1} 集 ${episode.title}`, exact: true })
      .click()
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime), {
        timeout: 10000,
      })
      .toBeGreaterThan(0.2)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    const expected = inventory.tracks.find((track) => track.name === names[index])!
    const duration = await page
      .locator('audio')
      .evaluate((audio: HTMLAudioElement) => audio.duration * 1000)
    expect(Math.abs(duration - expected.durationMs)).toBeLessThan(100)
    await page.getByRole('combobox', { name: '播放倍速', exact: true }).selectOption('1.5')
    const middle = Math.floor(duration / 2)
    await page.getByRole('slider', { name: '播放进度', exact: true }).fill(String(middle))
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
      .toBeCloseTo(middle / 1000, 1)
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
      .toBeGreaterThan(middle / 1000 + 0.3)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    report.codecChecks.push({
      index: index + 1,
      audioHash: episode.contentHash,
      format: expected.format,
      codec: expected.stream.codec_name,
      durationMs: duration,
      rate: 1.5,
      seekMs: middle,
      status: 'passed',
    })
  }
  await stage(
    `All ${matrixBook.episodes.length} actual source files played, changed rate and sought by media time`,
  )
  await importFolder(playlistFolder)
  const book = (await state()).books.find((book) => book.title === basename(playlistFolder))!
  for (const [index, episode] of book.episodes.entries())
    expect(episode.contentHash).toBe(manifest.samples[index]!.id)
  await page
    .getByRole('button', { name: `播放第 1 集 ${book.episodes[0]!.title}`, exact: true })
    .click()
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('0')
  await page.getByRole('combobox', { name: '播放倍速', exact: true }).selectOption('1')
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  const reader = page.getByRole('region', { name: '同步伴读', exact: true })
  await toggleCompanionGeneration(reader)
  await choose(settings)
  await reader.getByRole('button', { name: '选择组件配置', exact: true }).click()
  await expect(reader.getByText('本地组件已配置', { exact: true })).toBeVisible()
  const pid = await app.evaluate(() => process.pid)
  report.applicationPid = pid
  sampler = spawn(
    String(component.python),
    [
      '-B',
      '-X',
      'utf8',
      resolve('python/measure_listening.py'),
      '--pid',
      String(pid),
      '--output',
      resourceFile,
      '--stop',
      stopFile,
      '--maximum-seconds',
      String(
        Math.ceil(
          (manifest.samples.slice(0, 3).reduce((sum, sample) => sum + sample.durationMs, 0) +
            120000) /
            1000,
        ),
      ),
    ],
    { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env },
  )
  samplerDone = new Promise((resolve, reject) => {
    sampler!.once('error', reject)
    sampler!.once('close', resolve)
  })
  void samplerDone.catch(() => undefined)
  let diagnostic = ''
  sampler.stderr?.on('data', (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString('utf8')).slice(-8192)
  })
  await page.evaluate(() => {
    const audio = document.querySelector('audio')!
    const events: Record<string, unknown>[] = []
    Reflect.set(window, 'RALB_SOAK_EVENTS', events)
    for (const name of [
      'waiting',
      'stalled',
      'error',
      'playing',
      'pause',
      'ended',
      'seeking',
      'seeked',
      'ratechange',
    ])
      audio.addEventListener(name, () =>
        events.push({
          type: name,
          wallMs: Date.now(),
          positionMs: audio.currentTime * 1000,
          source: audio.currentSrc,
        }),
      )
  })
  const targets = book.episodes.map((episode) => ({
    episodeId: episode.id,
    audioHash: episode.contentHash,
  }))
  const startJob = async (episode: Episode, device: 'cpu' | 'cuda') => {
    await openCompanionTools(reader)
    const options = reader.locator('.transcription-controls > details')
    if (!(await options.evaluate((element: HTMLDetailsElement) => element.open)))
      await toggleCompanionGeneration(reader)
    await setSubtitleProfile(page, { engine: 'whisperx', device: device })
    const started = Date.now()
    await openCompanionTools(reader)
    await reader.getByRole('button', { name: '生成转写稿', exact: true }).click()
    report.jobs.push({
      episodeId: episode.id,
      device,
      startedWallMs: started,
      durationMs: manifest.samples[book.episodes.indexOf(episode)]!.durationMs,
      firstPartialMs: null,
      terminalMs: null,
    })
    if (await options.evaluate((element: HTMLDetailsElement) => element.open))
      await toggleCompanionGeneration(reader)
    await closeCompanionPanel(reader)
    await stage(
      `Started fresh WhisperX ${device} job on continuous track ${book.episodes.indexOf(episode) + 1}`,
    )
  }
  await startJob(book.episodes[0]!, 'cpu')
  await page.getByRole('button', { name: '播放', exact: true }).click()
  const started = Date.now(),
    samples: Record<string, unknown>[] = [],
    ipcLatencies: number[] = [],
    roundTrips: number[] = []
  let previous = -1,
    lastHeartbeat = 0,
    hiddenAt = 0,
    shown = false,
    chapterStop = false
  const terminal = new Set<string>()
  let finalSnapshot:
    | { source: string; positionMs: number; durationMs: number; paused: boolean; ended: boolean }
    | undefined
  const maximumMs =
    manifest.samples.slice(0, 3).reduce((sum, sample) => sum + sample.durationMs, 0) + 120000
  while (Date.now() - started < maximumMs) {
    const roundTrip = performance.now()
    const value = await page.evaluate(async (targets) => {
      const before = performance.now(),
        result = await window.desktop.getState()
      if (!result.ok) throw new Error(result.error.message)
      const ipcMs = performance.now() - before
      const audio = document.querySelector('audio')!
      const jobs = await Promise.all(
        targets.map((target) => window.desktop.getTranscriptionState(target)),
      )
      const alert = document.querySelector('.player-panel [role="alert"]')?.textContent ?? ''
      return {
        ipcMs,
        wallMs: Date.now(),
        source: audio.currentSrc,
        positionMs: audio.currentTime * 1000,
        durationMs: audio.duration * 1000,
        paused: audio.paused,
        ended: audio.ended,
        readyState: audio.readyState,
        error: audio.error?.message ?? '',
        alert,
        visibility: document.visibilityState,
        jobs: jobs.map((job) => (job.ok ? job.value.job : null)),
      }
    }, targets)
    roundTrips.push(performance.now() - roundTrip)
    ipcLatencies.push(value.ipcMs)
    if (value.error || value.alert) throw new Error(value.error || value.alert)
    const index = book.episodes.findIndex((episode) =>
      value.source.includes(`/media/${episode.id}/`),
    )
    samples.push(value)
    if (index !== previous) {
      expect(index).toBe(previous + 1)
      report.transitions.push({ index, wallMs: value.wallMs, positionMs: value.positionMs })
      previous = index
      await stage(`Natural playback reached continuous track ${index + 1}`)
      if (index === 1) await startJob(book.episodes[1]!, 'cuda')
      if (index === 2) {
        await menuAction(page, '播放选项', '收听工具')
        const tools = page.getByRole('dialog', { name: '收听工具', exact: true })
        await tools.getByRole('button', { name: '本集结束时停止', exact: true }).click()
        await tools.getByRole('button', { name: '关闭收听工具', exact: true }).click()
        chapterStop = true
      }
    }
    for (const job of value.jobs.filter((job): job is TranscriptionJob => job !== null)) {
      const measured = report.jobs.find((item) => item.episodeId === job.episodeId)
      if (!measured) continue
      measured.status = job.status
      measured.cacheHits = job.cacheHits
      measured.issueCount = job.issueCount
      measured.processedUntilMs = job.processedUntilMs
      measured.error = job.error
      if (job.completedChunks && measured.firstPartialMs === null)
        measured.firstPartialMs = value.wallMs - Number(measured.startedWallMs)
      if (['completed', 'canceled', 'failed'].includes(job.status) && !terminal.has(job.id)) {
        terminal.add(job.id)
        measured.terminalMs = value.wallMs - Number(measured.startedWallMs)
        measured.realTimeFactor = Number(measured.terminalMs) / Number(measured.durationMs)
        await stage(
          `WhisperX ${measured.device} ended as ${job.status}; first prefix ${measured.firstPartialMs} ms, total ${measured.terminalMs} ms`,
        )
      }
    }
    if (!hiddenAt && Date.now() - started >= 15000) {
      const hidden = await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]!
        window.hide()
        return { operation: 'hide', wallMs: Date.now(), visible: window.isVisible() }
      })
      expect(hidden.visible).toBe(false)
      report.nativeWindowEvents.push(hidden)
      hiddenAt = Date.now()
      await stage('Window hidden for 30 real seconds while audio and inference continue')
    } else if (hiddenAt && !shown && Date.now() - hiddenAt >= 30000) {
      const restored = await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]!
        window.show()
        return { operation: 'show', wallMs: Date.now(), visible: window.isVisible() }
      })
      expect(restored.visible).toBe(true)
      report.nativeWindowEvents.push(restored)
      shown = true
      await stage('Window restored after the hidden playback interval')
    }
    if (value.ended && index === 2 && value.paused && chapterStop) {
      finalSnapshot = value
      break
    }
    if (Date.now() - lastHeartbeat >= 30000) {
      console.log(
        JSON.stringify({
          elapsedSeconds: Math.round((Date.now() - started) / 1000),
          track: index + 1,
          mediaSeconds: Math.round(value.positionMs / 1000),
          paused: value.paused,
          jobs: report.jobs.map((job) => ({
            device: job.device,
            status: job.status,
            processedUntilMs: job.processedUntilMs,
          })),
        }),
      )
      lastHeartbeat = Date.now()
      await saveReport()
    }
    await delay(500)
  }
  expect(finalSnapshot).toBeDefined()
  expect(report.transitions).toHaveLength(3)
  expect(shown).toBe(true)
  expect(errors).toEqual([])
  const events = await page.evaluate(
    () => Reflect.get(window, 'RALB_SOAK_EVENTS') as Record<string, unknown>[],
  )
  await writeFile(join(directory, 'clock-samples.json'), JSON.stringify(samples))
  await writeFile(join(directory, 'media-events.json'), JSON.stringify(events, null, 2))
  await writeFile(
    join(directory, 'analysis.json'),
    JSON.stringify(analyzeListening(samples as unknown as ListeningSample[]), null, 2),
  )
  const stalledSamples = samples.filter(
    (sample, index) =>
      index &&
      !sample.paused &&
      sample.source === samples[index - 1]!.source &&
      Number(sample.positionMs) <= Number(samples[index - 1]!.positionMs) + 1,
  )
  const quantile = (values: number[], p: number) =>
    values.toSorted((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]
  report.clockSummary = {
    elapsedMs: Date.now() - started,
    expectedMediaMs: manifest.samples
      .slice(0, 3)
      .reduce((sum, sample) => sum + sample.durationMs, 0),
    samples: samples.length,
    nonAdvancingAdjacentSamples: stalledSamples.length,
    endedEvents: events.filter((event) => event.type === 'ended').length,
    waitingEvents: events.filter((event) => event.type === 'waiting').length,
    stalledEvents: events.filter((event) => event.type === 'stalled').length,
    scope:
      'native HTMLAudioElement clock/events; no physical acoustic quality claim; start/track transitions can emit waiting',
  }
  report.responsiveness = {
    ipcMs: {
      p50: quantile(ipcLatencies, 0.5),
      p95: quantile(ipcLatencies, 0.95),
      max: Math.max(...ipcLatencies),
    },
    nodeChromiumRoundTripMs: { p95: quantile(roundTrips, 0.95), max: Math.max(...roundTrips) },
    scope:
      'IPC renderer-main-renderer and harness round trip, not a physical input-to-display latency',
  }
  await stage(
    'Three complete source tracks played naturally at 1x, with two auto-next transitions and chapter-end sleep stop',
  )
  const completedState = await state()
  const completedBook = completedState.books.find((item) => item.id === book.id)!
  for (const [index, episode] of completedBook.episodes.entries())
    expect(episode.positionMs).toBeGreaterThan(manifest.samples[index]!.durationMs - 100)
  await page.screenshot({ path: join(directory, 'completed.png'), fullPage: true })
  await writeFile(stopFile, 'stop')
  expect(await samplerDone).toBe(0)
  report.resources = JSON.parse(await readFile(resourceFile, 'utf8'))
  expect((report.resources as { status: string }).status).toBe('completed')
  expect((report.resources as { samples: number }).samples).toBeGreaterThan(0)
  if (diagnostic) await writeFile(join(directory, 'sampler-stderr.txt'), diagnostic)
  await app.close()
  app = await electron.launch({ args: [resolve('.')], env })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.context().setOffline(true)
  await expect.poll(async () => (await state()).currentEpisodeId).toBe(book.episodes[2]!.id)
  await expect
    .poll(() =>
      page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime * 1000),
    )
    .toBeGreaterThan(manifest.samples[2]!.durationMs - 100)
  expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true)
  await stage(
    'All completed positions and the last chapter survived application restart without autoplay',
  )
  expect(errors).toEqual([])
  for (const [index, source] of originals.entries()) {
    const after = await stat(source.path)
    expect(after.size).toBe(source.info.size)
    expect(after.mtimeMs).toBe(source.info.mtimeMs)
    const copied = matrixPath(index)
    expect(await hash(source.path)).toBe(await hash(copied))
  }
  expect(report.jobs).toHaveLength(2)
  for (const job of report.jobs)
    expect(job.status, `${job.device} must complete before the chapter changes`).toBe('completed')
  for (const job of report.jobs)
    expect(job.cacheHits, 'fresh job checkpoints must not be reused').toBe(0)
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
  process.exitCode = 1
} finally {
  await writeFile(stopFile, 'stop')
  await app?.close().catch(() => undefined)
  if (samplerDone) {
    const timer = setTimeout(() => sampler?.kill(), 5000)
    await samplerDone.catch(() => undefined)
    clearTimeout(timer)
    try {
      report.resources = JSON.parse(await readFile(resourceFile, 'utf8'))
    } catch {
      /* Preserve the original benchmark failure. */
    }
  }
  await saveReport()
}
console.log(
  JSON.stringify({
    status: report.status,
    error: report.error,
    report: join(directory, 'report.json'),
  }),
)
