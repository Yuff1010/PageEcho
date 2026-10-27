import { leaveCompanionPage, menuAction, setVolume } from '../helpers/ui'
// Opt-in published audio decoding and natural mixed-format transitions.
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { AppState } from '../../src/shared/contracts'
import { analyzeListening, type ListeningSample } from './listening-analysis'

interface SourceManifest {
  catalog: string
  tracks: {
    name: string
    sourcePath: string
    sha256: string
    sizeBytes: number
    durationMs: number
    probe: { chapters?: unknown[] }
  }[]
}
const withM4a = process.argv.slice(2).includes('--m4a')
if (process.argv.slice(2).some((argument) => argument !== '--m4a'))
  throw new Error('Usage: npm run test:audiobook -- [--m4a]')
const manifestPaths = [resolve('cache/asr-evaluation/audiobook-source/manifest.json')]
if (withM4a) manifestPaths.push(resolve('cache/asr-evaluation/m4a-source/manifest.json'))
const manifests = await Promise.all(
  manifestPaths.map(async (path) => JSON.parse(await readFile(path, 'utf8')) as SourceManifest),
)
const tracks = manifests.flatMap((manifest) => manifest.tracks)
if (tracks.length < 2) throw new Error('Prepare actual audiobook sources first')
const short = tracks.find((track) => track.name === 'calltoarms_06_lu.mp3')!,
  whole = tracks.find((track) => extname(track.name).toLowerCase() === '.m4b')!
if (!short || !whole || short.durationMs < 60000 || whole.durationMs < 3600000)
  throw new Error('Expected the published short MP3 and long M4B')
const shortM4a = tracks.find((track) => track.name === 'Audiobook Sample.m4a')
if (withM4a && (!shortM4a || shortM4a.durationMs < 60000))
  throw new Error('Prepare the original published M4A samples first')
const playlist = withM4a ? [shortM4a!, short, whole] : [short, whole]
async function hash(path: string) {
  const value = createHash('sha256')
  for await (const bytes of createReadStream(path)) value.update(bytes)
  return value.digest('hex')
}
const directory = resolve(
  'cache/asr-evaluation/audiobook-playback',
  new Date().toISOString().replaceAll(':', '-'),
)
await mkdir(directory, { recursive: true })
const root = await mkdtemp(join(tmpdir(), '听读实际有声书 ')),
  matrixFolder = join(root, '原始编码验收'),
  playlistFolder = join(root, withM4a ? 'M4A转MP3转M4B连播' : 'MP3转M4B连播')
