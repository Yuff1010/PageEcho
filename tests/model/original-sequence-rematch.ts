import {
  closeOriginalPanel,
  leaveCompanionPage,
  openOriginalTools,
  useOriginalText,
} from '../helpers/ui'
// Compare frozen worker versions on adversarial text, then rematch frozen real episodes.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Worker } from 'node:worker_threads'
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'
import {
  ORIGINAL_MATCHER_VERSION,
  type OriginalMatch,
  type OriginalState,
  type OriginalTarget,
} from '../../src/shared/original'
import type { TranscriptDocument } from '../../src/shared/transcript'
import { parseOriginal } from '../../src/main/original/parse'
import { normalizeOriginal } from '../../src/main/original/normalize'
import { closeOwnedElectron } from './electron-lifecycle'

const args = process.argv.slice(2)
assert.deepEqual([args.length, args[0], args[2], args[4]], [6, '--app-root', '--report', '--text'])
const appRoot = resolve(args[1]!),
  sourceReport = resolve(args[3]!),
  textPath = resolve(args[5]!)
const source = JSON.parse(await readFile(sourceReport, 'utf8'))
assert.equal(source.status, 'passed')
const oldAppRoot = resolve(source.appRoot)
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
for (const root of [oldAppRoot, appRoot]) {
  const manifest = JSON.parse(await readFile(resolve(root, '../manifest.json'), 'utf8'))
  for (const [file, digest] of Object.entries(manifest.outputHashes))
    assert.equal(await hash(join(root, 'out', file)), digest)
}
const sourceDatabase = join(source.userData, 'data/library.sqlite3'),
  sourceDatabaseHash = await hash(sourceDatabase)
const originalStat = await stat(textPath),
  original = parseOriginal(await readFile(textPath), textPath)
