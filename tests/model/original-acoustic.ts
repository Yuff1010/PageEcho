import { closeOriginalPanel, openOriginalTools, useOriginalText } from '../helpers/ui'
// Opt-in real-model main-process integration, using an existing public human
// utterance reference. Coarse seeded clip bounds are not human timing labels.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { parseOriginal } from '../../src/main/original/parse'
import { createDataPaths } from '../../src/main/paths'
import type { OriginalTarget } from '../../src/shared/original'
import { closeOwnedElectron } from './electron-lifecycle'

const options: Record<string, string> = {}
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index],
    value = process.argv[index + 1]
  assert.ok(name && ['--app-root', '--component', '--request', '--output'].includes(name) && value)
  assert.equal(options[name], undefined, `Duplicate ${name}`)
  options[name] = value
}
assert.ok(options['--app-root'], 'Pass the frozen preview with --app-root.')
const appRoot = resolve(options['--app-root']),
  componentPath = resolve(
    options['--component'] ?? 'release/asr-component-0.7.0-win-x64/component.json',
  ),
  requestPath = resolve(
    options['--request'] ??
      'cache/optimization/original-acoustic-cli-2026-10-23/correct-cuda.request.json',
  ),
  directory = resolve(
    options['--output'] ??
      join(
        'cache/optimization/original-acoustic-main-runs',
        new Date().toISOString().replaceAll(':', '-'),
      ),
  )
await mkdir(directory, { recursive: true })
await copyFile(resolve('tests/model/original-acoustic.ts'), join(directory, 'runner-started.ts'))
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
const request = JSON.parse(await readFile(requestPath, 'utf8')) as {
  audioPath: string
  audioHash: string
  device: string
  text: string
  range: { startMs: number; endMs: number }
}
assert.equal(request.device, 'cuda')
assert.match(request.audioHash, /^[a-f0-9]{64}$/u)
assert.equal(await hash(request.audioPath), request.audioHash)
const cliReportPath = join(dirname(requestPath), 'report.json'),
  cliReport = JSON.parse(await readFile(cliReportPath, 'utf8')),
  referenceManifestPath = resolve(cliReport.manifest),
  referenceManifest = JSON.parse(await readFile(referenceManifestPath, 'utf8'))
assert.equal(await hash(referenceManifestPath), cliReport.manifestSha256)
const referenceSample = referenceManifest.samples.find(
  (sample: { audioHash: string }) => sample.audioHash === request.audioHash,
)
assert.ok(referenceSample, 'The source must bind to the existing human-reference manifest.')
assert.equal(
  referenceSample.reference.map((value: { text: string }) => value.text).join(''),
  request.text,
)
const component = JSON.parse(await readFile(componentPath, 'utf8')) as Record<
  string,
  string | number
>
assert.equal(
  component.version,
  2,
  'Use the pinned portable runtime; its model resources stay read-only.',
)
for (const key of ['python', 'models', 'resources', 'ffmpeg', 'ffprobe'])
  component[key] = resolve(dirname(componentPath), String(component[key]))
const buildManifestPath = resolve(appRoot, '../manifest.json'),
  build = JSON.parse(await readFile(buildManifestPath, 'utf8'))
assert.equal(build.status, 'built')
for (const [path, digest] of Object.entries(build.outputHashes))
  assert.equal(await hash(join(appRoot, 'out', path)), digest)
for (const [path, digest] of Object.entries(build.pythonHashes))
  assert.equal(await hash(join(appRoot, 'python', path)), digest)
const sourceStat = await stat(request.audioPath),
  sourceBefore = {
    sha256: request.audioHash,
    bytes: sourceStat.size,
    modifiedMs: sourceStat.mtimeMs,
  },
  durationMs =
    Number(
      execFileSync(
        String(component.ffprobe),
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=nw=1:nk=1',
          request.audioPath,
        ],
        { encoding: 'utf8', windowsHide: true },
      ).trim(),
    ) * 1000
