import {
  closeCompanionPanel,
  leaveCompanionPage,
  menuAction,
  openCompanionProofreading,
  openCompanionTools,
  openTranscriptImport,
  setSubtitleProfile,
  toggleCompanionGeneration,
} from '../helpers/ui'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { TranscriptDocument } from '../../src/shared/transcript'
import { createDataPaths } from '../../src/main/paths'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'

const audio = resolve('tests/fixtures/第32集-伴读样本.wav')
const fixture = JSON.parse(
  readFileSync(resolve('tests/fixtures/reading-manual.json'), 'utf8'),
) as TranscriptDocument
let stdlibPython: string | undefined
if (!process.env.RALB_EXECUTABLE) {
  try {
    stdlibPython = execFileSync('python', ['-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim()
  } catch {
    /* Optional source-only worker fault test; no Python required for ordinary playback. */
  }
}
const launch = (root: string, appRoot = process.env.RALB_APP_ROOT ?? '.') => {
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  return electron.launch({
    ...(process.env.RALB_EXECUTABLE
      ? { executablePath: resolve(process.env.RALB_EXECUTABLE), args: [] }
      : { args: [resolve(appRoot)] }),
    env,
  })
}
async function choose(app: ElectronApplication, path: string | null) {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: path === null, filePaths: path ? [path] : [] })
  }, path)
}
async function setup(app: ElectronApplication, page: Page) {
  await choose(app, audio)
  await page.getByRole('button', { name: '选择音频文件', exact: true }).click()
  await page.getByRole('button', { name: '继续播放', exact: true }).click()
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  const reader = page.getByRole('region', { name: '同步伴读', exact: true })
  await choose(app, resolve('tests/fixtures/reading-manual.json'))
  await openTranscriptImport(reader)
  await reader.getByRole('button', { name: '导入 JSON 文稿', exact: true }).click()
  await expect(reader.locator('.transcript-sentence')).toHaveCount(3)
  return reader
}

test('missing or invalid model components preserve playback; small corrections keep timing and survive restart', async () => {
  const root = mkdtempSync(join(tmpdir(), '听读 M3 纠错 '))
  let app = await launch(root)
  try {
    let page = await app.firstWindow()
    let reader = await setup(app, page)
    const tools = reader.locator('.companion-drawer--tools')
    await toggleCompanionGeneration(reader)
    await setSubtitleProfile(page, { engine: 'whisperx' })
    await expect(tools.getByRole('button', { name: '生成转写稿', exact: true })).toBeDisabled()
    await tools.getByRole('button', { name: '管理字幕组件', exact: true }).click()
    await choose(app, null)
    await tools.getByRole('button', { name: '选择组件配置', exact: true }).click()
    const invalid = join(root, 'invalid-component.json')
    writeFileSync(invalid, '{}')
    await choose(app, invalid)
    await tools.getByRole('button', { name: '选择组件配置', exact: true }).click()
    await expect(tools.getByRole('alert')).toContainText('组件配置无效')
    await toggleCompanionGeneration(reader)
    const text = fixture.segments[0]!.text.replace('继续', '开始')
    await openCompanionProofreading(reader)
    await reader.getByRole('button', { name: '编辑第 1 句', exact: true }).click()
    await reader.getByRole('textbox', { name: '纠正这句文字' }).fill(text)
    await reader.getByRole('button', { name: '保存纠错', exact: true }).click()
    await expect(reader.locator('.transcript-sentence').first()).toContainText(text)
    await reader.locator('.transcript-sentence').first().click()
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
      .toBeCloseTo(fixture.segments[0]!.startMs / 1000, 2)
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
      .toBeGreaterThan(1.2)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await app.close()
    app = await launch(root)
    page = await app.firstWindow()
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    reader = page.getByRole('region', { name: '同步伴读', exact: true })
    await expect(reader.locator('.transcript-sentence').first()).toContainText(text)
    await openCompanionTools(reader)
    await expect(reader.getByText('3 句 · 版本 2')).toBeVisible()
    await closeCompanionPanel(reader)
  } finally {
    await app.close()
  }
})

