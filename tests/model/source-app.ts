import { setVolume } from '../helpers/ui'
// Real source UI over production IPC, in an isolated preview build and user directory.
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { closeOwnedElectron } from './electron-lifecycle'

const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--app-root')
  throw new Error('Usage: npm run test:source:app -- --app-root <preview app>')
const appRoot = resolve(args[1]!)
const build = JSON.parse(await readFile(resolve(appRoot, '../manifest.json'), 'utf8'))
assert.equal(build.appRoot, appRoot)
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
for (const [name, digest] of Object.entries(build.outputHashes))
  assert.equal(await hash(join(appRoot, 'out', name)), digest)
const directory = resolve(
  'cache/asr-evaluation/source-app-runs',
  new Date().toISOString().replaceAll(':', '-'),
)
await mkdir(directory, { recursive: true })
const userData = await mkdtemp(join(tmpdir(), '听读在线界面检查 '))
const audio = resolve('cache/asr-evaluation/m4a-source/Audiobook Sample.m4a')
const original = await hash(audio)
const env: Record<string, string> = { RALB_USER_DATA: userData }
for (const [key, value] of Object.entries(process.env))
  if (
    value !== undefined &&
    !['ralb_user_data', 'electron_run_as_node', 'electron_renderer_url'].includes(key.toLowerCase())
  )
    env[key] = value
const report: Record<string, unknown> = {
  status: 'running',
  appRoot,
  userData,
  buildManifestSha256: await hash(resolve(appRoot, '../manifest.json')),
  scope:
    'Source UI search/detail/pagination/cancel/request-failure with simultaneous local playback; no physical-network-offline, online audio cache or online playback/ASR claim.',
}
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
await save()
console.log(JSON.stringify({ stage: 'starting', report: join(directory, 'report.json') }))
let app: ElectronApplication | undefined
try {
  app = await electron.launch({ args: [appRoot], env })
  const page = await app.firstWindow(),
    errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('button', { name: '选择音频文件', exact: true })).toBeEnabled()
  await setVolume(page, '0')
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, audio)
  await page.getByRole('button', { name: '选择音频文件', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Audiobook Sample.m4a', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: '继续播放', exact: true }).click()
  const clock = () =>
    page.locator('audio').evaluate((element: HTMLAudioElement) => ({
      position: element.currentTime,
      paused: element.paused,
      source: element.currentSrc,
    }))
  await expect.poll(async () => (await clock()).position).toBeGreaterThan(0.2)
  const before = await clock()
  await page.getByRole('button', { name: '在线书源', exact: true }).click()
  await page.getByLabel('搜索书籍', { exact: true }).fill('众仙俯首')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(page.getByRole('button', { name: '查看 众仙俯首 的详情', exact: true })).toBeVisible(
    { timeout: 40000 },
  )
  await page.getByRole('button', { name: '查看 众仙俯首 的详情', exact: true }).click()
  await expect(page.getByText('已读取 60 集 · 还有后续分集', { exact: true })).toBeVisible({
    timeout: 65000,
  })
  await expect(page.getByText('作者：咸鱼老白 · 演播：三声文化', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '加载更多分集', exact: true }).click()
  await expect(page.getByText('已读取 120 集 · 还有后续分集', { exact: true })).toBeVisible({
    timeout: 40000,
  })
  assert.equal(await page.locator('.source-episodes > li').count(), 120)
  await page.getByRole('heading', { name: '众仙俯首', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(directory, 'source-detail.png') })
  const after = await clock()
  assert.equal(after.source, before.source)
  assert.equal(after.paused, false)
  assert.ok(after.position > before.position + 1)
  report.localPlaybackDuringBrowsing = { before, after }
  console.log(JSON.stringify({ stage: 'source-ui-and-continuing-playback-complete' }))
  await save()
  const invalid = await page.evaluate(() =>
    window.desktop.getSourceBook({
      id: crypto.randomUUID(),
      sourceId: 'ting13',
      bookId: '39941',
      url: 'file:///C:/secret',
    } as never),
  )
  assert.equal(invalid.ok, false)
  if (!invalid.ok) assert.equal(invalid.error.code, 'INVALID_REQUEST')
  await app.evaluate(({ session }) => {
    Reflect.set(globalThis, 'sourceBlockedRequests', 0)
    session
      .fromPartition('persist:readlisten-source-ting13')
      .webRequest.onBeforeSendHeaders(
        { urls: ['https://www.ting13.cc/*'] },
        (_details, callback) => {
          Reflect.set(
            globalThis,
            'sourceBlockedRequests',
            Number(Reflect.get(globalThis, 'sourceBlockedRequests')) + 1,
          )
          callback({ cancel: true })
        },
      )
  })
  await page.getByRole('button', { name: '返回搜索结果', exact: true }).click()
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('暂时无法读取书源', { timeout: 10000 })
  assert.equal((await clock()).paused, false)
  report.blockedSourceRequests = await app.evaluate(({ session }) => {
    session.fromPartition('persist:readlisten-source-ting13').webRequest.onBeforeSendHeaders(null)
    return Number(Reflect.get(globalThis, 'sourceBlockedRequests'))
  })
  assert.ok(Number(report.blockedSourceRequests) > 0)
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByRole('button', { name: '取消读取', exact: true }).click()
  await expect(
    page.getByText('已取消读取，可以重新搜索或打开书籍。', { exact: true }),
  ).toBeVisible()
  await expect
    .poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
    .toBe(1)
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(page.getByRole('button', { name: '取消读取', exact: true })).toHaveCount(0, {
    timeout: 40000,
  })
  await expect(
    page.getByRole('button', { name: '查看 众仙俯首 的详情', exact: true }),
  ).toBeVisible()
  report.cancellationRequestFailureRetryAndBoundary = true
  assert.deepEqual(errors, [])
  const state = await page.evaluate(() => window.desktop.getState())
  assert.ok(state.ok)
  report.productVersion = state.value.version
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  const saved = await clock()
  const closed = await closeOwnedElectron(app)
  assert.equal(closed.kind, 'graceful')
  app = undefined
  app = await electron.launch({ args: [appRoot], env })
  const restarted = await app.firstWindow()
  await expect
    .poll(() =>
      restarted.locator('audio').evaluate((element: HTMLAudioElement) => element.currentTime),
    )
    .toBeCloseTo(saved.position, 1)
  assert.equal(
    await restarted.locator('audio').evaluate((element: HTMLAudioElement) => element.paused),
    true,
  )
  assert.equal(await hash(audio), original)
  report.restartRestoredPaused = true
  report.firstCleanup = closed
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
    report: join(directory, 'report.json'),
    error: report.error,
  }),
)
