import {
  closeCompanionPanel,
  openCompanionTools,
  setSubtitleProfile,
  toggleCompanionGeneration,
} from '../helpers/ui'
// Opt-in application regression for a film clip that previously failed alignment.
import { createHash } from 'node:crypto'
import { cp, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'
import { validateTranscript, type TranscriptRequest } from '../../src/shared/transcript'
import { closeOwnedElectron } from './electron-lifecycle'

const [appArgument, reportArgument, sampleId = 'chsims-video_0005-0010'] = process.argv.slice(2)
if (!appArgument || !reportArgument || process.argv.length > 5)
  throw new Error(
    'Usage: npm run test:film:app -- <preview-app> <completed-worker-report> [sample-id]',
  )
const appRoot = resolve(appArgument),
  workerPath = resolve(reportArgument)
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const workerBytes = await readFile(workerPath)
const worker = JSON.parse(workerBytes.toString('utf8')) as {
  status: string
  engine: string
  device: 'cpu' | 'cuda'
  manifestPath: string
  manifestSha256: string
  configuration: { alignmentAudioBounds: string }
  samples: {
    id: string
    status: string
    audioHash: string
    durationMs: number
    transcript: string
  }[]
}
if (
  worker.status !== 'passed' ||
  worker.engine !== 'whisperx' ||
  worker.configuration.alignmentAudioBounds !== 'whisperx-decoded-audio-bounds-v1'
)
  throw new Error('Require a complete WhisperX run with bounded decoded audio')
const manifestBytes = await readFile(worker.manifestPath)
expect(hash(manifestBytes)).toBe(worker.manifestSha256)
const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
  samples: { id: string; path: string; audioHash: string }[]
}
const source = manifest.samples.find((sample) => sample.id === sampleId)
const measured = worker.samples.find((sample) => sample.id === sampleId)
if (!source || !measured || measured.status !== 'completed')
  throw new Error('Missing completed clip')
expect(hash(await readFile(source.path))).toBe(measured.audioHash)
const expected = validateTranscript(
  JSON.parse(await readFile(join(dirname(workerPath), measured.transcript), 'utf8')),
  measured.audioHash,
  measured.durationMs,
)
const directory = resolve(
  'cache/asr-evaluation/film-app-runs',
  `${new Date().toISOString().replaceAll(':', '-')}-${worker.device}`,
)
await mkdir(directory, { recursive: true })
await copyFile(resolve('tests/model/film-app.ts'), join(directory, 'runner-started.ts'))
const component = JSON.parse(
  await readFile(join(dirname(workerPath), 'component.json'), 'utf8'),
) as Record<string, string | number>
if (component.version !== 1)
  throw new Error('This regression uses the recorded legacy development component')
const originalCache = String(component.cache)
component.cache = join(directory, 'component-cache')
await cp(
  join(originalCache, 'nltk/tokenizers/punkt_tab/english'),
  join(String(component.cache), 'nltk/tokenizers/punkt_tab/english'),
  { recursive: true },
)
const componentPath = join(directory, 'component.json')
await writeFile(componentPath, JSON.stringify(component, null, 2))
const userData = await mkdtemp(join(tmpdir(), '听读 film app '))
const env = { ...process.env, RALB_USER_DATA: userData }
Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
Reflect.deleteProperty(env, 'RALB_EXECUTABLE')
const launch = () => electron.launch({ args: [appRoot], env })
const choose = (app: ElectronApplication, path: string) =>
  app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, path)
const result: Record<string, unknown> = {
  status: 'running',
  appRoot,
  userData,
  sample: sampleId,
  device: worker.device,
  workerReport: workerPath,
  workerReportSha256: hash(workerBytes),
  manifestSha256: hash(manifestBytes),
  runnerSha256: hash(await readFile(join(directory, 'runner-started.ts'))),
  checks: [],
  cleanups: [],
}
const checks = result.checks as string[],
  cleanups = result.cleanups as unknown[]
let app = await launch(),
  page = await app.firstWindow()
