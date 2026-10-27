import { openOriginalSearch, useOriginalText } from '../helpers/ui'
// Real long-form original and frozen same-work ASR; do not re-run inference or edit source data.
import assert from 'node:assert/strict'
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'
import { createHash } from 'node:crypto'
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parseOriginal } from '../../src/main/original/parse'
import type { OriginalTarget } from '../../src/shared/original'
import { normalizeOriginal } from '../../src/main/original/normalize'
import type { SubtitleExportRequest } from '../../src/shared/subtitles'
import { closeOwnedElectron } from './electron-lifecycle'

const args = process.argv.slice(2)
assert.deepEqual([args.length, args[0], args[2], args[4]], [6, '--app-root', '--report', '--text'])
const appRoot = resolve(args[1]!),
  sourceReport = resolve(args[3]!),
  textPath = resolve(args[5]!)
const source = JSON.parse(await readFile(sourceReport, 'utf8'))
assert.equal(source.status, 'passed')
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
const sourceDatabase = join(source.userData, 'data/library.sqlite3'),
  sourceDatabaseHash = await hash(sourceDatabase)
const beforeStat = await stat(textPath),
  sourceTextHash = await hash(textPath)
const original = parseOriginal(await readFile(textPath), textPath)
const directory = resolve(
  'cache/asr-evaluation/reading-tools-runs',
  new Date().toISOString().replaceAll(':', '-'),
)
await mkdir(directory, { recursive: true })
await copyFile(resolve('tests/model/reading-tools.ts'), join(directory, 'runner-started.ts'))
const userData = await mkdtemp(join(tmpdir(), '听读全文字幕验收 '))
for (const entry of await readdir(source.userData))
  await cp(join(source.userData, entry), join(userData, entry), { recursive: true })
