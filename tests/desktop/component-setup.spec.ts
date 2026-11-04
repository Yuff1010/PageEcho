import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import { menuAction, openCompanionTools, openSubtitleAdvanced } from '../helpers/ui'

// The copied app uses the real discovery, native-selection IPC, bounded Python
// process, persistence, and player. Only capability diagnostics are a controlled
// stdlib fixture; this test makes no claim about model or CUDA readiness.
const probe = String.raw`
import argparse
import json
from pathlib import Path
import platform
import time

parser = argparse.ArgumentParser()
parser.add_argument('--models')
args, _ = parser.parse_known_args()
configuration = json.loads(Path(args.models).read_text(encoding='utf8'))
if configuration.get('mode') == 'invalid-json':
    print('fixture invalid result')
else:
    gate = configuration.get('gate')
    if gate:
        Path(gate + '.started').write_text('started', encoding='utf8')
        while not Path(gate).exists():
            time.sleep(0.02)
    print(json.dumps({
        'level': 'imports-and-files',
        'pythonVersion': platform.python_version(),
        'cudaName': None,
        'freeBytes': 1073741824,
        'issues': ['测试诊断：仅 CPU 可用，未执行真实模型推理。'],
        'capabilities': [
            {'engine': engine, 'device': device, 'available': device == 'cpu',
             'message': '测试 CPU 可用。' if device == 'cpu' else '测试 CUDA 不可用。'}
            for engine in ['whisperx', 'paraformer'] for device in ['cpu', 'cuda']
        ],
    }, ensure_ascii=False))
`
let python: string | undefined
try {
  python = execFileSync('python', ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
} catch {
  /* Only stdlib Python is required; this suite never loads actual ASR models. */
}
let appRoot: string, componentRoot: string
test.beforeAll(() => {
  if (!python || process.env.RALB_EXECUTABLE) return
  appRoot = mkdtempSync(join(tmpdir(), '听读 组件设置 应用 '))
  cpSync(resolve(process.env.RALB_APP_ROOT ?? '.', 'out'), join(appRoot, 'out'), {
    recursive: true,
  })
  writeFileSync(
    join(appRoot, 'package.json'),
    JSON.stringify({
      name: 'component-setup-fixture',
      type: 'module',
      main: './out/main/index.js',
    }),
  )
  symlinkSync(resolve('node_modules'), join(appRoot, 'node_modules'), 'junction')
  mkdirSync(join(appRoot, 'python'))
  writeFileSync(
    join(appRoot, 'python', 'asr_worker.py'),
    String.raw`
from pathlib import Path
import json
import sys
Path(__file__).with_name('worker-started').write_text('started', encoding='utf8')
print(json.dumps({'protocolVersion': 1, 'type': 'ready', 'configuration': {'fixture': True}}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    print(json.dumps({'protocolVersion': 1, 'type': 'error', 'jobId': request['jobId'],
                      'attempt': request['attempt'], 'code': 'UNEXPECTED_FIXTURE_START',
                      'message': 'Canceled preflight must not start the worker.'}), flush=True)
`,
  )
  writeFileSync(join(appRoot, 'python', 'asr_component_probe.py'), probe)
  componentRoot = join(appRoot, 'asr-component')
  writeComponent(componentRoot)
  const invalid = join(appRoot, 'components', 'incomplete')
  mkdirSync(invalid, { recursive: true })
  writeFileSync(join(invalid, 'component.json'), '{}')
})
test.skip(
  !python || !!process.env.RALB_EXECUTABLE,
  'Requires stdlib Python and a source/preview app; packaged runtime is never modified.',
)

function writeComponent(directory: string, mode = 'cpu', gate?: string) {
  mkdirSync(directory, { recursive: true })
  mkdirSync(join(directory, 'cache'), { recursive: true })
  writeFileSync(join(directory, 'models.json'), JSON.stringify({ mode, gate }))
  writeFileSync(
    join(directory, 'component.json'),
    JSON.stringify({
      version: 1,
      python,
      models: 'models.json',
      cache: 'cache',
      ffmpeg: python,
      ffprobe: python,
    }),
  )
}
async function fixture(multiple = false, manual = false) {
  writeComponent(componentRoot)
  const marker = join(appRoot, 'python', 'worker-started')
  if (existsSync(marker)) unlinkSync(marker)
  const root = mkdtempSync(join(tmpdir(), '听读 组件设置 数据 ')),
    store = new LibraryStore(createDataPaths(root).database)
  let audio = resolve('tests/fixtures/第32集-伴读样本.wav')
  if (multiple) {
    audio = join(root, '多集听书')
    mkdirSync(audio)
    copyFileSync(resolve('tests/fixtures/第32集-伴读样本.wav'), join(audio, '第1集.wav'))
    copyFileSync(resolve('tests/fixtures/第32集-伴读样本.wav'), join(audio, '第2集.wav'))
  }
  store.importBook(await scanBook(audio, multiple ? 'folder' : 'file'))
  const book = store.listBooks()[0]!
  store.saveProgress({
    sessionId: '',
    episodeId: book.episodes[0]!.id,
    positionMs: 0,
    durationMs: null,
    rate: 1,
    volume: 0,
  })
  if (manual)
    store.setSubtitlePreparation(book.id, {
      mode: 'manual',
      engine: 'whisperx',
      device: 'cpu',
      prepareNext: false,
    })
  store.close()
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  return { root, env, book }
}
async function openSetup(page: Page) {
  await page.getByRole('button', { name: '字幕与伴读', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '收听工具', exact: true })
  await openSubtitleAdvanced(dialog)
  await openComponentManagement(dialog.getByRole('region', { name: '本地字幕组件', exact: true }))
  return dialog
}
async function openComponentManagement(setup: Locator) {
  const manage = setup.getByRole('button', { name: /^(管理字幕组件|收起组件管理)$/ })
  if ((await manage.getAttribute('aria-expanded')) !== 'true') await manage.click()
  await expect(manage).toHaveAttribute('aria-expanded', 'true')
}
async function expectComponentDirectory(page: Page, setup: Locator, directory: string) {
  await expect
    .poll(async () => {
      const state = await page.evaluate(() => window.desktop.detectTranscriptionComponents())
      if (!state.ok) throw new Error(state.error.message)
      return state.value.currentDirectory
    })
    .toBe(directory)
  const help = setup.getByRole('button', { name: '字幕组件详情说明', exact: true })
  await help.focus()
  await expect(setup.getByRole('tooltip').filter({ hasText: directory })).toBeVisible()
  await help.press('Escape')
}
const paused = (page: Page) =>
  page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)

