import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import { menuAction } from '../helpers/ui'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), '听读 UI 任务安全 '))
  const folder = join(root, '安全操作书籍')
  mkdirSync(folder)
  const files = ['第01集.wav', '第02集.wav'].map((name) => join(folder, name))
  for (const file of files) {
    const wav = Buffer.alloc(44 + 120 * 16000)
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
    writeFileSync(file, wav)
  }
  const database = createDataPaths(root).database
  const store = new LibraryStore(database)
  store.importBook(await scanBook(folder, 'folder'))
  const book = store.listBooks()[0]!
  const episode = book.episodes[0]!
  store.saveTranscript(episode.id, {
    version: 1,
    audioHash: episode.contentHash,
    kind: 'manual',
    coverage: [{ startMs: 0, endMs: 120000 }],
    segments: [
      { id: 's1', startMs: 1000, endMs: 10000, text: '需要保留的人工字幕。' },
      { id: 's2', startMs: 20000, endMs: 30000, text: '下一段故事。' },
    ],
  })
  store.saveProgress({
    sessionId: '',
    episodeId: episode.id,
    positionMs: 5000,
    durationMs: 120000,
    rate: 1,
    volume: 0,
  })
  store.saveBookmark({
    episodeId: episode.id,
    audioHash: episode.contentHash,
    positionMs: 5000,
    note: '需要保留的书签备注',
  })
  store.markTranscriptRegion({
    episodeId: episode.id,
    audioHash: episode.contentHash,
    revision: 0,
    kind: 'intro',
    startMs: 0,
    endMs: 1000,
  })
  store.close()
  return { root, database, files, book, episode }
}

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

async function ready(app: ElectronApplication) {
  const page = await app.firstWindow()
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
  return page
}

function savedData(database: string) {
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    return {
      books: db.prepare('SELECT id FROM books ORDER BY id').all(),
      episodes: db.prepare('SELECT id, book_id FROM episodes ORDER BY id').all(),
      transcripts: db
        .prepare('SELECT id, revision, document_json FROM transcripts ORDER BY id')
        .all(),
      bookmarks: db.prepare('SELECT id, note, position_ms FROM bookmarks ORDER BY id').all(),
      regions: db
        .prepare(
          'SELECT episode_id, revision, regions_json FROM transcript_regions ORDER BY episode_id',
        )
        .all(),
    }
  } finally {
    db.close()
  }
}

async function media(page: Page) {
  return page.locator('audio').evaluate((audio: HTMLAudioElement) => ({
    src: audio.src,
    paused: audio.paused,
    time: audio.currentTime,
    loads: Number(Reflect.get(audio, 'safetyLoadStarts') ?? 0),
  }))
}

test('the current chapter pauses and resumes without reloading, while another chapter loads normally', async () => {
  const t = await fixture()
  const app = await launch(t.root)
  try {
    const page = await ready(app)
    await page.getByRole('button', { name: `打开 ${t.book.title} 的目录`, exact: true }).click()
    await page.locator('audio').evaluate((audio: HTMLAudioElement) => {
      Reflect.set(audio, 'safetyLoadStarts', 0)
      audio.addEventListener('loadstart', () => {
        Reflect.set(audio, 'safetyLoadStarts', Number(Reflect.get(audio, 'safetyLoadStarts')) + 1)
      })
    })
    const before = await media(page)
    await page.getByRole('button', { name: '播放第 1 集 第01集.wav', exact: true }).click()
    await expect.poll(async () => (await media(page)).time).toBeGreaterThan(before.time + 0.1)
    await page.getByRole('button', { name: '暂停第 1 集 第01集.wav', exact: true }).click()
    await expect.poll(async () => (await media(page)).paused).toBe(true)
    const paused = await media(page)
    expect(paused.src).toBe(before.src)
    expect(paused.loads).toBe(0)
    await page.getByRole('button', { name: '播放第 1 集 第01集.wav', exact: true }).click()
    await expect.poll(async () => (await media(page)).time).toBeGreaterThan(paused.time + 0.1)
    expect((await media(page)).loads).toBe(0)
    await page.getByRole('button', { name: '播放第 2 集 第02集.wav', exact: true }).click()
    await expect(
      page.getByRole('button', { name: '暂停第 2 集 第02集.wav', exact: true }),
    ).toBeEnabled()
    await expect.poll(async () => (await media(page)).loads).toBeGreaterThan(0)
    expect((await media(page)).src).not.toBe(before.src)
  } finally {
    await app.close()
  }
})