await mkdir(matrixFolder)
await mkdir(playlistFolder)
const originals = []
for (const [index, track] of tracks.entries()) {
  const info = await stat(track.sourcePath)
  expect(info.size).toBe(track.sizeBytes)
  expect(await hash(track.sourcePath)).toBe(track.sha256)
  originals.push({ ...track, info })
  await copyFile(
    track.sourcePath,
    join(matrixFolder, `第${String(index + 1).padStart(2, '0')}集${extname(track.name)}`),
  )
}
for (const [index, track] of playlist.entries())
  await copyFile(
    track.sourcePath,
    join(playlistFolder, `第${String(index + 1).padStart(2, '0')}集${extname(track.name)}`),
  )
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
  sourceManifests: await Promise.all(
    manifestPaths.map(async (path, index) => ({
      path,
      sha256: await hash(path),
      catalog: manifests[index]!.catalog,
    })),
  ),
  productVersion: (JSON.parse(await readFile('package.json', 'utf8')) as { version: string })
    .version,
  buildHashes: await Promise.all(
    ['out/main/index.js', 'out/preload/index.cjs'].map(async (path) => ({
      path,
      sha256: await hash(path),
    })),
  ),
  userData: root,
  codecChecks: [],
  transitions: [],
  windowEvents: [],
  volume: 0.02,
  scope:
    'native media clock/events; real file copies, no synthesized EOF/time; no acoustic quality or full-book listening claim',
}
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2))
await save()
let app: ElectronApplication | undefined, page: Page | undefined
const errors: string[] = []
try {
  app = await electron.launch({ args: [resolve('.')], env })
  page = await app.firstWindow()
  const watch = (window: Page) => window.on('pageerror', (error) => errors.push(error.message))
  watch(page)
  await page.context().setOffline(true)
  const state = async (): Promise<AppState> => {
    const result = await page!.evaluate(() => window.desktop.getState())
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  const importFolder = async (folder: string) => {
    await leaveCompanionPage(page!)
    await page!.getByRole('button', { name: /我的书架/ }).click()
    await app!.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, folder)
    await menuAction(page!, '更多导入方式', '导入文件夹')
    await page!.getByRole('button', { name: '确认导入', exact: true }).click()
    await page!
      .getByRole('button', { name: `打开 ${basename(folder)} 的目录`, exact: true })
      .click()
    return (await state()).books.find((book) => book.title === basename(folder))!
  }
  const restartPaused = async (episodeId: string, positionMs: number) => {
    await app!.close()
    app = undefined
    app = await electron.launch({ args: [resolve('.')], env })
    page = await app.firstWindow()
    watch(page)
    await page.context().setOffline(true)
    await expect.poll(async () => (await state()).currentEpisodeId).toBe(episodeId)
    await expect
      .poll(() =>
        page!.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime * 1000),
      )
      .toBeCloseTo(positionMs, -2)
    expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(
      true,
    )
    return page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime * 1000)
  }
  const matrix = await importFolder(matrixFolder)
  expect(matrix.episodes).toHaveLength(tracks.length)
  await setVolume(page, '0.02')
  for (const [index, episode] of matrix.episodes.entries()) {
    const expected = tracks[index]!
    expect(episode.contentHash).toBe(expected.sha256)
    await page
      .getByRole('button', { name: `播放第 ${index + 1} 集 ${episode.title}`, exact: true })
      .click()
    await expect
      .poll(() => page!.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime), {
        timeout: 10000,
      })
      .toBeGreaterThan(0.2)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    const duration = await page
      .locator('audio')
      .evaluate((audio: HTMLAudioElement) => audio.duration * 1000)
    expect(Math.abs(duration - expected.durationMs)).toBeLessThan(100)
    const seeks = []
    for (const [rate, ratio] of [
      ['0.75', 0.05],
      ['1.5', 0.5],
      ['2', 0.95],
    ] as const) {
      const target = Math.floor(duration * ratio)
      await page.getByRole('combobox', { name: '播放倍速', exact: true }).selectOption(rate)
      await page.getByRole('slider', { name: '播放进度', exact: true }).fill(String(target))
      await expect
        .poll(() => page!.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
        .toBeCloseTo(target / 1000, 1)
      expect(
        await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.playbackRate),
      ).toBe(Number(rate))
      await page.getByRole('button', { name: '播放', exact: true }).click()
      await expect
        .poll(() => page!.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
        .toBeGreaterThan(target / 1000 + 0.3)
      await page.getByRole('button', { name: '暂停', exact: true }).click()
      seeks.push({ rate: Number(rate), positionMs: target })
    }
    ;(report.codecChecks as unknown[]).push({
      name: expected.name,
      durationMs: duration,
      audioHash: expected.sha256,
      seeks,
      embeddedChapterCount: expected.probe.chapters?.length ?? 0,
    })
    await save()
    console.log(`Actual source decoded, changed rate and sought: ${expected.name}`)
  }
  if (withM4a) {
    const episode = matrix.episodes.at(-1)!
    expect(extname(tracks.at(-1)!.name)).toBe('.m4a')
    const positionMs = await page
      .locator('audio')
      .evaluate((audio: HTMLAudioElement) => audio.currentTime * 1000)
    expect(positionMs).toBeGreaterThan(45 * 60000)
    const restoredPositionMs = await restartPaused(episode.id, positionMs)
    report.m4aRestart = { audioHash: episode.contentHash, positionMs, restoredPositionMs }
    await save()
  }
  const book = await importFolder(playlistFolder)
  expect(book.episodes.map((episode) => episode.contentHash)).toEqual(
    playlist.map((track) => track.sha256),
  )
  report.playlist = book.episodes.map((episode) => ({
    id: episode.id,
    audioHash: episode.contentHash,
  }))
  await page
    .getByRole('button', { name: `播放第 1 集 ${book.episodes[0]!.title}`, exact: true })
    .click()
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('0')
  await page.getByRole('combobox', { name: '播放倍速', exact: true }).selectOption('1')
  await page.evaluate(() => {
    const events: unknown[] = []
    Reflect.set(window, 'RALB_BOOK_EVENTS', events)
    const audio = document.querySelector('audio')!
    for (const name of [
      'playing',
      'waiting',
      'stalled',
      'ended',
      'pause',
      'seeking',
      'seeked',
      'error',
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
  await page.getByRole('button', { name: '播放', exact: true }).click()
  const started = Date.now(),
    samples: ListeningSample[] = []
  let current = -1,
    hiddenAt = 0,
    shown = false,
    heartbeat = 0,
    finished = false
  const naturalDurationMs = playlist
    .slice(0, -1)
    .reduce((total, track) => total + track.durationMs, 0)
  while (Date.now() - started < naturalDurationMs + 45000) {
    const sample = await page.evaluate(async () => {
      const before = performance.now(),
        state = await window.desktop.getState()
      if (!state.ok) throw new Error(state.error.message)
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
        error: audio.error?.message ?? '',
        alert: document.querySelector('.player-panel [role="alert"]')?.textContent ?? '',
      }
    })
    if (sample.error || sample.alert) throw new Error(sample.error || sample.alert)
    samples.push(sample)
    const index = book.episodes.findIndex((episode) =>
      sample.source.includes(`/media/${episode.id}/`),
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
    if (!hiddenAt && Date.now() - started > 15000) {
      const result = await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]!
        window.hide()
        return { action: 'hide', wallMs: Date.now(), visible: window.isVisible() }
      })
      expect(result.visible).toBe(false)
      ;(report.windowEvents as unknown[]).push(result)
      hiddenAt = Date.now()
    } else if (hiddenAt && !shown && Date.now() - hiddenAt > 30000) {
      const result = await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]!
        window.show()
        return { action: 'show', wallMs: Date.now(), visible: window.isVisible() }
      })
      expect(result.visible).toBe(true)
      ;(report.windowEvents as unknown[]).push(result)
      shown = true
    }
    if (index === playlist.length - 1 && sample.positionMs >= 10000) {
      finished = true
      break
    }
    if (Date.now() - heartbeat > 30000) {
      console.log(
        JSON.stringify({
          elapsedSeconds: Math.round((Date.now() - started) / 1000),
          track: index + 1,
          positionSeconds: Math.round(sample.positionMs / 1000),
        }),
      )
      heartbeat = Date.now()
    }
    await delay(500)
  }
  expect(finished).toBe(true)
  expect(shown).toBe(true)
  expect(report.transitions as unknown[]).toHaveLength(playlist.length)
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  const saved = (await state()).books.find((item) => item.id === book.id)!
  for (const [index, track] of playlist.slice(0, -1).entries())
    expect(saved.episodes[index]!.positionMs).toBeGreaterThan(track.durationMs - 100)
  const lastEpisode = saved.episodes.at(-1)!
  const nextPosition = lastEpisode.positionMs
  expect(nextPosition).toBeGreaterThanOrEqual(10000)
  const events = await page.evaluate(
    () => Reflect.get(window, 'RALB_BOOK_EVENTS') as { type: string }[],
  )
  expect(events.filter((event) => event.type === 'ended')).toHaveLength(playlist.length - 1)
  report.analysis = analyzeListening(samples)
  report.natural = {
    completedTracks: playlist.slice(0, -1).map((track) => ({
      name: track.name,
      durationMs: track.durationMs,
    })),
    elapsedMs: Date.now() - started,
    nextPositionMs: nextPosition,
    endedEvents: playlist.length - 1,
  }
  await writeFile(join(directory, 'clock-samples.json'), JSON.stringify(samples))
  await writeFile(join(directory, 'media-events.json'), JSON.stringify(events, null, 2))
  await page.screenshot({ path: join(directory, 'natural-transition.png'), fullPage: true })
  await restartPaused(lastEpisode.id, nextPosition)
  expect(errors).toEqual([])
  for (const original of originals) {
    const after = await stat(original.sourcePath)
    expect(after.size).toBe(original.info.size)
    expect(after.mtimeMs).toBe(original.info.mtimeMs)
    expect(await hash(original.sourcePath)).toBe(original.sha256)
  }
  report.restartRestoredPaused = true
  report.originalsUnchanged = true
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
  process.exitCode = 1
  await page
    ?.screenshot({ path: join(directory, 'failure.png'), fullPage: true })
    .catch(() => undefined)
} finally {
  await app?.close().catch(() => undefined)
  await save()
}
console.log(
  JSON.stringify({
    status: report.status,
    error: report.error,
    report: join(directory, 'report.json'),
  }),
)