assert.ok(Number.isFinite(durationMs) && durationMs > 0 && request.range.endMs <= durationMs + 1)
const userData = await mkdtemp(join(tmpdir(), '听读 真实原文声音对齐 '))
await writeFile(join(userData, 'asr-component.json'), JSON.stringify(component, null, 2))
const paths = createDataPaths(userData),
  store = new LibraryStore(paths.database)
store.importBook(await scanBook(request.audioPath, 'file'))
const episode = store.listBooks()[0]!.episodes[0]!,
  target: OriginalTarget = { episodeId: episode.id, audioHash: episode.contentHash },
  textBytes = Buffer.from(request.text, 'utf8'),
  parsed = parseOriginal(textBytes, '公开人工参考原文.txt')
assert.equal(episode.contentHash, request.audioHash)
assert.equal(parsed.sentences.map((sentence) => sentence.text).join(''), request.text)
store.recordSourceDuration(episode.id, episode.contentHash, durationMs)
const transcript = store.saveTranscript(episode.id, {
  version: 1,
  kind: 'manual',
  audioHash: episode.contentHash,
  coverage: [{ startMs: 0, endMs: Math.ceil(durationMs) }],
  segments: [{ id: 'confirmed-reference', ...request.range, text: request.text }],
})
assert.equal(transcript.status, 'ready')
if (transcript.status !== 'ready') throw new Error('Seeded transcript missing')
const imported = store.originals.import(target, parsed),
  selection = { first: 0, last: parsed.sentences.length - 1 }
store.originals.saveAlignment(
  target,
  imported.info!.id,
  transcript.transcript.id,
  transcript.transcript.revision,
  0,
  [
    {
      segmentId: 'confirmed-reference',
      ...request.range,
      asrText: request.text,
      reviewed: false,
      candidates: [],
      selected: { ...selection, method: 'auto' },
    },
  ],
)
const seeded = store.originals.correct({
  ...target,
  originalId: imported.info!.id,
  revision: 1,
  segmentId: 'confirmed-reference',
  selection,
  ...request.range,
})
store.saveProgress({
  sessionId: '',
  episodeId: episode.id,
  positionMs: 0,
  durationMs,
  rate: 1,
  volume: 0,
})
store.close()
await writeFile(join(directory, 'reference-original.txt'), textBytes)
await writeFile(join(directory, 'seeded-original.json'), JSON.stringify(seeded, null, 2))
const report: Record<string, unknown> = {
  status: 'running',
  startedAt: new Date().toISOString(),
  appRoot,
  previewVersion: build.previewVersion,
  directory,
  userData,
  target,
  sourceBefore,
  durationMs,
  runnerSha256: await hash(join(directory, 'runner-started.ts')),
  buildManifestPath,
  buildManifestSha256: await hash(buildManifestPath),
  componentPath,
  componentSha256: await hash(componentPath),
  modelsManifestSha256: await hash(String(component.models)),
  requestPath,
  requestSha256: await hash(requestPath),
  cliReportPath,
  cliReportSha256: await hash(cliReportPath),
  referenceManifestPath,
  referenceManifestSha256: await hash(referenceManifestPath),
  referenceSource: referenceManifest.source,
  referenceSample,
  originalDocumentSha256: parsed.hash,
  originalTextSha256: createHash('sha256').update(request.text).digest('hex'),
  seededManualRange: request.range,
  seededSentenceCount: parsed.sentences.length,
  stages: [],
  scope:
    'Real pinned CUDA alignment through stock Electron main/preload IPC, preview isolation, explicit adoption, original sentence highlight/seek, manual-range restoration and source/build integrity. Uses published human utterance text. Seeded manual bounds are coarse clip coordinates, not human phoneme/sentence times. One short calibration utterance, no new model-quality or human timing-accuracy estimate.',
}
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
async function stage(name: string, extra: Record<string, unknown> = {}) {
  ;(report.stages as unknown[]).push({ name, at: new Date().toISOString(), ...extra })
  await save()
  console.log(JSON.stringify({ stage: name, ...extra }))
}
const env = { ...process.env, RALB_USER_DATA: userData }
for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'RALB_EXECUTABLE'])
  Reflect.deleteProperty(env, name)