test('removal explains data loss; cancel and Escape preserve playback and saved data; confirmation removes only app records', async () => {
  const t = await fixture()
  const app = await launch(t.root)
  try {
    const page = await ready(app)
    const before = savedData(t.database)
    expect(before.transcripts).toHaveLength(1)
    expect(before.bookmarks).toHaveLength(1)
    expect(before.regions).toHaveLength(1)
    await page.getByRole('button', { name: '播放', exact: true }).click()
    const trigger = page.getByRole('button', { name: `更多 ${t.book.title} 的操作`, exact: true })
    const remove = async () => {
      await menuAction(page, `更多 ${t.book.title} 的操作`, `移除 ${t.book.title} 的记录`)
      return page.getByRole('dialog', { name: '确认移除书籍', exact: true })
    }
    let dialog = await remove()
    await expect(dialog).toContainText('收听进度、字幕（含人工修改）、书签')
    await expect(dialog).toContainText('片段标注和相关任务记录')
    await expect(dialog).toContainText('此操作暂不支持撤销')
    await expect(dialog).toContainText('原音频文件仍保留在原位置')
    await expect(dialog.getByRole('button', { name: '保留这本书', exact: true })).toBeFocused()
    const playing = await media(page)
    await expect.poll(async () => (await media(page)).time).toBeGreaterThan(playing.time + 0.1)
    expect((await media(page)).paused).toBe(false)
    await dialog.getByRole('button', { name: '保留这本书', exact: true }).click()
    await expect(trigger).toBeFocused()
    expect(savedData(t.database)).toEqual(before)
    expect((await media(page)).paused).toBe(false)
    dialog = await remove()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    expect(savedData(t.database)).toEqual(before)
    expect((await media(page)).paused).toBe(false)
    dialog = await remove()
    await dialog.getByRole('button', { name: '确认移除记录', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByText('你的故事，从这里开始', { exact: true })).toBeVisible()
    expect(savedData(t.database)).toEqual({
      books: [],
      episodes: [],
      transcripts: [],
      bookmarks: [],
      regions: [],
    })
    expect(t.files.every((file) => existsSync(file))).toBe(true)
    await expect(page.getByRole('button', { name: '搜索书架', exact: true })).toBeFocused()
  } finally {
    await app.close()
  }
})

test('subtitle and bookmark entry points focus their section and restore the persistent trigger on close', async () => {
  const t = await fixture()
  const app = await launch(t.root)
  try {
    const page = await ready(app)
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1024, 768),
    )
    const trigger = page.getByRole('button', { name: '字幕与伴读', exact: true })
    await trigger.click()
    let dialog = page.getByRole('dialog', { name: '收听工具', exact: true })
    const subtitles = dialog.getByRole('tabpanel', { name: '字幕与缓存', exact: true })
    await expect(dialog.getByRole('tab', { name: '字幕与缓存', exact: true })).toBeFocused()
    await expect(dialog.getByRole('tabpanel')).toHaveCount(1)
    await expect(
      subtitles.getByRole('heading', { name: '字幕与缓存', exact: true }),
    ).toBeInViewport()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await menuAction(page, '播放选项', '收听工具')
    dialog = page.getByRole('dialog', { name: '收听工具', exact: true })
    await expect(dialog.getByRole('tab', { name: '播放与定时', exact: true })).toBeFocused()
    await expect(dialog.getByRole('tabpanel', { name: '播放与定时', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '播放选项', exact: true })).toBeFocused()
    const bookMenu = page.getByRole('button', { name: `更多 ${t.book.title} 的操作`, exact: true })
    await menuAction(page, `更多 ${t.book.title} 的操作`, '本书设置与书签')
    dialog = page.getByRole('dialog', { name: '收听工具', exact: true })
    await expect(dialog.getByRole('tab', { name: '查看书签', exact: true })).toBeFocused()
    await expect(dialog.getByRole('region', { name: '本书书签', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: '关闭收听工具', exact: true }).click()
    await expect(bookMenu).toBeFocused()
  } finally {
    await app.close()
  }
})