test('unwritable cache and terminal-status storage failures preserve reading and playback, and can be retried', async ({}, info) => {
  test.skip(
    !stdlibPython,
    'This source-only fault test requires stdlib Python; it does not load any model.',
  )
  const root = mkdtempSync(join(tmpdir(), '听读 转写存储故障 '))
  const appRoot = join(root, '受控缓存预检程序')
  mkdirSync(appRoot)
  cpSync(resolve(process.env.RALB_APP_ROOT ?? '.', 'out'), join(appRoot, 'out'), {
    recursive: true,
  })
  cpSync(resolve('python'), join(appRoot, 'python'), {
    recursive: true,
    filter: (source) => !source.endsWith('__pycache__'),
  })
  writeFileSync(
    join(appRoot, 'package.json'),
    JSON.stringify({
      name: 'cache-preflight-fixture',
      type: 'module',
      main: './out/main/index.js',
    }),
  )
  symlinkSync(resolve('node_modules'), join(appRoot, 'node_modules'), 'junction')
  // This fixture exercises the real worker's cache preflight without installing
  // ML packages. Invented metadata only satisfies its prerequisite-version gate;
  // it is not evidence of an installed or secure component. The obstructed cache
  // must fail before any nonexistent ML module can be imported.
  const versions = JSON.parse(
    execFileSync(
      stdlibPython!,
      [
        '-B',
        '-c',
        'import json,sys;sys.path.insert(0,sys.argv[1]);from asr_security import SECURITY_BASELINE;print(json.dumps(SECURITY_BASELINE))',
        resolve('python'),
      ],
      { encoding: 'utf8', windowsHide: true },
    ),
  ) as Record<string, string>
  for (const [name, version] of Object.entries(versions)) {
    const directory = join(appRoot, 'python', `${name.replaceAll('-', '_')}-${version}.dist-info`)
    mkdirSync(directory)
    writeFileSync(
      join(directory, 'METADATA'),
      `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n\nSynthetic test metadata, not an installed package.\n`,
    )
  }
  const cache = join(root, 'component-cache')
  mkdirSync(cache)
  const models = join(root, 'models.json'),
    component = join(root, 'component.json')
  writeFileSync(models, JSON.stringify({ version: 1, models: {} }))
  writeFileSync(
    component,
    JSON.stringify({
      version: 1,
      python: stdlibPython,
      models,
      cache,
      ffmpeg: stdlibPython,
      ffprobe: stdlibPython,
    }),
  )
  const app = await launch(root, appRoot)
  let database: DatabaseSync | undefined
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const reader = await setup(app, page)
    const tools = reader.locator('.companion-drawer--tools')
    const activity = tools.getByRole('region', { name: '字幕生成进度', exact: true })
    await toggleCompanionGeneration(reader)
    await choose(app, component)
    await tools.getByRole('button', { name: '管理字幕组件', exact: true }).click()
    await tools.getByRole('button', { name: '选择组件配置', exact: true }).click()
    await expect(tools.locator('.component-setup-summary')).toContainText('已选择')
    await setSubtitleProfile(page, { engine: 'whisperx', device: 'cpu' })
    // Replace only this empty fixture directory after configuration. The real
    // production preflight must report a cache failure before importing ML libraries.
    rmdirSync(cache)
    writeFileSync(cache, 'injected cache path obstruction')
    database = new DatabaseSync(join(root, 'data', 'library.sqlite3'))
    database.exec(`CREATE TRIGGER reject_terminal BEFORE UPDATE OF status ON transcription_jobs
      WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT,'injected terminal status write failure'); END`)
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await tools.getByRole('button', { name: '生成转写稿', exact: true }).click()
    await expect(activity).toContainText('任务状态无法保存，转写队列已暂停')
    await expect(activity.getByRole('button', { name: '重新生成字幕', exact: true })).toBeEnabled()
    expect(database.prepare('SELECT status FROM transcription_jobs').get()!.status).toBe('running')
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
      .toBeGreaterThan(1.5)
    expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(
      false,
    )
    await expect(reader.locator('.transcript-sentence')).toHaveCount(3)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await leaveCompanionPage(page)
    await menuAction(page, '应用设置', '缓存与任务')
    const panel = page.getByRole('dialog', { name: '缓存与任务', exact: true })
    await panel.getByRole('tab', { name: /^转写任务/ }).click()
    await expect(panel.getByText(/任务状态无法保存，转写队列已暂停/)).toBeVisible()
    await panel.getByRole('button', { name: '关闭缓存与任务', exact: true }).click()
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    await openCompanionTools(reader)
    await activity.getByRole('button', { name: '重新生成字幕', exact: true }).click()
    await expect(tools.getByRole('alert')).toContainText('任务状态仍无法保存')
    database.exec('DROP TRIGGER reject_terminal')
    await activity.getByRole('button', { name: '重新生成字幕', exact: true }).click()
    await expect
      .poll(() => database!.prepare('SELECT status FROM transcription_jobs').get()!.status)
      .toBe('failed')
    await expect(
      activity.locator('.transcription-activity-note').filter({
        hasText: '缓存目录不可写或空间不可用',
      }),
    ).toBeVisible()
    expect(database.prepare('SELECT attempt FROM transcription_jobs').get()!.attempt).toBe(2)
    await expect(reader.locator('.transcript-sentence').first()).toContainText(
      fixture.segments[0]!.text,
    )
    expect(errors).toEqual([])
    await page.screenshot({ path: info.outputPath('storage-failure.png') })
  } finally {
    database?.exec('DROP TRIGGER IF EXISTS reject_terminal')
    database?.close()
    await app.close()
  }
})

