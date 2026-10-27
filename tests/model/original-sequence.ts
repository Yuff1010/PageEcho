import {
  closeCompanionPanel,
  closeOriginalPanel,
  leaveCompanionPage,
  openCompanionTools,
  openOriginalTools,
  setSubtitleProfile,
  setVolume,
  toggleCompanionGeneration,
  useOriginalText,
} from '../helpers/ui'
// Opt-in real adjacent episodes, original chapter coverage and restart persistence.
// Automatic text mappings are observations, never human accuracy labels.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import type { AppState } from '../../src/shared/contracts'
import {
  ORIGINAL_MATCHER_VERSION,
  type OriginalState,
  type OriginalTarget,
} from '../../src/shared/original'
import type { StoredTranscript } from '../../src/shared/transcript'
import { parseOriginal } from '../../src/main/original/parse'
import { closeOwnedElectron } from './electron-lifecycle'

const args = process.argv.slice(2)
assert.deepEqual(
  [args.length, args[0], args[2], args[4], args[6], args[8]],
  [10, '--app-root', '--component', '--report', '--text', '--episodes'],
)
const appRoot = resolve(args[1]!),
  componentPath = resolve(args[3]!),
  sourceReport = resolve(args[5]!),
  textPath = resolve(args[7]!)
const episodeOrders = args[9]!.split(',').map(Number)
assert.ok(
  episodeOrders.length > 0 &&
    episodeOrders.length <= 5 &&
    episodeOrders.every(
      (n, i) =>
        Number.isSafeInteger(n) &&
        n >= 2 &&
        n <= 20 &&
        (i === 0 || n === episodeOrders[i - 1]! + 1),
    ),
)
const source = JSON.parse(await readFile(sourceReport, 'utf8'))
assert.equal(source.status, 'passed')
const firstSource = JSON.parse(await readFile(source.sourceReport, 'utf8'))
assert.equal(firstSource.status, 'passed')
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
const sourceDatabase = join(source.userData, 'data/library.sqlite3'),
  sourceDatabaseHash = await hash(sourceDatabase)
const originalBytes = await readFile(textPath),
  originalStat = await stat(textPath),
  parsed = parseOriginal(originalBytes, textPath)
assert.equal(parsed.hash, source.matching.originalHash)
const directory = resolve(
  'cache/asr-evaluation/original-sequence-runs',
  new Date().toISOString().replaceAll(':', '-'),
)
await mkdir(directory, { recursive: true })
await copyFile(resolve('tests/model/original-sequence.ts'), join(directory, 'runner-started.ts'))
const userData = await mkdtemp(join(tmpdir(), '听读真实跨集原文 '))
for (const entry of await readdir(source.userData))
  await cp(join(source.userData, entry), join(userData, entry), { recursive: true })
const component = JSON.parse(await readFile(componentPath, 'utf8'))
assert.equal(component.version, 2)
for (const key of ['python', 'models', 'resources', 'ffmpeg', 'ffprobe'])
  component[key] = resolve(dirname(componentPath), component[key])
const config = join(directory, 'component.json')
await writeFile(config, JSON.stringify(component, null, 2))
const build = JSON.parse(await readFile(resolve(appRoot, '../manifest.json'), 'utf8'))
for (const [file, digest] of Object.entries(build.outputHashes))
  assert.equal(await hash(join(appRoot, 'out', file)), digest)