let app: ElectronApplication | undefined
try {
  await stage('starting', { report: join(directory, 'report.json') })
  app = await electron.launch({ args: [appRoot], env })
  const page = await app.firstWindow(),
    errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.context().setOffline(true)
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  await useOriginalText(page)
  await openOriginalTools(page)
  await page.locator('.original-review > summary').click()
  const acoustic = page.locator('.original-acoustic-alignment').first()
  await acoustic.locator(':scope > summary').click()
  const original = async () => {
    const result = await page.evaluate((input) => window.desktop.getOriginalState(input), target)
    assert.ok(result.ok)
    return result.value
  }
  const acousticState = async () => {
    const result = await page.evaluate(
      (input) => window.desktop.getOriginalAcousticState(input),
      target,
    )
    assert.ok(result.ok)
    return result.value
  }
  const before = await original()
  assert.deepEqual(before.alignment, seeded.alignment)
  const startedAt = performance.now(),
    start = await page.evaluate((input) => window.desktop.startOriginalAcousticAlignment(input), {
      ...target,
      originalId: before.info!.id,
      revision: before.alignment!.revision,
      segmentId: 'confirmed-reference',
      device: 'cuda' as const,
    })
  assert.ok(start.ok && start.value.job)
  assert.equal(start.value.job.status, 'running')
  assert.match(start.value.job.id, /^[a-f0-9-]{36}$/u)
  await expect(acoustic.getByRole('button', { name: '取消声音对齐', exact: true })).toBeVisible()
  await stage('running-cancelable', { jobId: start.value.job.id, cancelControlAvailable: true })
  assert.deepEqual((await original()).alignment, before.alignment)
  const observed: unknown[] = [],
    seen = new Set<string>()
  await expect
    .poll(
      async () => {
        const current = (await acousticState()).job
        assert.ok(current)
        const identity = `${current.status}:${current.stage}`
        if (!seen.has(identity)) {
          seen.add(identity)
          observed.push({
            status: current.status,
            stage: current.stage,
            at: new Date().toISOString(),
          })
          report.observedJobStates = observed
          await save()
        }
        if (['failed', 'rejected', 'canceled'].includes(current.status))
          throw new Error(
            `Real model did not return a reviewable proposal: ${current.status} ${current.error ?? JSON.stringify(current.result?.reasons)}`,
          )
        return current.status
      },
      { timeout: 180_000, intervals: [200, 500, 1000] },
    )
    .toBe('ready')
  const ready = (await acousticState()).job!
  assert.ok(ready.result && ready.result.status === 'accepted')
  assert.equal(ready.device, 'cuda')
  assert.ok(ready.result.sentenceTimes.length)
  assert.deepEqual((await original()).alignment, before.alignment)
  await writeFile(join(directory, 'real-model-proposal.json'), JSON.stringify(ready, null, 2))
  report.proposalWallMs = performance.now() - startedAt
  await stage('proposal-isolated', {
    resultPath: join(directory, 'real-model-proposal.json'),
    wallMs: report.proposalWallMs,
  })
  await acoustic.getByRole('button', { name: '采用新同步点', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(directory, 'real-proposal.png'), animations: 'disabled' })
  const adopted = await page.evaluate(
    (input) => window.desktop.applyOriginalAcousticAlignment(input),
    { id: ready.id, revision: before.alignment!.revision },
  )
  assert.ok(adopted.ok)
  const applied = adopted.value.alignment!.matches[0]!
  assert.equal(applied.acoustic?.id, ready.id)
  assert.deepEqual(applied.acoustic.manualRange, request.range)
  assert.deepEqual(applied.acoustic.sentenceTimes, ready.result.sentenceTimes)
  await writeFile(join(directory, 'adopted-original.json'), JSON.stringify(adopted.value, null, 2))
  await expect(
    acoustic.getByRole('button', { name: '恢复此前人工同步点', exact: true }),
  ).toBeVisible()
  await closeOriginalPanel(page)
  await page.getByRole('button', { name: '跟随原文播放位置', exact: true }).click()
  const mediaChecks: unknown[] = [],
    seek = page.getByRole('slider', { name: '播放进度', exact: true }),
    highlighted = page.locator('.original-sentence[aria-current="true"]')
  for (const sentence of ready.result.sentenceTimes) {
    const positionMs = Math.floor((sentence.startMs + sentence.endMs) / 2)
    await seek.fill(String(positionMs))
    await expect(highlighted).toHaveCount(1)
    await expect(highlighted).toHaveAttribute('data-ordinal', String(sentence.ordinal))
    await page
      .locator(`.original-sentence.original-text[data-ordinal="${sentence.ordinal}"]`)
      .click()
    await expect
      .poll(() =>
        page.locator('audio').evaluate((element: HTMLAudioElement) => element.currentTime),
      )
      .toBeCloseTo(sentence.startMs / 1000, 2)
    mediaChecks.push({
      ordinal: sentence.ordinal,
      midpointMs: positionMs,
      clickExpectedMs: sentence.startMs,
      actualMs: await page
        .locator('audio')
        .evaluate((element: HTMLAudioElement) => element.currentTime * 1000),
    })
  }
  const first = ready.result.sentenceTimes[0]!,
    last = ready.result.sentenceTimes.at(-1)!
  for (const positionMs of [
    first.startMs > 1 ? Math.floor(first.startMs / 2) : -1,
    last.endMs + 1 < durationMs ? Math.floor((last.endMs + durationMs) / 2) : -1,
  ]) {
    if (positionMs < 0) continue
    await seek.fill(String(positionMs))
    await expect(highlighted).toHaveCount(0)
    mediaChecks.push({ uncoveredPositionMs: positionMs, highlightedCount: 0 })
  }
  report.mediaChecks = mediaChecks
  await stage('adopted-sentence-sync-and-seek', {
    sentenceCount: ready.result.sentenceTimes.length,
  })
  const restored = await page.evaluate(
    (input) => window.desktop.restoreOriginalAcousticAlignment(input),
    {
      ...target,
      originalId: adopted.value.info!.id,
      revision: adopted.value.alignment!.revision,
      segmentId: 'confirmed-reference',
      historyId: applied.acoustic.id,
    },
  )
  assert.ok(restored.ok)
  const manual = restored.value.alignment!.matches[0]!
  assert.deepEqual({ startMs: manual.startMs, endMs: manual.endMs }, request.range)
  assert.equal(manual.acoustic, undefined)
  assert.deepEqual(manual.selected, before.alignment!.matches[0]!.selected)
  await writeFile(
    join(directory, 'restored-original.json'),
    JSON.stringify(restored.value, null, 2),
  )
  await stage('manual-range-restored')
  assert.deepEqual(errors, [])
  report.rendererErrors = errors
  report.cleanup = await closeOwnedElectron(app)
  assert.equal((report.cleanup as { kind: string }).kind, 'graceful')
  app = undefined
  const afterStat = await stat(request.audioPath)
  report.sourceAfter = {
    sha256: await hash(request.audioPath),
    bytes: afterStat.size,
    modifiedMs: afterStat.mtimeMs,
  }
  assert.deepEqual(report.sourceAfter, sourceBefore)
  assert.equal(await hash(buildManifestPath), report.buildManifestSha256)
  assert.equal(await hash(componentPath), report.componentSha256)
  assert.equal(await hash(String(component.models)), report.modelsManifestSha256)
  report.status = 'passed'
  report.finishedAt = new Date().toISOString()
  await stage('passed')
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
  report.finishedAt = new Date().toISOString()
  await save()
  throw error
} finally {
  if (app) {
    report.cleanup = await closeOwnedElectron(app)
    await save()
  }
}