test('a stale editor and a large rewrite cannot overwrite the current document', async () => {
  const root = mkdtempSync(join(tmpdir(), '听读 M3 版本冲突 '))
  const app = await launch(root)
  try {
    const page = await app.firstWindow()
    const reader = await setup(app, page)
    const draft = fixture.segments[0]!.text.replace('继续', '下去')
    const replacement = fixture.segments[0]!.text.replace('继续', '开始')
    await openCompanionProofreading(reader)
    await reader.getByRole('button', { name: '编辑第 1 句', exact: true }).click()
    await reader.getByRole('textbox', { name: '纠正这句文字' }).fill(draft)
    const next = join(root, 'replacement.json')
    writeFileSync(
      next,
      JSON.stringify({
        ...fixture,
        segments: fixture.segments.map((segment, i) =>
          i ? segment : { ...segment, text: replacement },
        ),
      }),
    )
    await choose(app, next)
    await openTranscriptImport(reader)
    await reader.getByRole('button', { name: '重新导入文稿', exact: true }).click()
    await expect(reader.locator('.transcript-sentence').first()).toContainText(replacement)
    await reader.getByRole('button', { name: '保存纠错', exact: true }).click()
    await expect(reader.getByRole('alert')).toContainText('文稿已更新')
    await reader.getByRole('button', { name: '取消纠错', exact: true }).click()
    await openCompanionProofreading(reader)
    await reader.getByRole('button', { name: '编辑第 1 句', exact: true }).click()
    await reader
      .getByRole('textbox', { name: '纠正这句文字' })
      .fill('这是一段完全不同的新内容，需要重新拆分句子并对齐音频时间。')
    await reader.getByRole('button', { name: '保存纠错', exact: true }).click()
    await expect(reader.getByRole('alert')).toContainText('重新对齐')
    await expect(reader.locator('.transcript-sentence').first()).toContainText(replacement)
    await openCompanionTools(reader)
    await expect(reader.getByText('3 句 · 版本 2')).toBeVisible()
    await closeCompanionPanel(reader)
  } finally {
    await app.close()
  }
})

test('an interrupted job without configured components keeps its partial and can be configured or canceled', async () => {
  const root = mkdtempSync(join(tmpdir(), '听读 M3 待恢复任务 '))
  const paths = createDataPaths(root)
  const store = new LibraryStore(paths.database)
  store.importBook(await scanBook(audio, 'file'))
  const episode = store.listBooks()[0]!.episodes[0]!
  store.saveProgress({
    sessionId: '',
    episodeId: episode.id,
    positionMs: 1500,
    durationMs: 16360,
    rate: 1,
    volume: 1,
  })
  const job = store.createJob({
    episodeId: episode.id,
    audioHash: episode.contentHash,
    engine: 'whisperx',
    device: 'cpu',
  })
  store.setJobStatus(job.id, 1, 'running')
  store.acceptJobSnapshot(
    job.id,
    1,
    {
      document: {
        ...fixture,
        kind: 'transcript',
        coverage: [{ startMs: 0, endMs: 5000 }],
        segments: [fixture.segments[0]!],
      },
      processedUntilMs: 5000,
      cacheKey: 'a'.repeat(64),
      cacheHits: 0,
      totalChunks: 2,
      issues: [],
    },
    1,
    false,
  )
  store.close()
  const app = await launch(root)
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    const reader = page.getByRole('region', { name: '同步伴读', exact: true })
    const tools = reader.locator('.companion-drawer--tools')
    const activity = tools.getByRole('region', { name: '字幕生成进度', exact: true })
    await openCompanionTools(reader)
    await expect(activity).toHaveAttribute('data-job-status', 'queued')
    await expect(reader.locator('.transcript-sentence')).toHaveCount(1)
    await toggleCompanionGeneration(reader)
    await tools.getByRole('button', { name: '管理字幕组件', exact: true }).click()
    await expect(tools.getByRole('button', { name: '选择组件配置', exact: true })).toBeEnabled()
    await expect(tools.getByRole('combobox', { name: '字幕引擎', exact: true })).toBeDisabled()
    await expect(tools.getByRole('combobox', { name: '字幕设备', exact: true })).toBeDisabled()
    await expect(tools.getByRole('button', { name: '保存并生成本集', exact: true })).toBeDisabled()
    await choose(app, null)
    await tools.getByRole('button', { name: '选择组件配置', exact: true }).click()
    await activity.getByRole('button', { name: '取消字幕生成', exact: true }).click()
    await expect(activity).toHaveAttribute('data-job-status', 'canceled')
    await expect(reader.locator('.transcript-sentence')).toHaveCount(1)
    await expect(activity.getByRole('button', { name: '重新生成字幕', exact: true })).toBeDisabled()
  } finally {
    await app.close()
  }
})