async function firstGeneration(page: Page, mode: 'manual' | 'ahead' = 'manual') {
  await expect(
    page
      .getByRole('region', { name: '播放器', exact: true })
      .getByRole('button', { name: '播放', exact: true }),
  ).toBeEnabled()
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  const reader = page.getByRole('region', { name: '同步伴读', exact: true })
  // The main generation action now starts automatic preparation. These cases
  // intentionally exercise the manual save transaction before any profile exists.
  await openCompanionTools(reader)
  await reader.locator('.transcription-controls > details > summary').click()
  await openComponentManagement(reader.getByRole('region', { name: '本地字幕组件', exact: true }))
  await reader.getByRole('button', { name: '使用 asr-component', exact: true }).click()
  await reader.getByRole('button', { name: '手动选择引擎和设备', exact: true }).click()
  await reader.getByRole('combobox', { name: '字幕准备方案', exact: true }).selectOption(mode)
  await reader.getByRole('combobox', { name: '字幕引擎', exact: true }).selectOption('whisperx')
  await reader.getByRole('combobox', { name: '字幕设备', exact: true }).selectOption('cpu')
  return reader
}

function delayedGenerationApp(root: string) {
  const copied = mkdtempSync(join(tmpdir(), '听读 首次生成延迟 '))
  cpSync(join(appRoot, 'out'), join(copied, 'out'), { recursive: true })
  cpSync(join(appRoot, 'python'), join(copied, 'python'), { recursive: true })
  symlinkSync(resolve('node_modules'), join(copied, 'node_modules'), 'junction')
  writeFileSync(
    join(copied, 'package.json'),
    JSON.stringify({
      name: 'first-generation-latency-fixture',
      type: 'module',
      main: './out/main/index.js',
    }),
  )
  writeComponent(join(copied, 'asr-component'), 'cpu', join(root, 'release-delayed-probe'))
  const path = join(copied, 'out/main/index.js'),
    source = readFileSync(path, 'utf8')
  const needle = 'handle(CHANNELS.prepareAndStartTranscription, (request) => {'
  expect(source.split(needle)).toHaveLength(2)
  // Delay entry to the real atomic command, keeping validation/session checks,
  // SQLite writes, task deduplication, preflight cancellation and playback real.
  writeFileSync(
    path,
    source.replace(
      needle,
      `handle(CHANNELS.prepareAndStartTranscription, async (request) => {
    globalThis.__generationSavePending = true;
    await new Promise((resolve) => ipcMain.once('fixture:release-generation', resolve));
    globalThis.__generationSavePending = false;
  `,
    ),
  )
  return copied
}

