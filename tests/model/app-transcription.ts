import {
  closeCompanionPanel,
  leaveCompanionPage,
  menuAction,
  openCompanionProofreading,
  openCompanionSettings,
  openCompanionTools,
  setSubtitleProfile,
  toggleCompanionGeneration,
} from '../helpers/ui'
// Opt-in full application acceptance using a prepared local song or audiobook.
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdir, mkdtemp, readFile, writeFile, cp, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { TranscriptRequest } from '../../src/shared/transcript'
import { closeOwnedElectron } from './electron-lifecycle'

const directory = resolve(
  'cache/asr-evaluation/app-runs',
  new Date().toISOString().replaceAll(':', '-'),
)
await mkdir(directory, { recursive: true })
await copyFile(resolve('tests/model/app-transcription.ts'), join(directory, 'runner-started.ts'))
const args = process.argv.slice(2)
let selectedComponent = 'cache/asr-evaluation/component.json'
let isolated = false
let appPath = resolve('.')
let offlineUi = false
let selectedEngine: 'whisperx' | 'paraformer' = 'whisperx'
let sourceAudio = ''
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--isolated-runtime') isolated = true
  else if (args[index] === '--offline-ui') offlineUi = true
  else if (args[index] === '--app-path' && args[index + 1]) appPath = resolve(args[++index]!)
  else if (args[index] === '--component' && args[index + 1]) selectedComponent = args[++index]!
  else if (args[index] === '--audio' && args[index + 1]) sourceAudio = resolve(args[++index]!)
  else if (args[index] === '--engine') {
    const engine = args[++index]
    if (engine !== 'whisperx' && engine !== 'paraformer')
      throw new Error('--engine 仅支持 whisperx 或 paraformer。')
    selectedEngine = engine
  } else
    throw new Error(
      '支持 --component 路径、--audio 路径、--engine whisperx/paraformer、--isolated-runtime、--app-path 路径、--offline-ui。',
    )
}
const originalComponent = resolve(selectedComponent)
const component = JSON.parse(await readFile(originalComponent, 'utf8')) as Record<
  string,
  string | number
>
if (isolated && component.version !== 2) throw new Error('独立运行时验收需要便携组件 v2。')
for (const key of [
  'python',
  'models',
  'ffmpeg',
  'ffprobe',
  component.version === 2 ? 'resources' : 'cache',
])
  component[key] = resolve(dirname(originalComponent), String(component[key]))
if (component.version === 1) {
  const resources = String(component.cache)
  component.cache = join(directory, 'component-cache')
  await cp(
    join(resources, 'nltk/tokenizers/punkt_tab/english'),
    join(String(component.cache), 'nltk/tokenizers/punkt_tab/english'),
    { recursive: true },
  )
}
const componentPath = join(directory, 'component.json')
await writeFile(componentPath, JSON.stringify(component, null, 2))
if (!sourceAudio) {
  const manifest = JSON.parse(
    await readFile(resolve('cache/asr-evaluation/samples.json'), 'utf8'),
  ) as { samples: { sourcePath: string }[] }
  sourceAudio = manifest.samples[0]!.sourcePath
}
const root = await mkdtemp(join(tmpdir(), '听读 ASR app '))
const env = { ...process.env, RALB_USER_DATA: root }
Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
Reflect.deleteProperty(env, 'RALB_EXECUTABLE')
if (isolated) {
  for (const key of Object.keys(env))
    if (['path', 'pythonhome', 'pythonpath'].includes(key.toLowerCase()))
      Reflect.deleteProperty(env, key)
  Reflect.set(
    env,
    'PATH',
    `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32;${process.env.SystemRoot ?? 'C:\\Windows'}`,
  )
  Reflect.deleteProperty(env, 'PYTHONHOME')
  Reflect.deleteProperty(env, 'PYTHONPATH')
}
const launch = async () => {
  const instance = await electron.launch({ args: [appPath], env })
  if (offlineUi) await (await instance.firstWindow()).context().setOffline(true)
  return instance
}
const choose = (app: ElectronApplication, path: string) =>
  app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, path)
const report: {
  status: string
  data: string
  appPath: string
  offlineUi: boolean
  engine: string
  sourceAudio: string
  stages: string[]
  cleanups: unknown[]
  error?: string
} = {
  status: 'running',
  data: root,
  appPath,
  offlineUi,
  engine: selectedEngine,
  sourceAudio,
  stages: [],
  cleanups: [],
}
const closeApplication = async (instance: ElectronApplication) => {
  const result = await closeOwnedElectron(instance)
  report.cleanups.push(result)
  expect(result.kind).toBe('graceful')
}
const stage = async (name: string) => {
  report.stages.push(name)
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2))
  console.log(name)
}
let app = await launch(),
  page = await app.firstWindow()
