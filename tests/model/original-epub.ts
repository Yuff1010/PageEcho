import {
  closeOriginalPanel,
  openOriginalSearch,
  openOriginalTools,
  openTranscriptImport,
  setVolume,
  useOriginalText,
} from '../helpers/ui'
// Official unmodified EPUB2/3 + frozen real 43-minute MP3/ASR; no new inference.
import assert from 'node:assert/strict'
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Worker } from 'node:worker_threads'
import { parseOriginal } from '../../src/main/original/parse'
import {
  ORIGINAL_MATCHER_VERSION,
  type OriginalMatch,
  type OriginalState,
} from '../../src/shared/original'
import type { TranscriptDocument } from '../../src/shared/transcript'
import type { SubtitleExportRequest } from '../../src/shared/subtitles'
import { closeOwnedElectron } from './electron-lifecycle'

const args = process.argv.slice(2)
assert.deepEqual(
  [args.length, args[0], args[2], args[4], args[6], args[8]],
  [10, '--app-root', '--old-app-root', '--manifest', '--audio-manifest', '--transcript'],
)
const appRoot = resolve(args[1]!),
  oldAppRoot = resolve(args[3]!),
  epubManifestPath = resolve(args[5]!),
  audioManifestPath = resolve(args[7]!),
  transcriptPath = resolve(args[9]!)