test('failed profile storage never starts generation and the same panel can retry', async () => {
  const data = await fixture(),
    app = await electron.launch({ args: [appRoot], env: data.env })
  const database = new DatabaseSync(createDataPaths(data.root).database)
  try {
    const page = await app.firstWindow(),
      reader = await firstGeneration(page, 'ahead')
    database.exec(`CREATE TRIGGER reject_first_subtitle_profile BEFORE INSERT ON book_subtitle_settings
      BEGIN SELECT RAISE(ABORT,'fixture profile write failure'); END`)
    await reader.getByRole('button', { name: '保存并生成本集', exact: true }).click()
    await expect(reader.getByRole('alert')).toBeVisible()
    await expect(reader.getByRole('button', { name: '保存并生成本集', exact: true })).toBeEnabled()
    expect(
      database.prepare('SELECT count(*) AS amount FROM transcription_jobs').get()!.amount,
    ).toBe(0)
    expect(
      database.prepare('SELECT count(*) AS amount FROM book_subtitle_settings').get()!.amount,
    ).toBe(0)
    expect(existsSync(join(appRoot, 'python', 'worker-started'))).toBe(false)
    database.exec('DROP TRIGGER reject_first_subtitle_profile')
    await reader.getByRole('button', { name: '保存并生成本集', exact: true }).click()
    await expect.poll(() => existsSync(join(appRoot, 'python', 'worker-started'))).toBe(true)
    const state = await page.evaluate(() => window.desktop.getState())
    expect(state.ok && state.value.books[0]?.subtitlePreparation?.mode).toBe('ahead')
    expect(
      database.prepare('SELECT count(*) AS amount FROM transcription_jobs').get()!.amount,
    ).toBe(1)
  } finally {
    database.exec('DROP TRIGGER IF EXISTS reject_first_subtitle_profile')
    database.close()
    await app.close()
  }
})

test('canceling a pending first-generation command cancels only its newly created task', async () => {
  const data = await fixture(),
    copied = delayedGenerationApp(data.root)
  const app = await electron.launch({ args: [copied], env: data.env })
  const database = new DatabaseSync(createDataPaths(data.root).database)
  try {
    const page = await app.firstWindow(),
      reader = await firstGeneration(page, 'ahead')
    await reader.getByRole('button', { name: '保存并生成本集', exact: true }).click()
    await expect
      .poll(() => app.evaluate(() => Reflect.get(globalThis, '__generationSavePending')))
      .toBe(true)
    await reader.getByRole('button', { name: '取消本次生成', exact: true }).click()
    await app.evaluate(({ ipcMain }) => {
      ipcMain.emit('fixture:release-generation')
    })
    await expect
      .poll(() => database.prepare('SELECT status FROM transcription_jobs').get()?.status)
      .toBe('canceled')
    expect(existsSync(join(copied, 'python', 'worker-started'))).toBe(false)
    expect(
      await reader
        .locator('.transcription-controls > details')
        .evaluate((element: HTMLDetailsElement) => element.open),
    ).toBe(false)
  } finally {
    await app
      .evaluate(({ ipcMain }) => {
        ipcMain.emit('fixture:release-generation')
      })
      .catch(() => undefined)
    writeFileSync(join(data.root, 'release-delayed-probe'), '')
    database.close()
    await app.close()
  }
})

