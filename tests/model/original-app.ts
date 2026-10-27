import {
  closeOriginalPanel,
  openCompanionTools,
  openOriginalContents,
  openOriginalTools,
  openTranscriptImport,
  setVolume,
  useOriginalText,
} from '../helpers/ui'
// Actual user-selected original through stock Electron. Audio/timestamps are test fixtures.
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseOriginal } from '../../src/main/original/parse'
import { closeOwnedElectron } from './electron-lifecycle'
import type { OriginalState, OriginalTarget } from '../../src/shared/original'
import type { TranscriptDocument } from '../../src/shared/transcript'

const args = process.argv.slice(2)
assert.equal(args.length, 4)
assert.equal(args[0], '--app-root')
assert.equal(args[2], '--text')
const appRoot = resolve(args[1]!),
  textPath = resolve(args[3]!)
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
const sourceBefore = {
  hash: await hash(textPath),
  size: (await stat(textPath)).size,
  modified: (await stat(textPath)).mtimeMs,
}
const parsed = parseOriginal(await readFile(textPath), textPath)
const chapter19 = parsed.chapters.find((chapter) => /^第19章/.test(chapter.title))!,
  chapter20 = parsed.chapters.find((chapter) => /^第20章/.test(chapter.title))!
assert.ok(chapter19 && chapter20)
const middle = parsed.sentences
  .slice(chapter19.first + 1, chapter19.first + chapter19.count - 1)
  .find((sentence) => sentence.text.replace(/\s/g, '').length >= 15)!
assert.ok(middle)
const directory = resolve(
  'cache/asr-evaluation/original-runs',
  new Date().toISOString().replaceAll(':', '-'),
)
await mkdir(directory, { recursive: true })
await copyFile(resolve('tests/model/original-app.ts'), join(directory, 'runner-started.ts'))
const userData = await mkdtemp(join(tmpdir(), '听读原文验收 ')),
  audio = resolve('tests/fixtures/第32集-伴读样本.wav')
