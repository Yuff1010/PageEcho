import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import type { TranscriptDocument } from '../../src/shared/transcript'

let python: string | undefined
try {
  python = execFileSync('python', ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
} catch {
  // The production rejection case needs no Python; fixture activation uses stdlib only.
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), '听读 离线安装界面 ')),
    paths = createDataPaths(root),
    store = new LibraryStore(paths.database)
  store.importBook(await scanBook(resolve('tests/fixtures/第32集-伴读样本.wav'), 'file'))
  const book = store.listBooks()[0]!,
    episode = book.episodes[0]!
  store.saveTranscript(
    episode.id,
    JSON.parse(
      readFileSync(resolve('tests/fixtures/reading-manual.json'), 'utf8'),
    ) as TranscriptDocument,
  )
  store.saveProgress({
    sessionId: '',
    episodeId: episode.id,
    positionMs: 0,
    durationMs: 16360,
    rate: 1,
    volume: 1,
  })
  store.close()
  const external = join(root, '既有外部组件')
  mkdirSync(external)
  mkdirSync(join(external, 'resources'))
  writeFileSync(join(external, 'runtime.exe'), 'Metadata-only external component; never executed.')
  writeFileSync(join(external, 'models.json'), JSON.stringify({ version: 1, models: {} }))
  writeFileSync(
    join(external, 'component.json'),
    JSON.stringify({
      version: 2,
      python: python ?? 'runtime.exe',
      models: 'models.json',
      resources: 'resources',
      ffmpeg: python ?? 'runtime.exe',
      ffprobe: python ?? 'runtime.exe',
    }),
  )
  const unknown = join(root, '未知组件.zip')
  writeFileSync(unknown, 'This file is not a publisher-pinned component archive.')
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  return { root, paths, book, episode, external, unknown, env }
}
function launch(env: NodeJS.ProcessEnv, appRoot?: string) {
  return electron.launch({
    ...(process.env.RALB_EXECUTABLE
      ? { executablePath: resolve(process.env.RALB_EXECUTABLE), args: [] }
      : { args: [appRoot ?? resolve(process.env.RALB_APP_ROOT ?? '.')] }),
    env: Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
  })
}
async function select(app: ElectronApplication, path: string | null) {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: path === null,
      filePaths: path === null ? [] : [path],
    })
  }, path)
}
async function openPanel(page: Page) {
  await page.getByRole('button', { name: '字幕与伴读', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '收听工具', exact: true })
  await dialog.locator('.component-installation > summary').click()
  const panel = dialog.getByRole('region', { name: '离线组件安装', exact: true })
  await expect(panel.getByRole('combobox', { name: '安装目标引擎', exact: true })).toBeVisible()
  return { dialog, panel }
}
async function installState(page: Page) {
  return page.evaluate(async () => {
    const result = await window.desktop.getComponentInstallations()
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  })
}
async function configured(page: Page) {
  return page.evaluate(async () => {
    const result = await window.desktop.detectTranscriptionComponents()
    if (!result.ok) throw new Error(result.error.message)
    return result.value.currentDirectory
  })
}

