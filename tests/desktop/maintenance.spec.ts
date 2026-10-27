import { menuAction, leaveCompanionPage } from '../helpers/ui'
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, appendFile, access, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import { checkpointFixture } from '../fixtures/checkpoint-cache'
import type { TranscriptDocument } from '../../src/shared/transcript'

function launch(root: string) {
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  return electron.launch({
    ...(process.env.RALB_EXECUTABLE
      ? { executablePath: resolve(process.env.RALB_EXECUTABLE), args: [] }
      : { args: [resolve(process.env.RALB_APP_ROOT ?? '.')] }),
    env,
  })
}
async function choose(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, path)
}
async function setup(queued = false) {
  const root = await mkdtemp(join(tmpdir(), '听读 管理面板 ')),
    paths = createDataPaths(root)
  const store = new LibraryStore(paths.database)
  store.importBook(await scanBook(resolve('tests/fixtures/第32集-伴读样本.wav'), 'file'))
  const episode = store.listBooks()[0]!.episodes[0]!
  const document = JSON.parse(
    await readFile(resolve('tests/fixtures/reading-manual.json'), 'utf8'),
  ) as TranscriptDocument
  store.saveTranscript(episode.id, document)
  store.saveProgress({
    sessionId: '',
    episodeId: episode.id,
    positionMs: 2000,
    durationMs: 16360,
    rate: 1,
    volume: 1,
  })
  if (queued)
    store.createJob({
      episodeId: episode.id,
      audioHash: episode.contentHash,
      engine: 'whisperx',
      device: 'cpu',
    })
  store.close()
  await writeFile(
    join(paths.logs, 'app.log'),
    'X'.repeat(70000) + '\nFixture diagnostic <script>literal text</script>\n',
  )
  return { root, paths, episode }
}

test('the dashboard previews and clears isolated checkpoints without touching models or the current document', async ({}, info) => {
  const t = await setup(),
    cache = join(t.root, 'resources'),
    selected = join(t.root, 'component.json')
  await mkdir(cache)
  const group = await checkpointFixture(cache),
    runtime = join(t.root, 'runtime.exe'),
    models = join(t.root, 'models.json')
  await writeFile(runtime, 'not executed')
  await writeFile(
    models,
    JSON.stringify({
      version: 1,
      models: { fixture: { repository: 'fixture/model', revision: 'fixed', path: cache } },
    }),
  )
  await writeFile(join(cache, 'weights.bin'), 'model weights to keep')
  await mkdir(join(cache, 'jobs', 'unrecognized'))
  await writeFile(join(cache, 'jobs', 'unrecognized', 'notes.txt'), 'keep user data')
  await writeFile(
    selected,
    JSON.stringify({
      version: 1,
      python: runtime,
      models,
      cache,
      ffmpeg: runtime,
      ffprobe: runtime,
    }),
  )
  const app = await launch(t.root)
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    await leaveCompanionPage(page)
    await menuAction(page, '应用设置', '缓存与任务')
    const panel = page.getByRole('dialog', { name: '缓存与任务', exact: true })
    await expect(panel.getByText('尚未配置转写组件，普通播放可以继续使用。')).toBeVisible()
    await choose(app, selected)
    await panel.getByRole('button', { name: '选择组件配置', exact: true }).click()
    await expect(panel.getByText('本地组件配置已更新。')).toBeVisible()
    await expect(panel.getByTestId('checkpoint-usage')).toContainText('1 组')
    await expect(panel.getByText('fixture/model · fixed', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: '预览清理分块缓存', exact: true }).click()
    await expect(panel.getByRole('group', { name: '确认清理预览' })).toBeVisible()
    await access(join(group, 'chunk-000000.json'))
    await appendFile(join(group, 'chunk-000000.json'), 'changed since preview')
    await panel.getByRole('button', { name: '确认清理分块缓存', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('缓存自预览后已变化')
    await access(join(group, 'manifest.json'))
    await panel.getByRole('button', { name: '预览清理分块缓存', exact: true }).click()
    await panel.getByRole('button', { name: '确认清理分块缓存', exact: true }).click()
    await expect(panel.getByTestId('checkpoint-usage')).toContainText('0 组')
    expect(await readFile(join(cache, 'weights.bin'), 'utf8')).toBe('model weights to keep')
    expect(await readFile(join(cache, 'jobs', 'unrecognized', 'notes.txt'), 'utf8')).toBe(
      'keep user data',
    )
    const current = await page.evaluate((target) => window.desktop.getTranscript(target), {
      episodeId: t.episode.id,
      audioHash: t.episode.contentHash,
    })
    expect(
      current.ok && current.value.status === 'ready' && current.value.transcript.revision,
    ).toBe(1)
    await panel.getByRole('tab', { name: '应用日志', exact: true }).click()
    await expect(panel.getByRole('tab', { name: '应用日志', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(panel.getByRole('tab', { name: '存储与组件', exact: true })).toHaveAttribute(
      'aria-selected',
      'false',
    )
    await expect(panel.locator('.app-log')).toContainText(
      'Fixture diagnostic <script>literal text</script>',
    )
    await expect(
      panel.getByText('仅在本机显示最新日志，可能含音频路径和模型诊断。已截取最后 64 KiB。'),
    ).toBeVisible()
    expect(await panel.locator('script').count()).toBe(0)
    await page.screenshot({ path: info.outputPath('maintenance-log.png') })
    await panel.getByRole('button', { name: '关闭缓存与任务', exact: true }).click()
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeEnabled()
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('a recovered queued job blocks cache clearing but can be canceled from the task dashboard', async ({}, info) => {
  const t = await setup(true),
    app = await launch(t.root)
  try {
    const page = await app.firstWindow()
    await leaveCompanionPage(page)
    await menuAction(page, '应用设置', '缓存与任务')
    const panel = page.getByRole('dialog', { name: '缓存与任务', exact: true })
    await expect(
      panel.getByRole('button', { name: '预览清理分块缓存', exact: true }),
    ).toBeDisabled()
    await expect(panel.getByRole('button', { name: '选择组件配置', exact: true })).toBeEnabled()
    const blocked = await page.evaluate(() => window.desktop.prepareCacheClear())
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.error.code).toBe('BUSY')
    await panel.getByRole('tab', { name: /^转写任务/ }).click()
    await expect(panel.locator('[data-job-status="queued"]')).toBeVisible()
    await panel.getByRole('checkbox', { name: '只看活动任务' }).check()
    await panel.getByRole('button', { name: '取消任务', exact: true }).click()
    await expect(panel.locator('.maintenance-tasks li')).toHaveCount(0)
    await panel.getByRole('checkbox', { name: '只看活动任务' }).uncheck()
    await expect(panel.locator('[data-job-status="canceled"]')).toBeVisible()
    await expect(panel.getByRole('button', { name: '重试任务', exact: true })).toBeDisabled()
    await page.screenshot({ path: info.outputPath('maintenance-tasks.png') })
    await panel.getByRole('button', { name: '关闭缓存与任务', exact: true }).click()
    const doc = await page.evaluate((target) => window.desktop.getTranscript(target), {
      episodeId: t.episode.id,
      audioHash: t.episode.contentHash,
    })
    expect(doc.ok && doc.value.status === 'ready' && doc.value.transcript.revision).toBe(1)
  } finally {
    await app.close()
  }
})