const report: Record<string, unknown> = {
  status: 'running',
  startedAt: new Date().toISOString(),
  directory,
  appRoot,
  userData,
  sourceReport,
  sourceReportHash: await hash(sourceReport),
  sourceDatabaseHash,
  originalHash: parsed.hash,
  originalBytes: originalStat.size,
  originalModified: originalStat.mtimeMs,
  runnerHash: await hash(join(directory, 'runner-started.ts')),
  buildManifestHash: await hash(resolve(appRoot, '../manifest.json')),
  requestedEpisodeOrders: episodeOrders,
  episodes: [],
  stages: [],
  scope:
    'Frozen actual first-episode baseline plus actual adjacent same-work MP3/Paraformer CUDA in a copied profile. Independent per-episode original mappings, chapter coverage, click seek and restart. No human mapping, speech-recognition or acoustic-boundary accuracy claim.',
}
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
async function stage(name: string, extra: Record<string, unknown> = {}) {
  ;(report.stages as unknown[]).push({ name, at: new Date().toISOString(), ...extra })
  await save()
  console.log(JSON.stringify({ stage: name, ...extra }))
}
await stage('starting', { report: join(directory, 'report.json') })
let app: ElectronApplication | undefined
const snapshots: {
  target: OriginalTarget
  original: OriginalState
  transcript: StoredTranscript
}[] = []
try {
  const env = { ...process.env, RALB_USER_DATA: userData }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  Reflect.deleteProperty(env, 'ELECTRON_RENDERER_URL')
  app = await electron.launch({ args: [appRoot], env })
  let page = await app.firstWindow()
  const errors: string[] = []
  const observeErrors = (p: Page) => p.on('pageerror', (error) => errors.push(error.message))
  observeErrors(page)
  const state = async (): Promise<AppState> => {
    const result = await page.evaluate(() => window.desktop.getState())
    assert.ok(result.ok)
    return result.value
  }
  const getOriginal = async (target: OriginalTarget) => {
    const result = await page.evaluate((input) => window.desktop.getOriginalState(input), target)
    assert.ok(result.ok)
    return result.value
  }
  const getTranscript = async (target: OriginalTarget) => {
    const result = await page.evaluate((input) => window.desktop.getTranscript(input), target)
    assert.ok(result.ok && result.value.status === 'ready')
    return result.value.transcript
  }
  const firstTarget = {
    episodeId: firstSource.audio.id as string,
    audioHash: firstSource.audio.contentHash as string,
  }
  let initial = await getOriginal(firstTarget)
  assert.ok(initial.info && initial.alignment)
  if (initial.stale) {
    const before = initial.alignment
    const matched = await page.evaluate((input) => window.desktop.matchOriginal(input), firstTarget)
    assert.ok(matched.ok && matched.value.alignment && !matched.value.stale)
    assert.equal(matched.value.alignment.matcherVersion, ORIGINAL_MATCHER_VERSION)
    initial = matched.value
    report.firstEpisodeRuleRefresh = {
      from: before.matcherVersion,
      to: ORIGINAL_MATCHER_VERSION,
      oldRevision: before.revision,
      newRevision: initial.alignment!.revision,
    }
  }
  assert.ok(initial.info && initial.alignment && !initial.stale)
  assert.equal(initial.info.hash, parsed.hash)
  snapshots.push({
    target: firstTarget,
    original: initial,
    transcript: await getTranscript(firstTarget),
  })
  const library = await state(),
    book = library.books.find((item) => item.id === firstSource.audio.bookId)!
  assert.ok(book?.online?.bookId === '38229')
  const selected = episodeOrders.map((order) => book.episodes.find((item) => item.order === order)!)
  assert.ok(selected.every((episode) => !!episode && !episode.contentHash))
  report.selectedBeforeProcessing = selected
  await save()
  await setVolume(page, '0')
  await app.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
  }, config)
  const configured = await page.evaluate(() => window.desktop.configureTranscription())
  assert.ok(configured.ok && !configured.value.canceled)

  for (const episode of selected) {
    await stage('opening-next-real-episode', { order: episode.order, title: episode.title })
    await leaveCompanionPage(page)
    await page.getByRole('button', { name: /我的书架/ }).click()
    await page.getByRole('button', { name: '打开 青山 的目录', exact: true }).click()
    await page
      .getByRole('button', { name: `播放第 ${episode.order} 集 ${episode.title}`, exact: true })
      .click()
    await expect
      .poll(
        () =>
          page
            .locator('audio')
            .evaluate(
              (audio: HTMLAudioElement, id) =>
                audio.currentSrc.includes(id) && !audio.paused && audio.currentTime > 0.2,
              episode.id,
            ),
        { timeout: 150_000 },
      )
      .toBe(true)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    const materialized = (await state()).books
      .find((item) => item.id === book.id)!
      .episodes.find((item) => item.id === episode.id)!
    assert.ok(materialized.contentHash && materialized.durationMs)
    const target = { episodeId: materialized.id, audioHash: materialized.contentHash }
    assert.equal((await getOriginal(target)).info?.id, initial.info.id)
    assert.equal((await getOriginal(target)).alignment, null)
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    const reader = page.getByRole('region', { name: '同步伴读', exact: true })
    await reader.getByRole('button', { name: '转写字幕', exact: true }).click()
    await toggleCompanionGeneration(reader)
    await setSubtitleProfile(page, { engine: 'paraformer', device: 'cuda' })
    await openCompanionTools(reader)
    await reader.getByRole('button', { name: '生成转写稿', exact: true }).click()
    await closeCompanionPanel(reader)
    await stage('real-asr-started', { order: episode.order, target, audio: materialized })
    let completed = false
    const deadline = Date.now() + 600_000
    for (let tick = 0; Date.now() < deadline; tick++) {
      const current = await page.evaluate(
        (input) => window.desktop.getTranscriptionState(input),
        target,
      )
      assert.ok(current.ok)
      if (current.value.job?.status === 'failed' || current.value.job?.status === 'canceled')
        throw new Error(current.value.job.error ?? 'ASR stopped')
      if (current.value.job?.status === 'completed') {
        completed = true
        break
      }
      if (tick % 5 === 0) {
        report.currentJob = current.value.job
        await save()
      }
      await delay(1000)
    }
    assert.ok(completed, 'Real transcription did not complete before deadline')
    const processing = await page.evaluate(
      (input) => window.desktop.getTranscriptionState(input),
      target,
    )
    assert.ok(processing.ok && processing.value.job?.status === 'completed')
    const transcript = await getTranscript(target)
    await stage('real-asr-completed', {
      order: episode.order,
      chunks: processing.value.job.completedChunks,
      segments: transcript.document.segments.length,
    })
    await writeFile(
      join(directory, `episode-${episode.order}-transcript.json`),
      JSON.stringify(transcript, null, 2) + '\n',
    )
    await useOriginalText(reader)
    await openOriginalTools(reader)
    const beforeMatchRevision = (await getOriginal(target)).alignment?.revision ?? 0
    await reader.getByRole('button', { name: /^(匹配这一集转写稿|重新匹配这一集)$/ }).click()
    await expect
      .poll(async () => (await getOriginal(target)).alignment?.revision, { timeout: 70_000 })
      .toBeGreaterThan(beforeMatchRevision)
    await expect(reader.getByRole('button', { name: '重新匹配这一集', exact: true })).toBeEnabled({
      timeout: 70_000,
    })
    const matched = await getOriginal(target)
    assert.ok(matched.alignment && !matched.stale)
    assert.equal(matched.info?.id, initial.info.id)
    const accepted = matched.alignment.matches.filter((match) => match.selected)
    assert.ok(accepted.length, 'No actual text mapping observed')
    const chapters = initial.info.chapters
      .filter((chapter) =>
        accepted.some(
          (match) =>
            match.selected!.first < chapter.first + chapter.count &&
            match.selected!.last >= chapter.first,
        ),
      )
      .map((chapter) => ({
        index: chapter.index,
        title: chapter.title,
        first: chapter.first,
        count: chapter.count,
      }))
    await writeFile(
      join(directory, `episode-${episode.order}-alignment.json`),
      JSON.stringify(matched.alignment, null, 2) + '\n',
    )
    const chosen =
      accepted.find((match) =>
        initial.info!.chapters.some(
          (chapter) =>
            match.selected!.first < chapter.first && match.selected!.last >= chapter.first,
        ),
      ) ?? accepted[0]!
    await page
      .getByRole('slider', { name: '播放进度', exact: true })
      .fill(String(chosen.startMs + 1))
    await closeOriginalPanel(reader)
    await reader.getByRole('button', { name: '跟随原文播放位置', exact: true }).click()
    await expect(page.locator('.original-sentence[aria-current="true"]')).not.toHaveCount(0)
    await page.locator('.original-sentence.original-text[aria-current="true"]').first().click()
    const clock = await page.locator('audio').evaluate((audio: HTMLAudioElement) => ({
      positionMs: audio.currentTime * 1000,
      paused: audio.paused,
      volume: audio.volume,
    }))
    assert.ok(Math.abs(clock.positionMs - chosen.startMs) < 5)
    assert.equal(clock.paused, true)
    assert.equal(clock.volume, 0)
    await page.screenshot({ path: join(directory, `episode-${episode.order}-original.png`) })
    snapshots.push({ target, original: matched, transcript })
    ;(report.episodes as unknown[]).push({
      order: episode.order,
      audio: materialized,
      job: processing.value.job,
      transcriptHash: createHash('sha256')
        .update(JSON.stringify(transcript.document))
        .digest('hex'),
      total: matched.alignment.matches.length,
      selected: accepted.length,
      unmatched: matched.alignment.matches.length - accepted.length,
      reviewed: matched.alignment.matches.filter((match) => match.reviewed).length,
      chapters,
      clickSeek: clock,
    })
    await save()
  }
  const chapterEpisodes = initial.info.chapters
    .map((chapter) => ({
      index: chapter.index,
      title: chapter.title,
      episodes: snapshots
        .filter((snapshot) =>
          snapshot.original.alignment!.matches.some(
            (match) =>
              match.selected &&
              match.selected.first < chapter.first + chapter.count &&
              match.selected.last >= chapter.first,
          ),
        )
        .map(
          (snapshot) =>
            book.episodes.find((episode) => episode.id === snapshot.target.episodeId)!.order,
        ),
    }))
    .filter((chapter) => chapter.episodes.length)
  report.chapterEpisodes = chapterEpisodes
  report.coverage = {
    multipleChapters: chapterEpisodes.length >= 2,
    chapterAcrossEpisodes: chapterEpisodes.some((chapter) => chapter.episodes.length >= 2),
    episodeAcrossChapters: snapshots.some(
      (snapshot) =>
        chapterEpisodes.filter((chapter) =>
          chapter.episodes.includes(
            book.episodes.find((episode) => episode.id === snapshot.target.episodeId)!.order,
          ),
        ).length >= 2,
    ),
  }
  const review = snapshots.flatMap((snapshot, i) => {
    const matches = snapshot.original.alignment!.matches
    const selected = matches.filter((match) => match.selected)
    const choices = [
      ...new Set([
        matches[0],
        matches.at(-1),
        selected[0],
        selected.at(-1),
        matches.find((match) => !match.selected),
      ]),
    ].filter((match) => !!match)
    return choices.map((match) => ({
      id: `${i + 1}:${match.segmentId}`,
      episodeId: snapshot.target.episodeId,
      audioHash: snapshot.target.audioHash,
      startMs: match.startMs,
      endMs: match.endMs,
      asrText: match.asrText,
      selected: match.selected,
      originalText: match.selected
        ? parsed.sentences
            .slice(match.selected.first, match.selected.last + 1)
            .map((sentence) => sentence.text)
            .join('')
        : null,
      humanReview: {
        spokenText: null,
        selectionCorrect: null,
        startErrorMs: null,
        endErrorMs: null,
        notes: null,
      },
    }))
  })
  await writeFile(
    join(directory, 'review-template.json'),
    JSON.stringify(
      {
        status: 'unreviewed',
        originalHash: parsed.hash,
        scope: 'Machine-selected text excerpts are not reference labels. Human fields start empty.',
        items: review,
      },
      null,
      2,
    ) + '\n',
  )
  report.cleanupBeforeRestart = await closeOwnedElectron(app)
  app = undefined
  app = await electron.launch({ args: [appRoot], env })
  page = await app.firstWindow()
  observeErrors(page)
  for (const snapshot of snapshots) {
    assert.deepEqual(await getOriginal(snapshot.target), snapshot.original)
    assert.deepEqual(await getTranscript(snapshot.target), snapshot.transcript)
  }
  report.restart = {
    episodes: snapshots.length,
    originalId: initial.info.id,
    transcriptsAndAlignmentsPreserved: true,
    firstFrozenTranscriptUnchanged: true,
  }
  assert.deepEqual(errors, [])
  report.cleanup = await closeOwnedElectron(app)
  app = undefined
  assert.equal(await hash(sourceDatabase), sourceDatabaseHash)
  assert.equal(await hash(textPath), parsed.hash)
  const afterStat = await stat(textPath)
  assert.deepEqual([afterStat.size, afterStat.mtimeMs], [originalStat.size, originalStat.mtimeMs])
  report.sourceDatabaseAndOriginalUnchanged = true
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
  console.log(
    JSON.stringify({
      status: report.status,
      report: join(directory, 'report.json'),
      error: report.error,
    }),
  )
}