const report: Record<string, unknown> = {
  status: 'running',
  startedAt: new Date().toISOString(),
  appRoot,
  directory,
  userData,
  sourceReport,
  sourceReportHash: await hash(sourceReport),
  sourceDatabaseHash,
  sourceTextHash,
  sourceTextBytes: beforeStat.size,
  sourceTextModified: beforeStat.mtimeMs,
  runnerHash: await hash(join(directory, 'runner-started.ts')),
  buildManifestHash: await hash(resolve(appRoot, '../manifest.json')),
  scope:
    'Actual user TXT / copied frozen same-work MP3 and ASR. Whole-book search, UI locate, native-dialog export and exact subtitle coordinates. No new inference, human mapping accuracy or acoustic-boundary claim.',
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
  const library = await page.evaluate(() => window.desktop.getState())
  assert.ok(library.ok)
  const episode = library.value.books
    .find((book) => book.online?.bookId === '38229')
    ?.episodes.find((item) => item.order === 1)
  assert.ok(episode?.contentHash)
  const target: OriginalTarget = { episodeId: episode.id, audioHash: episode.contentHash }
  let initial = await page.evaluate((input) => window.desktop.getOriginalState(input), target)
  if (initial.ok && initial.value.stale) {
    const oldVersion = initial.value.alignment?.matcherVersion
    initial = await page.evaluate((input) => window.desktop.matchOriginal(input), target)
    report.ruleRefresh = {
      oldVersion,
      newVersion: initial.ok ? initial.value.alignment?.matcherVersion : null,
    }
  }
  assert.ok(initial.ok && initial.value.info && initial.value.alignment && !initial.value.stale)
  assert.equal(initial.value.info.hash, original.hash)
  const info = initial.value.info,
    alignment = initial.value.alignment
  const transcript = await page.evaluate((input) => window.desktop.getTranscript(input), target)
  assert.ok(transcript.ok && transcript.value.status === 'ready')
  const stored = transcript.value.transcript
  report.originalSentences = info.sentenceCount
  report.originalSections = info.chapters.length
  const sample = original.sentences
    .slice(-30)
    .find((sentence) => normalizeOriginal(sentence.text).length >= 24)!
  assert.ok(sample)
  const query = normalizeOriginal(sample.text).slice(0, 24),
    started = performance.now()
  const found = await page.evaluate((input) => window.desktop.findOriginal(input), {
    ...target,
    originalId: info.id,
    query,
    offset: 0,
  })
  assert.ok(
    found.ok &&
      found.value.results.some(
        (result) => result.first <= sample.ordinal && result.last >= sample.ordinal,
      ),
  )
  report.tailSearch = {
    query,
    targetOrdinal: sample.ordinal,
    result: found.value,
    wallMs: performance.now() - started,
  }
  const common = '青山',
    commonStarted = performance.now()
  const first = await page.evaluate((input) => window.desktop.findOriginal(input), {
    ...target,
    originalId: info.id,
    query: common,
    offset: 0,
  })
  assert.ok(first.ok)
  const individualHits = original.sentences.filter((sentence) =>
    normalizeOriginal(sentence.text).includes(common),
  ).length
  assert.ok(first.value.total >= individualHits)
  const offset = Math.max(0, Math.floor((first.value.total - 1) / 20) * 20)
  const last = await page.evaluate((input) => window.desktop.findOriginal(input), {
    ...target,
    originalId: info.id,
    query: common,
    offset,
  })
  assert.ok(last.ok && last.value.total === first.value.total)
  for (const result of [...first.value.results, ...last.value.results]) {
    assert.ok(
      normalizeOriginal(
        original.sentences
          .slice(result.first, result.last + 1)
          .map((sentence) => sentence.text)
          .join(''),
      ).includes(common),
    )
  }
  report.commonSearch = {
    query: common,
    individualSentenceHits: individualHits,
    total: first.value.total,
    lastOffset: offset,
    lastCount: last.value.results.length,
    wallMs: performance.now() - commonStarted,
  }
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  await useOriginalText(page)
  await openOriginalSearch(page)
  await page.getByRole('textbox', { name: '全文搜索文字' }).fill(query)
  await page.getByRole('button', { name: '搜索原文', exact: true }).click()
  await expect(page.locator('.original-search-results button')).toHaveCount(
    found.value.results.length,
  )
  const positionBefore = await page
    .locator('audio')
    .evaluate((audio: HTMLAudioElement) => ({ paused: audio.paused, position: audio.currentTime }))
  assert.ok(positionBefore.paused)
  await page.locator('.original-search-results button').first().click()
  await expect(page.locator('.original-sentence[data-search-hit="true"]')).toHaveCount(
    found.value.results[0]!.last - found.value.results[0]!.first + 1,
  )
  const positionAfter = await page
    .locator('audio')
    .evaluate((audio: HTMLAudioElement) => ({ paused: audio.paused, position: audio.currentTime }))
  assert.deepEqual(positionAfter, positionBefore)
  report.locatePreservedPausedPosition = positionAfter
  await page.screenshot({ path: join(directory, 'real-original-search.png') })

  const exports: Record<string, unknown>[] = []
  for (const kind of ['transcript', 'original'] as const)
    for (const format of ['srt', 'vtt'] as const) {
      const destination = join(directory, `${kind}.${format}`)
      await app.evaluate(({ dialog }, path) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
      }, destination)
      const request: SubtitleExportRequest = {
        ...target,
        transcriptId: stored.id,
        transcriptRevision: stored.revision,
        format,
        ...(kind === 'original'
          ? {
              source: 'original' as const,
              originalId: info.id,
              alignmentRevision: alignment.revision,
            }
          : { source: 'transcript' as const }),
      }
      const result = await page.evaluate((input) => window.desktop.exportSubtitles(input), request)
      assert.ok(result.ok && !result.value.canceled)
      const contents = await readFile(destination, 'utf8')
      const cueTimes = [
        ...contents.matchAll(
          /^(\d+):(\d{2}):(\d{2})[,.](\d{3}) --> (\d+):(\d{2}):(\d{2})[,.](\d{3})$/gm,
        ),
      ].map((match) => ({
        startMs:
          Number(match[1]) * 3600000 +
          Number(match[2]) * 60000 +
          Number(match[3]) * 1000 +
          Number(match[4]),
        endMs:
          Number(match[5]) * 3600000 +
          Number(match[6]) * 60000 +
          Number(match[7]) * 1000 +
          Number(match[8]),
      }))
      const expected =
        kind === 'original'
          ? alignment.matches.filter((match) => match.selected)
          : stored.document.segments
      assert.deepEqual(
        cueTimes,
        expected.map(({ startMs, endMs }) => ({ startMs, endMs })),
      )
      assert.equal(result.value.cueCount, expected.length)
      assert.equal(
        result.value.skippedSegments,
        kind === 'original' ? alignment.matches.length - expected.length : 0,
      )
      exports.push({
        source: kind,
        format,
        cues: cueTimes.length,
        skipped: result.value.skippedSegments,
        bytes: Buffer.byteLength(contents),
        hash: await hash(destination),
      })
    }
  report.exports = exports
  assert.deepEqual(
    await page.evaluate((input) => window.desktop.getTranscript(input), target),
    transcript,
  )
  assert.deepEqual(
    await page.evaluate((input) => window.desktop.getOriginalState(input), target),
    initial,
  )
  report.savedTranscriptAndAlignmentUnchanged = true
  assert.deepEqual(errors, [])
  report.cleanup = await closeOwnedElectron(app)
  app = undefined
  assert.equal(await hash(sourceDatabase), sourceDatabaseHash)
  assert.equal(await hash(textPath), sourceTextHash)
  const afterStat = await stat(textPath)
  assert.deepEqual([afterStat.size, afterStat.mtimeMs], [beforeStat.size, beforeStat.mtimeMs])
  report.sourceDatabaseAndUserTextUnchanged = true
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.stack : String(error)
  process.exitCode = 1
} finally {
  if (app) {
    try {
      report.cleanup = await closeOwnedElectron(app)
    } catch (error) {
      report.cleanupError = String(error)
    }
  }
  report.finishedAt = new Date().toISOString()
  await save()
  console.log(JSON.stringify({ status: report.status, report: join(directory, 'report.json') }))
}