test('the production installer rejects unknown ZIPs and invalid IPC while native cancel and notifications preserve the target draft', async ({}, info) => {
  const data = await fixture(),
    app = await launch(data.env)
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: '播放', exact: true }).click()
    const { dialog, panel } = await openPanel(page)
    await select(app, join(data.external, 'component.json'))
    await dialog.getByRole('button', { name: '选择组件配置', exact: true }).click()
    await expect.poll(() => configured(page)).toBe(data.external)
    const engine = panel.getByRole('combobox', { name: '安装目标引擎', exact: true }),
      device = panel.getByRole('combobox', { name: '安装目标设备', exact: true })
    await expect(
      panel.getByRole('button', { name: '选择本地组件 ZIP', exact: true }),
    ).toBeDisabled()
    await engine.selectOption('paraformer')
    await device.selectOption('cuda')
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.send('component-install:changed'),
    )
    await expect(engine).toHaveValue('paraformer')
    await expect(device).toHaveValue('cuda')
    await expect(
      panel.getByText('在线组件源尚未配置，可从离线包安装。', { exact: true }),
    ).toBeVisible()
    await expect(panel.getByText('CPU 专用包仅支持', { exact: false })).toContainText(
      '通用包也可在 CPU 上运行，仍含 CUDA 依赖',
    )
    await select(app, null)
    await panel.getByRole('button', { name: '选择本地组件 ZIP', exact: true }).click()
    await expect(panel.getByText('未选择离线包，原组件继续保留。', { exact: true })).toBeVisible()
    expect((await installState(page)).activity).toBeNull()
    const invalid = await page.evaluate(async () => {
      const requests = [
        window.desktop.chooseComponentPackage({ engine: 'invalid', device: 'cpu' } as never),
        window.desktop.chooseComponentPackage({
          engine: 'whisperx',
          device: 'cpu',
          path: '../untrusted.zip',
        } as never),
        window.desktop.startComponentInstallation({ id: '../escape' }),
        window.desktop.cancelComponentInstallation({ id: '' }),
        window.desktop.activateComponentInstallation({ id: 'not-a-uuid' }),
      ]
      return Promise.all(
        requests.map(async (pending) => {
          const result = await pending
          return result.ok ? 'unexpected-success' : result.error.code
        }),
      )
    })
    expect(invalid).toEqual(Array(5).fill('INVALID_REQUEST'))
    expect((await installState(page)).activity).toBeNull()
    await select(app, data.unknown)
    await panel.getByRole('button', { name: '选择本地组件 ZIP', exact: true }).click()
    await expect(panel.locator('[data-installation-status="failed"]')).toBeVisible()
    await expect(panel.getByRole('alert')).not.toBeEmpty()
    await expect(panel.getByText('版本未确认', { exact: false })).toBeVisible()
    await expect(engine).toHaveValue('paraformer')
    await expect(device).toHaveValue('cuda')
    await expect(panel.getByRole('button', { name: '安装所选组件', exact: true })).toHaveCount(0)
    expect((await installState(page)).installations).toEqual([])
    expect(await configured(page)).toBe(data.external)
    expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(
      false,
    )
    const state = await page.evaluate(() => window.desktop.getState())
    expect(state.ok && state.value.books[0]?.subtitlePreparation).toBeUndefined()
    await page.screenshot({ path: info.outputPath('untrusted-package-preserves-component.png') })
  } finally {
    await app.close()
  }
})

