import { openCompanionTools, openTranscriptImport } from '../helpers/ui'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import { CHANNELS } from '../../src/shared/contracts'
import type { TranscriptRequest } from '../../src/shared/transcript'

function wave(path: string, marker: number) {
  const wav = Buffer.alloc(44 + 16000 * 40)
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
  wav.writeInt16LE(marker, 44)
  writeFileSync(path, wav)
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), '听读 字幕导入 ')),
    folder = join(root, '测试有声书')
  mkdirSync(folder)
  wave(join(folder, '第1集.wav'), 1)
  wave(join(folder, '第2集.wav'), 2)
  const paths = createDataPaths(root),
    store = new LibraryStore(paths.database)
  store.importBook(await scanBook(folder, 'folder'))
  const book = store.listBooks()[0]!
  store.setSubtitlePreparation(book.id, {
    mode: 'manual',
    engine: 'whisperx',
    device: 'cpu',
    prepareNext: false,
  })
  for (const episode of book.episodes) {
    store.recordSourceDuration(episode.id, episode.contentHash, 40000)
    store.saveTranscript(episode.id, {
      version: 1,
      kind: 'manual',
      audioHash: episode.contentHash,
      coverage: [{ startMs: 0, endMs: 40000 }],
      segments: [{ id: 'seed', startMs: 100, endMs: 2000, text: '王林走进大殿。' }],
    })
  }
  const episode = book.episodes[0]!
  store.saveProgress({
    sessionId: '',
    episodeId: episode.id,
    positionMs: 0,
    durationMs: 40000,
    rate: 1,
    volume: 0,
  })
  store.close()
  return { root, paths, book, target: { episodeId: episode.id, audioHash: episode.contentHash } }
}
function launch(root: string, appRoot?: string) {
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  return electron.launch({
    ...(process.env.RALB_EXECUTABLE
      ? { executablePath: resolve(process.env.RALB_EXECUTABLE), args: [] }
      : { args: [appRoot ?? resolve(process.env.RALB_APP_ROOT ?? '.')] }),
    env,
  })
}
async function read(page: Page) {
  await page.getByRole('button', { name: '继续播放', exact: true }).click()
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  await expect(page.locator('.transcript-sentence').first()).toBeVisible()
}
async function formal(page: Page, target: TranscriptRequest) {
  return page.evaluate(async (target) => {
    const r = await window.desktop.getTranscript(target)
    if (!r.ok || r.value.status !== 'ready') throw new Error('Expected formal transcript')
    return r.value.transcript
  }, target)
}
async function choose(app: ElectronApplication, path: string | null) {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: path === null, filePaths: path ? [path] : [] })
  }, path)
}
async function panel(page: Page) {
  await openCompanionTools(page)
  await page
    .getByRole('dialog', { name: '伴读工具', exact: true })
    .getByRole('button', { name: '导入 SRT/WebVTT', exact: true })
    .click()
  return page.getByRole('dialog', { name: '导入 SRT/WebVTT 字幕', exact: true })
}
function stamp(ms: number) {
  return `00:${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
}
function manySrt() {
  const start = '1\n00:00:00,100 --> 00:00:01,100\n甲\n\n2\n00:00:00,600 --> 00:00:01,600\n乙\n\n'
  return (
    start +
    Array.from(
      { length: 52 },
      (_, i) =>
        `${i + 3}\n${stamp(2000 + i * 500)} --> ${stamp(2300 + i * 500)}\n第${i + 3}段文字\n\n`,
    ).join('')
  )
}
async function emit(app: ElectronApplication, target: TranscriptRequest) {
  await app.evaluate(
    ({ BrowserWindow }, { target, channel }) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send(channel, target)
    },
    { target, channel: CHANNELS.transcriptionChanged },
  )
}

test('SRT overlap, complete paging, explicit offset and adoption preserve original media coordinates, source and restart', async ({}, info) => {
  const f = await fixture(),
    path = join(f.root, '重叠字幕.srt')
  writeFileSync(path, manySrt())
  let app = await launch(f.root)
  try {
    let page = await app.firstWindow()
    await read(page)
    const before = await formal(page, f.target)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 600))
    await choose(app, path)
    const p = await panel(page)
    await p.getByRole('button', { name: '选择字幕文件', exact: true }).click()
    await expect(p).toContainText('来源 54 条字幕 → 55 段伴读文字')
    await expect(p.locator('.subtitle-import-rows li')).toHaveCount(50)
    await expect(p.locator('.subtitle-import-rows li').nth(1)).toContainText('甲\n乙')
    expect((await formal(page, f.target)).revision).toBe(before.revision)
    await p.getByRole('button', { name: '下一页字幕预览', exact: true }).click()
    await expect(p.locator('.subtitle-import-rows li')).toHaveCount(5)
    await expect(p.locator('.subtitle-import-rows li').last()).toContainText('第54段文字')
    await p.getByRole('spinbutton', { name: '导入字幕时间偏移毫秒', exact: true }).fill('100')
    await expect(p.getByRole('button', { name: /替换当前版本/ })).toBeDisabled()
    await p.getByRole('button', { name: '重新预览字幕', exact: true }).click()
    await expect(p).toContainText('本次全部字幕时间延后 100 毫秒')
    await expect(p.locator('.subtitle-import-rows li').first()).toContainText(
      '00:00:00.200–00:00:00.700',
    )
    await p.getByRole('button', { name: '试听此段', exact: true }).first().click()
    await expect
      .poll(() =>
        page.locator('audio[data-player="persistent"]').evaluate((a: HTMLAudioElement) => a.paused),
      )
      .toBe(false)
    await p.getByRole('button', { name: '停止导入试听', exact: true }).click()
    await expect(page.locator('audio')).toHaveCount(1)
    await p.getByRole('button', { name: /替换当前版本/ }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('subtitle-import-720.png') })
    expect(await p.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true)
    await p.getByRole('button', { name: /替换当前版本/ }).click()
    await expect(p).toBeHidden()
    const imported = await formal(page, f.target)
    expect(imported.revision).toBeGreaterThan(before.revision)
    expect(imported.document.kind).toBe('transcript')
    expect(imported.document.segments).toHaveLength(55)
    expect(imported.document.segments[0]!.startMs).toBe(200)
    await page.getByRole('slider', { name: '播放进度', exact: true }).fill('800')
    await expect(page.locator('.transcript-sentence[aria-current="true"]')).toContainText('甲')
    await expect(page.locator('.transcript-sentence[aria-current="true"]')).toContainText('乙')
    const rendered = await page
      .locator('.transcript-sentence[aria-current="true"] .transcript-sentence-text')
      .evaluate((element) => {
        const node = element.firstChild!,
          first = document.createRange(),
          second = document.createRange()
        first.setStart(node, 0)
        first.setEnd(node, 1)
        second.setStart(node, 2)
        second.setEnd(node, 3)
        return {
          whiteSpace: getComputedStyle(element).whiteSpace,
          first: first.getBoundingClientRect().top,
          second: second.getBoundingClientRect().top,
        }
      })
    expect(rendered.whiteSpace).toBe('pre-wrap')
    expect(rendered.second).toBeGreaterThan(rendered.first)
    await app.close()
    app = await launch(f.root)
    page = await app.firstWindow()
    await read(page)
    expect((await formal(page, f.target)).document).toEqual(imported.document)
    await openCompanionTools(page)
    await page.getByRole('button', { name: '字幕编辑与撤销', exact: true }).click()
    const e = page.getByRole('dialog', { name: '字幕编辑', exact: true })
    await e.getByRole('textbox', { name: '字幕编辑文字', exact: true }).fill('丙')
    await e.getByRole('button', { name: '预览字幕修改', exact: true }).click()
    await e.getByRole('button', { name: '应用字幕修改', exact: true }).click()
    await expect(e).toContainText('字幕修改已保存')
    await e.getByRole('button', { name: '撤销字幕修改', exact: true }).click()
    expect((await formal(page, f.target)).document).toEqual(imported.document)
  } finally {
    await app.close()
  }
  const saved = new LibraryStore(f.paths.database)
  try {
    const source = saved.subtitleImportSource(f.target)
    expect(source?.bytes).toEqual(readFileSync(path))
    expect(source?.offsetMs).toBe(100)
    expect(source?.metadata.overlappingCues).toBe(2)
  } finally {
    saved.close()
  }
})

test('explicit GB18030, Big5 and UTF16 recover SRT text while malformed and non-UTF8 WebVTT never replace a formal document', async () => {
  const f = await fixture(),
    app = await launch(f.root)
  try {
    const page = await app.firstWindow()
    await read(page)
    const before = await formal(page, f.target)
    const srtHead = Buffer.from('1\n00:00:00,100 --> 00:00:01,000\n', 'ascii')
    for (const [encoding, bytes, text] of [
      ['gb18030', Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), '中文'],
      ['big5', Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]), '中文'],
      ['utf-16le', Buffer.from('中文', 'utf16le'), '中文'],
    ] as const) {
      const path = join(f.root, `${encoding}.srt`)
      writeFileSync(
        path,
        encoding === 'utf-16le'
          ? Buffer.from('1\n00:00:00,100 --> 00:00:01,000\n中文', 'utf16le')
          : Buffer.concat([srtHead, bytes]),
      )
      await choose(app, path)
      const p = await panel(page)
      await p.getByRole('button', { name: '选择字幕文件', exact: true }).click()
      await expect(p.getByRole('button', { name: /替换当前版本/ })).toBeDisabled()
      await p.getByRole('combobox', { name: '导入字幕编码', exact: true }).selectOption(encoding)
      await p.getByRole('button', { name: '重新预览字幕', exact: true }).click()
      await expect(p.locator('.subtitle-import-rows')).toContainText(text)
      await expect(p.getByRole('button', { name: /替换当前版本/ })).toBeEnabled()
      await p.getByRole('button', { name: '取消字幕导入', exact: true }).click()
    }
    for (const [name, contents] of [
      [
        'bad.vtt',
        Buffer.concat([
          Buffer.from('WEBVTT\n\n00:00.100 --> 00:01.000\n'),
          Buffer.from([0xd6, 0xd0]),
        ]),
      ],
      ['bad.srt', Buffer.from('1\n00:00:02,000 --> 00:00:01,000\n坏时间')],
    ] as const) {
      const path = join(f.root, name)
      writeFileSync(path, contents)
      await choose(app, path)
      const p = await panel(page)
      await p.getByRole('button', { name: '选择字幕文件', exact: true }).click()
      await expect(p.getByRole('button', { name: /替换当前版本/ })).toBeDisabled()
      await expect(p.getByLabel('字幕导入问题')).toBeVisible()
      await p.getByRole('button', { name: '取消字幕导入', exact: true }).click()
    }
    expect(await formal(page, f.target)).toEqual(before)
  } finally {
    await app.close()
  }
})

test('actual progress notifications retain dirty import options while a genuine formal revision freezes the old preview', async () => {
  const f = await fixture(),
    path = join(f.root, '字幕.srt'),
    app = await launch(f.root)
  writeFileSync(path, '1\n00:00:00,100 --> 00:00:01,500\n字幕文字')
  try {
    const page = await app.firstWindow()
    await read(page)
    await choose(app, path)
    const p = await panel(page)
    await p.getByRole('button', { name: '选择字幕文件', exact: true }).click()
    await p.getByRole('spinbutton', { name: '导入字幕时间偏移毫秒', exact: true }).fill('135')
    await emit(app, f.target)
    await page.waitForTimeout(150)
    await expect(
      p.getByRole('spinbutton', { name: '导入字幕时间偏移毫秒', exact: true }),
    ).toHaveValue('135')
    await expect(p).not.toContainText('正式文稿已变化')
    const before = await formal(page, f.target)
    const changed = await page.evaluate((request) => window.desktop.changeTranscript(request), {
      ...f.target,
      revision: before.revision,
      commandId: randomUUID(),
      operation: { kind: 'text' as const, segmentId: 'seed', text: '王琳走进大殿。' },
    })
    expect(changed.ok).toBe(true)
    await expect(p).toContainText('正式文稿已变化')
    await expect(
      p.getByRole('spinbutton', { name: '导入字幕时间偏移毫秒', exact: true }),
    ).toHaveValue('135')
    await expect(p.getByRole('button', { name: /替换当前版本/ })).toBeDisabled()
  } finally {
    await app.close()
  }
})

test('closing a pending native picker and switching episodes cancels a late subtitle selection without writing either transcript', async () => {
  const f = await fixture(),
    path = join(f.root, '迟到.srt'),
    app = await launch(f.root)
  writeFileSync(path, '1\n00:00:00,100 --> 00:00:01,000\n迟到文字')
  try {
    const page = await app.firstWindow()
    await read(page)
    const before = await formal(page, f.target),
      other = { episodeId: f.book.episodes[1]!.id, audioHash: f.book.episodes[1]!.contentHash },
      otherBefore = await formal(page, other)
    await app.evaluate(({ dialog, ipcMain }) => {
      dialog.showOpenDialog = () => {
        Reflect.set(globalThis, '__subtitlePickerPending', true)
        return new Promise((resolve) =>
          ipcMain.once('fixture:subtitle-picker', (_e, value) => {
            Reflect.set(globalThis, '__subtitlePickerPending', false)
            resolve(value)
          }),
        )
      }
    })
    const p = await panel(page)
    await p.getByRole('button', { name: '选择字幕文件', exact: true }).click()
    await expect
      .poll(() => app.evaluate(() => Reflect.get(globalThis, '__subtitlePickerPending')))
      .toBe(true)
    await p.getByRole('button', { name: '关闭字幕导入', exact: true }).click()
    await page.getByRole('button', { name: '播放选项', exact: true }).click()
    await page.getByRole('menuitem', { name: '下一集', exact: true }).click()
    await app.evaluate(
      ({ ipcMain }, path) =>
        ipcMain.emit('fixture:subtitle-picker', {}, { canceled: false, filePaths: [path] }),
      path,
    )
    await expect(
      page.getByRole('dialog', { name: '导入 SRT/WebVTT 字幕', exact: true }),
    ).toHaveCount(0)
    expect(await formal(page, f.target)).toEqual(before)
    expect(await formal(page, other)).toEqual(otherBefore)
  } finally {
    await app
      .evaluate(({ ipcMain }) =>
        ipcMain.emit('fixture:subtitle-picker', {}, { canceled: true, filePaths: [] }),
      )
      .catch(() => {})
    await app.close()
  }
})

test('the legacy JSON picker cannot overwrite a correction committed while selection is pending', async () => {
  const f = await fixture(),
    app = await launch(f.root)
  try {
    const page = await app.firstWindow()
    await read(page)
    const before = await formal(page, f.target),
      path = join(f.root, '旧稿.json')
    writeFileSync(path, JSON.stringify(before.document))
    await app.evaluate(({ dialog, ipcMain }) => {
      dialog.showOpenDialog = () => {
        Reflect.set(globalThis, '__jsonPickerPending', true)
        return new Promise((resolve) =>
          ipcMain.once('fixture:json-picker', (_e, value) => resolve(value)),
        )
      }
    })
    await openTranscriptImport(page)
    await page.getByRole('button', { name: '重新导入文稿', exact: true }).click()
    await expect
      .poll(() => app.evaluate(() => Reflect.get(globalThis, '__jsonPickerPending')))
      .toBe(true)
    const changed = await page.evaluate((request) => window.desktop.changeTranscript(request), {
      ...f.target,
      revision: before.revision,
      commandId: randomUUID(),
      operation: { kind: 'text' as const, segmentId: 'seed', text: '王琳走进大殿。' },
    })
    expect(changed.ok).toBe(true)
    await app.evaluate(
      ({ ipcMain }, path) =>
        ipcMain.emit('fixture:json-picker', {}, { canceled: false, filePaths: [path] }),
      path,
    )
    await expect(page.getByRole('alert')).toContainText('正式文稿已变化')
    expect((await formal(page, f.target)).document.segments[0]!.text).toBe('王琳走进大殿。')
  } finally {
    await app
      .evaluate(({ ipcMain }) =>
        ipcMain.emit('fixture:json-picker', {}, { canceled: true, filePaths: [] }),
      )
      .catch(() => {})
    await app.close()
  }
})

test('a delayed real preview page keeps newer option drafts dirty until the requested options are revalidated', async ({}, info) => {
  test.skip(
    !!process.env.RALB_EXECUTABLE,
    'Response-delay fixture uses a disposable copied preview.',
  )
  const f = await fixture(),
    path = join(f.root, '多页.srt'),
    appRoot = mkdtempSync(join(tmpdir(), '听读 导入响应延迟 '))
  writeFileSync(path, manySrt())
  cpSync(resolve(process.env.RALB_APP_ROOT ?? '.', 'out'), join(appRoot, 'out'), {
    recursive: true,
  })
  symlinkSync(resolve('node_modules'), join(appRoot, 'node_modules'), 'junction')
  writeFileSync(
    join(appRoot, 'package.json'),
    JSON.stringify({
      name: 'subtitle-import-response-fixture',
      type: 'module',
      main: './out/main/index.js',
    }),
  )
  const main = join(appRoot, 'out/main/index.js'),
    original = readFileSync(main, 'utf8'),
    marker =
      /handle\(CHANNELS\.subtitleImportPage,\s*\(request\) =>\s*subtitleImports\.page\(request\)\s*\);/
  expect(marker.test(original)).toBe(true)
  const modified = original.replace(
    marker,
    `handle(CHANNELS.subtitleImportPage, async (request) => {
    const result = subtitleImports.page(request);
    globalThis.__subtitlePagePending = true;
    await new Promise(resolve => ipcMain.once('fixture:release-subtitle-page', resolve));
    globalThis.__subtitlePagePending = false;
    return result;
  });`,
  )
  writeFileSync(main, modified)
  writeFileSync(
    info.outputPath('response-delay-scope.json'),
    JSON.stringify(
      {
        sourcePreview: resolve(process.env.RALB_APP_ROOT ?? '.'),
        copiedApp: appRoot,
        originalMainSha256: createHash('sha256').update(original).digest('hex'),
        modifiedMainSha256: createHash('sha256').update(modified).digest('hex'),
        scope:
          'Only delay delivery after production preview page has been read. Real parser, version checks, source bytes, SQLite, adoption and audio remain unchanged.',
      },
      null,
      2,
    ),
  )
  const app = await launch(f.root, appRoot)
  try {
    const page = await app.firstWindow()
    await read(page)
    await choose(app, path)
    const p = await panel(page)
    await p.getByRole('button', { name: '选择字幕文件', exact: true }).click()
    await p.getByRole('button', { name: '下一页字幕预览', exact: true }).click()
    await expect
      .poll(() => app.evaluate(() => Reflect.get(globalThis, '__subtitlePagePending')))
      .toBe(true)
    await p.getByRole('spinbutton', { name: '导入字幕时间偏移毫秒', exact: true }).fill('137')
    await app.evaluate(({ ipcMain }) => ipcMain.emit('fixture:release-subtitle-page'))
    await expect(
      p.getByRole('spinbutton', { name: '导入字幕时间偏移毫秒', exact: true }),
    ).toHaveValue('137')
    await expect(p).toContainText('选项已修改，下面仍是上次预览')
    await expect(p.getByRole('button', { name: /替换当前版本/ })).toBeDisabled()
    await p.getByRole('button', { name: '重新预览字幕', exact: true }).click()
    await expect(p).toContainText('本次全部字幕时间延后 137 毫秒')
    await expect(p.getByRole('button', { name: /替换当前版本/ })).toBeEnabled()
  } finally {
    await app
      .evaluate(({ ipcMain }) => ipcMain.emit('fixture:release-subtitle-page'))
      .catch(() => {})
    await app.close()
  }
})

test('WebVTT notes, layout, voice markup and entities are previewed as inert text before explicit adoption', async () => {
  const f = await fixture(),
    path = join(f.root, '标记.vtt'),
    app = await launch(f.root)
  writeFileSync(
    path,
    'WEBVTT\n\nSTYLE\n::cue {color:red}\n\nREGION\nid:main\nwidth:80%\n\nNOTE private note\n不会出现\n\nvoice-1\n00:00.100 --> 00:02.000 line:20% align:start\n<v 李明><b>甲 &amp; &lt;script&gt;</b>\n第二行</v>\n',
  )
  try {
    const page = await app.firstWindow()
    await read(page)
    await choose(app, path)
    const p = await panel(page)
    await p.getByRole('button', { name: '选择字幕文件', exact: true }).click()
    await expect(p.locator('.subtitle-import-rows')).toContainText('甲 & <script>')
    await expect(p.locator('.subtitle-import-rows')).toContainText('第二行')
    await expect(p.locator('.subtitle-import-rows script')).toHaveCount(0)
    await expect(p.getByLabel('字幕格式转换提示')).toContainText('注释没有作为字幕文字导入')
    await expect(p.getByLabel('字幕格式转换提示')).toContainText('样式表没有作为字幕文字导入')
    await p.getByRole('button', { name: /替换当前版本/ }).click()
    await expect(p).toBeHidden()
    const doc = (await formal(page, f.target)).document
    expect(doc.segments[0]!.text).toContain('<script>')
    expect(doc.segments[0]!.text).not.toContain('不会出现')
    await expect(page.locator('.transcript-sentence-text')).toHaveCSS('white-space', 'pre-wrap')
  } finally {
    await app.close()
  }
})

test('an episode without a formal document can cancel then explicitly bind its first external subtitle without requiring an ASR component', async () => {
  const f = await fixture(),
    path = join(f.root, '首份.srt')
  const db = new DatabaseSync(f.paths.database)
  db.prepare('DELETE FROM transcripts WHERE episode_id=?').run(f.target.episodeId)
  db.close()
  writeFileSync(path, '1\n00:00:00,100 --> 00:00:01,000\n首份外部字幕')
  const app = await launch(f.root)
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    await expect(page.getByRole('heading', { name: '这一集还没有文稿', exact: true })).toBeVisible()
    await choose(app, null)
    let p = await panel(page)
    await p.getByRole('button', { name: '选择字幕文件', exact: true }).click()
    await expect(p.getByRole('button', { name: '选择字幕文件', exact: true })).toBeEnabled()
    await p.getByRole('button', { name: '取消字幕导入', exact: true }).click()
    const missing = await page.evaluate((target) => window.desktop.getTranscript(target), f.target)
    expect(missing.ok && missing.value.status).toBe('missing')
    await choose(app, path)
    p = await panel(page)
    await p.getByRole('button', { name: '选择字幕文件', exact: true }).click()
    await expect(p).toContainText('不含本应用的音频哈希')
    await p.getByRole('button', { name: '绑定当前集并导入', exact: true }).click()
    await expect(p).toBeHidden()
    await expect(page.locator('.transcript-sentence-text')).toContainText('首份外部字幕')
    const doc = await formal(page, f.target)
    expect(doc.revision).toBe(1)
    expect(doc.document.audioHash).toBe(f.target.audioHash)
    expect(doc.document.coverage).toEqual([{ startMs: 100, endMs: 1000 }])
    await expect(page.locator('audio')).toHaveCount(1)
  } finally {
    await app.close()
  }
})
