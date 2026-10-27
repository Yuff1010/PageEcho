import { closeCompanionPanel, openCompanionSearch, openCompanionTools } from '../helpers/ui'
// Actual frozen 43-minute audiobook ASR; native renderer worker and media, no new inference.
import assert from 'node:assert/strict'
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'
import { createHash } from 'node:crypto'
import { cp, copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { TranscriptDocument } from '../../src/shared/transcript'
import { closeOwnedElectron } from './electron-lifecycle'

const args = process.argv.slice(2)
assert.deepEqual([args.length, args[0], args[2]], [4, '--app-root', '--report'])
const appRoot = resolve(args[1]!),
  sourceReport = resolve(args[3]!)
const source = JSON.parse(await readFile(sourceReport, 'utf8'))
assert.equal(source.status, 'passed')
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
const sourceDatabase = join(source.userData, 'data/library.sqlite3'),
  databaseHash = await hash(sourceDatabase)
const document = JSON.parse(await readFile(source.transcriptPath, 'utf8')) as TranscriptDocument
assert.equal(document.segments.length, 1006)
const originals = await Promise.all(
  [source.sourceAudio, source.transcriptPath].map(async (path: string) => ({
    path,
    stat: await stat(path),
    hash: await hash(path),
  })),
)
assert.equal(originals[0]!.hash, source.audioHash)
assert.equal(originals[1]!.hash, source.transcriptHash)
// Independent oracle: map each normalized UTF-16 position to its source segment.
// Production uses monotone segment spans and a query cache instead.
const normalize = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
const parts = document.segments.map((segment) => normalize(segment.text)),
  text = parts.join('')
const owners = parts.flatMap((part, index) => Array.from({ length: part.length }, () => index))
function expected(query: string) {
  const needle = normalize(query),
    ranges = new Map<string, { first: number; last: number }>()
  for (let from = 0; from < text.length;) {
    const at = text.indexOf(needle, from)
    if (at < 0) break
    const first = owners[at]!,
      last = owners[at + needle.length - 1]!
    ranges.set(`${first}:${last}`, { first, last })
    from = at + 1
  }
  return [...ranges.values()]
}
const queries = [0.15, 0.5, 0.85].map((fraction) => {
  const index = Math.floor(document.segments.length * fraction)
  const query = parts
    .slice(index, index + 2)
    .join('')
    .slice(0, 6)
  assert.ok(Array.from(query).length >= 2)
  return { fraction, index, query, ranges: expected(query) }
})
const frequent = ['阿q', '阿Q', '没有', '一个'].find((query) => expected(query).length > 20)
assert.ok(frequent, 'A real repeated phrase is required to exercise result pagination')
queries.push({ fraction: -1, index: -1, query: frequent, ranges: expected(frequent) })
const directory = resolve(
  'cache/asr-evaluation/transcript-search-runs',
  new Date().toISOString().replaceAll(':', '-'),
)
await mkdir(directory, { recursive: true })
await copyFile(resolve('tests/model/transcript-search.ts'), join(directory, 'runner-started.ts'))
const userData = await mkdtemp(join(tmpdir(), '听读真实文稿搜索 '))
await cp(join(source.userData, 'data'), join(userData, 'data'), { recursive: true })
const report: Record<string, unknown> = {
  status: 'running',
  startedAt: new Date().toISOString(),
  appRoot,
  directory,
  userData,
  sourceReport,
  sourceReportHash: await hash(sourceReport),
  sourceDatabase,
  sourceDatabaseHash: databaseHash,
  sourceAudio: source.sourceAudio,
  audioHash: source.audioHash,
  transcriptPath: source.transcriptPath,
  transcriptHash: source.transcriptHash,
  runnerHash: await hash(join(directory, 'runner-started.ts')),
  buildManifestHash: await hash(resolve(appRoot, '../manifest.json')),
  scope:
    'Actual original 43-minute MP3 / frozen 1,006-segment ASR in a copied profile. Native worker search, independent full-document count/range oracle, real locate and media-state checks. No new inference, listening accuracy or phonetic-boundary claim.',
}
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
await save()
console.log(JSON.stringify({ stage: 'starting', report: join(directory, 'report.json') }))
let app: ElectronApplication | undefined
try {
  const env = { ...process.env, RALB_USER_DATA: userData }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  Reflect.deleteProperty(env, 'ELECTRON_RENDERER_URL')
  app = await electron.launch({ args: [appRoot], env })
  const page = await app.firstWindow(),
    errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const target = { episodeId: source.episode.id, audioHash: source.audioHash }
  const initial = await page.evaluate((input) => window.desktop.getTranscript(input), target)
  assert.ok(initial.ok && initial.value.status === 'ready')
  assert.deepEqual(initial.value.transcript.document, document)
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  await openCompanionTools(page)
  await expect(page.getByRole('dialog', { name: '伴读工具', exact: true })).toContainText(
    '1,006 句',
  )
  await closeCompanionPanel(page)
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('1500')
  await expect
    .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
    .toBe(1.5)
  const clock = () =>
    page.locator('audio').evaluate((audio: HTMLAudioElement) => ({
      positionMs: audio.currentTime * 1000,
      paused: audio.paused,
    }))
  const before = await clock()
  assert.equal(before.paused, true)
  const results = []
  for (const sample of queries) {
    await openCompanionSearch(page)
    await page.getByRole('textbox', { name: '文稿搜索文字' }).fill(sample.query)
    await expect(page.getByRole('button', { name: '搜索文稿', exact: true })).toBeEnabled()
    const started = performance.now()
    await page.getByRole('button', { name: '搜索文稿', exact: true }).click()
    await expect(page.locator('.transcript-search')).toContainText(
      `共 ${sample.ranges.length} 处结果`,
    )
    const durationMs = performance.now() - started
    const readRanges = () =>
      page.locator('.transcript-search-results button > span:first-child').evaluateAll((elements) =>
        elements.map((element) => {
          const match = element.textContent!.match(/第 (\d+)(?:–(\d+))? 句/)!
          return { first: Number(match[1]) - 1, last: Number(match[2] ?? match[1]) - 1 }
        }),
      )
    assert.deepEqual(await readRanges(), sample.ranges.slice(0, 20))
    if (sample.ranges.length > 20) {
      await page.getByRole('button', { name: '文稿搜索末页', exact: true }).click()
      const offset = Math.floor((sample.ranges.length - 1) / 20) * 20
      await expect(page.locator('.transcript-search')).toContainText(
        `第 ${Math.floor(offset / 20) + 1} /`,
      )
      assert.deepEqual(await readRanges(), sample.ranges.slice(offset, offset + 20))
    }
    const selected = sample.ranges.at(-1)!
    await page.locator('.transcript-search-results button').last().click()
    const sentence = page.locator(
      `.transcript-sentence[data-segment-id="${document.segments[selected.first]!.id}"]`,
    )
    await expect(sentence).toHaveAttribute('data-search-hit', 'true')
    await expect(sentence).toBeInViewport({ ratio: 1 })
    assert.deepEqual(await clock(), before)
    await page.screenshot({ path: join(directory, `query-${results.length}.png`) })
    results.push({
      fraction: sample.fraction,
      sourceIndex: sample.index,
      query: sample.query,
      total: sample.ranges.length,
      selected,
      durationMs,
      clockUnchanged: true,
    })
  }
  assert.deepEqual(
    await page.evaluate((input) => window.desktop.getTranscript(input), target),
    initial,
  )
  assert.deepEqual(errors, [])
  report.results = results
  report.transcriptUnchanged = true
  report.cleanup = await closeOwnedElectron(app)
  app = undefined
  assert.equal((report.cleanup as { kind: string }).kind, 'graceful')
  assert.equal(await hash(sourceDatabase), databaseHash)
  for (const file of originals) {
    const after = await stat(file.path)
    assert.deepEqual(
      [after.size, after.mtimeMs, await hash(file.path)],
      [file.stat.size, file.stat.mtimeMs, file.hash],
    )
  }
  report.sourcesUnchanged = true
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.stack : String(error)
  process.exitCode = 1
} finally {
  if (app) report.cleanup = await closeOwnedElectron(app)
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