test('switching episodes while the initial command is delayed prevents old-session settings and task creation', async () => {
  const data = await fixture(true),
    copied = delayedGenerationApp(data.root)
  const app = await electron.launch({ args: [copied], env: data.env })
  const database = new DatabaseSync(createDataPaths(data.root).database)
  try {
    const page = await app.firstWindow(),
      reader = await firstGeneration(page, 'ahead')
    await reader.getByRole('button', { name: '保存并生成本集', exact: true }).click()
    await expect
      .poll(() => app.evaluate(() => Reflect.get(globalThis, '__generationSavePending')))
      .toBe(true)
    await menuAction(page, '播放选项', '下一集')
    await expect(reader.locator('.companion-title')).toContainText('第2集')
    await app.evaluate(({ ipcMain }) => {
      ipcMain.emit('fixture:release-generation')
    })
    await expect
      .poll(() => app.evaluate(() => Reflect.get(globalThis, '__generationSavePending')))
      .toBe(false)
    expect(
      database.prepare('SELECT count(*) AS amount FROM transcription_jobs').get()!.amount,
    ).toBe(0)
    expect(
      database.prepare('SELECT count(*) AS amount FROM book_subtitle_settings').get()!.amount,
    ).toBe(0)
    expect(existsSync(join(copied, 'python', 'worker-started'))).toBe(false)
  } finally {
    await app
      .evaluate(({ ipcMain }) => {
        ipcMain.emit('fixture:release-generation')
      })
      .catch(() => undefined)
    writeFileSync(join(data.root, 'release-delayed-probe'), '')
    database.close()
    await app.close()
  }
})

test('canceling the pending configuration preserves a matching task started elsewhere', async () => {
  const data = await fixture(),
    copied = delayedGenerationApp(data.root)
  const app = await electron.launch({ args: [copied], env: data.env })
  const database = new DatabaseSync(createDataPaths(data.root).database)
  try {
    const page = await app.firstWindow(),
      reader = await firstGeneration(page)
    await reader.getByRole('button', { name: '保存并生成本集', exact: true }).click()
    await expect
      .poll(() => app.evaluate(() => Reflect.get(globalThis, '__generationSavePending')))
      .toBe(true)
    const existing = await page.evaluate(async (episode) => {
      const result = await window.desktop.startTranscription({
        episodeId: episode.id,
        audioHash: episode.contentHash,
        engine: 'whisperx',
        device: 'cpu',
      })
      if (!result.ok || !result.value.job) throw new Error('Missing existing task')
      return result.value.job.id
    }, data.book.episodes[0]!)
    await reader.getByRole('button', { name: '取消本次生成', exact: true }).click()
    await app.evaluate(({ ipcMain }) => {
      ipcMain.emit('fixture:release-generation')
    })
    await expect
      .poll(() => app.evaluate(() => Reflect.get(globalThis, '__generationSavePending')))
      .toBe(false)
    await expect
      .poll(
        () =>
          database.prepare('SELECT count(*) AS amount FROM book_subtitle_settings').get()!.amount,
      )
      .toBe(1)
    expect(
      database.prepare('SELECT count(*) AS amount FROM transcription_jobs').get()!.amount,
    ).toBe(1)
    expect(
      database.prepare('SELECT status FROM transcription_jobs WHERE id=?').get(existing)!.status,
    ).toBe('running')
    await page.evaluate((id) => window.desktop.cancelTranscription({ id }), existing)
    await expect
      .poll(
        () =>
          database.prepare('SELECT status FROM transcription_jobs WHERE id=?').get(existing)
            ?.status,
      )
      .toBe('canceled')
  } finally {
    await app
      .evaluate(({ ipcMain }) => {
        ipcMain.emit('fixture:release-generation')
      })
      .catch(() => undefined)
    writeFileSync(join(data.root, 'release-delayed-probe'), '')
    database.close()
    await app.close()
  }
})