const errors: string[] = []
page.on('pageerror', (error) => errors.push(error.message))
let target: TranscriptRequest
const state = async () => {
  const response = await page.evaluate(
    (target) => window.desktop.getTranscriptionState(target),
    target,
  )
  if (!response.ok) throw new Error(response.error.message)
  return response.value
}
const waitCompleted = async (priorId?: string) => {
  await expect
    .poll(
      async () => {
        const current = await state()
        if (current.job?.status === 'failed')
          throw new Error(current.job.error ?? 'Model job failed')
        return current.job?.status === 'completed' && (!priorId || current.job.id !== priorId)
      },
      { timeout: 180000, intervals: [100, 300] },
    )
    .toBe(true)
  return state()
}
try {
  await choose(app, source.path)
  await page.getByRole('button', { name: '选择音频文件', exact: true }).click()
  await page.getByRole('button', { name: '继续播放', exact: true }).click()
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  const library = await page.evaluate(() => window.desktop.getState())
  if (!library.ok) throw new Error(library.error.message)
  const episode = library.value.books[0]!.episodes[0]!
  target = { episodeId: episode.id, audioHash: episode.contentHash }
  let reader = page.getByRole('region', { name: '同步伴读', exact: true })
  await toggleCompanionGeneration(reader)
  await choose(app, componentPath)
  await reader.getByRole('button', { name: '选择组件配置', exact: true }).click()
  await expect(reader.getByText('本地组件已配置', { exact: true })).toBeVisible()
  await setSubtitleProfile(page, { engine: 'whisperx', device: worker.device })
  await openCompanionTools(reader)
  await reader.getByRole('button', { name: '生成转写稿', exact: true }).click()
  await closeCompanionPanel(reader)
  const completed = await waitCompleted()
  expect(completed.job!.cacheHits).toBe(0)
  expect(completed.job!.completedChunks).toBe(1)
  if (completed.transcript.status !== 'ready') throw new Error('Missing generated document')
  expect(completed.transcript.transcript.document).toEqual(expected)
  result.initialJob = completed.job
  result.document = expected
  checks.push(
    'Previously failed clip completes fresh generation through the actual UI with the reference-worker document',
  )
  const first = expected.segments[0]!
  const sentence = () => reader.locator(`[data-segment-id="${first.id}"]`)
  await expect(sentence()).toContainText(first.text)
  await sentence().click()
  await expect
    .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
    .toBeCloseTo(first.startMs / 1000, 2)
  await expect(sentence()).toHaveAttribute('aria-current', 'true')
  expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true)
  checks.push('Generated sentence seeks and highlights on the unchanged media timeline')
  await page.screenshot({ path: join(directory, 'reading.png'), fullPage: true })
  const closed = await closeOwnedElectron(app)
  cleanups.push(closed)
  expect(closed.kind).toBe('graceful')
  app = await launch()
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  reader = page.getByRole('region', { name: '同步伴读', exact: true })
  await expect(sentence()).toContainText(first.text)
  const restored = await state()
  expect(restored.transcript).toEqual(completed.transcript)
  expect(restored.job!.id).toBe(completed.job!.id)
  checks.push('Application restart preserves the completed task and document')
  if (
    !(await reader
      .locator('.transcription-controls > details')
      .evaluate((element: HTMLDetailsElement) => element.open))
  )
    await toggleCompanionGeneration(reader)
  await setSubtitleProfile(page, { engine: 'whisperx', device: worker.device })
  await openCompanionTools(reader)
  await reader.getByRole('button', { name: '生成转写稿', exact: true }).click()
  await closeCompanionPanel(reader)
  const replayed = await waitCompleted(completed.job!.id)
  expect(replayed.job!.cacheHits).toBe(1)
  expect(replayed.transcript).toEqual(completed.transcript)
  result.replayJob = replayed.job
  checks.push(
    'Regeneration after restart reuses the new-contract checkpoint and preserves the current document',
  )
  expect(errors).toEqual([])
  result.status = 'passed'
} catch (error) {
  result.status = 'failed'
  result.error = String(error)
  process.exitCode = 1
  await page
    .screenshot({ path: join(directory, 'failure.png'), fullPage: true })
    .catch(() => undefined)
} finally {
  const closed = await closeOwnedElectron(app)
  cleanups.push(closed)
  if (closed.kind === 'forced') {
    result.status = 'failed'
    process.exitCode = 1
  }
  result.finishedAt = new Date().toISOString()
  await writeFile(join(directory, 'report.json'), JSON.stringify(result, null, 2) + '\n')
}
console.log(
  JSON.stringify({
    status: result.status,
    report: join(directory, 'report.json'),
    error: result.error,
  }),
)