const env = { ...process.env, RALB_USER_DATA: userData }
Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
Reflect.deleteProperty(env, 'ELECTRON_RENDERER_URL')
const report: Record<string, unknown> = {
  status: 'running',
  startedAt: new Date().toISOString(),
  directory,
  appRoot,
  userData,
  runnerSha256: await hash(join(directory, 'runner-started.ts')),
  sourceBefore,
  scope:
    'Actual user GB18030 TXT import/index, UI navigation, worker retrieval, review/version/restart preservation. Transcript excerpts selected from this text use synthetic fixture timestamps and unrelated fixture audio. No same-work audio, acoustic alignment or recognition-quality claim.',
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
  const choose = async (path: string | null) =>
    app!.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: selected === null,
        filePaths: selected ? [selected] : [],
      })
    }, path)
  await choose(audio)
  await page.getByRole('button', { name: '选择音频文件', exact: true }).click()
  await page.getByRole('button', { name: '继续播放', exact: true }).click()
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  const state = await page.evaluate(() => window.desktop.getState())
  assert.ok(state.ok)
  const episode = state.value.books[0]!.episodes[0]!,
    target: OriginalTarget = { episodeId: episode.id, audioHash: episode.contentHash }
  const transcript: TranscriptDocument = {
    version: 1,
    kind: 'manual',
    audioHash: episode.contentHash,
    coverage: [{ startMs: 0, endMs: 15000 }],
    segments: [
      { id: 'middle-of-chapter19', startMs: 1000, endMs: 3000, text: middle.text },
      {
        id: 'fixture-insertion',
        startMs: 5000,
        endMs: 7000,
        text: '这是一条测试专用的插话，内容与小说正文完全无关，请不要强行映射。',
      },
      {
        id: 'cross-chapter19-20',
        startMs: 9000,
        endMs: 12000,
        text: parsed.sentences
          .slice(chapter20.first - 2, chapter20.first + 2)
          .map((sentence) => sentence.text)
          .join(''),
      },
    ],
  }
  const transcriptFile = join(directory, 'synthetic-timestamps.json')
  await writeFile(transcriptFile, JSON.stringify(transcript))
  await setVolume(page, '0')
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  await choose(transcriptFile)
  await openTranscriptImport(page)
  await page.getByRole('button', { name: '导入 JSON 文稿', exact: true }).click()
  await expect(page.getByRole('button', { name: '导入 JSON 文稿', exact: true })).toBeHidden()
  await openCompanionTools(page)
  await expect(page.getByText('3 句 · 版本 1', { exact: true })).toBeVisible()
  await useOriginalText(page)
  const importedSource = async () => {
    await expect(page.getByRole('dialog', { name: '原文工具', exact: true })).toBeHidden({
      timeout: 70_000,
    })
    await expect(page.locator('.original-viewport')).toHaveAttribute('aria-busy', 'false', {
      timeout: 70_000,
    })
    await openOriginalTools(page, '原文来源')
  }
  await choose(textPath)
  const importStart = performance.now()
  await page.getByRole('button', { name: '导入 TXT / EPUB 原文', exact: true }).click()
  await importedSource()
  await expect(page.locator('.original-summary')).toContainText('gb18030', { timeout: 70_000 })
  report.importWallMs = performance.now() - importStart
  const originalState = async (): Promise<OriginalState> => {
    const result = await page.evaluate((input) => window.desktop.getOriginalState(input), target)
    assert.ok(result.ok)
    return result.value
  }
  const initial = await originalState()
  assert.ok(initial.info)
  assert.equal(initial.info.hash, sourceBefore.hash)
  assert.equal(initial.info.sentenceCount, parsed.sentences.length)
  report.imported = {
    id: initial.info.id,
    encoding: initial.info.encoding,
    chapters: initial.info.chapters.length,
    sentences: initial.info.sentenceCount,
    firstChapter: initial.info.chapters[0],
    lastChapter: initial.info.chapters.at(-1),
  }
  await openOriginalContents(page)
  await page
    .getByRole('combobox', { name: '原文章节', exact: true })
    .selectOption(String(chapter20.index))
  await expect(
    page
      .getByRole('region', { name: '小说原文', exact: true })
      .getByRole('heading', { name: chapter20.title, exact: true }),
  ).toBeVisible()
  await page.screenshot({ path: join(directory, 'actual-original-import.png'), fullPage: true })
  await page.getByRole('button', { name: '播放', exact: true }).click()
  const matchStart = performance.now(),
    ipc: number[] = []
  await openOriginalTools(page)
  await page.getByRole('button', { name: /^(匹配这一集转写稿|重新匹配这一集)$/ }).click()
  for (let i = 0; i < 20; i++) {
    const start = performance.now()
    await page.evaluate(() => window.desktop.getState())
    ipc.push(performance.now() - start)
    if (!(await page.getByRole('button', { name: '重新匹配这一集', exact: true }).count()))
      await page.waitForTimeout(50)
    else break
  }
  await expect(page.locator('.original-review summary')).toContainText('2 / 3', { timeout: 70_000 })
  await expect(page.getByRole('button', { name: '重新匹配这一集', exact: true })).toBeEnabled({
    timeout: 70_000,
  })
  report.matchWallMs = performance.now() - matchStart
  report.ipcSamplesMs = ipc
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  const aligned = await originalState()
  assert.equal(aligned.alignment!.matches[0]!.selected!.first, middle.ordinal)
  assert.equal(aligned.alignment!.matches[1]!.selected, null)
  assert.deepEqual(aligned.alignment!.matches[2]!.selected, {
    first: chapter20.first - 2,
    last: chapter20.first + 1,
    method: 'auto',
  })
  report.retrieval = aligned.alignment!.matches.map((match) => ({
    id: match.segmentId,
    selected: match.selected,
    scores: match.candidates.map((candidate) => candidate.score),
  }))
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('1500')
  await closeOriginalPanel(page)
  await page.getByRole('button', { name: '跟随原文播放位置', exact: true }).click()
  await expect(page.locator('.original-sentence[aria-current="true"]')).toHaveCount(1)
  await openOriginalTools(page)
  await page.locator('.original-review summary').click()
  await page.getByRole('button', { name: '校正原文与同步点', exact: true }).first().click()
  await page.getByLabel('起始秒', { exact: true }).fill('1.25')
  await page.getByLabel('结束秒', { exact: true }).fill('3.25')
  await page.getByRole('button', { name: '保存原文校正', exact: true }).click()
  await expect
    .poll(async () => (await originalState()).alignment?.revision)
    .toBe(aligned.alignment!.revision + 1)
  await page.getByRole('button', { name: '校正原文与同步点', exact: true }).last().click()
  await page.getByRole('button', { name: '保留空缺', exact: true }).click()
  await expect
    .poll(async () => (await originalState()).alignment?.revision)
    .toBe(aligned.alignment!.revision + 2)
  await page.getByRole('button', { name: '重新匹配这一集', exact: true }).click()
  await expect
    .poll(async () => (await originalState()).alignment?.revision, { timeout: 70_000 })
    .toBe(aligned.alignment!.revision + 3)
  const reviewed = await originalState()
  assert.equal(reviewed.alignment!.matches[0]!.startMs, 1250)
  assert.equal(reviewed.alignment!.matches[2]!.selected, null)
  assert.equal(reviewed.alignment!.matches[2]!.reviewed, true)
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('9500')
  await expect(page.locator('.original-sentence[aria-current="true"]')).toHaveCount(0)
  await closeOriginalPanel(page)
  await page.screenshot({ path: join(directory, 'manual-gap-retained.png'), fullPage: true })
  await openOriginalTools(page, '原文来源')
  await choose(null)
  await page.getByRole('button', { name: '更换 TXT / EPUB 原文', exact: true }).click()
  assert.equal((await originalState()).info!.id, initial.info.id)
  const invalid = join(directory, 'invalid.txt')
  await writeFile(invalid, Buffer.from([0, 1, 2]))
  await choose(invalid)
  await page.getByRole('button', { name: '更换 TXT / EPUB 原文', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('控制字符')
  assert.equal((await originalState()).info!.id, initial.info.id)
  const changed = join(directory, 'different-version.txt')
  await writeFile(changed, '第1章 新版本\n不同版本的正文需要独立映射，不应继承旧映射。')
  await choose(changed)
  await page.getByRole('button', { name: '更换 TXT / EPUB 原文', exact: true }).click()
  await importedSource()
  await expect(page.locator('.original-summary')).toContainText('different-version')
  const changedOriginal = await originalState()
  assert.ok(
    changedOriginal.alignment === null ||
      changedOriginal.alignment.matches.every(
        (match) => match.selected === null && !match.reviewed,
      ),
  )
  await choose(textPath)
  await page.getByRole('button', { name: '更换 TXT / EPUB 原文', exact: true }).click()
  await importedSource()
  await expect(page.locator('.original-summary')).toContainText('gb18030', { timeout: 70_000 })
  assert.deepEqual((await originalState()).alignment, reviewed.alignment)
  const interrupted = page.evaluate((input) => window.desktop.importOriginal(input), target)
  await page.waitForTimeout(20)
  const cancelResult = await page.evaluate(() => window.desktop.cancelOriginal())
  assert.ok(cancelResult.ok)
  const canceledImport = await interrupted
  assert.ok(!canceledImport.ok && canceledImport.error.code === 'BUSY')
  assert.deepEqual((await originalState()).alignment, reviewed.alignment)
  await page.getByRole('button', { name: '更换 TXT / EPUB 原文', exact: true }).click()
  await importedSource()
  await expect(page.locator('.original-summary')).toContainText('gb18030', { timeout: 70_000 })
  report.cancellation = {
    workerCanceled: true,
    previousAlignmentPreserved: true,
    subsequentImportPassed: true,
  }
  report.cleanups = [await closeOwnedElectron(app)]
  app = undefined
  app = await electron.launch({ args: [appRoot], env })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  const restored = await originalState()
  assert.deepEqual(restored.alignment, reviewed.alignment)
  const restoredTranscript = await page.evaluate(
    (input) => window.desktop.getTranscript(input),
    target,
  )
  assert.ok(restoredTranscript.ok && restoredTranscript.value.status === 'ready')
  assert.deepEqual(restoredTranscript.value.transcript.document, transcript)
  assert.deepEqual(
    {
      hash: await hash(textPath),
      size: (await stat(textPath)).size,
      modified: (await stat(textPath)).mtimeMs,
    },
    sourceBefore,
  )
  report.restored = {
    revision: restored.alignment!.revision,
    sameOriginalVersion: restored.info!.id === initial.info.id,
    transcriptUnchanged: true,
    sourceFileUnchanged: true,
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
    app = undefined
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