test('nearby components are explicit choices; CPU-only checks guide the shared profile and selection survives restart', async ({}, info) => {
  const data = await fixture(false, true)
  let app = await electron.launch({ args: [appRoot], env: data.env })
  try {
    let page = await app.firstWindow()
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    let dialog = await openSetup(page),
      setup = dialog.getByRole('region', { name: '本地字幕组件', exact: true })
    await expect(
      setup.getByRole('button', { name: '使用 asr-component', exact: true }),
    ).toBeEnabled()
    await expect(setup.getByRole('button', { name: '使用 incomplete', exact: true })).toBeDisabled()
    const before = await page.evaluate(() => window.desktop.detectTranscriptionComponents())
    expect(before.ok && before.value.configured).toBe(false)
    await setup.getByRole('button', { name: 'asr-component位置说明', exact: true }).focus()
    await expect(setup.getByRole('tooltip').filter({ hasText: componentRoot })).toBeVisible()
    await setup.getByRole('button', { name: '使用 asr-component', exact: true }).focus()
    await expect(
      setup
        .getByRole('button', { name: '使用 asr-component', exact: true })
        .locator('..')
        .getByText('未检查', { exact: true }),
    ).toBeVisible()
    await setup.locator('.component-installation > summary').click()
    const installation = setup.getByRole('region', { name: '离线组件安装', exact: true })
    await installation.getByLabel('离线安装帮助', { exact: true }).click()
    if (!before.ok || !before.value.guidance) throw Error('Missing authoritative local guidance')
    expect(before.value.guidance.checkedDevices).toEqual([])
    expect(before.value.guidance.suggestedDevice).toBeNull()
    for (const item of before.value.guidance.packages)
      await expect(installation.getByText(item.archiveName, { exact: true })).toBeVisible()
    expect(await installation.locator('.component-package-guide li').count()).toBe(
      before.value.guidance.packages.length,
    )
    await installation
      .getByRole('combobox', { name: '安装目标引擎', exact: true })
      .selectOption('paraformer')
    await installation
      .getByRole('combobox', { name: '安装目标设备', exact: true })
      .selectOption('cuda')
    await expect(
      installation.getByRole('list', { name: '离线安装步骤', exact: true }),
    ).toContainText('选包核对安装启用')
    await setup.getByRole('button', { name: '使用 asr-component', exact: true }).click()
    await expectComponentDirectory(page, setup, componentRoot)
    await setup.getByRole('button', { name: '检查组件', exact: true }).click()
    await expect(setup.getByText('组件检查通过', { exact: true })).toBeVisible()
    await expect(
      installation.getByText('当前组件已检查可用：CPU。安装目标仍由你选择。', { exact: true }),
    ).toBeVisible()
    await expect(
      installation.getByRole('combobox', { name: '安装目标引擎', exact: true }),
    ).toHaveValue('paraformer')
    await expect(
      installation.getByRole('combobox', { name: '安装目标设备', exact: true }),
    ).toHaveValue('cuda')
    await expect(setup.getByText('WhisperX · CPU：可用', { exact: true })).toBeVisible()
    await expect(
      setup.getByText('Paraformer · NVIDIA GPU：测试 CUDA 不可用。', { exact: true }),
    ).toBeVisible()
    await dialog.getByRole('combobox', { name: '字幕引擎', exact: true }).selectOption('whisperx')
    const device = dialog.getByRole('combobox', { name: '字幕设备', exact: true })
    await expect(device.locator('option[value="cuda"]')).toHaveJSProperty('disabled', true)
    await device.selectOption('cpu')
    await dialog.getByRole('button', { name: '保存字幕准备设置', exact: true }).click()
    await expect(dialog.getByText('本书字幕准备设置已保存。', { exact: true })).toBeVisible()
    await setup.locator('.component-check').scrollIntoViewIfNeeded()
    await page.screenshot({
      path: info.outputPath('component-check-cpu.png'),
      animations: 'disabled',
    })
    await dialog.getByRole('button', { name: '关闭收听工具', exact: true }).click()
    expect(await paused(page)).toBe(false)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await app.close()
    app = await electron.launch({ args: [appRoot], env: data.env })
    page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '字幕与伴读', exact: true })).toBeEnabled()
    dialog = await openSetup(page)
    setup = dialog.getByRole('region', { name: '本地字幕组件', exact: true })
    await expectComponentDirectory(page, setup, componentRoot)
    await expect(dialog.getByRole('combobox', { name: '字幕引擎', exact: true })).toHaveValue(
      'whisperx',
    )
    await expect(dialog.getByRole('combobox', { name: '字幕设备', exact: true })).toHaveValue('cpu')
  } finally {
    await app.close()
  }
})

