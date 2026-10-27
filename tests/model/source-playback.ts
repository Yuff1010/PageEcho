import {
  closeCompanionPanel,
  menuAction,
  openCompanionTools,
  setSubtitleProfile,
  setVolume,
  toggleCompanionGeneration,
} from '../helpers/ui'
// Opt-in real-source download/playback/restart and optional full ASR, in a preview build.
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { closeOwnedElectron } from './electron-lifecycle'
import type { AppState, Episode } from '../../src/shared/contracts'

const args = process.argv.slice(2)
let appRoot = '',
  componentPath = ''
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--app-root' && args[i + 1]) appRoot = resolve(args[++i]!)
  else if (args[i] === '--component' && args[i + 1]) componentPath = resolve(args[++i]!)
  else
    throw Error(
      'Usage: npm run test:source:playback -- --app-root <preview app> [--component <portable component.json>]',
    )
}
assert.ok(appRoot)
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
const manifestPath = resolve(appRoot, '../manifest.json')
const build = JSON.parse(await readFile(manifestPath, 'utf8'))
assert.equal(build.appRoot, appRoot)
for (const [path, digest] of Object.entries(build.outputHashes))
  assert.equal(await hash(join(appRoot, 'out', path)), digest)
const directory = resolve(
  'cache/asr-evaluation/source-playback-runs',
  new Date().toISOString().replaceAll(':', '-'),
)
await mkdir(directory, { recursive: true })
await copyFile(resolve('tests/model/source-playback.ts'), join(directory, 'runner-started.ts'))
await copyFile(
  resolve('tests/model/electron-lifecycle.ts'),
  join(directory, 'lifecycle-started.ts'),
)
const userData = await mkdtemp(join(tmpdir(), '听读在线播放检查 '))
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
  buildManifestSha256: await hash(manifestPath),
  startedAt: new Date().toISOString(),
  runnerSha256: await hash(join(directory, 'runner-started.ts')),
  lifecycleSha256: await hash(join(directory, 'lifecycle-started.ts')),
  stages: [],
  scope:
    'Actual anonymous ting13 source UI, complete MP3 download, local Range/seek, adjacent episode switch and network-denied cache restart; optional Paraformer CUDA full-source workflow. Seek-assisted EOF is not uninterrupted whole-source or acoustic quality evidence.',
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
  page.on('pageerror', (e) => errors.push(e.message))
  const state = async (): Promise<AppState> => {
    const result = await page.evaluate(() => window.desktop.getState())
    if (!result.ok) throw Error(result.error.message)
    return result.value
  }
  const clock = () =>
    page.locator('audio').evaluate((a: HTMLAudioElement) => ({
      positionMs: a.currentTime * 1000,
      durationMs: a.duration * 1000,
      paused: a.paused,
      source: a.currentSrc,
      error: a.error?.message ?? '',
    }))
  await page.getByRole('button', { name: '在线书源', exact: true }).click()
  await page.getByLabel('搜索书籍', { exact: true }).fill('众仙俯首')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page
    .getByRole('button', { name: '查看 众仙俯首 的详情', exact: true })
    .click({ timeout: 40000 })
  await expect(page.getByText('已读取 60 集 · 还有后续分集', { exact: true })).toBeVisible({
    timeout: 65000,
  })
  await page.getByRole('button', { name: '加入书架', exact: true }).click()
  await expect(page.getByRole('button', { name: '更新书架目录', exact: true })).toBeVisible()
  let library = await state()
  report.productVersion = library.version
  const online = library.books.find((b) => b.online?.bookId === '39941')!
  assert.equal(online.episodes.length, 60)
  assert.equal(online.online!.catalogComplete, false)
  assert.ok(online.episodes.every((e) => e.contentHash === '' && e.online?.cached === false))
  const first = online.episodes[0]!,
    second = online.episodes[1]!
  report.identity = {
    bookId: online.id,
    firstId: first.id,
    secondId: second.id,
    nativeFirst: first.online!.episodeId,
    catalogCount: 60,
  }
  await stage('stable-uncached-catalog-added')
  await setVolume(page, '0')
  await page.getByRole('button', { name: `缓存并播放 ${first.title}`, exact: true }).click()
  await expect
    .poll(
      async () => {
        const c = await clock()
        return c.positionMs > 200 && !c.paused
      },
      { timeout: 150000 },
    )
    .toBe(true)
  await expect(page.getByRole('button', { name: '取消读取', exact: true })).toHaveCount(0, {
    timeout: 5000,
  })
  library = await state()
  const cached = library.books.find((b) => b.id === online.id)!.episodes[0]!
  assert.equal(cached.id, first.id)
  assert.equal(cached.online!.cached, true)
  assert.match(cached.contentHash, /^[a-f0-9]{64}$/)
  assert.ok(cached.sizeBytes > 100000)
  report.firstCached = {
    id: cached.id,
    contentHash: cached.contentHash,
    sizeBytes: cached.sizeBytes,
    media: await clock(),
  }
  const ranges = await app.evaluate(
    async ({ net }, url) => {
      const head = await net.fetch(url, { method: 'HEAD' })
      const size = Number(head.headers.get('content-length'))
      const values = []
      for (const start of [0, Math.floor(size / 2)]) {
        const result = await net.fetch(url, {
          headers: { Range: `bytes=${start}-${start + 1023}` },
        })
        values.push({
          status: result.status,
          range: result.headers.get('content-range'),
          size: (await result.arrayBuffer()).byteLength,
          start,
        })
      }
      return { head: head.status, size, values }
    },
    (await clock()).source,
  )
  assert.equal(ranges.head, 200)
  assert.equal(ranges.size, cached.sizeBytes)
  for (const r of ranges.values) {
    assert.equal(r.status, 206)
    assert.equal(r.size, 1024)
    assert.equal(r.range, `bytes ${r.start}-${r.start + 1023}/${ranges.size}`)
  }
  report.localRanges = ranges
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('120000')
  await expect.poll(async () => (await clock()).positionMs).toBeGreaterThan(120100)
  await stage('real-source-cached-playing-and-local-range-seek')
  await page.screenshot({ path: join(directory, 'source-playing.png') })

  let transcriptBefore: unknown
  if (componentPath) {
    const component = JSON.parse(await readFile(componentPath, 'utf8'))
    assert.equal(component.version, 2)
    for (const key of ['python', 'models', 'ffmpeg', 'ffprobe', 'resources'])
      component[key] = resolve(dirname(componentPath), component[key])
    const config = join(directory, 'component.json')
    await writeFile(config, JSON.stringify(component, null, 2))
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, config)
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    const reader = page.getByRole('region', { name: '同步伴读', exact: true })
    await toggleCompanionGeneration(reader)
    await reader.getByRole('button', { name: '选择组件配置', exact: true }).click()
    await expect(reader.getByText('本地组件已配置', { exact: true })).toBeVisible()
    await setSubtitleProfile(page, { engine: 'paraformer', device: 'cuda' })
    await openCompanionTools(reader)
    await reader.getByRole('button', { name: '生成转写稿', exact: true }).click()
    await closeCompanionPanel(reader)
    await stage('actual-cached-source-full-paraformer-cuda-started')
    const target = { episodeId: cached.id, audioHash: cached.contentHash }
    await expect
      .poll(
        async () => {
          const response = await page.evaluate(
            (t) => window.desktop.getTranscriptionState(t),
            target,
          )
          assert.ok(response.ok)
          if (response.value.job?.status === 'failed')
            throw Error(response.value.job.error ?? 'ASR failed')
          report.asrLatest = response.value.job
          await save()
          return response.value.job?.status
        },
        { timeout: 1200000, intervals: [1000] },
      )
      .toBe('completed')
    const result = await page.evaluate((t) => window.desktop.getTranscript(t), target)
    assert.ok(result.ok)
    assert.equal(result.value.status, 'ready')
    if (result.value.status === 'ready') {
      transcriptBefore = result.value
      report.transcript = {
        revision: result.value.transcript.revision,
        segments: result.value.transcript.document.segments.length,
        documentSha256: createHash('sha256')
          .update(JSON.stringify(result.value.transcript.document))
          .digest('hex'),
      }
    }
    await stage('full-source-transcript-ready')
    await page.screenshot({ path: join(directory, 'source-transcript.png') })
  }
  // A real ended event after an explicit UI seek tests auto-next, not whole-source duration.
  await page
    .getByRole('slider', { name: '播放进度', exact: true })
    .fill(String(Math.floor((await clock()).durationMs - 3000)))
  await expect
    .poll(
      async () => {
        const s = await state(),
          c = await clock()
        return s.currentEpisodeId === second.id && !c.paused && c.positionMs > 500
      },
      { timeout: 150000 },
    )
    .toBe(true)
  report.seekAssistedAutoNext = await clock()
  await stage('seek-assisted-real-ended-and-next-source-episode')
  // Previous starts the first episode from zero, then persist a distant paused position.
  await menuAction(page, '播放选项', '上一集')
  await expect.poll(async () => (await clock()).source.includes(first.id)).toBe(true)
  await expect.poll(async () => (await clock()).paused).toBe(false)
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('180000')
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  const saved = await clock()
  const cleanup = await closeOwnedElectron(app)
  assert.equal(cleanup.kind, 'graceful')
  app = undefined
  report.firstCleanup = cleanup
  app = await electron.launch({ args: [appRoot], env })
  // Deny browser source requests and Node media HTTP. A cache hit must make zero requests.
  await app.evaluate(({ session }) => {
    Reflect.set(globalThis, 'sourcePlaybackFetches', 0)
    globalThis.fetch = async () => {
      Reflect.set(
        globalThis,
        'sourcePlaybackFetches',
        Number(Reflect.get(globalThis, 'sourcePlaybackFetches')) + 1,
      )
      throw Error('Test network denied')
    }
    session
      .fromPartition('persist:readlisten-source-ting13')
      .webRequest.onBeforeSendHeaders({ urls: ['https://www.ting13.cc/*'] }, (_details, callback) =>
        callback({ cancel: true }),
      )
  })
  page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  await expect.poll(async () => (await clock()).positionMs).toBeCloseTo(saved.positionMs, -1)
  assert.equal((await clock()).paused, true)
  // Explicitly reopen after denial as well, so startup timing cannot hide a cache miss.
  await page.getByRole('button', { name: '继续播放', exact: true }).click()
  await expect.poll(async () => (await clock()).positionMs).toBeGreaterThan(saved.positionMs + 500)
  assert.equal(
    await app.evaluate(() => Number(Reflect.get(globalThis, 'sourcePlaybackFetches'))),
    0,
  )
  library = await state()
  const restored: Episode = library.books
    .find((b) => b.id === online.id)!
    .episodes.find((e) => e.id === first.id)!
  assert.equal(restored.contentHash, cached.contentHash)
  assert.equal(library.books.find((b) => b.id === online.id)!.episodes.length, 60)
  if (transcriptBefore) {
    const restoredTranscript = await page.evaluate((t) => window.desktop.getTranscript(t), {
      episodeId: first.id,
      audioHash: cached.contentHash,
    })
    assert.ok(restoredTranscript.ok)
    assert.deepEqual(restoredTranscript.value, transcriptBefore)
    report.transcriptReusedOnRestart = true
  }
  report.cacheOnlyRestart = {
    saved,
    restored: await clock(),
    nodeHttpRequests: 0,
    scope: 'Application network denial injection, not a physical network disconnect',
  }
  await page.screenshot({ path: join(directory, 'source-cache-restart.png') })
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  assert.deepEqual(errors, [])
  await stage('network-denied-cache-restart-and-progress-restored')
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
