import { menuAction } from '../helpers/ui'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  openSync,
  writeSync,
  ftruncateSync,
  closeSync,
  unlinkSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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
function wav(path: string, seconds: number) {
  const size = seconds * 16000
  const header = Buffer.alloc(44)
  header.write('RIFF')
  header.writeUInt32LE(size + 36, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(8000, 24)
  header.writeUInt32LE(16000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(size, 40)
  const file = openSync(path, 'w')
  writeSync(file, header)
  ftruncateSync(file, size + 44)
  closeSync(file)
}
async function currentTime(page: Page) {
  return page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)
}
async function seek(page: Page, ms: number) {
  await page.getByRole('slider', { name: '播放进度' }).fill(String(ms))
  await expect.poll(() => currentTime(page)).toBeGreaterThanOrEqual(ms / 1000 - 0.5)
}
async function state(page: Page) {
  const result = await page.evaluate(() => window.desktop.getState())
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

test('two-hour audio seeks, rate and volume work; page changes and tray preserve one audio; explicit exit restores progress', async ({}, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), '听读 long player '))
  const path = join(root, '两小时 测试.wav')
  wav(path, 7200)
  let app = await launch(root)
  try {
    let page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await choose(app, path)
    await page.getByRole('button', { name: '选择音频文件' }).click()
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeEnabled()
    await expect.poll(() => currentTime(page)).toBeGreaterThan(0)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    const mediaUrl = await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.src)
    expect(
      await app.evaluate(async ({ net }, url) => {
        const response = await net.fetch(url, { headers: { Range: 'bytes=44-59' } })
        return {
          status: response.status,
          range: response.headers.get('content-range'),
          bytes: (await response.arrayBuffer()).byteLength,
        }
      }, mediaUrl),
    ).toEqual({ status: 206, range: 'bytes 44-59/115200044', bytes: 16 })
    await seek(page, 5400000)
    await page.getByRole('button', { name: '前进 15 秒' }).click()
    await expect.poll(() => currentTime(page)).toBeCloseTo(5415, 0)
    await page.getByRole('button', { name: '后退 15 秒' }).click()
    await expect.poll(() => currentTime(page)).toBeCloseTo(5400, 0)
    await page.getByRole('combobox', { name: '播放倍速' }).selectOption('1.5')
    await page.getByRole('button', { name: '调整音量', exact: true }).click()
    await page.getByRole('slider', { name: '音量', exact: true }).fill('0.35')
    expect(
      await page.locator('audio').evaluate((audio: HTMLAudioElement) => ({
        rate: audio.playbackRate,
        volume: audio.volume,
      })),
    ).toEqual({ rate: 1.5, volume: 0.35 })
    await page.evaluate(() => Reflect.set(window, 'originalAudio', document.querySelector('audio')))
    await page.getByRole('button', { name: '打开 两小时 测试.wav 的目录' }).click()
    await page.getByRole('button', { name: /我的书架/ }).click()
    expect(
      await page.evaluate(
        () => Reflect.get(window, 'originalAudio') === document.querySelector('audio'),
      ),
    ).toBe(true)
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible()),
      )
      .toBe(false)
    await expect.poll(() => currentTime(page)).toBeGreaterThan(5401)
    await expect
      .poll(async () => (await state(page)).books[0]!.episodes[0]!.positionMs)
      .toBeGreaterThan(5402000)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.show())
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await seek(page, 5410000)
    const closed = app.waitForEvent('close')
    await menuAction(page, '应用设置', '退出听见书页')
    await closed
    app = await launch(root)
    page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
    await expect.poll(() => currentTime(page)).toBeCloseTo(5410, 0)
    await expect(page.getByRole('combobox', { name: '播放倍速' })).toHaveValue('1.5')
    await page.getByRole('button', { name: '调整音量', exact: true }).click()
    await expect(page.getByRole('slider', { name: '音量', exact: true })).toHaveValue('0.35')
    expect((await state(page)).books[0]!.episodes[0]!.positionMs).toBeGreaterThanOrEqual(5409500)
    await page.screenshot({ path: testInfo.outputPath('m1-player.png'), fullPage: true })
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('folder order is confirmed before import, natural sort and auto-next save the correct chapter', async () => {
  const root = mkdtempSync(join(tmpdir(), '听读 folder player '))
  const folder = join(root, '测试书籍')
  mkdirSync(folder)
  for (const name of ['第10集.wav', '第2集.wav', '第1集.wav']) wav(join(folder, name), 10)
  const app = await launch(root)
  try {
    const page = await app.firstWindow()
    await choose(app, folder)
    await menuAction(page, '更多导入方式', '导入文件夹')
    const preview = page.getByRole('region', { name: '确认章节顺序' })
    await expect(preview.locator('li > span')).toHaveText(['第1集.wav', '第2集.wav', '第10集.wav'])
    expect((await state(page)).books).toHaveLength(0)
    await page.getByRole('button', { name: '反转顺序' }).click()
    await expect(preview.locator('li > span')).toHaveText(['第10集.wav', '第2集.wav', '第1集.wav'])
    await page.getByRole('button', { name: '取消导入' }).click()
    expect((await state(page)).books).toHaveLength(0)
    await menuAction(page, '更多导入方式', '导入文件夹')
    await page.getByRole('button', { name: '确认导入', exact: true }).click()
    await page.getByRole('button', { name: '打开 测试书籍 的目录' }).click()
    await page.getByRole('button', { name: '播放第 1 集 第1集.wav', exact: true }).click()
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeEnabled()
    await seek(page, 9800)
    await expect(page.locator('.now-playing h2')).toHaveText('第2集.wav')
    await expect
      .poll(async () => (await state(page)).books[0]!.currentEpisodeId)
      .toBe((await state(page)).books[0]!.episodes[1]!.id)
    const saved = (await state(page)).books[0]!
    expect(saved.episodes[0]!.positionMs).toBeGreaterThan(9900)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    const oldSession = await page.evaluate(async () => {
      const result = await window.desktop.getState()
      if (!result.ok) throw new Error('state')
      return window.desktop.openEpisode({ id: result.value.books[0]!.episodes[0]!.id })
    })
    if (!oldSession.ok) throw new Error('open')
    await page.getByRole('button', { name: '播放第 3 集 第10集.wav', exact: true }).click()
    await expect(page.locator('.now-playing h2')).toHaveText('第10集.wav')
    const stale = await page.evaluate(
      (source) =>
        window.desktop.saveProgress({
          sessionId: source.sessionId,
          episodeId: source.episode.id,
          positionMs: 123,
          durationMs: 10000,
          rate: 1,
          volume: 1,
        }),
      oldSession.value,
    )
    expect(stale).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    unlinkSync(join(folder, '第2集.wav'))
    await menuAction(page, '播放选项', '上一集')
    await expect(page.getByRole('alert')).toContainText('音频已移动或无法读取')
    await menuAction(page, '播放选项', '下一集')
    await expect(page.locator('.now-playing h2')).toHaveText('第10集.wav')
    await expect(page.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
    await expect(page.getByRole('alert')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('missing, changed and corrupt audio show recovery actions without deleting originals', async () => {
  const root = mkdtempSync(join(tmpdir(), '听读 errors player '))
  const path = join(root, '可移动.wav')
  wav(path, 30)
  const app = await launch(root)
  try {
    const page = await app.firstWindow()
    await choose(app, path)
    await page.getByRole('button', { name: '选择音频文件' }).click()
    await expect(page.getByRole('heading', { name: '可移动.wav', exact: true })).toBeVisible()
    unlinkSync(path)
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('音频已移动或无法读取')
    writeFileSync(path, 'corrupt but nonempty')
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('音频文件已变化')
    await page.getByRole('button', { name: '选择音频文件' }).click()
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('无法播放此音频')
    await expect(page.getByRole('button', { name: '重试播放' })).toBeVisible()
    await menuAction(page, '更多 可移动.wav 的操作', '移除 可移动.wav 的记录')
    await page
      .getByRole('dialog', { name: '确认移除书籍', exact: true })
      .getByRole('button', { name: '确认移除记录', exact: true })
      .click()
    expect(existsSync(path)).toBe(true)
    await expect(page.getByText('你的故事，从这里开始')).toBeVisible()
  } finally {
    await app.close()
  }
})

for (const format of ['mp3', 'm4a', 'm4b']) {
  test(`${format} synthetic codec fixture decodes, changes speed and seeks`, async () => {
    const root = mkdtempSync(join(tmpdir(), `ralb-${format}-`))
    const fixture = resolve(`tests/fixtures/tone.${format}`)
    expect(existsSync(fixture), 'Regenerate fixtures with tests/fixtures/generate.ts').toBe(true)
    const app = await launch(root)
    try {
      const page = await app.firstWindow()
      await choose(app, fixture)
      await page.getByRole('button', { name: '选择音频文件' }).click()
      await page.getByRole('button', { name: '继续播放', exact: true }).click()
      await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeEnabled()
      await page.getByRole('combobox', { name: '播放倍速' }).selectOption('2')
      await seek(page, 12000)
      await expect.poll(() => currentTime(page)).toBeGreaterThan(12.2)
      await page.getByRole('button', { name: '暂停', exact: true }).click()
      await expect(page.getByRole('alert')).toHaveCount(0)
      if (format === 'm4b') expect((await state(page)).books[0]!.episodes).toHaveLength(1)
    } finally {
      await app.close()
    }
  })
}

test('upgrading a v1 library preserves the selection and imports it from history without a picker', async () => {
  const root = mkdtempSync(join(tmpdir(), '听读 upgrade '))
  const path = join(root, '旧版选择.wav')
  wav(path, 30)
  mkdirSync(join(root, 'data'))
  const db = new DatabaseSync(join(root, 'data', 'library.sqlite3'))
  db.exec(`CREATE TABLE selected_files(id TEXT PRIMARY KEY, locator TEXT UNIQUE COLLATE NOCASE,
    name TEXT, size_bytes INTEGER, modified_at REAL, selected_at TEXT); PRAGMA user_version = 1;`)
  db.prepare('INSERT INTO selected_files VALUES (?, ?, ?, ?, ?, ?)').run(
    'a02a836c-1f16-44bf-a0aa-55cd14976534',
    path,
    '旧版选择.wav',
    480044,
    0,
    '2026-10-19',
  )
  db.close()
  const app = await launch(root)
  try {
    const page = await app.firstWindow()
    await menuAction(page, '应用设置', '应用信息')
    await page.getByText('此前选择的音频 · 1', { exact: true }).click()
    await page.getByRole('button', { name: '加入书架 旧版选择.wav', exact: true }).click()
    await expect(page.getByRole('heading', { name: '旧版选择.wav', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeEnabled()
    const imported = (await state(page)).books[0]!.episodes[0]!
    expect(imported.contentHash).toMatch(/^[0-9a-f]{64}$/)
  } finally {
    await app.close()
  }
})