test('invalid or canceled folder choices preserve the component; failed checks disable generation profiles while playback works', async () => {
  const data = await fixture(false, true),
    app = await electron.launch({ args: [appRoot], env: data.env })
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    const dialog = await openSetup(page),
      setup = dialog.getByRole('region', { name: '本地字幕组件', exact: true })
    await setup.getByRole('button', { name: '使用 asr-component', exact: true }).click()
    await expectComponentDirectory(page, setup, componentRoot)
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
    })
    await setup.getByRole('button', { name: '选择组件文件夹', exact: true }).click()
    await expect(setup.getByRole('button', { name: '检查组件', exact: true })).toBeEnabled()
    await app.evaluate(
      ({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
      },
      join(appRoot, 'components', 'incomplete'),
    )
    await setup.getByRole('button', { name: '选择组件文件夹', exact: true }).click()
    await expect(setup.getByRole('alert')).toContainText('组件配置无效')
    const state = await page.evaluate(() => window.desktop.detectTranscriptionComponents())
    expect(state.ok && state.value.currentDirectory).toBe(componentRoot)
    const broken = join(data.root, 'broken-diagnostics')
    writeComponent(broken, 'invalid-json')
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, broken)
    await setup.getByRole('button', { name: '选择组件文件夹', exact: true }).click()
    await expectComponentDirectory(page, setup, broken)
    await dialog.getByRole('combobox', { name: '字幕引擎', exact: true }).selectOption('whisperx')
    await setup.getByRole('button', { name: '检查组件', exact: true }).click()
    await expect(setup.getByText('组件检查发现问题', { exact: true })).toBeVisible()
    await expect(
      dialog.getByRole('button', { name: '保存字幕准备设置', exact: true }),
    ).toBeDisabled()
    await expect(
      setup.getByText('组件检查返回了无效结果，请重新选择完整组件。', { exact: true }),
    ).toHaveCount(1)
    await dialog.getByRole('button', { name: '关闭收听工具', exact: true }).click()
    expect(await paused(page)).toBe(false)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await expect.poll(() => paused(page)).toBe(false)
  } finally {
    await app.close()
  }
})

test('selecting the missing component resumes requested subtitle preparation without another generation click', async ({}, info) => {
  const data = await fixture(),
    app = await electron.launch({ args: [appRoot], env: data.env })
  try {
    const page = await app.firstWindow()
    const before = await page.evaluate(() => window.desktop.detectTranscriptionComponents())
    expect(before.ok && before.value.configured).toBe(false)
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await expect.poll(() => paused(page)).toBe(false)
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    const reader = page.getByRole('region', { name: '同步伴读', exact: true })
    await reader.getByRole('button', { name: '配置字幕组件', exact: true }).click()
    const setup = reader.getByRole('region', { name: '本地字幕组件', exact: true })
    await expect(setup).toBeVisible()
    await openComponentManagement(setup)
    expect(existsSync(join(appRoot, 'python', 'worker-started'))).toBe(false)
    const idle = await page.evaluate(
      (episode) =>
        window.desktop.getTranscriptionState({
          episodeId: episode.id,
          audioHash: episode.contentHash,
        }),
      data.book.episodes[0]!,
    )
    expect(idle.ok && idle.value.job).toBeNull()
    expect(
      await reader
        .locator('.transcript-import')
        .evaluate((element: HTMLDetailsElement) => element.open),
    ).toBe(false)
    await expect(
      reader.getByRole('button', { name: '导入 JSON 文稿', exact: true }),
    ).not.toBeVisible()
    expect(await page.getByRole('dialog', { name: '收听工具', exact: true }).count()).toBe(0)
    await setup.getByRole('button', { name: '使用 asr-component', exact: true }).click()
    await expect.poll(() => existsSync(join(appRoot, 'python', 'worker-started'))).toBe(true)
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setBounds({ width: 720, height: 600 }),
    )
    await page.screenshot({
      path: info.outputPath('first-generation-720x600.png'),
      animations: 'disabled',
    })
    const controls = reader.locator('.transcription-controls > details')
    if (!(await controls.evaluate((element: HTMLDetailsElement) => element.open)))
      await controls.locator(':scope > summary').click()
    const profile = reader.locator('[aria-label="本集字幕配置"]')
    await expect(profile).toContainText('Paraformer')
    await expect(profile).toContainText('CPU')
    await expect(profile).toContainText('边播放边生成')
    await expect(reader.getByRole('button', { name: '生成转写稿', exact: true })).toBeEnabled()
    const saved = await page.evaluate(() => window.desktop.getState())
    expect(saved.ok && saved.value.books[0]?.subtitlePreparation).toEqual({
      mode: 'auto',
      engine: 'paraformer',
      device: 'cpu',
      prepareNext: false,
    })
    const database = new DatabaseSync(createDataPaths(data.root).database)
    expect(
      database.prepare('SELECT count(*) AS amount FROM transcription_jobs').get()!.amount,
    ).toBe(1)
    database.close()
  } finally {
    await app.close()
  }
})

