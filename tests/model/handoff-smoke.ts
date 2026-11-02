// Opt-in local isolation check. It never opens the user's normal or preview data.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'
import { extractFile } from '@electron/asar'
import { closeOwnedElectron } from './electron-lifecycle'

assert.deepEqual([process.argv.length, process.argv[2]], [4, '--directory'])
const source = resolve(process.argv[3]!)
const directory = resolve('cache/handoff-smoke', new Date().toISOString().replaceAll(':', '-'))
await mkdir(directory, { recursive: true })
const isolated = await mkdtemp(join(tmpdir(), '听读 独立交付 '))
const copied = join(isolated, basename(source))
const data = join(isolated, '全新应用数据')
const files = JSON.parse(await readFile(join(source, 'SHA256.json'), 'utf8')) as Record<
  string,
  string
>
const digest = async (path: string) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
const report: Record<string, unknown> = {
  status: 'running',
  source,
  copied,
  data,
  startedAt: new Date().toISOString(),
  officialExecutableUnchanged: false,
  cleanDeviceVerified: false,
  installerBuilt: false,
  scope: 'Local Windows isolation with the unchanged official Electron executable; not a clean OS.',
}
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
let app: ElectronApplication | undefined
let stage = 'copy-and-verify'
try {
  await cp(source, copied, { recursive: true })
  for (const [file, expected] of Object.entries(files)) {
    const target = resolve(copied, file)
    const local = relative(copied, target)
    assert.ok(local && local !== '..' && !local.startsWith('..' + sep))
    assert.equal(await digest(target), expected, file)
  }
  const executablePath = join(copied, 'runtime/electron.exe')
  const expectedPackage = JSON.parse(
    extractFile(join(copied, 'runtime/resources/app.asar'), 'package.json').toString('utf8'),
  ) as { version: string }
  assert.equal(
    await digest(executablePath),
    await digest(resolve('node_modules/electron/dist/electron.exe')),
  )
  report.officialExecutableUnchanged = true
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  for (const key of Object.keys(env))
    if (
      /^(NODE|PYTHON|VIRTUAL_ENV|CONDA|npm_)/i.test(key) ||
      /^ELECTRON_(RUN_AS_NODE|RENDERER_URL)$/i.test(key) ||
      /^RALB_/i.test(key) ||
      key.toLowerCase() === 'path'
    )
      Reflect.deleteProperty(env, key)
  env.PATH = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  env.RALB_USER_DATA = data
  report.environment = {
    PATH: env.PATH,
    nodeAndPythonVariablesRemoved: true,
    userDataIsolated: true,
    cwd: isolated,
  }
  const launch = () =>
    electron.launch({ executablePath, args: [], cwd: isolated, env, timeout: 20000 })
  stage = 'first-launch'
  await save()
  app = await launch()
  report.selfContainedRuntimeExecuted = true
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.context().setOffline(true)
  await expect(page).toHaveTitle('听见书页 · PageEcho')
  await expect(page.getByRole('link', { name: '听见书页首页', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '选择音频文件', exact: true })).toBeEnabled()
  const identity = await app.evaluate(({ app }) => ({
    isPackaged: app.isPackaged,
    name: app.getName(),
    version: app.getVersion(),
    appPath: app.getAppPath(),
    executable: app.getPath('exe'),
    userData: app.getPath('userData'),
    resources: process.resourcesPath,
  }))
  report.identity = identity
  // The unchanged electron.exe reports false even when loading resources/app.asar.
  // Verify the distribution boundary directly rather than falsifying that flag.
  report.electronPackagedFlag = identity.isPackaged
  assert.equal(resolve(identity.appPath), resolve(copied, 'runtime/resources/app.asar'))
  assert.equal(resolve(identity.executable), resolve(executablePath))
  assert.equal(resolve(identity.userData), resolve(data))
  assert.equal(identity.version, expectedPackage.version)
  assert.equal(identity.name, 'ReadAndListenBook')
  stage = 'local-audio-import-and-position'
  const wav = Buffer.alloc(44 + 70 * 16000)
  wav.write('RIFF')
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24)
  wav.writeUInt32LE(16000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(wav.length - 44, 40)
  const audio = join(isolated, '山间来信 第1集.wav')
  await writeFile(audio, wav)
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, audio)
  await page.getByRole('button', { name: '选择音频文件', exact: true }).click()
  await page.getByRole('button', { name: '继续播放', exact: true }).click()
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('12345')
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const result = await window.desktop.getState()
        return result.ok ? result.value.books[0]?.episodes[0]?.positionMs : undefined
      }),
    )
    .toBe(12345)
  report.audio = { imported: true, positionMs: 12345, paused: true }
  stage = 'original-worker-and-reading-position'
  const text = join(isolated, '山间来信.txt')
  await writeFile(
    text,
    '第1章 山路\n清晨的风穿过树梢。\n少年沿着小路前进。\n山间的钟声渐渐远去。\n小船驶向远方。\n第2章 清晨\n第二天的故事仍在继续。',
  )
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, text)
  const imported = await page.evaluate(() => window.desktop.importReadingBook())
  assert.ok(imported.ok && !imported.value.canceled, JSON.stringify(imported))
  if (!imported.ok || imported.value.canceled) throw new Error('Original worker import failed')
  const book = imported.value.book
  assert.equal(book.chapters.length, 2)
  const parsed = await page.evaluate(
    (id) => window.desktop.getReadingPage({ id, start: 0 }),
    book.id,
  )
  assert.ok(parsed.ok)
  assert.equal(parsed.value.sentences[0]?.text, '清晨的风穿过树梢。')
  const saved = await page.evaluate(
    (id) => window.desktop.saveReadingPosition({ id, position: 3 }),
    book.id,
  )
  assert.ok(saved.ok)
  await page.evaluate((id) => location.assign(`#/read/${encodeURIComponent(id)}`), book.id)
  await expect(page.locator('.book-viewport')).toHaveAttribute('aria-busy', 'false')
  await expect(page.locator('.reader-progress-label')).toHaveAttribute('data-position', '3')
  await page.screenshot({ path: join(directory, 'standalone-reading.png'), animations: 'disabled' })
  report.reading = { imported: true, originalWorkerExecuted: true, id: book.id, position: 3 }
  stage = 'native-ebook-speech'
  const speechSource = await page.evaluate(async (id) => {
    const voices = await window.desktop.getEbookSpeechVoices()
    if (!voices.ok || !voices.value.available)
      throw new Error(voices.ok ? voices.value.message : voices.error.message)
    const generated = await window.desktop.synthesizeEbookSpeech({ id, ordinal: 3, offset: 0 })
    if (!generated.ok) throw new Error(generated.error.message)
    return { url: generated.value.url, voices: voices.value.voices }
  }, book.id)
  // Main-process inspection keeps the renderer's connect-src 'none' intact.
  const speechWave = await app.evaluate(async ({ net }, url) => {
    const response = await net.fetch(url)
    const bytes = new Uint8Array(await response.arrayBuffer())
    return { wavBytes: bytes.length, nonSilent: bytes.subarray(44).some((value) => value !== 0) }
  }, speechSource.url)
  const actualMediaPlayed = await page.evaluate(async (url) => {
    const audio = new Audio(url)
    await audio.play()
    const played = !audio.paused
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    await window.desktop.releaseEbookSpeech()
    return played
  }, speechSource.url)
  assert.ok(speechWave.wavBytes > 44 && speechWave.nonSilent && actualMediaPlayed)
  report.ebookSpeech = {
    ...speechWave,
    voices: speechSource.voices.map((voice) => ({ name: voice.name, language: voice.language })),
    actualMediaPlayed,
    systemVoices: true,
    modelComponentRequired: false,
  }
  stage = 'first-exit'
  report.firstCleanup = await closeOwnedElectron(app)
  app = undefined
  stage = 'restart'
  app = await launch()
  const resumed = await app.firstWindow()
  resumed.on('pageerror', (error) => errors.push(error.message))
  await resumed.context().setOffline(true)
  await expect(resumed.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
  const restored = await resumed.evaluate(async () => {
    const state = await window.desktop.getState()
    const reading = await window.desktop.getReadingBooks()
    return { state, reading }
  })
  assert.ok(restored.state.ok && restored.reading.ok)
  assert.equal(restored.state.value.books[0]?.episodes[0]?.positionMs, 12345)
  assert.equal(restored.reading.value.find((item) => item.id === book.id)?.position, 3)
  const clock = await resumed.locator('audio').evaluate((node: HTMLAudioElement) => ({
    paused: node.paused,
    positionMs: Math.round(node.currentTime * 1000),
  }))
  assert.deepEqual(clock, { paused: true, positionMs: 12345 })
  assert.deepEqual(errors, [])
  report.restart = { audioAndReadingPositionsRestored: true, audioPaused: true }
  report.secondCleanup = await closeOwnedElectron(app)
  app = undefined
  stage = 'post-run-integrity'
  for (const [file, expected] of Object.entries(files))
    assert.equal(await digest(join(copied, file)), expected, file)
  report.distributionUnchangedAfterRun = true
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.stage = stage
  report.error = error instanceof Error ? error.stack : String(error)
  process.exitCode = 1
} finally {
  if (app) report.cleanup = await closeOwnedElectron(app)
  report.finishedAt = new Date().toISOString()
  await save()
  console.log(
    JSON.stringify({ status: report.status, stage, report: join(directory, 'report.json') }),
  )
}
