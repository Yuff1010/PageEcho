import { menuAction } from '../helpers/ui'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
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
function audio(path: string, seconds: number) {
  const bytes = Buffer.alloc(44 + seconds * 16000)
  bytes.write('RIFF')
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(8000, 24)
  bytes.writeUInt32LE(16000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(bytes.length - 44, 40)
  writeFileSync(path, bytes)
}
async function library(page: Page) {
  const result = await page.evaluate(() => window.desktop.getState())
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
async function importFolder(app: ElectronApplication, page: Page, path: string) {
  await choose(app, path)
  await menuAction(page, '更多导入方式', '导入文件夹')
  await page.getByRole('button', { name: '确认导入', exact: true }).click()
}
async function time(page: Page) {
  return page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)
}
function timerFeedback(page: Page) {
  return page
    .getByRole('region', { name: '播放器', exact: true })
    .getByRole('status')
    .filter({ hasText: /定时|本集结束|^\d+ 分钟后停止$/ })
}
async function seek(page: Page, ms: number) {
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill(String(ms))
  await expect.poll(() => time(page)).toBeCloseTo(ms / 1000, 0)
}
async function tools(page: Page) {
  await menuAction(page, '播放选项', '收听工具')
  return page.getByRole('dialog', { name: '收听工具', exact: true })
}

test('bookmarks preserve coordinates and notes across restart; changed audio disables old jumps', async ({}, info) => {
  const root = mkdtempSync(join(tmpdir(), '听读 M4 bookmarks ')),
    folder = join(root, '故事 章节')
  mkdirSync(folder)
  const file = join(folder, '第01集.wav')
  audio(file, 60)
  let app = await launch(root)
  try {
    let page = await app.firstWindow()
    await importFolder(app, page, folder)
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await seek(page, 1250)
    await menuAction(page, '播放选项', '添加书签')
    await menuAction(page, '播放选项', '添加书签')
    let dialog = await tools(page)
    await dialog.getByRole('tab', { name: '查看书签', exact: true }).click()
    await expect(dialog.getByText('书签 · 1', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: '备注', exact: true }).click()
    await dialog
      .getByRole('textbox', { name: '书签备注', exact: true })
      .fill('想回来听的地方 <script>普通文字</script>')
    await dialog.getByRole('button', { name: '保存备注', exact: true }).click()
    await expect(dialog.getByText('书签备注已保存。', { exact: true })).toBeVisible()
    await dialog.getByRole('tab', { name: '播放与定时', exact: true }).click()
    await dialog.getByRole('spinbutton', { name: '跳过片头秒数' }).fill('5')
    await dialog.getByRole('spinbutton', { name: '跳过片尾秒数' }).fill('3')
    await dialog.getByRole('button', { name: '保存跳过设置' }).click()
    await expect(dialog.getByText('本书跳过设置已保存。')).toBeVisible()
    await dialog.getByRole('button', { name: '关闭收听工具' }).click()
    const closed = app.waitForEvent('close')
    await menuAction(page, '应用设置', '退出听读')
    await closed
    app = await launch(root)
    page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
    await expect.poll(() => time(page)).toBeCloseTo(5, 0)
    dialog = await tools(page)
    await dialog.getByRole('tab', { name: '查看书签', exact: true }).click()
    await expect(
      dialog.getByText('想回来听的地方 <script>普通文字</script>', { exact: true }),
    ).toBeVisible()
    await dialog.getByRole('tab', { name: '播放与定时', exact: true }).click()
    await expect(dialog.getByRole('spinbutton', { name: '跳过片头秒数' })).toHaveValue('5')
    await dialog.getByRole('tab', { name: '查看书签', exact: true }).click()
    await dialog.getByRole('button', { name: /^跳转书签/ }).click()
    await expect.poll(() => time(page)).toBeCloseTo(1.25, 1)
    expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(
      true,
    )
    await page.getByRole('combobox', { name: '书架排序' }).selectOption('played')
    const recentPosition = page
      .getByRole('region', { name: '最近播放', exact: true })
      .locator('.shelf-book-position')
    await expect(recentPosition).toBeVisible()
    await expect(recentPosition).toHaveText('第01集.wav · 00:00:01')
    const secondFile = join(root, '另一本故事.wav')
    audio(secondFile, 30)
    await choose(app, secondFile)
    await page.getByRole('button', { name: '选择音频文件', exact: true }).click()
    await expect(
      page.getByRole('region', { name: '最近播放', exact: true }).locator('.file-list > li'),
    ).toHaveCount(1)
    await page.getByRole('button', { name: /^我的书架/ }).click()
    await page
      .locator('.file-list > li')
      .filter({ hasText: '另一本故事.wav' })
      .getByRole('button', { name: '继续播放', exact: true })
      .click()
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await expect.poll(() => time(page)).toBeLessThan(1)
    await page.getByRole('combobox', { name: '书架排序' }).selectOption('played')
    await expect(
      page
        .getByRole('region', { name: '最近播放', exact: true })
        .locator('.file-list > li')
        .first(),
    ).toContainText('另一本故事.wav')
    const separate = (await library(page)).books.find((book) => book.title === '另一本故事.wav')!
    expect(separate.introMs).toBe(0)
    expect(separate.outroMs).toBe(0)
    appendFileSync(file, Buffer.from([0]))
    await importFolder(app, page, folder)
    await page.getByRole('button', { name: `打开 故事 章节 的目录`, exact: true }).click()
    await page.getByRole('button', { name: '本书设置与书签', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '收听工具', exact: true })
    await dialog.getByRole('tab', { name: '查看书签', exact: true }).click()
    await expect(dialog.getByText('旧音频版本，无法跳转；备注仍可保留或删除。')).toBeVisible()
    await expect(dialog.getByRole('button', { name: /^跳转书签/ })).toBeDisabled()
    await page.screenshot({ path: info.outputPath('m4-bookmarks.png') })
    await dialog.getByRole('button', { name: /^删除书签/ }).click()
    await expect(dialog.getByText('书签 · 0', { exact: true })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('intro and outro use media coordinates, advance once, and respect end-of-chapter sleep and short chapters', async () => {
  const root = mkdtempSync(join(tmpdir(), '听读 M4 skip ')),
    folder = join(root, '连续故事')
  mkdirSync(folder)
  audio(join(folder, '第01集.wav'), 20)
  audio(join(folder, '第02集.wav'), 20)
  audio(join(folder, '第03集.wav'), 3)
  const app = await launch(root)
  try {
    const page = await app.firstWindow()
    await importFolder(app, page, folder)
    await page.getByRole('button', { name: '打开 连续故事 的目录', exact: true }).click()
    await page.getByRole('button', { name: '本书设置与书签' }).click()
    let dialog = page.getByRole('dialog', { name: '收听工具', exact: true })
    await dialog.getByRole('tab', { name: '播放与定时', exact: true }).click()
    await dialog.getByRole('spinbutton', { name: '跳过片头秒数' }).fill('5')
    await dialog.getByRole('spinbutton', { name: '跳过片尾秒数' }).fill('4')
    await dialog.getByRole('button', { name: '保存跳过设置' }).click()
    await expect(dialog.getByText('本书跳过设置已保存。')).toBeVisible()
    await dialog.getByRole('button', { name: '关闭收听工具' }).click()
    await page.getByRole('button', { name: '播放第 1 集 第01集.wav', exact: true }).click()
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeEnabled()
    await expect.poll(() => time(page)).toBeGreaterThanOrEqual(5)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await seek(page, 15800)
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await page.locator('audio').evaluate((audio: HTMLAudioElement) => {
      audio.currentTime = 16.05
      for (let i = 0; i < 3; i++) audio.dispatchEvent(new Event('timeupdate'))
    })
    await expect(
      page
        .getByRole('region', { name: '播放器', exact: true })
        .getByRole('heading', { name: '第02集.wav', exact: true }),
    ).toBeVisible()
    await expect.poll(() => time(page)).toBeGreaterThanOrEqual(5)
    expect((await library(page)).books[0]!.episodes[0]!.positionMs).toBeGreaterThanOrEqual(16000)
    expect((await library(page)).books[0]!.episodes[2]!.positionMs).toBe(0)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    dialog = await tools(page)
    await dialog.getByRole('button', { name: '本集结束时停止', exact: true }).click()
    await dialog.getByRole('button', { name: '关闭收听工具' }).click()
    await seek(page, 15900)
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await expect(timerFeedback(page)).toHaveText('本集已定时停止')
    await expect(timerFeedback(page)).toBeVisible()
    await expect(
      page
        .getByRole('region', { name: '播放器', exact: true })
        .getByRole('heading', { name: '第02集.wav', exact: true }),
    ).toBeVisible()
    expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(
      true,
    )
    expect((await library(page)).books[0]!.episodes[1]!.positionMs).toBeGreaterThanOrEqual(16000)
    await menuAction(page, '播放选项', '下一集')
    await expect(
      page
        .getByRole('region', { name: '播放器', exact: true })
        .getByRole('heading', { name: '第03集.wav', exact: true }),
    ).toBeVisible()
    await expect(page.getByText('本集短于跳过时长，本集完整播放。', { exact: true })).toBeVisible()
    await expect.poll(() => time(page)).toBeLessThan(1)
  } finally {
    await app.close()
  }
})

test('an expired timer prevents pending media from starting after metadata arrives', async () => {
  const root = mkdtempSync(join(tmpdir(), '听读 M4 pending timer ')),
    folder = join(root, '故事')
  mkdirSync(folder)
  audio(join(folder, '第01集.wav'), 120)
  audio(join(folder, '第02集.wav'), 120)
  const app = await launch(root)
  try {
    const page = await app.firstWindow()
    await page.clock.install()
    await importFolder(app, page, folder)
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    const dialog = await tools(page)
    await dialog.getByRole('spinbutton', { name: '定时分钟' }).fill('1')
    await dialog.getByRole('button', { name: '启动定时', exact: true }).click()
    await dialog.getByRole('button', { name: '关闭收听工具' }).click()
    // Hold only media URL assignment to reproduce a slow metadata load. IPC and storage stay real.
    await page.locator('audio').evaluate((audio: HTMLAudioElement) => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')!
      Reflect.set(window, 'releaseHeldMedia', () => {
        Object.defineProperty(audio, 'src', descriptor)
        audio.src = Reflect.get(window, 'heldMediaUrl')
        audio.load()
      })
      Object.defineProperty(audio, 'src', {
        configurable: true,
        get: () => descriptor.get!.call(audio),
        set: (url: string) => Reflect.set(window, 'heldMediaUrl', url),
      })
    })
    await menuAction(page, '播放选项', '下一集')
    await expect
      .poll(() => page.evaluate(() => typeof Reflect.get(window, 'heldMediaUrl')))
      .toBe('string')
    const now = await page.evaluate(() => Date.now())
    await page.clock.setSystemTime(new Date(now + 61000))
    await page.clock.runFor(600)
    await page.evaluate(() => Reflect.get(window, 'releaseHeldMedia')())
    await expect(page.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
    expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(
      true,
    )
    await expect(timerFeedback(page)).toHaveText('已定时停止')
    await expect(timerFeedback(page)).toBeVisible()
  } finally {
    await app.close()
  }
})

test('a failed progress write holds the current chapter at its outro until the user recovers', async () => {
  const root = mkdtempSync(join(tmpdir(), '听读 M4 progress error ')),
    folder = join(root, '故事')
  mkdirSync(folder)
  audio(join(folder, '第01集.wav'), 20)
  audio(join(folder, '第02集.wav'), 20)
  const app = await launch(root)
  let database: DatabaseSync | undefined
  try {
    const page = await app.firstWindow()
    await importFolder(app, page, folder)
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    const dialog = await tools(page)
    await dialog.getByRole('spinbutton', { name: '跳过片尾秒数' }).fill('4')
    await dialog.getByRole('button', { name: '保存跳过设置' }).click()
    await expect(dialog.getByText('本书跳过设置已保存。')).toBeVisible()
    await dialog.getByRole('button', { name: '关闭收听工具' }).click()
    await seek(page, 15900)
    database = new DatabaseSync(join(root, 'data', 'library.sqlite3'))
    database.exec(
      "CREATE TRIGGER refuse_progress BEFORE UPDATE OF position_ms ON episodes BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;",
    )
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await expect(page.getByText(/进度保存失败：/)).toBeVisible()
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused))
      .toBe(true)
    await expect(
      page
        .getByRole('region', { name: '播放器', exact: true })
        .getByRole('heading', { name: '第01集.wav', exact: true }),
    ).toBeVisible()
    database.exec('DROP TRIGGER refuse_progress;')
    await page.getByRole('button', { name: '重试保存', exact: true }).click()
    await expect(page.getByText(/进度保存失败：/)).not.toBeVisible()
    expect((await library(page)).books[0]!.episodes[0]!.positionMs).toBeGreaterThanOrEqual(16000)
    await menuAction(page, '播放选项', '下一集')
    await expect(
      page
        .getByRole('region', { name: '播放器', exact: true })
        .getByRole('heading', { name: '第02集.wav', exact: true }),
    ).toBeVisible()
  } finally {
    database?.close()
    await app.close()
  }
})

test('wall-clock sleep pauses real playback in the tray, saves its media position and stays cleared after restart', async () => {
  const root = mkdtempSync(join(tmpdir(), '听读 M4 timer ')),
    file = join(root, '定时故事.wav')
  audio(file, 120)
  let app = await launch(root)
  try {
    let page = await app.firstWindow()
    await page.clock.install()
    await choose(app, file)
    await page.getByRole('button', { name: '选择音频文件', exact: true }).click()
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await seek(page, 10000)
    await page.getByRole('combobox', { name: '播放倍速' }).selectOption('2')
    const dialog = await tools(page)
    await dialog.getByRole('spinbutton', { name: '定时分钟' }).fill('1')
    await dialog.getByRole('button', { name: '启动定时', exact: true }).click()
    await dialog.getByRole('button', { name: '关闭收听工具' }).click()
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
    const now = await page.evaluate(() => Date.now())
    await page.clock.setSystemTime(new Date(now + 61000))
    await page.clock.runFor(600)
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused))
      .toBe(true)
    const position = await time(page)
    expect(position).toBeGreaterThanOrEqual(10)
    expect(position).toBeLessThan(20)
    await expect
      .poll(async () => (await library(page)).books[0]!.episodes[0]!.positionMs)
      .toBeCloseTo(position * 1000, -2)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.show())
    await expect(timerFeedback(page)).toHaveText('已定时停止')
    await expect(timerFeedback(page)).toBeVisible()
    const closed = app.waitForEvent('close')
    await menuAction(page, '应用设置', '退出听读')
    await closed
    app = await launch(root)
    page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
    await expect(timerFeedback(page)).toHaveCount(0)
    expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(
      true,
    )
  } finally {
    await app.close()
  }
})
