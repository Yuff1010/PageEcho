import { leaveCompanionPage, menuAction, setVolume, toggleCompanionGeneration } from '../helpers/ui'
// Actual first/next ASR, cache eviction/refetch, and page-boundary playback after restart.
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { AppState } from '../../src/shared/contracts'
import { closeOwnedElectron } from './electron-lifecycle'

const args = process.argv.slice(2)
assert.equal(args.length, 4)
assert.equal(args[0], '--app-root')
assert.equal(args[2], '--component')
const appRoot = resolve(args[1]!),
  componentFile = resolve(args[3]!)
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
const manifestPath = resolve(appRoot, '../manifest.json'),
  build = JSON.parse(await readFile(manifestPath, 'utf8'))
assert.equal(build.appRoot, appRoot)
for (const [path, digest] of Object.entries(build.outputHashes))
  assert.equal(await hash(join(appRoot, 'out', path)), digest)
const directory = resolve(
  'cache/asr-evaluation/source-preparation-runs',
  new Date().toISOString().replaceAll(':', '-'),
)
await mkdir(directory, { recursive: true })
await copyFile(resolve('tests/model/source-preparation.ts'), join(directory, 'runner-started.ts'))
const userData = await mkdtemp(join(tmpdir(), '听读在线预处理验收 '))
const component = JSON.parse(await readFile(componentFile, 'utf8'))
assert.equal(component.version, 2)
for (const key of ['python', 'models', 'resources', 'ffmpeg', 'ffprobe'])
  component[key] = resolve(dirname(componentFile), component[key])
const config = join(directory, 'component.json')
await writeFile(config, JSON.stringify(component, null, 2))
const env: Record<string, string> = { RALB_USER_DATA: userData }
for (const [key, value] of Object.entries(process.env))
  if (
    value !== undefined &&
    ![
      'ralb_user_data',
      'electron_run_as_node',
      'electron_renderer_url',
      'ralb_executable',
    ].includes(key.toLowerCase())
  )
    env[key] = value