test('automatic prerequisite checking keeps playback and IPC responsive and cancellation prevents a late worker start', async ({}, info) => {
  const data = await fixture(false, true),
    gate = join(data.root, 'release-probe')
  writeComponent(componentRoot, 'cpu', gate)
  const app = await electron.launch({ args: [appRoot], env: data.env })
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    const reader = page.getByRole('region', { name: '同步伴读', exact: true })
    await openCompanionTools(reader)
    await reader.locator('.transcription-controls > details > summary').click()
    const setup = reader.getByRole('region', { name: '本地字幕组件', exact: true })
    await openComponentManagement(setup)
    await setup.getByRole('button', { name: '使用 asr-component', exact: true }).click()
    await reader.getByRole('button', { name: '调整字幕方案', exact: true }).click()
    await expectComponentDirectory(page, setup, componentRoot)
    await reader.getByRole('combobox', { name: '字幕引擎', exact: true }).selectOption('whisperx')
    await reader.getByRole('combobox', { name: '字幕设备', exact: true }).selectOption('cpu')
    await reader.getByRole('button', { name: '保存并生成本集', exact: true }).click()
    const activity = reader
      .locator('.companion-drawer[data-panel="tools"]')
      .getByRole('region', { name: '字幕生成进度', exact: true })
    await expect(activity).toHaveAttribute('data-job-status', 'running')
    await expect(activity).toContainText('检查字幕组件')
    await expect.poll(() => existsSync(`${gate}.started`)).toBe(true)
    const requestedAt = Date.now(),
      state = await page.evaluate(() => window.desktop.getState())
    expect(state.ok).toBe(true)
    expect(Date.now() - requestedAt).toBeLessThan(2000)
    expect(await paused(page)).toBe(false)
    await activity.getByRole('button', { name: '取消字幕生成', exact: true }).click()
    await expect(activity).toHaveAttribute('data-job-status', 'canceled', { timeout: 3000 })
    writeFileSync(gate, '')
    expect(existsSync(join(appRoot, 'python', 'worker-started'))).toBe(false)
    expect(await paused(page)).toBe(false)
    // Retry without an explicit component check. A failed automatic preflight
    // must publish the negative capability report to the already-mounted reader.
    writeComponent(componentRoot, 'invalid-json')
    await activity.getByRole('button', { name: '重新生成字幕', exact: true }).click()
    await expect(activity).toHaveAttribute('data-job-status', 'failed')
    const controls = reader.locator('.transcription-controls > details')
    if (!(await controls.evaluate((element: HTMLDetailsElement) => element.open)))
      await controls.locator(':scope > summary').click()
    const component = reader.getByRole('region', { name: '本地字幕组件', exact: true })
    await openComponentManagement(component)
    await expect(component.getByText('组件检查发现问题', { exact: true })).toBeVisible()
    await expect(reader.getByRole('button', { name: '生成转写稿', exact: true })).toBeDisabled()
    expect(existsSync(join(appRoot, 'python', 'worker-started'))).toBe(false)
    expect(await paused(page)).toBe(false)
    await component.locator('.component-check').scrollIntoViewIfNeeded()
    await page.screenshot({
      path: info.outputPath('automatic-preflight-error.png'),
      animations: 'disabled',
    })
  } finally {
    await app.close()
  }
})
