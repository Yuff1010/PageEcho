import { openTranscriptImport } from '../helpers/ui'
// Opt-in real-model acceptance. Not part of CI: needs the private sample cache.
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { validateTranscript } from '../../src/shared/transcript'
import { closeOwnedElectron } from './electron-lifecycle'

const directory = resolve(process.argv[2] ?? '')
const sampleId = process.argv[3] ?? 'song-1'
if (!process.argv[2]) throw new Error('请提供评估运行目录和可选 sample ID')
const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')) as {
  samples: {
    id: string
    audioHash: string
    offsetMs: number
    durationMs: number
    path: string
    originalSourcePath?: string
    attempts: { status: string; transcript?: string }[]
  }[]
}
const sample = report.samples.find((sample) => sample.id === sampleId)
const attempt = sample?.attempts.find(
  (attempt) => attempt.status === 'passed' && attempt.transcript,
)
if (!sample || !attempt?.transcript) throw new Error('这个样本还没有通过时间校验的文稿')
const transcriptPath = join(directory, attempt.transcript)
const document = validateTranscript(
  JSON.parse(await readFile(transcriptPath, 'utf8')),
  sample.audioHash,
  sample.offsetMs + sample.durationMs,
)
const first = document.segments[0]
if (!first) throw new Error('这个样本未识别出文字，不能验收阅读流程')
let sourcePath = sample.originalSourcePath ?? sample.path
if (!sample.originalSourcePath && sampleId !== 'known-tts-control') {
  const manifest = JSON.parse(
    await readFile(resolve('cache/asr-evaluation/samples.json'), 'utf8'),
  ) as { samples: { id: string; sourcePath: string }[] }
  const source = manifest.samples.find((source) => source.id === sample.audioHash)
  if (!source) throw new Error('找不到对应的原歌曲')
  sourcePath = source.sourcePath
}
const root = await mkdtemp(join(tmpdir(), '听读 real-model '))
const env = { ...process.env, RALB_USER_DATA: root }
Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
Reflect.deleteProperty(env, 'RALB_EXECUTABLE')
const launch = () => electron.launch({ args: [resolve('.')], env })
const choose = (app: ElectronApplication, path: string) =>
  app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, path)
let app = await launch()
const errors: string[] = []
const result: Record<string, unknown> = { sample: sampleId, sourceBuild: true, userData: root }
const cleanups: unknown[] = []
result.cleanups = cleanups
try {
  let page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await choose(app, sourcePath)
  await page.getByRole('button', { name: '选择音频文件', exact: true }).click()
  await page.getByRole('button', { name: '继续播放', exact: true }).click()
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  await choose(app, transcriptPath)
  let reader = page.getByRole('region', { name: '同步伴读', exact: true })
  await openTranscriptImport(reader)
  await reader.getByRole('button', { name: '导入 JSON 文稿', exact: true }).click()
  const sentence = () => reader.locator(`[data-segment-id="${first.id}"]`)
  await expect(sentence()).toContainText(first.text)
  await sentence().click()
  await expect
    .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
    .toBeCloseTo(first.startMs / 1000, 2)
  await expect(sentence()).toHaveAttribute('aria-current', 'true')
  expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true)
  await page.screenshot({ path: join(directory, `${sampleId}.desktop.png`), fullPage: true })
  const closed = await closeOwnedElectron(app)
  cleanups.push(closed)
  expect(closed.kind).toBe('graceful')
  app = await launch()
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('button', { name: '继续播放', exact: true }).click()
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  reader = page.getByRole('region', { name: '同步伴读', exact: true })
  await expect(sentence()).toContainText(first.text)
  expect(errors).toEqual([])
  result.status = 'passed'
  result.checks = [
    'original audio playback',
    'generated transcript import',
    'original timeline seek',
    'highlight',
    'restart reuse',
  ]
} catch (error) {
  result.status = 'failed'
  result.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  try {
    const closed = await closeOwnedElectron(app)
    cleanups.push(closed)
    if (closed.kind === 'forced' && result.status === 'passed') {
      result.status = 'failed'
      result.error = 'Final application shutdown required forced test-process cleanup'
      process.exitCode = 1
    }
  } catch (error) {
    result.status = 'failed'
    result.cleanupError = String(error)
    process.exitCode = 1
  }
  result.completedAt = new Date().toISOString()
  await writeFile(
    join(directory, `${sampleId}.desktop.json`),
    JSON.stringify(result, null, 2) + '\n',
  )
}
console.log(JSON.stringify(result))