const report: Record<string, unknown> = {
  status: 'running',
  appRoot,
  userData,
  startedAt: new Date().toISOString(),
  buildManifestSha256: await hash(manifestPath),
  runnerSha256: await hash(join(directory, 'runner-started.ts')),
  stages: [],
  scope:
    'Actual anonymous source and portable Paraformer CUDA: current/next complete ASR, managed cache clear/refetch preserving documents/bookmarks/progress, restart with fresh catalog continuation from 60 to 61. Explicit seek-assisted EOF, no uninterrupted duration or human accuracy claim.',
}
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
const stage = async (name: string) => {
  ;(report.stages as unknown[]).push({ name, at: new Date().toISOString() })
  await save()
  console.log(JSON.stringify({ stage: name }))
}
await save()
console.log(JSON.stringify({ stage: 'starting', report: join(directory, 'report.json') }))
let app: ElectronApplication | undefined
try {
  app = await electron.launch({ args: [appRoot], env })
  let page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const state = async (): Promise<AppState> => {
    const r = await page.evaluate(() => window.desktop.getState())
    assert.ok(r.ok)
    return r.value
  }
  const clock = () =>
    page.locator('audio').evaluate((a: HTMLAudioElement) => ({
      positionMs: a.currentTime * 1000,
      durationMs: a.duration * 1000,
      source: a.currentSrc,
      paused: a.paused,
      error: a.error?.message ?? '',
    }))
  await page.getByRole('button', { name: '在线书源', exact: true }).click()
  await page.getByLabel('搜索书籍', { exact: true }).fill('众仙俯首')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page
    .getByRole('button', { name: '查看 众仙俯首 的详情', exact: true })
    .click({ timeout: 40000 })
  await expect(page.getByText('已读取 60 集 · 未完', { exact: true })).toBeVisible({
    timeout: 65000,
  })
  await page.getByRole('button', { name: '加入书架', exact: true }).click()
  await expect(page.getByRole('button', { name: '更新书架目录', exact: true })).toBeVisible()
  const original = (await state()).books.find((b) => b.online?.bookId === '39941')!
  const first = original.episodes[0]!,
    second = original.episodes[1]!,
    sixtieth = original.episodes[59]!
  report.identity = {
    bookId: original.id,
    firstId: first.id,
    secondId: second.id,
    sixtiethId: sixtieth.id,
  }
  await setVolume(page, '0')
  await page.getByRole('button', { name: `缓存并播放 ${first.title}`, exact: true }).click()
  await expect
    .poll(
      async () => {
        const c = await clock()
        return !c.paused && c.positionMs > 200
      },
      { timeout: 150000 },
    )
    .toBe(true)
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  const reader = page.getByRole('region', { name: '同步伴读', exact: true })
  await toggleCompanionGeneration(reader)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, config)
  await reader.getByRole('button', { name: '选择组件配置', exact: true }).click()
  await expect(reader.getByText('本地组件已配置', { exact: true })).toBeVisible()
  await menuAction(page, '播放选项', '收听工具')
  const tools = page.getByRole('dialog', { name: '收听工具', exact: true })
  const options = tools.getByRole('region', { name: '在线预处理', exact: true })
  const subtitles = tools.getByRole('region', { name: '字幕准备', exact: true })
  await subtitles.getByRole('combobox', { name: '字幕准备方案', exact: true }).selectOption('ahead')
  await subtitles
    .getByRole('combobox', { name: '字幕引擎', exact: true })
    .selectOption('paraformer')
  await subtitles.getByRole('combobox', { name: '字幕设备', exact: true }).selectOption('cuda')
  await subtitles.getByLabel('本集完成后准备下一集字幕', { exact: true }).check()
  await subtitles.getByRole('button', { name: '保存字幕准备设置', exact: true }).click()
  await expect(subtitles.getByText('本书字幕准备设置已保存。', { exact: true })).toBeVisible()
  await options.getByLabel('自动缓存下一集', { exact: true }).check()
  await options.getByRole('button', { name: '保存预处理设置', exact: true }).click()
  await expect(options.getByText('预处理设置已保存。', { exact: true })).toBeVisible()
  await stage('current-and-next-preparation-enabled-through-ui')
  await expect
    .poll(
      async () => {
        const jobs = await page.evaluate(() =>
          window.desktop.getTranscriptionJobs({ page: 0, activeOnly: false }),
        )
        const status = await page.evaluate(() => window.desktop.getSourcePreparationState())
        assert.ok(jobs.ok && status.ok)
        if (status.value.stage === 'failed') throw Error(status.value.message)
        const current = jobs.value.jobs.find((job) => job.episodeId === first.id),
          next = jobs.value.jobs.find((job) => job.episodeId === second.id)
        if (next?.status === 'running') assert.equal(current?.status, 'completed')
        await appendFile(
          join(directory, 'preparation-observations.jsonl'),
          JSON.stringify({
            at: new Date().toISOString(),
            status: status.value,
            jobs: jobs.value.jobs,
          }) + '\n',
        )
        report.preparationLatest = { status: status.value, jobs: jobs.value.jobs }
        await save()
        return current?.status === 'completed' && next?.status === 'completed'
      },
      { timeout: 600000, intervals: [1000] },
    )
    .toBe(true)
  const cached = (await state()).books.find((b) => b.id === original.id)!.episodes
  assert.equal(cached.filter((e) => e.online?.cached).length, 2)
  const firstHash = cached[0]!.contentHash,
    secondHash = cached[1]!.contentHash
  assert.ok(cached[1]!.durationMs)
  const nextJob = (
    report.preparationLatest as { jobs: { episodeId: string; rangeEndMs: number | null }[] }
  ).jobs.find((job) => job.episodeId === second.id)!
  assert.equal(nextJob.rangeEndMs, Math.round(cached[1]!.durationMs!))
  const target = { episodeId: first.id, audioHash: firstHash }
  const transcript = await page.evaluate((t) => window.desktop.getTranscript(t), target)
  assert.ok(transcript.ok)
  assert.equal(transcript.value.status, 'ready')
  report.transcriptSha256 = createHash('sha256')
    .update(JSON.stringify(transcript.value))
    .digest('hex')
  await page.screenshot({ path: join(directory, 'preparation-ready.png') })
  // Stop future speculative work while retaining the two completed jobs and audio files.
  await options.getByLabel('自动缓存下一集', { exact: true }).uncheck()
  await options.getByRole('button', { name: '保存预处理设置', exact: true }).click()
  await subtitles
    .getByRole('combobox', { name: '字幕准备方案', exact: true })
    .selectOption('manual')
  await subtitles.getByRole('button', { name: '保存字幕准备设置', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await state()).books.find((b) => b.id === original.id)!.subtitlePreparation?.mode ===
        'manual',
    )
    .toBe(true)
  await tools.getByRole('button', { name: '关闭收听工具', exact: true }).click()
  await stage('both-complete-source-transcripts-prepared-current-first')
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('180000')
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  const bookmark = await page.evaluate(
    (t) => window.desktop.saveBookmark({ ...t, positionMs: 180000, note: '在线缓存清理后保留' }),
    target,
  )
  assert.ok(bookmark.ok)
  await menuAction(page, '播放选项', '下一集')
  await expect.poll(async () => (await clock()).source.includes(second.id)).toBe(true)
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '播放', exact: true }).click()
  await expect.poll(async () => (await clock()).positionMs).toBeGreaterThan(200)
  assert.equal(
    (await state()).books.find((b) => b.id === original.id)!.episodes[1]!.contentHash,
    secondHash,
  )
  await leaveCompanionPage(page)
  await menuAction(page, '应用设置', '缓存与任务')
  const maintenance = page.getByRole('dialog', { name: '缓存与任务', exact: true })
  const panel = maintenance.getByRole('region', { name: '在线音频缓存', exact: true })
  await panel.getByRole('button', { name: '预览清理在线音频', exact: true }).click()
  const confirmation = panel.getByRole('group', { name: '确认清理在线音频', exact: true })
  await expect(confirmation).toContainText('将清理 1 个文件')
  await confirmation.getByRole('button', { name: '确认清理在线音频', exact: true }).click()
  await expect
    .poll(async () => {
      const r = await page.evaluate(() => window.desktop.getSourceCacheState())
      assert.ok(r.ok)
      return r.value.files
    })
    .toBe(1)
  let library = await state()
  assert.equal(library.books.find((b) => b.id === original.id)!.episodes[0]!.online!.cached, false)
  const kept = await page.evaluate((t) => window.desktop.getTranscript(t), target)
  assert.deepEqual(kept, transcript)
  const marks = await page.evaluate((id) => window.desktop.getBookmarks({ id }), original.id)
  assert.ok(marks.ok)
  assert.ok(marks.value.some((mark) => mark.id === bookmark.value.id))
  await page.screenshot({ path: join(directory, 'cache-cleared-current-retained.png') })
  await maintenance.getByRole('button', { name: '关闭缓存与任务', exact: true }).click()
  await leaveCompanionPage(page)
  await page.getByRole('button', { name: /我的书架/ }).click()
  await page.getByRole('button', { name: '打开 众仙俯首 的目录', exact: true }).click()
  await page.getByRole('button', { name: `播放第 1 集 ${first.title}`, exact: true }).click()
  await expect
    .poll(
      async () => {
        const c = await clock()
        return c.source.includes(first.id) && !c.paused && c.positionMs > 180100
      },
      { timeout: 150000 },
    )
    .toBe(true)
  assert.ok((await clock()).positionMs < 190000)
  assert.equal(
    (await state()).books.find((b) => b.id === original.id)!.episodes[0]!.contentHash,
    firstHash,
  )
  assert.deepEqual(await page.evaluate((t) => window.desktop.getTranscript(t), target), transcript)
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  const closed = await closeOwnedElectron(app)
  assert.equal(closed.kind, 'graceful')
  app = undefined
  report.firstCleanup = closed
  await stage('managed-cache-clear-refetch-preserved-document-bookmark-and-progress')
  app = await electron.launch({ args: [appRoot], env })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
  library = await state()
  assert.equal(library.books.find((b) => b.id === original.id)!.episodes.length, 60)
  await page.getByRole('button', { name: '打开 众仙俯首 的目录', exact: true }).click()
  await page.getByRole('button', { name: `播放第 60 集 ${sixtieth.title}`, exact: true }).click()
  await expect
    .poll(
      async () => {
        const c = await clock()
        return c.source.includes(sixtieth.id) && !c.paused && c.positionMs > 200
      },
      { timeout: 150000 },
    )
    .toBe(true)
  const sixty = await clock()
  await page
    .getByRole('slider', { name: '播放进度', exact: true })
    .fill(String(Math.floor(sixty.durationMs - 2000)))
  await expect
    .poll(
      async () => {
        const s = await state(),
          b = s.books.find((b) => b.id === original.id)!,
          episode = b.episodes.find((e) => e.order === 61),
          c = await clock()
        return (
          b.episodes.length === 120 &&
          !!episode &&
          s.currentEpisodeId === episode.id &&
          !c.paused &&
          c.positionMs > 200
        )
      },
      { timeout: 180000 },
    )
    .toBe(true)
  library = await state()
  const completed = library.books.find((b) => b.id === original.id)!
  assert.equal(completed.episodes[0]!.id, first.id)
  assert.equal(completed.episodes[59]!.id, sixtieth.id)
  assert.equal(completed.online!.catalogComplete, false)
  assert.equal(completed.online!.preparation.cacheNext, false)
  report.continuation = {
    from: { id: sixtieth.id, order: 60, media: sixty },
    to: { episode: completed.episodes[60], media: await clock() },
    catalogCount: completed.episodes.length,
  }
  report.cacheState = await page.evaluate(() => window.desktop.getSourceCacheState())
  await page.screenshot({ path: join(directory, 'automatic-page-continuation.png') })
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  assert.deepEqual(errors, [])
  await stage('fresh-restart-real-60-to-61-auto-next-with-catalog-continuation')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.stack : String(error)
  process.exitCode = 1
  await (
    await app?.firstWindow()
  )
    ?.screenshot({ path: join(directory, 'failure.png') })
    .catch(() => undefined)
} finally {
  if (app) {
    const cleanup = await closeOwnedElectron(app)
    report.finalCleanup = cleanup
    if (cleanup.kind !== 'graceful') {
      report.status = 'failed'
      process.exitCode = 1
    }
  }
  report.finishedAt = new Date().toISOString()
  await save()
}
console.log(
  JSON.stringify({
    status: report.status,
    error: report.error,
    report: join(directory, 'report.json'),
  }),
)