const epubManifest = JSON.parse(await readFile(epubManifestPath, 'utf8'))
const audioManifest = JSON.parse(await readFile(audioManifestPath, 'utf8'))
const document = JSON.parse(await readFile(transcriptPath, 'utf8')) as TranscriptDocument
assert.equal(document.kind, 'transcript')
assert.equal(epubManifest.catalog, 'https://www.gutenberg.org/ebooks/27166')
const audio = audioManifest.tracks.find(
  (track: { sha256: string }) => track.sha256 === document.audioHash,
)
assert.ok(audio && document.segments.length === 1006)
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
assert.equal(await hash(audio.sourcePath), document.audioHash)
const audioStat = await stat(audio.sourcePath)
for (const root of [appRoot, oldAppRoot]) {
  const manifest = JSON.parse(await readFile(resolve(root, '../manifest.json'), 'utf8'))
  for (const [path, digest] of Object.entries(manifest.outputHashes))
    assert.equal(await hash(join(root, 'out', path)), digest)
}
const directory = resolve(
  'cache/asr-evaluation/original-epub-runs',
  new Date().toISOString().replaceAll(':', '-'),
)
await mkdir(directory, { recursive: true })
await copyFile(resolve('tests/model/original-epub.ts'), join(directory, 'runner-started.ts'))
const userData = await mkdtemp(join(tmpdir(), '听读真实EPUB跨章 '))
const report: Record<string, unknown> = {
  status: 'running',
  startedAt: new Date().toISOString(),
  directory,
  appRoot,
  oldAppRoot,
  userData,
  runnerHash: await hash(join(directory, 'runner-started.ts')),
  buildManifestHash: await hash(resolve(appRoot, '../manifest.json')),
  epubManifestPath,
  epubManifestHash: await hash(epubManifestPath),
  audioManifestPath,
  audioManifestHash: await hash(audioManifestPath),
  sourceAudio: audio.sourcePath,
  audioHash: document.audioHash,
  transcriptPath,
  transcriptHash: await hash(transcriptPath),
  variants: [],
  scope:
    'Actual published single 43-minute MP3 and official unmodified traditional-Chinese EPUB2/3. Frozen ASR import, controlled old/new worker comparison, real UI chapter jumps and subtitle export, variant switch and restart. Publication is not a human spoken transcript; automatic counts are not accuracy.',
}
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
await save()
console.log(JSON.stringify({ stage: 'starting', report: join(directory, 'report.json') }))
async function baseline(parsed: ReturnType<typeof parseOriginal>): Promise<OriginalMatch[]> {
  const worker = new Worker(join(oldAppRoot, 'out/main/original-worker.js'), {
    workerData: { kind: 'match', original: parsed, transcript: document },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise((done, reject) => {
      timer = setTimeout(() => reject(new Error('Old worker timed out')), 60000)
      worker.once('error', reject)
      worker.once('message', (result) =>
        result.ok ? done(result.value) : reject(new Error(result.error.message)),
      )
      worker.once('exit', (code) => {
        if (code) reject(new Error(`Old worker exited ${code}`))
      })
    })
  } finally {
    clearTimeout(timer)
    await worker.terminate()
  }
}
let app: ElectronApplication | undefined
try {
  const env = { ...process.env, RALB_USER_DATA: userData }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  Reflect.deleteProperty(env, 'ELECTRON_RENDERER_URL')
  app = await electron.launch({ args: [appRoot], env })
  let page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const choose = async (path: string) =>
    app!.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] })
    }, path)
  await setVolume(page, '0')
  await choose(audio.sourcePath)
  await page.getByRole('button', { name: '选择音频文件', exact: true }).click()
  await page.getByRole('button', { name: '继续播放', exact: true }).click()
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  const library = await page.evaluate(() => window.desktop.getState())
  assert.ok(library.ok)
  const episode = library.value.books[0]!.episodes[0]!
  assert.equal(episode.contentHash, document.audioHash)
  const target = { episodeId: episode.id, audioHash: episode.contentHash }
  report.episode = episode
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  await choose(transcriptPath)
  await openTranscriptImport(page)
  await page.getByRole('button', { name: '导入 JSON 文稿', exact: true }).click()
  const savedTranscript = await page.evaluate(
    (input) => window.desktop.getTranscript(input),
    target,
  )
  assert.ok(savedTranscript.ok && savedTranscript.value.status === 'ready')
  assert.deepEqual(savedTranscript.value.transcript.document, document)
  await useOriginalText(page)
  const getOriginal = async (): Promise<OriginalState> => {
    const result = await page.evaluate((input) => window.desktop.getOriginalState(input), target)
    assert.ok(result.ok)
    return result.value
  }
  const snapshots: { path: string; state: OriginalState }[] = []
  for (const file of epubManifest.files as { path: string; sha256: string; variant: string }[]) {
    assert.equal(await hash(file.path), file.sha256)
    const parsed = parseOriginal(await readFile(file.path), file.path)
    const previous = await baseline(parsed)
    if (snapshots.length) await openOriginalTools(page, '原文来源')
    await choose(file.path)
    await page
      .getByRole('button', {
        name: snapshots.length ? '更换 TXT / EPUB 原文' : '导入 TXT / EPUB 原文',
        exact: true,
      })
      .click()
    await expect(page.getByRole('dialog', { name: '原文工具', exact: true })).toBeHidden({
      timeout: 70_000,
    })
    await expect(page.locator('.original-viewport')).toHaveAttribute('aria-busy', 'false', {
      timeout: 70_000,
    })
    await openOriginalTools(page, '原文来源')
    await expect(page.locator('.original-summary')).toContainText('EPUB')
    await expect
      .poll(async () => (await getOriginal()).info?.hash, { timeout: 70000 })
      .toBe(file.sha256)
    const imported = await getOriginal()
    assert.equal(imported.info?.hash, file.sha256)
    assert.equal(imported.info?.parserVersion, 3)
    assert.ok(imported.info.chapters.every((chapter) => chapter.count > 0))
    // Automatic matching may already populate a fresh version; earlier manual
    // choices must never be inherited by this newly imported document.
    assert.ok(
      imported.alignment === null || imported.alignment.matches.every((match) => !match.reviewed),
    )
    if (imported.alignment) assert.equal(imported.alignment.originalId, imported.info.id)
    await openOriginalTools(page)
    const beforeMatchRevision = (await getOriginal()).alignment?.revision ?? 0
    await page.getByRole('button', { name: /^(匹配这一集转写稿|重新匹配这一集)$/ }).click()
    await expect
      .poll(async () => (await getOriginal()).alignment?.revision, { timeout: 70000 })
      .toBeGreaterThan(beforeMatchRevision)
    await expect(page.getByRole('button', { name: '重新匹配这一集', exact: true })).toBeEnabled({
      timeout: 70_000,
    })
    const matched = await getOriginal()
    assert.ok(matched.info && matched.alignment && !matched.stale)
    assert.equal(matched.alignment.matcherVersion, ORIGINAL_MATCHER_VERSION)
    const selected = matched.alignment.matches.filter((match) => match.selected)
    assert.ok(selected.length > previous.filter((match) => match.selected).length)
    const chapters = matched.info.chapters.filter(
      (chapter) =>
        selected.some(
          (match) =>
            match.selected!.first < chapter.first + chapter.count &&
            match.selected!.last >= chapter.first,
        ) && /^第.*章/.test(chapter.title),
    )
    assert.ok(
      chapters.length >= 3,
      'No observed original chapter crossing in this actual single MP3',
    )
    const seeks = []
    await closeOriginalPanel(page)
    for (const chapter of chapters.slice(0, 3)) {
      const match = selected.find(
        (item) =>
          item.selected!.first >= chapter.first &&
          item.selected!.last < chapter.first + chapter.count,
      )!
      assert.ok(match)
      await page
        .getByRole('slider', { name: '播放进度', exact: true })
        .fill(String(match.startMs + 1))
      await page.getByRole('button', { name: '跟随原文播放位置', exact: true }).click()
      await expect(page.locator('.original-sentence[aria-current="true"]')).not.toHaveCount(0)
      await page.locator('.original-sentence.original-text[aria-current="true"]').first().click()
      const clock = await page.locator('audio').evaluate((audio: HTMLAudioElement) => ({
        positionMs: audio.currentTime * 1000,
        paused: audio.paused,
        source: audio.currentSrc,
      }))
      assert.ok(
        Math.abs(clock.positionMs - match.startMs) < 5 &&
          clock.paused &&
          clock.source.includes(episode.id),
      )
      seeks.push({ chapter: chapter.title, selected: match.selected, clock })
    }
    await page.screenshot({ path: join(directory, `${file.variant}-chapter-jump.png`) })
    await openOriginalSearch(page)
    await page.getByRole('textbox', { name: '全文搜索文字', exact: true }).fill('头发')
    await page.getByRole('button', { name: '搜索原文', exact: true }).click()
    await expect(page.locator('.original-search-results li').first()).toBeVisible()
    const searchExcerpt = await page.locator('.original-search-results').innerText()
    assert.match(searchExcerpt, /頭[髮發]/)
    await closeOriginalPanel(page)
    const srt = join(directory, file.variant + '-original.srt')
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    }, srt)
    const exportRequest: SubtitleExportRequest = {
      ...target,
      source: 'original',
      format: 'srt',
      originalId: matched.info.id,
      alignmentRevision: matched.alignment.revision,
      transcriptId: matched.alignment.transcriptId,
      transcriptRevision: matched.alignment.transcriptRevision,
    }
    const exported = await page.evaluate(
      (input) => window.desktop.exportSubtitles(input),
      exportRequest,
    )
    assert.ok(exported.ok && !exported.value.canceled)
    assert.equal(exported.value.cueCount, selected.length)
    assert.equal(exported.value.skippedSegments, document.segments.length - selected.length)
    const contents = await readFile(srt, 'utf8')
    assert.match(contents, /[傳為來頭髮]/)
    const times = [
      ...contents.matchAll(/^(\d+):(\d{2}):(\d{2}),(\d{3}) --> (\d+):(\d{2}):(\d{2}),(\d{3})$/gm),
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
    assert.deepEqual(
      times,
      selected.map(({ startMs, endMs }) => ({ startMs, endMs })),
    )
    await writeFile(
      join(directory, file.variant + '-comparison.json'),
      JSON.stringify(
        { originalHash: file.sha256, parsed, before: previous, after: matched.alignment },
        null,
        2,
      ) + '\n',
    )
    snapshots.push({ path: file.path, state: matched })
    ;(report.variants as unknown[]).push({
      variant: file.variant,
      path: file.path,
      hash: file.sha256,
      parserVersion: parsed.parserVersion,
      sections: parsed.chapters.length,
      sentences: parsed.sentences.length,
      total: document.segments.length,
      oldSelected: previous.filter((match) => match.selected).length,
      selected: selected.length,
      unselected: document.segments.length - selected.length,
      reviewed: selected.filter((match) => match.reviewed).length,
      chapters: chapters.map((chapter) => chapter.title),
      seeks,
      simplifiedSearchFoundTraditionalText: true,
      exportHash: await hash(srt),
    })
    await save()
    console.log(
      JSON.stringify({
        stage: 'variant-passed',
        variant: file.variant,
        selected: selected.length,
        chapters: chapters.map((chapter) => chapter.title),
      }),
    )
  }
  await openOriginalTools(page, '原文来源')
  await choose(snapshots[0]!.path)
  await page.getByRole('button', { name: '更换 TXT / EPUB 原文', exact: true }).click()
  await expect
    .poll(async () => (await getOriginal()).info?.id, { timeout: 70000 })
    .toBe(snapshots[0]!.state.info!.id)
  assert.deepEqual(await getOriginal(), snapshots[0]!.state)
  assert.deepEqual(
    await page.evaluate((input) => window.desktop.getTranscript(input), target),
    savedTranscript,
  )
  report.cleanupBeforeRestart = await closeOwnedElectron(app)
  app = undefined
  app = await electron.launch({ args: [appRoot], env })
  page = await app.firstWindow()
  assert.deepEqual(await getOriginal(), snapshots[0]!.state)
  assert.deepEqual(
    await page.evaluate((input) => window.desktop.getTranscript(input), target),
    savedTranscript,
  )
  report.restart = { originalAndAlignmentPreserved: true, transcriptUnchanged: true }
  assert.deepEqual(errors, [])
  report.cleanup = await closeOwnedElectron(app)
  app = undefined
  assert.equal(await hash(audio.sourcePath), document.audioHash)
  const afterStat = await stat(audio.sourcePath)
  assert.deepEqual([afterStat.size, afterStat.mtimeMs], [audioStat.size, audioStat.mtimeMs])
  for (const file of epubManifest.files) assert.equal(await hash(file.path), file.sha256)
  assert.equal(await hash(transcriptPath), report.transcriptHash)
  report.sourceFilesUnchanged = true
  report.accuracyStatus = 'unrated-no-human-spoken-transcript-or-boundaries'
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