const errors: string[] = []
const watch = (page: Page) => page.on('pageerror', (error) => errors.push(error.message))
watch(page)
let target: TranscriptRequest
const state = async () => {
  const response = await page.evaluate(
    (target) => window.desktop.getTranscriptionState(target),
    target,
  )
  if (!response.ok) throw new Error(response.error.message)
  return response.value
}
try {
  await choose(app, sourceAudio)
  await page.getByRole('button', { name: '选择音频文件', exact: true }).click()
  await page.getByRole('button', { name: '继续播放', exact: true }).click()
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  const library = await page.evaluate(() => window.desktop.getState())
  if (!library.ok) throw new Error(library.error.message)
  const episode = library.value.books[0]!.episodes[0]!
  target = { episodeId: episode.id, audioHash: episode.contentHash }
  let reader = page.getByRole('region', { name: '同步伴读', exact: true })
  const openOptions = async () => {
    if (!(await reader.isVisible()))
      await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    await openCompanionTools(reader)
    if (
      !(await reader
        .locator('.transcription-controls > details')
        .evaluate((element: HTMLDetailsElement) => element.open))
    )
      await toggleCompanionGeneration(reader)
  }
  await openOptions()
  await choose(app, componentPath)
  await reader.getByRole('button', { name: '选择组件配置', exact: true }).click()
  await expect(reader.getByText('本地组件已配置', { exact: true })).toBeVisible()
  await setSubtitleProfile(page, { engine: selectedEngine, device: 'cuda' })
  await openCompanionTools(reader)
  await reader.getByRole('button', { name: '生成转写稿', exact: true }).click()
  await closeCompanionPanel(reader)
  await stage(`Started a real full-source ${selectedEngine} job through the application UI`)
  await expect
    .poll(
      async () => {
        const value = await state()
        if (value.job?.status === 'failed') throw new Error(value.job.error ?? 'Job failed')
        return value.job?.status === 'running' && value.job.completedChunks > 0
      },
      { timeout: 180000, intervals: [50, 100] },
    )
    .toBe(true)
  const beforeRestart = (await state()).job!
  await closeApplication(app)
  await stage('Closed during generation with a persisted partial transcript')
  app = await launch()
  page = await app.firstWindow()
  watch(page)
  await expect
    .poll(async () => (await state()).job?.attempt, { timeout: 15000 })
    .toBeGreaterThan(beforeRestart.attempt)
  await expect
    .poll(
      async () => {
        const value = await state()
        if (value.job?.status === 'failed')
          throw new Error(value.job.error ?? 'Recovered job failed')
        return value.job?.status
      },
      { timeout: 180000, intervals: [100, 300] },
    )
    .toBe('completed')
  const completed = await state()
  expect(completed.job!.id).toBe(beforeRestart.id)
  expect(completed.job!.cacheHits).toBeGreaterThan(0)
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  reader = page.getByRole('region', { name: '同步伴读', exact: true })
  await expect(reader.locator('.transcript-sentence').first()).toBeVisible()
  await stage('Restart recovered the same job and reused completed chunks')
  if (completed.transcript.status !== 'ready') throw new Error('Missing completed document')
  const first = completed.transcript.transcript.document.segments[0]!
  await openCompanionProofreading(reader)
  await reader.getByRole('button', { name: '标注第 1 句', exact: true }).click()
  await reader.getByRole('combobox', { name: '片段类型' }).selectOption('advertisement')
  await reader.getByRole('button', { name: '保存片段标注', exact: true }).click()
  await expect(reader.getByRole('form', { name: '片段标注', exact: true })).toHaveCount(0)
  const marked = await page.evaluate(
    (target) => window.desktop.getTranscriptRegions(target),
    target,
  )
  expect(marked.ok && marked.value.regions).toEqual([
    { startMs: first.startMs, endMs: first.endMs, kind: 'advertisement' },
  ])
  await stage('A manual test mark on generated text retained original media coordinates')
  const corrected = (first.text[0] === '字' ? '词' : '字') + first.text.slice(1)
  await reader.getByRole('button', { name: '编辑第 1 句', exact: true }).click()
  await reader.getByRole('textbox', { name: '纠正这句文字' }).fill(corrected)
  await reader.getByRole('button', { name: '保存纠错', exact: true }).click()
  await expect(reader.locator('.transcript-sentence').first()).toContainText(corrected)
  const edited = await state()
  if (edited.transcript.status !== 'ready') throw new Error('Missing edited document')
  expect(edited.transcript.transcript.document.segments[0]!.startMs).toBe(first.startMs)
  expect(edited.transcript.transcript.document.segments[0]!.endMs).toBe(first.endMs)
  await openOptions()
  await setSubtitleProfile(page, { engine: selectedEngine, device: 'cuda' })
  await openCompanionTools(reader)
  await reader.getByRole('button', { name: '生成转写稿', exact: true }).click()
  await closeCompanionPanel(reader)
  await expect
    .poll(
      async () => {
        const value = await state()
        return value.job?.id !== completed.job!.id && value.job?.status === 'completed'
      },
      { timeout: 30000 },
    )
    .toBe(true)
  const protectedState = await state()
  expect(
    protectedState.transcript.status === 'ready' &&
      protectedState.transcript.transcript.document.segments[0]!.text,
  ).toBe(corrected)
  expect(protectedState.job!.autoApply).toBe(false)
  await openCompanionTools(reader)
  await reader.getByRole('button', { name: '预览生成稿', exact: true }).click()
  await closeCompanionPanel(reader)
  await expect(reader.locator('.transcript-sentence').first()).toContainText(first.text)
  await openCompanionTools(reader)
  await reader.getByRole('button', { name: '使用生成稿', exact: true }).click()
  await closeCompanionPanel(reader)
  await expect
    .poll(async () => {
      const value = await state()
      return value.transcript.status === 'ready'
        ? value.transcript.transcript.document.segments[0]!.text
        : ''
    })
    .toBe(first.text)
  await stage(
    'Correction kept timestamps; regeneration preserved it until explicit preview adoption',
  )
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('1000')
  await page.getByRole('button', { name: '播放', exact: true }).click()
  await openOptions()
  await setSubtitleProfile(page, { device: 'cpu' })
  await openCompanionTools(reader)
  await reader.getByRole('button', { name: '生成转写稿', exact: true }).click()
  await closeCompanionPanel(reader)
  const blockedMaintenance = await page.evaluate(() => window.desktop.prepareCacheClear())
  expect(blockedMaintenance.ok).toBe(false)
  if (!blockedMaintenance.ok) expect(blockedMaintenance.error.code).toBe('BUSY')
  await openCompanionTools(reader)
  await reader.getByRole('button', { name: '取消生成', exact: true }).click()
  await closeCompanionPanel(reader)
  await expect.poll(async () => (await state()).job?.status, { timeout: 15000 }).toBe('canceled')
  expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(
    false,
  )
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  expect(errors).toEqual([])
  await page.screenshot({ path: join(directory, 'app.png'), fullPage: true })
  await stage('Canceling a model job preserved ordinary audio playback')
  const beforeClear = await state()
  await leaveCompanionPage(page)
  await menuAction(page, '应用设置', '缓存与任务')
  const maintenance = page.getByRole('dialog', { name: '缓存与任务', exact: true })
  await expect(
    maintenance.getByRole('button', { name: '预览清理分块缓存', exact: true }),
  ).toBeEnabled({ timeout: 15000 })
  await maintenance.getByRole('button', { name: '预览清理分块缓存', exact: true }).click()
  await maintenance.getByRole('button', { name: '确认清理分块缓存', exact: true }).click()
  await expect(maintenance.getByTestId('checkpoint-usage')).toContainText('0 组')
  expect((await state()).transcript).toEqual(beforeClear.transcript)
  await page.screenshot({ path: join(directory, 'maintenance.png'), fullPage: true })
  await maintenance.getByRole('button', { name: '关闭缓存与任务', exact: true }).click()
  await stage(
    'Active jobs blocked cleanup; isolated real checkpoints cleared without changing the stored document',
  )
  await openOptions()
  await setSubtitleProfile(page, { device: 'cuda' })
  await openCompanionTools(reader)
  await reader.getByRole('button', { name: '生成转写稿', exact: true }).click()
  await closeCompanionPanel(reader)
  await expect
    .poll(
      async () => {
        const next = await state()
        if (next.job?.status === 'failed') throw new Error(next.job.error ?? 'Regeneration failed')
        return next.job?.id !== beforeClear.job?.id && next.job?.status === 'completed'
      },
      { timeout: 180000, intervals: [100, 300] },
    )
    .toBe(true)
  const regenerated = await state()
  expect(regenerated.job!.cacheHits).toBe(0)
  expect(regenerated.transcript).toEqual(beforeClear.transcript)
  expect(
    await page.evaluate((target) => window.desktop.getTranscriptRegions(target), target),
  ).toEqual(marked)
  await stage(
    'Regeneration recomputed cleared chunks with zero cache hits and preserved the current document',
  )
  await openCompanionSettings(reader)
  await reader.getByRole('checkbox', { name: '折叠已标注片段', exact: true }).check()
  await closeCompanionPanel(reader)
  await expect(reader.getByRole('button', { name: '展开广告片段', exact: true })).toBeVisible()
  await closeApplication(app)
  app = await launch()
  page = await app.firstWindow()
  watch(page)
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  reader = page.getByRole('region', { name: '同步伴读', exact: true })
  await expect(reader.getByRole('button', { name: '展开广告片段', exact: true })).toBeVisible()
  expect(
    await page.evaluate((target) => window.desktop.getTranscriptRegions(target), target),
  ).toEqual(marked)
  await stage(
    'The test mark survived correction, regeneration, checkpoint cleanup and application restart',
  )
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
  process.exitCode = 1
  await page
    .screenshot({ path: join(directory, 'failure.png'), fullPage: true })
    .catch(() => undefined)
} finally {
  try {
    await closeApplication(app)
  } catch (error) {
    report.status = 'failed'
    report.error = `${report.error ?? ''}\nApplication cleanup failed: ${String(error)}`.trim()
    process.exitCode = 1
  }
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2))
}
console.log(
  JSON.stringify({
    status: report.status,
    error: report.error,
    report: join(directory, 'report.json'),
  }),
)
