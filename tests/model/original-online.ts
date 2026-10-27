import {
  closeCompanionPanel,
  closeOriginalPanel,
  openCompanionTools,
  openOriginalTools,
  setSubtitleProfile,
  setVolume,
  toggleCompanionGeneration,
  useOriginalText,
} from '../helpers/ui'
// Opt-in same-work online MP3 -> real ASR -> local original retrieval. No human accuracy claim.
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { OriginalState } from '../../src/shared/original'
import { closeOwnedElectron } from './electron-lifecycle'

const args = process.argv.slice(2)
assert.equal(args.length, 6)
assert.equal(args[0], '--app-root')
assert.equal(args[2], '--component')
assert.equal(args[4], '--text')
const appRoot = resolve(args[1]!),
  componentPath = resolve(args[3]!),
  textPath = resolve(args[5]!)
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
const directory = resolve(
  'cache/asr-evaluation/original-online-runs',
  new Date().toISOString().replaceAll(':', '-'),
)
await mkdir(directory, { recursive: true })
await copyFile(resolve('tests/model/original-online.ts'), join(directory, 'runner-started.ts'))
const userData = await mkdtemp(join(tmpdir(), '听读青山原文实测 ')),
  component = JSON.parse(await readFile(componentPath, 'utf8'))
assert.equal(component.version, 2)
for (const key of ['python', 'models', 'resources', 'ffmpeg', 'ffprobe'])
  component[key] = resolve(dirname(componentPath), component[key])