assert.equal(original.hash, source.originalHash)
const directory = resolve(
  'cache/asr-evaluation/original-sequence-rematch-runs',
  new Date().toISOString().replaceAll(':', '-'),
)
await mkdir(directory, { recursive: true })
await copyFile(
  resolve('tests/model/original-sequence-rematch.ts'),
  join(directory, 'runner-started.ts'),
)
const report: Record<string, unknown> = {
  status: 'running',
  startedAt: new Date().toISOString(),
  directory,
  appRoot,
  oldAppRoot,
  sourceReport,
  sourceDatabaseHash,
  sourceReportHash: await hash(sourceReport),
  originalHash: original.hash,
  runnerHash: await hash(join(directory, 'runner-started.ts')),
  buildManifestHash: await hash(resolve(appRoot, '../manifest.json')),
  episodes: [],
  scope:
    'Same frozen real ASR on episodes 1/2/3, exact whole-original ambiguity repair, actual renderer IPC rematch/click and restart. Automatic mapping totals remain unreviewed; no new inference or human accuracy claim.',
}
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
await save()
console.log(JSON.stringify({ stage: 'starting', report: join(directory, 'report.json') }))
async function workerMatch(
  root: string,
  input: ReturnType<typeof parseOriginal>,
  transcript: TranscriptDocument,
): Promise<OriginalMatch[]> {
  const worker = new Worker(join(root, 'out/main/original-worker.js'), {
    workerData: { kind: 'match', original: input, transcript },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<OriginalMatch[]>((done, reject) => {
      timer = setTimeout(() => reject(new Error('Frozen worker comparison timed out')), 60_000)
      worker.once('error', reject)
      worker.once('exit', (code) => {
        if (code) reject(new Error(`Frozen worker exited ${code}`))
      })
      worker.once('message', (result) =>
        result.ok ? done(result.value) : reject(new Error(result.error.message)),
      )
    })
  } finally {
    clearTimeout(timer)
    await worker.terminate()
  }
}
let app: ElectronApplication | undefined
try {
  const query = '晨曦映照苍翠山谷少年背起行囊沿着石阶走向远处古老的城堡'
  const noise = Array.from({ length: query.length - 2 }, (_, i) => query.slice(i, i + 3))
    .reverse()
    .join('甲')
  const split = Array.from({ length: 4 }, (_, i) =>
    query.slice(Math.floor((i * query.length) / 4), Math.floor(((i + 1) * query.length) / 4)),
  )
  const distractions = Array.from({ length: 25 }, (_, i) => `第${i}处干扰${noise}。`).join('\n')
  const cases = [
    {
      name: 'duplicate-outside-shortlist',
      text: `第1章\n${query}。\n${distractions}\n第2章\n${split.join('。')}。`,
      parts: [query],
      ambiguous: true,
    },
    {
      name: 'duplicate-context-outside-shortlist',
      text: `第1章\n${query}。\n${distractions}\n第2章\n${split.join('。')}。`,
      parts: [query.slice(0, 16), query.slice(16)],
      ambiguous: true,
    },
    {
      name: 'unique-exact-outside-shortlist',
      text: `第1章\n${distractions}\n第2章\n${split.join('。')}。`,
      parts: [query],
      ambiguous: false,
    },
  ]
  const comparisons = []
  for (const fixture of cases) {
    const parsed = parseOriginal(Buffer.from(fixture.text), fixture.name + '.txt')
    const transcript: TranscriptDocument = {
      version: 1,
      audioHash: 'a'.repeat(64),
      kind: 'transcript',
      coverage: [{ startMs: 0, endMs: 10000 }],
      segments: fixture.parts.map((text, i) => ({
        id: `s${i}`,
        startMs: 1000 + i * 2000,
        endMs: 2000 + i * 2000,
        text,
      })),
    }
    const before = await workerMatch(oldAppRoot, parsed, transcript),
      after = await workerMatch(appRoot, parsed, transcript)
    if (fixture.ambiguous) {
      assert.ok(before.some((match) => match.selected))
      assert.ok(after.every((match) => match.selected === null))
    } else {
      assert.equal(before[0]?.selected, null)
      assert.deepEqual(after[0]?.selected, { first: 25, last: 28, method: 'auto' })
    }
    await writeFile(
      join(directory, fixture.name + '.json'),
      JSON.stringify({ parsed, transcript, before, after }, null, 2) + '\n',
    )
    comparisons.push({
      name: fixture.name,
      beforeSelected: before.filter((match) => match.selected).length,
      afterSelected: after.filter((match) => match.selected).length,
    })
  }
  report.frozenWorkerComparisons = comparisons
  const userData = await mkdtemp(join(tmpdir(), '听读真实原文全局复验 '))
  for (const entry of await readdir(source.userData))
    await cp(join(source.userData, entry), join(userData, entry), { recursive: true })
  report.userData = userData
  await save()
  const env = { ...process.env, RALB_USER_DATA: userData }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  Reflect.deleteProperty(env, 'ELECTRON_RENDERER_URL')
  app = await electron.launch({ args: [appRoot], env })
  let page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const state = await page.evaluate(() => window.desktop.getState())
  assert.ok(state.ok)
  const book = state.value.books.find((item) => item.online?.bookId === '38229')!
  assert.ok(book)
  const episodes = book.episodes.filter((episode) =>
    [1, ...source.requestedEpisodeOrders].includes(episode.order),
  )
  assert.equal(episodes.length, source.requestedEpisodeOrders.length + 1)
  const snapshots: { target: OriginalTarget; state: OriginalState }[] = []
  for (const episode of episodes) {
    const target = { episodeId: episode.id, audioHash: episode.contentHash }
    const before = await page.evaluate((input) => window.desktop.getOriginalState(input), target)
    const frozen = await page.evaluate(
      (input) => window.desktop.getTranscriptionState(input),
      target,
    )
    assert.ok(before.ok && before.value.stale && before.value.alignment && before.value.info)
    assert.ok(
      frozen.ok &&
        frozen.value.transcript.status === 'ready' &&
        frozen.value.job?.status === 'completed',
    )
    await leaveCompanionPage(page)
    await page.getByRole('button', { name: /我的书架/ }).click()
    await page.getByRole('button', { name: '打开 青山 的目录', exact: true }).click()
    await page
      .getByRole('button', { name: `播放第 ${episode.order} 集 ${episode.title}`, exact: true })
      .click()
    await expect
      .poll(() =>
        page
          .locator('audio')
          .evaluate(
            (audio: HTMLAudioElement, id) => audio.currentSrc.includes(id) && !audio.paused,
            episode.id,
          ),
      )
      .toBe(true)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
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
          const value = await page.evaluate(
            (input) => window.desktop.getOriginalState(input),
            target,
          )
          return value.ok ? value.value.alignment?.matcherVersion : 0
        },
        { timeout: 70_000 },
      )
      .toBe(ORIGINAL_MATCHER_VERSION)
    const after = await page.evaluate((input) => window.desktop.getOriginalState(input), target)
    assert.ok(after.ok && after.value.alignment && after.value.info && !after.value.stale)
    assert.equal(after.value.info.hash, original.hash)
    const oldMatches = new Map(
      before.value.alignment.matches.map((match) => [match.segmentId, match]),
    )
    const added = after.value.alignment.matches.filter(
      (match) => match.selected && !oldMatches.get(match.segmentId)?.selected,
    )
    const removed = before.value.alignment.matches.filter(
      (match) =>
        match.selected &&
        !after.value.alignment!.matches.find((item) => item.segmentId === match.segmentId)
          ?.selected,
    )
    const review = added.map((match) => {
      const text = original.sentences
        .slice(match.selected!.first, match.selected!.last + 1)
        .map((sentence) => sentence.text)
        .join('')
      assert.ok(normalizeOriginal(text).includes(normalizeOriginal(match.asrText)))
      return {
        segmentId: match.segmentId,
        startMs: match.startMs,
        endMs: match.endMs,
        asrText: match.asrText,
        selected: match.selected,
        originalText: text,
        basis: match.candidates[0]?.basis ?? 'direct',
        humanVerified: null,
      }
    })
    const chapters = after.value.info.chapters
      .filter((chapter) =>
        after.value.alignment!.matches.some(
          (match) =>
            match.selected &&
            match.selected.first < chapter.first + chapter.count &&
            match.selected.last >= chapter.first,
        ),
      )
      .map((chapter) => chapter.title)
    await writeFile(
      join(directory, `episode-${episode.order}-comparison.json`),
      JSON.stringify(
        { target, before: before.value, after: after.value, addedReview: review, removed },
        null,
        2,
      ) + '\n',
    )
    const unchanged = await page.evaluate(
      (input) => window.desktop.getTranscriptionState(input),
      target,
    )
    assert.deepEqual(unchanged, frozen)
    const first = after.value.alignment.matches.find((match) => match.selected)!
    await page
      .getByRole('slider', { name: '播放进度', exact: true })
      .fill(String(first.startMs + 1))
    await closeOriginalPanel(page)
    await page.getByRole('button', { name: '跟随原文播放位置', exact: true }).click()
    await expect(page.locator('.original-sentence[aria-current="true"]')).not.toHaveCount(0)
    await page.locator('.original-sentence.original-text[aria-current="true"]').first().click()
    const position = await page.locator('audio').evaluate((audio: HTMLAudioElement) => ({
      positionMs: audio.currentTime * 1000,
      paused: audio.paused,
    }))
    assert.ok(Math.abs(position.positionMs - first.startMs) < 5 && position.paused)
    await page.screenshot({ path: join(directory, `episode-${episode.order}-rematched.png`) })
    snapshots.push({ target, state: after.value })
    ;(report.episodes as unknown[]).push({
      order: episode.order,
      target,
      oldVersion: before.value.alignment.matcherVersion,
      newVersion: ORIGINAL_MATCHER_VERSION,
      total: after.value.alignment.matches.length,
      beforeSelected: before.value.alignment.matches.filter((match) => match.selected).length,
      afterSelected: after.value.alignment.matches.filter((match) => match.selected).length,
      added: added.length,
      removed: removed.length,
      reviewed: after.value.alignment.matches.filter((match) => match.reviewed).length,
      chapters,
      transcriptAndJobUnchanged: true,
      wallMs: performance.now() - started,
      clickSeek: position,
    })
    await save()
    console.log(
      JSON.stringify({
        stage: 'episode-rematched',
        order: episode.order,
        added: added.length,
        removed: removed.length,
      }),
    )
  }
  report.cleanupBeforeRestart = await closeOwnedElectron(app)
  app = undefined
  app = await electron.launch({ args: [appRoot], env })
  page = await app.firstWindow()
  for (const snapshot of snapshots)
    assert.deepEqual(
      await page.evaluate((input) => window.desktop.getOriginalState(input), snapshot.target),
      { ok: true, value: snapshot.state },
    )
  report.restart = { episodes: snapshots.length, alignmentsPreserved: true }
  assert.deepEqual(errors, [])
  report.cleanup = await closeOwnedElectron(app)
  app = undefined
  assert.equal(await hash(sourceDatabase), sourceDatabaseHash)
  assert.equal(await hash(textPath), original.hash)
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