// Only a copied preview receives the controlled core. The production catalog
// above is unchanged, and service/IPC/queue/configuration/probe still run normally.
// This does not validate archive extraction, ASR quality, GPU or disk savings.
function controlledApp(reportPath: string) {
  const directory = mkdtempSync(join(tmpdir(), '听读 安装界面 受控core '))
  cpSync(resolve(process.env.RALB_APP_ROOT ?? '.', 'out'), join(directory, 'out'), {
    recursive: true,
  })
  cpSync(resolve(process.env.RALB_APP_ROOT ?? '.', 'python'), join(directory, 'python'), {
    recursive: true,
  })
  symlinkSync(resolve('node_modules'), join(directory, 'node_modules'), 'junction')
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: 'component-installation-ui-fixture',
      type: 'module',
      main: './out/main/index.js',
    }),
  )
  const main = join(directory, 'out/main/index.js'),
    source = readFileSync(main, 'utf8')
  const changed = ['out/main/index.js', 'python/asr_component_probe.py', 'python/asr_worker.py']
  const originalHashes = Object.fromEntries(
    changed.map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(join(directory, file)))
        .digest('hex'),
    ]),
  )
  expect(/(?:class ComponentInstallerCore|ComponentInstallerCore = class)/.test(source)).toBe(true)
  writeFileSync(
    main,
    source +
      String.raw`
// Test-only controlled core: no production catalog or application source is changed.
const __installationFixture = globalThis.__installationFixture = {
  inspections: 0, installs: 0, verifications: 0, holdInspect: false, holdInstall: false, failVerify: false
};
async function __installationGate(key, signal) {
  while (__installationFixture[key]) {
    signal.throwIfAborted();
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  signal.throwIfAborted();
}
ComponentInstallerCore.prototype.inspect = async function(path, profile, signal, progress) {
  __installationFixture.inspections++;
  progress('inspecting', 1, 64);
  await __installationGate('holdInspect', signal);
  progress('inspecting', 64, 64);
  return { archivePath: path, bundle: { id: 'ui-fixture', version: '0.7.0-fixture', archiveBytes: 64, archiveSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64) }, profile, files: [], requiredBytes: 128, freeBytes: 1073741824, sourceSize: 64, sourceModifiedMs: 0 };
};
ComponentInstallerCore.prototype.load = async function() {
  const fs = await import('node:fs/promises'), path = await import('node:path');
  try { return JSON.parse(await fs.readFile(path.join(process.env.RALB_USER_DATA, 'ui-managed-receipts.json'), 'utf8')); }
  catch(error) { if(error.code === 'ENOENT') return []; throw error; }
};
ComponentInstallerCore.prototype.install = async function(plan, signal, progress) {
  __installationFixture.installs++;
  progress('installing', 1, 128);
  await __installationGate('holdInstall', signal);
  const fs = await import('node:fs/promises'), path = await import('node:path'), crypto = await import('node:crypto');
  const id = crypto.randomUUID(), root = path.join(process.env.RALB_USER_DATA, 'ui-managed', id);
  await fs.mkdir(path.join(root, 'resources'), {recursive: true});
  await fs.writeFile(path.join(root, 'models.json'), JSON.stringify({version: 1, models: {}}));
  const componentPath = path.join(root, 'component.json');
  await fs.writeFile(componentPath, JSON.stringify({version: 2, python: ${JSON.stringify(python)}, models: 'models.json', resources: 'resources', ffmpeg: ${JSON.stringify(python)}, ffprobe: ${JSON.stringify(python)}}));
  const receipt = {id, version: plan.bundle.version, profile: plan.profile, bytes: 128, installedAt: new Date().toISOString(), componentPath, receiptPath: path.join(root, 'receipt.json')};
  await fs.writeFile(receipt.receiptPath, JSON.stringify(receipt));
  const receipts = await this.load(); receipts.push(receipt);
  await fs.writeFile(path.join(process.env.RALB_USER_DATA, 'ui-managed-receipts.json'), JSON.stringify(receipts));
  progress('checking', 128, 128);
  return receipt;
};
ComponentInstallerCore.prototype.verify = async function(receipt, signal) {
  __installationFixture.verifications++;
  signal.throwIfAborted();
  if (__installationFixture.failVerify) throw new AppError('FILE_CHANGED', '测试校验拒绝，原组件保持不变。');
};
`,
  )
  writeFileSync(
    join(directory, 'python/asr_component_probe.py'),
    String.raw`
import json
print(json.dumps({'level':'imports-and-files','pythonVersion':'fixture-stdlib','cudaName':None,'freeBytes':1073741824,'issues':['UI fixture only, no model inference.'],'capabilities':[{'engine':engine,'device':device,'available':device=='cpu','message':'fixture CPU only'} for engine in ['whisperx','paraformer'] for device in ['cpu','cuda']]}))
`,
  )
  writeFileSync(
    join(directory, 'python/asr_worker.py'),
    String.raw`
import json,sys,time
print(json.dumps({'protocolVersion':1,'type':'ready','configuration':{'uiFixture':True}}),flush=True)
for line in sys.stdin:
    request=json.loads(line)
    while True:
        time.sleep(0.05)
`,
  )
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        scope:
          'A temporary copied preview receives prototype overrides for the installation core plus a stdlib capability probe and a held fake ASR worker. Main IPC/service/queue/configuration/player remain real. No archive trust, resource enforcement, real inference or quality claim.',
        sourceAppRoot: resolve(process.env.RALB_APP_ROOT ?? '.'),
        temporaryAppRoot: directory,
        productionCatalogChanged: false,
        originalHashes,
        modifiedHashes: Object.fromEntries(
          changed.map((file) => [
            file,
            createHash('sha256')
              .update(readFileSync(join(directory, file)))
              .digest('hex'),
          ]),
        ),
      },
      null,
      2,
    ),
  )
  return directory
}
async function fixtureFlag(app: ElectronApplication, key: string, value: boolean) {
  await app.evaluate(
    (_, change) => {
      Reflect.set(Reflect.get(globalThis, '__installationFixture'), change.key, change.value)
    },
    { key, value },
  )
}
async function fixtureCount(app: ElectronApplication, key: string) {
  return app.evaluate(
    (_, key) => Reflect.get(Reflect.get(globalThis, '__installationFixture'), key),
    key,
  )
}