const config = join(directory, 'component.json')
await writeFile(config, JSON.stringify(component, null, 2))
const env = { ...process.env, RALB_USER_DATA: userData }
Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
Reflect.deleteProperty(env, 'ELECTRON_RENDERER_URL')
const report: Record<string, unknown> = {
  status: 'running',
  directory,
  appRoot,
  userData,
  startedAt: new Date().toISOString(),
  runnerSha256: await hash(join(directory, 'runner-started.ts')),
  buildManifestSha256: await hash(resolve(appRoot, '../manifest.json')),
  originalFileHash: await hash(textPath),
  scope:
    'Same title/author Qing Shan from user-selected ting13 anonymous source, actual complete MP3, portable Paraformer CUDA, local user GB18030 original, retrieval/highlight/click/restart. Text similarity is not human-verified mapping or phonetic accuracy. Not uninterrupted listening.',
}
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
await save()
console.log(JSON.stringify({ stage: 'starting', report: join(directory, 'report.json') }))
let app: ElectronApplication | undefined
try {
  app = await electron.launch({ args: [appRoot], env })
  let page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('button', { name: '在线书源', exact: true }).click()
  await page.getByLabel('搜索书籍', { exact: true }).fill('青山')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page
    .getByRole('button', { name: '查看 青山 的详情', exact: true })
    .click({ timeout: 40_000 })
  await expect(page.getByRole('button', { name: '加入书架', exact: true })).toBeEnabled({
    timeout: 65_000,
  })
  await page.getByRole('button', { name: '加入书架', exact: true }).click()
  const library = await page.evaluate(() => window.desktop.getState())
  assert.ok(library.ok)
  const book = library.value.books.find((book) => book.online?.bookId === '38229')!
  assert.ok(book)
  const episode = book.episodes[0]!,
    target = { episodeId: episode.id, audioHash: '' }
  await setVolume(page, '0')
  await page.getByRole('button', { name: `缓存并播放 ${episode.title}`, exact: true }).click()
  await expect
    .poll(
      () =>
        page
          .locator('audio')
          .evaluate((audio: HTMLAudioElement) => !audio.paused && audio.currentTime > 0.5),
      { timeout: 150_000 },
    )
    .toBe(true)
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  const current = await page.evaluate(() => window.desktop.getState())
  assert.ok(current.ok)
  const materialized = current.value.books.find((b) => b.id === book.id)!.episodes[0]!
  target.audioHash = materialized.contentHash
  report.audio = {
    ...materialized,
    sourceBookId: '38229',
    sourceBookTitle: '青山',
    sourceAuthor: '会说话的肘子',
    narrator: '头陀渊',
  }
  await save()
  console.log(JSON.stringify({ stage: 'actual-audio-cached', durationMs: materialized.durationMs }))
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  await toggleCompanionGeneration(page)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, config)
  await page.getByRole('button', { name: '选择组件配置', exact: true }).click()
  await expect(page.getByText('本地组件已配置', { exact: true })).toBeVisible()
  await setSubtitleProfile(page, { engine: 'paraformer', device: 'cuda' })
  await openCompanionTools(page)
  await page.getByRole('button', { name: '生成转写稿', exact: true }).click()
  await closeCompanionPanel(page)
  await useOriginalText(page)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, textPath)
  await page.getByRole('button', { name: '导入 TXT / EPUB 原文', exact: true }).click()
  await expect(page.locator('.original-viewport')).toHaveAttribute('aria-busy', 'false', {
    timeout: 70_000,
  })
  await openOriginalTools(page, '原文来源')
  await expect(page.locator('.original-summary')).toContainText('gb18030', { timeout: 70_000 })
  await expect
    .poll(
      async () => {
        const value = await page.evaluate(
          (input) => window.desktop.getTranscriptionState(input),
          target,
        )
        assert.ok(value.ok)
        if (value.value.job?.status === 'failed')
          throw new Error(value.value.job.error ?? 'ASR failed')
        return value.value.job?.status
      },
      { timeout: 600_000, intervals: [1000] },
    )
    .toBe('completed')
  const job = await page.evaluate((input) => window.desktop.getTranscriptionState(input), target)
  assert.ok(job.ok)
  assert.equal(job.value.transcript.status, 'ready')
  if (job.value.transcript.status !== 'ready') throw new Error('Missing complete transcript')
  report.transcription = {
    job: job.value.job,
    segments: job.value.transcript.transcript.document.segments.length,
    transcriptRevision: job.value.transcript.transcript.revision,
    documentSha256: createHash('sha256')
      .update(JSON.stringify(job.value.transcript.transcript.document))
      .digest('hex'),
  }
  await save()
  console.log(
    JSON.stringify({
      stage: 'actual-asr-completed',
      chunks: job.value.job?.completedChunks,
      segments: job.value.transcript.transcript.document.segments.length,
    }),
  )
  const getOriginal = async (): Promise<OriginalState> => {
    const value = await page.evaluate((input) => window.desktop.getOriginalState(input), target)
    assert.ok(value.ok)
    return value.value
  }
  await openOriginalTools(page)
  const start = performance.now(),
    beforeMatchRevision = (await getOriginal()).alignment?.revision ?? 0
  await page.getByRole('button', { name: /^(匹配这一集转写稿|重新匹配这一集)$/ }).click()
  await expect
    .poll(async () => (await getOriginal()).alignment?.revision, {
      timeout: 70_000,
      intervals: [500],
    })
    .toBeGreaterThan(beforeMatchRevision)
  await expect(page.getByRole('button', { name: '重新匹配这一集', exact: true })).toBeEnabled({
    timeout: 70_000,
  })
  report.matchWallMs = performance.now() - start
  const matched = await getOriginal(),
    matches = matched.alignment!.matches,
    accepted = matches.filter((match) => match.selected)
  assert.ok(accepted.length > 0, 'No confident mapping found; do not claim matching succeeded')
  report.matching = {
    originalId: matched.info!.id,
    originalHash: matched.info!.hash,
    matcherVersion: matched.alignment!.matcherVersion,
    total: matches.length,
    accepted: accepted.length,
    unmatched: matches.length - accepted.length,
    withCandidates: matches.filter((match) => match.candidates.length).length,
    reviewed: matches.filter((match) => match.reviewed).length,
    firstAccepted: accepted.slice(0, 5).map((match) => ({
      segmentId: match.segmentId,
      startMs: match.startMs,
      endMs: match.endMs,
      selection: match.selected,
      candidates: match.candidates.map((candidate) => ({
        first: candidate.first,
        last: candidate.last,
        score: candidate.score,
        chapter: candidate.chapter,
      })),
    })),
  }
  assert.equal(matched.info!.hash, report.originalFileHash)
  await page
    .getByRole('slider', { name: '播放进度', exact: true })
    .fill(String(accepted[0]!.startMs + 20))
  await closeOriginalPanel(page)
  await page.getByRole('button', { name: '跟随原文播放位置', exact: true }).click()
  await expect(page.locator('.original-sentence[aria-current="true"]')).not.toHaveCount(0)
  await page.locator('.original-sentence.original-text[aria-current="true"]').first().click()
  const clock = await page.locator('audio').evaluate((audio: HTMLAudioElement) => ({
    positionMs: audio.currentTime * 1000,
    paused: audio.paused,
    volume: audio.volume,
  }))
  assert.equal(clock.paused, true)
  assert.equal(clock.volume, 0)
  assert.ok(Math.abs(clock.positionMs - accepted[0]!.startMs) < 5)
  report.clickSeek = clock
  await page.screenshot({ path: join(directory, 'same-work-original-matched.png'), fullPage: true })
  report.cleanups = [await closeOwnedElectron(app)]
  app = undefined
  app = await electron.launch({ args: [appRoot], env })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  assert.deepEqual((await getOriginal()).alignment, matched.alignment)
  const restoredTranscript = await page.evaluate(
    (input) => window.desktop.getTranscript(input),
    target,
  )
  assert.ok(restoredTranscript.ok && restoredTranscript.value.status === 'ready')
  assert.deepEqual(
    restoredTranscript.value.transcript.document,
    job.value.transcript.transcript.document,
  )
  assert.equal(await hash(textPath), report.originalFileHash)
  report.restart = {
    alignmentUnchanged: true,
    transcriptUnchanged: true,
    originalFileUnchanged: true,
  }
  assert.deepEqual(errors, [])
  ;(report.cleanups as unknown[]).push(await closeOwnedElectron(app))
  app = undefined
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.stack : String(error)
  if (app) {
    await app
      .firstWindow()
      .then((page) => page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }))
      .catch(() => {})
    report.cleanup = await closeOwnedElectron(app)
  }
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  await save()
  console.log(
    JSON.stringify({
      status: report.status,
      report: join(directory, 'report.json'),
      error: report.error,
    }),
  )
}
