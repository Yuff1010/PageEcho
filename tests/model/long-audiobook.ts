import { menuAction, setVolume } from '../helpers/ui'
// Opt-in whole-source playback at native 1x speed. No synthetic EOF or time changes.
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { AppState } from '../../src/shared/contracts'
import { analyzeListening, type ListeningSample } from './listening-analysis'
import { closeOwnedElectron } from './electron-lifecycle'
import { installLongInputIsolation, setLongInputLocked } from './long-input-isolation'

interface Track {
  name: string
  sourcePath: string
  sha256: string
  sizeBytes: number
  durationMs: number
}
interface Manifest {
  catalog: string
  tracks: Track[]
}
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--format' || !['m4a', 'm4b'].includes(args[1]!))
  throw new Error('Usage: npm run test:audiobook:long -- --format m4b|m4a')
const format = args[1]!
const manifestPath = resolve(
  format === 'm4b'
    ? 'cache/asr-evaluation/audiobook-source/manifest.json'
    : 'cache/asr-evaluation/m4a-source/manifest.json',
)
const nextManifestPath = resolve('cache/asr-evaluation/audiobook-source/manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
const nextManifest = JSON.parse(await readFile(nextManifestPath, 'utf8')) as Manifest
const whole = manifest.tracks.find(
  (track) => track.name === (format === 'm4b' ? 'chinesecallToArms_librivox.m4b' : 'HardSpeed.m4a'),
)
const next = nextManifest.tracks.find((track) => track.name === 'calltoarms_06_lu.mp3')
if (!whole || !next || whole.durationMs < (format === 'm4b' ? 4 * 3600000 : 45 * 60000))
  throw new Error('Prepare the pinned whole audiobook and following MP3 source first')
const tracks = [whole, next]
async function hash(path: string) {
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(path)) digest.update(bytes)
  return digest.digest('hex')
}
const directory = resolve(
  'cache/asr-evaluation/long-audiobook',
  `${new Date().toISOString().replaceAll(':', '-')}-${format}`,
)
await mkdir(directory, { recursive: true })
await copyFile(resolve('tests/model/long-audiobook.ts'), join(directory, 'runner-started.ts'))
await copyFile(
  resolve('tests/model/electron-lifecycle.ts'),
  join(directory, 'lifecycle-started.ts'),
)
await copyFile(
  resolve('tests/model/long-input-isolation.ts'),
  join(directory, 'input-isolation-started.ts'),
)
const root = await mkdtemp(join(tmpdir(), '听读整书长时验收 '))
const folder = join(root, '整书自然连播')
await mkdir(folder)
const originals = []
for (const [index, track] of tracks.entries()) {
  const info = await stat(track.sourcePath)
  expect(info.size).toBe(track.sizeBytes)
  expect(await hash(track.sourcePath)).toBe(track.sha256)
  originals.push({ track, size: info.size, mtimeMs: info.mtimeMs })
  await copyFile(track.sourcePath, join(folder, `第0${index + 1}集${extname(track.name)}`))
}
const env: Record<string, string> = {}
for (const [key, value] of Object.entries(process.env))
  if (
    value !== undefined &&
    !['electron_run_as_node', 'ralb_executable', 'path', 'pythonhome', 'pythonpath'].includes(
      key.toLowerCase(),
    )
  )
    env[key] = value