test('a late native package choice never installs automatically and ready or running installation cancellation preserves the original component', async ({}, info) => {
  test.skip(
    !python || !!process.env.RALB_EXECUTABLE,
    'Controlled core activation requires a copied preview and stdlib Python.',
  )
  const data = await fixture(),
    app = await launch(data.env, controlledApp(info.outputPath('controlled-core-scope.json')))
  try {
    const page = await app.firstWindow()
    const { dialog, panel } = await openPanel(page)
    await select(app, join(data.external, 'component.json'))
    await dialog.getByRole('button', { name: '选择组件配置', exact: true }).click()
    await expect.poll(() => configured(page)).toBe(data.external)
    await panel
      .getByRole('combobox', { name: '安装目标引擎', exact: true })
      .selectOption('paraformer')
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () =>
        new Promise((resolve) => {
          Reflect.set(globalThis, '__finishPackageChoice', () =>
            resolve({ canceled: false, filePaths: [path] }),
          )
        })
    }, data.unknown)
    await panel.getByRole('button', { name: '选择本地组件 ZIP', exact: true }).click()
    await expect
      .poll(() => app.evaluate(() => typeof Reflect.get(globalThis, '__finishPackageChoice')))
      .toBe('function')
    await dialog.getByRole('button', { name: '关闭收听工具', exact: true }).click()
    await app.evaluate(() => Reflect.get(globalThis, '__finishPackageChoice')())
    await expect.poll(async () => (await installState(page)).activity?.status).toBe('ready')
    expect(await fixtureCount(app, 'installs')).toBe(0)
    expect(await configured(page)).toBe(data.external)
    const opened = await openPanel(page)
    await expect(opened.panel.locator('[data-installation-status="ready"]')).toBeVisible()
    await expect(opened.panel.getByText('组件 0.7.0-fixture', { exact: false })).toBeVisible()
    await opened.panel.getByRole('button', { name: '取消本次安装', exact: true }).click()
    await expect(opened.panel.locator('[data-installation-status="canceled"]')).toBeVisible()
    await expect(opened.panel.locator('.tools-notice')).toHaveText(
      '本次安装已取消，原组件继续保留。',
    )
    await expect(
      opened.panel.getByRole('combobox', { name: '安装目标引擎', exact: true }),
    ).toBeEnabled()
    expect(await fixtureCount(app, 'installs')).toBe(0)
    await opened.panel
      .getByRole('combobox', { name: '安装目标引擎', exact: true })
      .selectOption('whisperx')
    await select(app, data.unknown)
    await opened.panel.getByRole('button', { name: '选择本地组件 ZIP', exact: true }).click()
    await expect(opened.panel.locator('[data-installation-status="ready"]')).toBeVisible()
    await fixtureFlag(app, 'holdInstall', true)
    await opened.panel.getByRole('button', { name: '安装所选组件', exact: true }).click()
    await expect(opened.panel.locator('[data-installation-status="installing"]')).toBeVisible()
    await opened.panel.getByRole('button', { name: '取消本次安装', exact: true }).click()
    await expect(opened.panel.locator('[data-installation-status="canceled"]')).toBeVisible()
    await expect(opened.panel.locator('.tools-notice')).toHaveText(
      '本次安装已取消，原组件继续保留。',
    )
    await expect(
      opened.panel.getByRole('combobox', { name: '安装目标引擎', exact: true }),
    ).toBeEnabled()
    await expect(
      opened.panel.getByRole('combobox', { name: '安装目标引擎', exact: true }),
    ).toHaveValue('whisperx')
    expect((await installState(page)).installations).toEqual([])
    expect(await configured(page)).toBe(data.external)
    const transcribed = await page.evaluate(
      async (target) => window.desktop.getTranscriptionState(target),
      { episodeId: data.episode.id, audioHash: data.episode.contentHash },
    )
    expect(transcribed.ok && transcribed.value.job).toBeNull()
    await page.screenshot({ path: info.outputPath('canceled-install-preserves-original.png') })
  } finally {
    await app.close()
  }
})

