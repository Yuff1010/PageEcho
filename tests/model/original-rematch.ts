import { closeOriginalPanel, openOriginalTools, useOriginalText } from '../helpers/ui'
// Reuse frozen real ASR in a fresh copied profile; leave the original run unchanged.
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { closeOwnedElectron } from './electron-lifecycle'
import { ORIGINAL_MATCHER_VERSION } from '../../src/shared/original'

const args = process.argv.slice(2)
assert.equal(args.length, 4)
assert.equal(args[0], '--app-root')
assert.equal(args[2], '--report')
const appRoot = resolve(args[1]!),
  sourceReport = resolve(args[3]!),
  source = JSON.parse(await readFile(sourceReport, 'utf8'))
assert.equal(source.status, 'passed')
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
const sourceDatabase = join(source.userData, 'data/library.sqlite3'),
  sourceDatabaseHash = await hash(sourceDatabase)
const directory = resolve(
    'cache/asr-evaluation/original-rematch-runs',
    new Date().toISOString().replaceAll(':', '-'),
  ),
  userData = await mkdtemp(join(tmpdir(), '听读原文上下文复验 '))
await mkdir(directory, { recursive: true })
await copyFile(resolve('tests/model/original-rematch.ts'), join(directory, 'runner-started.ts'))
for (const entry of await readdir(source.userData))
  await cp(join(source.userData, entry), join(userData, entry), { recursive: true })
const report: Record<string, unknown> = {
  status: 'running',
  appRoot,
  userData,
  directory,
  sourceReport,
  sourceReportHash: await hash(sourceReport),
  sourceDatabaseHash,
  runnerSha256: await hash(join(directory, 'runner-started.ts')),
  buildManifestHash: await hash(resolve(appRoot, '../manifest.json')),
  startedAt: new Date().toISOString(),
  scope:
    'Actual Electron versioned text/context matcher using copied frozen same-work real MP3/ASR profile. Original ASR and source run untouched; no new inference. Automatic mappings remain unreviewed; count is not accuracy.',
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
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const target = {
    episodeId: source.audio.id as string,
    audioHash: source.audio.contentHash as string,
  }
  const state = await page.evaluate((input) => window.desktop.getOriginalState(input), target)
  assert.ok(state.ok && state.value.stale)
  const transcript = await page.evaluate((input) => window.desktop.getTranscript(input), target)
  assert.ok(transcript.ok && transcript.value.status === 'ready')
  const documentHash = createHash('sha256')
    .update(JSON.stringify(transcript.value.transcript.document))
    .digest('hex')
  assert.equal(documentHash, source.transcription.documentSha256)
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  await useOriginalText(page)
  await openOriginalTools(page)
  await expect(
    page.getByText('字幕或匹配规则已变化，旧同步位置暂不使用，请重新匹配。', { exact: true }),
  ).toBeVisible()
  const started = performance.now()
  await page.getByRole('button', { name: '重新匹配这一集', exact: true }).click()
  await expect
    .poll(
      async () => {
        const value = await page.evaluate((input) => window.desktop.getOriginalState(input), target)
        return value.ok ? value.value.alignment?.matcherVersion : 0
      },
      { timeout: 70_000 },
    )
    .toBe(ORIGINAL_MATCHER_VERSION)
  report.matchWallMs = performance.now() - started
  const after = await page.evaluate((input) => window.desktop.getOriginalState(input), target)
  assert.ok(after.ok && after.value.alignment && !after.value.stale)
  const matches = after.value.alignment.matches,
    accepted = matches.filter((match) => match.selected),
    context = accepted.filter((match) => match.candidates[0]?.basis === 'context')
  assert.ok(accepted.length >= source.matching.accepted)
  assert.ok(context.length > 0)
  report.matching = {
    matcherVersion: ORIGINAL_MATCHER_VERSION,
    revision: after.value.alignment.revision,
    originalId: after.value.info!.id,
    originalHash: after.value.info!.hash,
    total: matches.length,
    accepted: accepted.length,
    priorAccepted: source.matching.accepted,
    contextAccepted: context.length,
    unmatched: matches.length - accepted.length,
    withCandidates: matches.filter((match) => match.candidates.length).length,
    reviewed: matches.filter((match) => match.reviewed).length,
  }
  await page
    .getByRole('slider', { name: '播放进度', exact: true })
    .fill(String(context[0]!.startMs + 10))
  await closeOriginalPanel(page)
  await page.getByRole('button', { name: '跟随原文播放位置', exact: true }).click()
  await expect(page.locator('.original-sentence[aria-current="true"]')).not.toHaveCount(0)
  await page.locator('.original-sentence.original-text[aria-current="true"]').first().click()
  const clock = await page.locator('audio').evaluate((audio: HTMLAudioElement) => ({
    positionMs: audio.currentTime * 1000,
    paused: audio.paused,
  }))
  // Multiple ASR parts may map to one original sentence; its nearest time is selected.
  assert.equal(clock.paused, true)
  report.clickSeek = clock
  await page.screenshot({ path: join(directory, 'same-work-context-matched.png'), fullPage: true })
  const job = await page.evaluate((input) => window.desktop.getTranscriptionState(input), target)
  assert.ok(job.ok)
  assert.equal(job.value.job?.id, source.transcription.job.id)
  assert.equal(job.value.job?.attempt, source.transcription.job.attempt)
  assert.equal(job.value.job?.updatedAt, source.transcription.job.updatedAt)
  report.transcriptUnchanged = documentHash === source.transcription.documentSha256
  report.asrReusedWithoutNewAttempt = true
  assert.deepEqual(errors, [])
  report.cleanup = await closeOwnedElectron(app)
  app = undefined
  assert.equal(await hash(sourceDatabase), sourceDatabaseHash)
  report.originalSourceDatabaseUnchanged = true
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
      matching: report.matching,
      error: report.error,
    }),
  )
}