env.RALB_USER_DATA = root
env.PATH = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32;${process.env.SystemRoot ?? 'C:\\Windows'}`
const report: Record<string, unknown> = {
  status: 'running',
  runnerPid: process.pid,
  format,
  userData: root,
  sourceManifests: await Promise.all(
    [...new Set([manifestPath, nextManifestPath])].map(async (path) => ({
      path,
      sha256: await hash(path),
    })),
  ),
  whole: { ...whole, catalog: manifest.catalog },
  next: { ...next, catalog: nextManifest.catalog },
  runnerSha256: await hash(resolve('tests/model/long-audiobook.ts')),
  lifecycleSha256: await hash(resolve('tests/model/electron-lifecycle.ts')),
  inputIsolationSha256: await hash(resolve('tests/model/long-input-isolation.ts')),
  cleanups: [],
  buildHashes: await Promise.all(
    ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html'].map(async (path) => ({
      path,
      sha256: await hash(path),
    })),
  ),
  volume: 0,
  samplePeriodMs: 1000,
  nativeWindowEvents: [],
  transitions: [],
  scope:
    'Whole original source at native 1x, then real EOF auto-next and paused restart. Sampled clocks/resources; no acoustic or ASR quality claim.',
}
const save = async () => {
  await writeFile(join(directory, 'report.json.tmp'), JSON.stringify(report, null, 2) + '\n')
  await rename(join(directory, 'report.json.tmp'), join(directory, 'report.json'))
}
await save()
console.log(
  JSON.stringify({
    stage: 'starting',
    report: join(directory, 'report.json'),
    durationMs: whole.durationMs,
  }),
)
const samples: ListeningSample[] = []
let app: ElectronApplication | undefined, page: Page | undefined
const errors: string[] = []
try {
  app = await electron.launch({ args: [resolve('.')], env })
  report.launcherPid = app.process().pid
  report.applicationPid = await app.evaluate(() => process.pid)
  page = await app.firstWindow()
  await page.context().setOffline(true)
  page.on('pageerror', (error) => errors.push(error.message))
  const state = async (): Promise<AppState> => {
    const result = await page!.evaluate(() => window.desktop.getState())
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  report.productVersion = (await state()).version
  await app.evaluate(
    ({ BrowserWindow }, format) =>
      BrowserWindow.getAllWindows()[0]!.setTitle(
        `自动长测 ${format.toUpperCase()} · 静音 · 请勿操作`,
      ),
    format,
  )
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, folder)
  await menuAction(page, '更多导入方式', '导入文件夹')
  await page.getByRole('button', { name: '确认导入', exact: true }).click()
  await page.getByRole('button', { name: `打开 ${basename(folder)} 的目录`, exact: true }).click()
  const book = (await state()).books.find((item) => item.title === basename(folder))!
  expect(book.episodes.map((episode) => episode.contentHash)).toEqual(
    tracks.map((track) => track.sha256),
  )
  report.playlist = book.episodes
  await page
    .getByRole('button', { name: `播放第 1 集 ${book.episodes[0]!.title}`, exact: true })
    .click()
  await expect
    .poll(() => page!.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
    .toBeGreaterThan(0.1)
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  const mediaDurationMs = await page
    .locator('audio')
    .evaluate((audio: HTMLAudioElement) => audio.duration * 1000)
  expect(Math.abs(mediaDurationMs - whole.durationMs)).toBeLessThan(100)
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('0')
  await setVolume(page, '0')
  await page.getByRole('combobox', { name: '播放倍速', exact: true }).selectOption('1')
  await page.evaluate(() => {
    const events: unknown[] = []
    Reflect.set(window, 'RALB_LONG_EVENTS', events)
    const audio = document.querySelector('audio')!
    for (const type of [
      'playing',
      'waiting',
      'stalled',
      'pause',
      'ended',
      'error',
      'seeking',
      'seeked',
      'ratechange',
    ])
      audio.addEventListener(type, () =>
        events.push({
          type,
          wallMs: Date.now(),
          positionMs: audio.currentTime * 1000,
          source: audio.currentSrc,
        }),
      )
    for (const type of ['click', 'input', 'change'])
      document.querySelector('.player-panel')?.addEventListener(type, (event) => {
        const target = (event.target as Element).closest('button,input,select')
        if (!target) return
        events.push({
          type: `control-${type}`,
          wallMs: Date.now(),
          positionMs: audio.currentTime * 1000,
          source: audio.currentSrc,
          control: target.getAttribute('aria-label') ?? target.textContent?.trim().slice(0, 50),
          trusted: event.isTrusted,
          paused: audio.paused,
          volume: audio.volume,
          rate: audio.playbackRate,
        })
      })
  })
  report.inputIsolation = await installLongInputIsolation(page, format.toUpperCase())
  const windowAction = async (visible: boolean, reason: string) => {
    const result = await app!.evaluate(({ BrowserWindow }, show) => {
      const window = BrowserWindow.getAllWindows()[0]!
      if (show) window.show()
      else window.close()
      return { wallMs: Date.now(), visible: window.isVisible(), destroyed: window.isDestroyed() }
    }, visible)
    expect(result.destroyed).toBe(false)
    expect(result.visible).toBe(visible)
    ;(report.nativeWindowEvents as unknown[]).push({ ...result, reason })
    if (visible) {
      await page!.getByRole('button', { name: '伴读阅读', exact: true }).click()
      await page!.getByRole('button', { name: '章节目录', exact: true }).click()
    }
    await save()
  }
  await page.getByRole('button', { name: '播放', exact: true }).click()
  await setLongInputLocked(page, true)
  const started = Date.now()
  report.startedAt = new Date(started).toISOString()
  report.mediaDurationMs = mediaDurationMs
  report.expectedNaturalEndAt = new Date(started + mediaDurationMs).toISOString()
  await save()
  const actions = [{ at: 60000, visible: false, reason: 'initial-close-to-tray' }]
  for (let at = 3600000; at + 120000 < mediaDurationMs; at += 3600000) {
    actions.push({ at, visible: true, reason: 'hourly-restore-and-navigate' })
    actions.push({ at: at + 30000, visible: false, reason: 'hourly-close-to-tray' })
  }
  actions.push({ at: mediaDurationMs - 60000, visible: true, reason: 'restore-before-natural-end' })
  let actionIndex = 0,
    lastHeartbeat = 0,
    current = -1,
    finished = false
  while (Date.now() - started < mediaDurationMs + 120000) {
    const sample = await page.evaluate(async () => {
      const before = performance.now(),
        result = await window.desktop.getState()
      if (!result.ok) throw new Error(result.error.message)
      const ipcMs = performance.now() - before,
        audio = document.querySelector('audio')!
      return {
        wallMs: Date.now(),
        source: audio.currentSrc,
        positionMs: audio.currentTime * 1000,
        paused: audio.paused,
        ipcMs,
        visibility: document.visibilityState,
        jobs: [],
        rate: audio.playbackRate,
        volume: audio.volume,
        savedPositionMs: result.value.books
          .flatMap((item) => item.episodes)
          .find((episode) => episode.id === result.value.currentEpisodeId)?.positionMs,
        error: audio.error?.message ?? '',
        alert: document.querySelector('.player-panel [role="alert"]')?.textContent ?? '',
      }
    })
    if (sample.error || sample.alert || errors.length)
      throw new Error(sample.error || sample.alert || errors.join('\n'))
    expect(sample.rate).toBe(1)
    samples.push(sample)
    await appendFile(join(directory, 'clock-samples.jsonl'), JSON.stringify(sample) + '\n')
    const index = book.episodes.findIndex((episode) =>
      sample.source.includes(`/media/${episode.id}/`),
    )
    if (index === 0 && sample.paused && sample.positionMs < mediaDurationMs - 500)
      throw new Error(
        'Unexpected pause during whole-source playback; preserve the failed observation instead of waiting for the full deadline',
      )
    if (index !== current) {
      expect(index).toBe(current + 1)
      ;(report.transitions as unknown[]).push({
        index,
        wallMs: sample.wallMs,
        positionMs: sample.positionMs,
      })
      current = index
      await save()
    }
    const action = actions[actionIndex]
    if (action && Date.now() - started >= action.at) {
      await windowAction(action.visible, action.reason)
      actionIndex++
    }
    if (index === 1 && sample.positionMs >= 10000) {
      finished = true
      break
    }
    if (Date.now() - lastHeartbeat >= 60000) {
      report.latest = {
        wallMs: sample.wallMs,
        elapsedMs: Date.now() - started,
        index,
        positionMs: sample.positionMs,
        savedPositionMs: sample.savedPositionMs,
      }
      const metrics = await app.evaluate(({ app }) => app.getAppMetrics())
      await appendFile(
        join(directory, 'app-metrics.jsonl'),
        JSON.stringify({ wallMs: Date.now(), metrics }) + '\n',
      )
      const events = await page.evaluate(() => Reflect.get(window, 'RALB_LONG_EVENTS'))
      await writeFile(join(directory, 'media-events.json'), JSON.stringify(events, null, 2))
      await save()
      console.log(
        JSON.stringify({
          stage: 'playing',
          elapsedSeconds: Math.round((Date.now() - started) / 1000),
          index,
          positionSeconds: Math.round(sample.positionMs / 1000),
          savedSeconds: Math.round((sample.savedPositionMs ?? 0) / 1000),
        }),
      )
      lastHeartbeat = Date.now()
    }
    await delay(1000)
  }
  expect(finished).toBe(true)
  expect(actionIndex).toBe(actions.length)
  expect(report.transitions as unknown[]).toHaveLength(2)
  await setLongInputLocked(page, false)
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  const saved = (await state()).books.find((item) => item.id === book.id)!
  expect(saved.episodes[0]!.positionMs).toBeGreaterThan(mediaDurationMs - 100)
  const positionMs = saved.episodes[1]!.positionMs
  expect(positionMs).toBeGreaterThanOrEqual(10000)
  const events = await page.evaluate(
    () => Reflect.get(window, 'RALB_LONG_EVENTS') as { type: string }[],
  )
  expect(events.filter((event) => event.type === 'ended')).toHaveLength(1)
  report.analysis = analyzeListening(samples)
  report.natural = {
    elapsedMs: Date.now() - started,
    completedDurationMs: mediaDurationMs,
    nextPositionMs: positionMs,
    endedEvents: 1,
  }
  await writeFile(join(directory, 'media-events.json'), JSON.stringify(events, null, 2))
  await page.screenshot({ path: join(directory, 'natural-end.png'), fullPage: true })
  const closed = await closeOwnedElectron(app)
  ;(report.cleanups as unknown[]).push(closed)
  expect(closed.kind).toBe('graceful')
  app = undefined
  app = await electron.launch({ args: [resolve('.')], env })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.context().setOffline(true)
  await expect.poll(async () => (await state()).currentEpisodeId).toBe(saved.episodes[1]!.id)
  await expect
    .poll(() =>
      page!.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime * 1000),
    )
    .toBeCloseTo(positionMs, -2)
  expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true)
  expect(errors).toEqual([])
  for (const original of originals) {
    const after = await stat(original.track.sourcePath)
    expect(after.size).toBe(original.size)
    expect(after.mtimeMs).toBe(original.mtimeMs)
    expect(await hash(original.track.sourcePath)).toBe(original.track.sha256)
  }
  report.originalsUnchanged = true
  report.restartRestoredPaused = true
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
  report.analysis = analyzeListening(samples)
  process.exitCode = 1
  try {
    const events = await page?.evaluate(() => Reflect.get(window, 'RALB_LONG_EVENTS'))
    if (events)
      await writeFile(join(directory, 'media-events.json'), JSON.stringify(events, null, 2) + '\n')
    report.finalObservation = await page?.evaluate(() => {
      const audio = document.querySelector('audio')!
      return {
        at: new Date().toISOString(),
        paused: audio.paused,
        positionMs: audio.currentTime * 1000,
        durationMs: audio.duration * 1000,
        volume: audio.volume,
        rate: audio.playbackRate,
        error: audio.error?.message ?? '',
      }
    })
  } catch (captureError) {
    report.diagnosticCaptureError = String(captureError)
  }
  await page
    ?.screenshot({ path: join(directory, 'failure.png'), fullPage: true })
    .catch(() => undefined)
} finally {
  if (app) {
    try {
      const closed = await closeOwnedElectron(app)
      ;(report.cleanups as unknown[]).push(closed)
      if (closed.kind === 'forced' && report.status === 'passed') {
        report.status = 'failed'
        report.error = 'Final application shutdown required forced test-process cleanup'
        process.exitCode = 1
      }
    } catch (error) {
      report.status = 'failed'
      report.cleanupError = String(error)
      process.exitCode = 1
    }
  }
  report.finishedAt = new Date().toISOString()
  await save()
}
console.log(
  JSON.stringify({
    status: report.status,
    error: report.error,
    report: join(directory, 'report.json'),
  }),
)