test('installation requires separate activation, rejects active-task or failed checks, and can restore the external component across restart', async ({}, info) => {
  test.skip(
    !python || !!process.env.RALB_EXECUTABLE,
    'Controlled core activation requires a copied preview and stdlib Python.',
  )
  const data = await fixture(),
    appRoot = controlledApp(info.outputPath('controlled-core-scope.json'))
  let app = await launch(data.env, appRoot)
  try {
    let page = await app.firstWindow(),
      opened = await openPanel(page)
    await select(app, join(data.external, 'component.json'))
    await opened.dialog.getByRole('button', { name: '选择组件配置', exact: true }).click()
    await expect.poll(() => configured(page)).toBe(data.external)
    await opened.panel
      .getByRole('combobox', { name: '安装目标引擎', exact: true })
      .selectOption('paraformer')
    await select(app, data.unknown)
    await opened.panel.getByRole('button', { name: '选择本地组件 ZIP', exact: true }).click()
    await expect(opened.panel.locator('[data-installation-status="ready"]')).toBeVisible()
    await expect(opened.panel.getByText('预计新增占用', { exact: true })).toBeVisible()
    await opened.panel.getByRole('button', { name: '安装所选组件', exact: true }).click()
    await expect(opened.panel.locator('[data-installation-status="installed"]')).toBeVisible()
    expect(await configured(page)).toBe(data.external)
    expect(await fixtureCount(app, 'verifications')).toBe(0)
    const target = { episodeId: data.episode.id, audioHash: data.episode.contentHash }
    const job = await page.evaluate(async (target) => {
      const result = await window.desktop.startTranscription({
        ...target,
        engine: 'whisperx',
        device: 'cpu',
      })
      if (!result.ok || !result.value.job) throw new Error('Fixture job must exist')
      return result.value.job
    }, target)
    await opened.panel.getByRole('button', { name: '启用此版本', exact: true }).click()
    await expect(opened.panel.getByRole('alert')).toContainText('任务')
    expect(await configured(page)).toBe(data.external)
    await page.evaluate(async (id) => {
      const result = await window.desktop.cancelTranscription({ id })
      if (!result.ok) throw new Error(result.error.message)
    }, job.id)
    await expect
      .poll(async () => {
        const result = await page.evaluate(
          (target) => window.desktop.getTranscriptionState(target),
          target,
        )
        return result.ok && result.value.job?.status
      })
      .toBe('canceled')
    await fixtureFlag(app, 'failVerify', true)
    await opened.panel.getByRole('button', { name: '启用此版本', exact: true }).click()
    await expect(opened.panel.getByRole('alert')).toContainText('测试校验拒绝')
    expect(await configured(page)).toBe(data.external)
    await fixtureFlag(app, 'failVerify', false)
    await opened.panel.getByRole('button', { name: '启用此版本', exact: true }).click()
    await expect(opened.panel.getByRole('button', { name: '正在使用', exact: true })).toBeDisabled()
    const managed = (await installState(page)).installations.find((item) => item.managed)!
    expect(managed.active).toBe(true)
    await expect(opened.panel.getByText(/^保存于 \d{4}/)).toBeVisible()
    await expect(opened.panel.getByText(/^安装于 \d{4}/)).toBeVisible()
    expect((await installState(page)).installations.find((item) => !item.managed)?.active).toBe(
      false,
    )
    const state = await page.evaluate(() => window.desktop.getState())
    expect(state.ok && state.value.books[0]?.subtitlePreparation).toBeUndefined()
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setBounds({ width: 720, height: 600 }),
    )
    await opened.panel
      .getByRole('button', { name: '恢复此版本', exact: true })
      .scrollIntoViewIfNeeded()
    expect(
      await opened.panel.evaluate(
        (element) =>
          element.getBoundingClientRect().left >= 0 &&
          element.getBoundingClientRect().right <= window.innerWidth &&
          element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true)
    await page.screenshot({ path: info.outputPath('installed-versions-720x600.png') })
    await opened.panel.getByRole('button', { name: '恢复此版本', exact: true }).click()
    await expect.poll(() => configured(page)).toBe(data.external)
    expect((await installState(page)).installations.find((item) => !item.managed)?.active).toBe(
      true,
    )
    await app.close()
    app = await launch(data.env, appRoot)
    page = await app.firstWindow()
    opened = await openPanel(page)
    expect(await configured(page)).toBe(data.external)
    expect(
      (await installState(page)).installations.find((item) => item.id === managed.id)?.active,
    ).toBe(false)
    await opened.panel.getByRole('button', { name: '启用此版本', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await installState(page)).installations.find((item) => item.id === managed.id)?.active,
      )
      .toBe(true)
    await expect(opened.panel.getByRole('button', { name: '正在使用', exact: true })).toBeDisabled()
    expect(
      (await installState(page)).installations.find((item) => item.id === managed.id)?.active,
    ).toBe(true)
  } finally {
    await app.close()
  }
})
