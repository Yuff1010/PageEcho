// Opt-in frozen Main acceptance for subtitle file import, with synthetic audio.
// No model, generated recognition or claimed human timing reference is involved.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, createReadStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import { parseOriginal } from '../../src/main/original/parse'
import { matchOriginal } from '../../src/main/original/match'
import type { Result } from '../../src/shared/contracts'
import type { TranscriptDocument } from '../../src/shared/transcript'
import { closeOwnedElectron } from './electron-lifecycle'

const args: Record<string, string> = {}
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]!,
    value = process.argv[index + 1]
  assert(['--app-root', '--output'].includes(name) && value)
  assert.equal(args[name], undefined)
  args[name] = value
}
assert(args['--app-root'])
const appRoot = resolve(args['--app-root']),
  manifestFile = resolve(appRoot, '../manifest.json'),
  build = JSON.parse(await readFile(manifestFile, 'utf8')),
  directory = resolve(
    args['--output'] ??
      `cache/optimization/subtitle-import-main-${build.previewVersion}-${new Date().toISOString().replaceAll(':', '-')}`,
  )
await mkdir(directory)
await copyFile(resolve('tests/model/subtitle-import.ts'), join(directory, 'runner-started.ts'))
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
async function hash(path: string) {
  const value = createHash('sha256')
  for await (const bytes of createReadStream(path)) value.update(bytes)
  return value.digest('hex')
}
assert.equal(build.status, 'built')
assert.equal(build.appRoot, appRoot)
for (const [group, root] of [
  ['sourceHashes', resolve('src')],
  ['outputHashes', join(appRoot, 'out')],
  ['pythonHashes', join(appRoot, 'python')],
  ['originalOutputHashes', resolve('out')],
] as const)
  for (const [name, expected] of Object.entries(build[group]))
    assert.equal(await hash(join(root, name)), expected)
const userData = await mkdtemp(join(tmpdir(), '听读 字幕真实导入 ')),
  paths = createDataPaths(userData),
  audioFolder = join(userData, 'owned-audio')
await mkdir(audioFolder)
const audioPath = join(audioFolder, '第1集-导入功能.wav'),
  wave = Buffer.alloc(44 + 16000 * 16)
wave.write('RIFF')
wave.writeUInt32LE(wave.length - 8, 4)
wave.write('WAVEfmt ', 8)
wave.writeUInt32LE(16, 16)
wave.writeUInt16LE(1, 20)
wave.writeUInt16LE(1, 22)
wave.writeUInt32LE(8000, 24)
wave.writeUInt32LE(16000, 28)
wave.writeUInt16LE(2, 32)
wave.writeUInt16LE(16, 34)
wave.write('data', 36)
wave.writeUInt32LE(wave.length - 44, 40)
await writeFile(audioPath, wave)
const srtPath = join(userData, '重启前-UTF16.srt'),
  srtBytes = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(
      '1\r\n00:00:00,500 --> 00:00:02,000\r\n少年走进山谷。\r\n保留第二行😀\r\n\r\n2\r\n00:00:04,000 --> 00:00:05,000\r\n远方响起钟声。\r\n',
      'utf16le',
    ),
  ]),
  vttPath = join(userData, '重启后-重叠与样式.vtt'),
  vttBytes = Buffer.from(
    'WEBVTT\n\nSTYLE\n::cue { color: lime }\n\nREGION\nid:spoken\nwidth:80%\nlines:3\n\nNOTE 原始来源保留\n不要作为字幕正文\n\nvoice-a\n00:00:00.500 --> 00:00:02.000 region:spoken align:start\n<v 旁白><b>少年</b><00:00:01.000>走进山谷。</v>\n\nvoice-b\n00:00:01.500 --> 00:00:03.000\n<c.green>山中响起钟声。</c>\n\nlast\n00:00:05.000 --> 00:00:06.000\n<script>字幕字面文字</script> &amp; &NotEqualTilde;\n',
  )
await writeFile(srtPath, srtBytes)
await writeFile(vttPath, vttBytes)
const store = new LibraryStore(paths.database)
store.importBook(await scanBook(audioFolder, 'folder'))
const book = store.listBooks()[0]!,
  episode = book.episodes[0]!,
  target = { episodeId: episode.id, audioHash: episode.contentHash },
  initial: TranscriptDocument = {
    version: 1,
    audioHash: target.audioHash,
    kind: 'manual',
    coverage: [{ startMs: 0, endMs: 16000 }],
    segments: [
      { id: 'old-a', startMs: 500, endMs: 2000, text: '少年走进山谷。' },
      { id: 'old-b', startMs: 4000, endMs: 5000, text: '远方响起钟声。' },
    ],
  }
store.recordSourceDuration(episode.id, episode.contentHash, 16000)
store.saveTranscript(episode.id, initial)
store.performTranscriptEdit({
  ...target,
  revision: 1,
  commandId: randomUUID(),
  operation: { kind: 'text', segmentId: 'old-a', text: '少年走入山谷。' },
})
const formal = store.getTranscript(episode.id, episode.contentHash)
assert(formal.status === 'ready')
const original = parseOriginal(Buffer.from('少年走进山谷。\n远方响起钟声。'), '人工原文.txt'),
  originalId = store.originals.import(target, original).info!.id
store.originals.saveAlignment(
  target,
  originalId,
  formal.transcript.id,
  formal.transcript.revision,
  0,
  matchOriginal(original, formal.transcript.document),
)
store.originals.correct({
  ...target,
  originalId,
  revision: 1,
  segmentId: 'old-a',
  selection: { first: 0, last: 0 },
  startMs: 550,
  endMs: 1950,
})
store.originals.correct({
  ...target,
  originalId,
  revision: 2,
  segmentId: 'old-b',
  selection: null,
  startMs: 4100,
  endMs: 4900,
})
store.saveBookmark({ ...target, positionMs: 800, note: '导入保留的书签' })
store.markTranscriptRegion({ ...target, revision: 0, startMs: 100, endMs: 300, kind: 'intro' })
store.setSubtitlePreparation(book.id, {
  mode: 'manual',
  engine: 'whisperx',
  device: 'cpu',
  prepareNext: false,
})
store.setProcessingPolicy({
  revision: store.processingResources().revision,
  policy: { cpuThreads: 1, lowPriority: true, backgroundIdleOnly: false },
})
store.saveProgress({
  sessionId: '',
  episodeId: episode.id,
  positionMs: 750,
  durationMs: 16000,
  rate: 1.25,
  volume: 0,
})
store.close()
const protectedBefore = {
    [audioPath]: await hash(audioPath),
    [srtPath]: await hash(srtPath),
    [vttPath]: await hash(vttPath),
  },
  report: Record<string, unknown> = {
    status: 'running',
    startedAt: new Date().toISOString(),
    appRoot,
    previewVersion: build.previewVersion,
    directory,
    userData,
    target,
    runnerSha256: await hash(join(directory, 'runner-started.ts')),
    manifestSha256: await hash(manifestFile),
    sourceHashes: build.sourceHashes,
    outputHashes: build.outputHashes,
    pythonHashes: build.pythonHashes,
    originalOutputHashes: build.originalOutputHashes,
    protectedBefore,
    stages: [],
    cleanups: [],
    scope:
      'Actual frozen Main/preload/IPC/native-picker-result/file decoding/parser/SQLite/player/restart. Only native file selection is controlled. Silent synthetic WAV and manually written caption files are functional fixtures, not human speech/timing labels or model quality evidence. No AI model, external media, visual layout execution or fabricated recognition.',
  }
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
async function stage(name: string) {
  ;(report.stages as unknown[]).push({ name, at: new Date().toISOString() })
  await save()
  console.log(JSON.stringify({ stage: name }))
}
async function value<T>(result: Promise<Result<T>>): Promise<T> {
  const actual = await result
  assert(actual.ok, JSON.stringify(actual))
  return actual.value
}
const env = { ...process.env, RALB_USER_DATA: userData }
for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'RALB_EXECUTABLE'])
  Reflect.deleteProperty(env, name)
let app: ElectronApplication | undefined, page!: Page
const rendererErrors: string[] = []
const doc = () =>
  page.evaluate(async (target) => {
    const result = await window.desktop.getTranscript(target)
    if (!result.ok || result.value.status !== 'ready') throw Error(JSON.stringify(result))
    return result.value.transcript
  }, target)
const clock = () =>
  page.locator('audio').evaluate((audio: HTMLAudioElement) => ({
    positionMs: audio.currentTime * 1000,
    paused: audio.paused,
    rate: audio.playbackRate,
    volume: audio.volume,
    source: audio.currentSrc,
  }))
async function kept() {
  const state = await value(page.evaluate(() => window.desktop.getState())),
    current = state.books.find((entry) => entry.id === book.id)!,
    original = await value(
      page.evaluate((target) => window.desktop.getOriginalState(target), target),
    )
  return {
    settings: current.subtitlePreparation,
    bookmarks: await value(page.evaluate((id) => window.desktop.getBookmarks({ id }), book.id)),
    regions: await value(
      page.evaluate((target) => window.desktop.getTranscriptRegions(target), target),
    ),
    originalId: original.info?.id,
    manual: original.alignment?.matches
      .filter((match) => match.reviewed)
      .map((match) => ({
        segmentId: match.segmentId,
        selected: match.selected,
        startMs: match.startMs,
        endMs: match.endMs,
      })),
  }
}
async function launch() {
  app = await electron.launch({ args: [appRoot], env })
  app
    .process()
    .stderr?.on('data', (bytes) => appendFileSync(join(directory, 'main-stderr.log'), bytes))
  page = await app.firstWindow()
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  await page.context().setOffline(true)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.webContents.setAudioMuted(true),
  )
  assert.equal(
    (await value(page.evaluate(() => window.desktop.getState()))).version,
    build.previewVersion,
  )
  await page.getByRole('button', { name: '继续播放', exact: true }).click()
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('750')
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  await expect(page.locator('.transcript-sentence').first()).toBeVisible()
}
async function close() {
  assert(app)
  const result = await closeOwnedElectron(app, 20000)
  app = undefined
  ;(report.cleanups as unknown[]).push(result)
  await save()
  assert.equal(result.kind, 'graceful')
}
async function select(path: string) {
  assert(app)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, path)
}
async function panel(path: string) {
  await select(path)
  await page.getByRole('button', { name: '导入 SRT/WebVTT', exact: true }).first().click()
  const panel = page.getByRole('dialog', { name: '导入 SRT/WebVTT 字幕', exact: true })
  await panel.getByRole('button', { name: '选择字幕文件', exact: true }).click()
  await expect(panel.getByRole('region', { name: '字幕导入预览', exact: true })).toBeVisible()
  return panel
}
function database() {
  const connection = new DatabaseSync(paths.database, { readOnly: true })
  try {
    const source = connection.prepare('SELECT * FROM subtitle_import_sources').get()!,
      bytes = Buffer.from(source.source_bytes as Uint8Array),
      commands = connection
        .prepare('SELECT * FROM subtitle_import_commands ORDER BY created_at')
        .all(),
      transcript = connection
        .prepare('SELECT * FROM transcripts WHERE episode_id=? AND audio_hash=?')
        .get(target.episodeId, target.audioHash)!,
      state = {
        schema: connection.prepare('PRAGMA user_version').get()!.user_version,
        source: {
          transcriptId: String(source.transcript_id),
          episodeId: String(source.episode_id),
          audioHash: String(source.audio_hash),
          encoding: String(source.encoding),
          format: String(source.format),
          fileName: String(source.file_name),
          import_revision: Number(source.import_revision),
          document_hash: String(source.document_hash),
          offset_ms: Number(source.offset_ms),
          metadata: JSON.parse(String(source.metadata_json)),
          byteLength: bytes.length,
          actualSourceSha256: sha(bytes),
        },
        commands,
        transcript: {
          ...transcript,
          document: JSON.parse(String(transcript.document_json)),
          document_json: undefined,
        },
        history: connection
          .prepare('SELECT id,status,label FROM transcript_edit_groups ORDER BY sequence')
          .all(),
      }
    assert.equal(state.schema, 15)
    assert.equal(source.source_sha256, sha(bytes))
    return { state, bytes }
  } finally {
    connection.close()
  }
}
function processes() {
  const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $importData='${userData.replaceAll("'", "''")}'; ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -and $_.CommandLine.Contains($importData) -and $_.Name -match '^(python|ffmpeg|ffprobe|electron)\\.exe$'} | ForEach-Object {[pscustomobject]@{pid=[int]$_.ProcessId;name=$_.Name;command=$_.CommandLine}}) -Compress`
  return JSON.parse(
    execFileSync(
      join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      ['-NoProfile', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 },
    ),
  )
}
try {
  await stage('seeded-manual-original-points-bookmarks-and-old-edit-history')
  await launch()
  const before = await doc(),
    protectedState = await kept(),
    pausedBefore = await clock(),
    canceledPanel = await panel(srtPath)
  await expect(canceledPanel).toContainText('UTF-16 LE')
  assert.deepEqual(await doc(), before)
  await canceledPanel.getByRole('button', { name: '关闭字幕导入', exact: true }).click()
  assert.deepEqual(await doc(), before)
  assert.deepEqual(await kept(), protectedState)
  assert.deepEqual(await clock(), pausedBefore)
  await stage('UTF16-preview-and-cancellation-preserve-formal-document-and-original-clock')
  const srtPanel = await panel(srtPath)
  await expect(srtPanel).toContainText('保留第二行😀')
  await srtPanel
    .getByRole('button', { name: `替换当前版本 ${before.revision} 并导入`, exact: true })
    .click()
  await expect(srtPanel).not.toBeVisible()
  const srtFormal = await doc()
  assert.equal(srtFormal.document.kind, 'transcript')
  assert.deepEqual(srtFormal.document.coverage, [
    { startMs: 500, endMs: 2000 },
    { startMs: 4000, endMs: 5000 },
  ])
  assert.deepEqual(
    srtFormal.document.segments.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })),
    [
      { startMs: 500, endMs: 2000, text: '少年走进山谷。\n保留第二行😀' },
      { startMs: 4000, endMs: 5000, text: '远方响起钟声。' },
    ],
  )
  const editing = await value(
    page.evaluate((target) => window.desktop.getTranscriptEditingState(target), target),
  )
  assert.equal(editing.historyCount, 0)
  assert.deepEqual(await kept(), protectedState)
  assert.deepEqual(await clock(), pausedBefore)
  const edited = await value(
    page.evaluate((request) => window.desktop.changeTranscript(request), {
      ...target,
      revision: srtFormal.revision,
      commandId: randomUUID(),
      operation: {
        kind: 'text' as const,
        segmentId: srtFormal.document.segments[0]!.id,
        text: '少年走入山谷。\n保留第二行😀',
      },
    }),
  )
  await value(
    page.evaluate((request) => window.desktop.undoTranscriptEdit(request), {
      ...target,
      revision: edited.history.revision!,
      commandId: randomUUID(),
      historyId: edited.history.undo!.id,
    }),
  )
  assert.deepEqual((await doc()).document, srtFormal.document)
  report.srt = {
    before,
    formal: srtFormal,
    current: await doc(),
    protectedState,
    clock: await clock(),
  }
  await stage('explicit-SRT-import-created-protected-baseline-and-exact-edit-undo')
  await close()
  const srtDatabase = database()
  assert.deepEqual(srtDatabase.bytes, srtBytes)
  assert.equal(srtDatabase.state.source.encoding, 'utf-16le')
  assert.equal(srtDatabase.state.source.format, 'srt')
  assert.equal(srtDatabase.state.source.import_revision, srtFormal.revision)
  assert.equal(srtDatabase.state.source.document_hash, sha(JSON.stringify(srtFormal.document)))
  assert.equal(srtDatabase.state.commands.length, 1)
  const closedSrtDatabase = join(directory, 'closed-srt.sqlite3')
  await copyFile(paths.database, closedSrtDatabase)
  report.closedSrt = {
    ...srtDatabase.state,
    databaseFile: closedSrtDatabase,
    databaseSha256: await hash(closedSrtDatabase),
  }
  await stage('graceful-closed-SRT-BLOB-source-and-imported-revision-independently-verified')
  await launch()
  assert.deepEqual((await doc()).document, srtFormal.document)
  const command = srtDatabase.state.commands[0]!,
    beforeReplay = await doc(),
    replay = await value(
      page.evaluate((request) => window.desktop.applySubtitleImport(request), {
        token: String(command.token),
        revision: Number(command.preview_revision),
        commandId: String(command.command_id),
      }),
    )
  assert.equal(replay.replayed, true)
  assert.deepEqual(await doc(), beforeReplay)
  const vttPanel = await panel(vttPath)
  await expect(vttPanel).toContainText('3 条字幕 → 4 段伴读文字')
  await expect(vttPanel).toContainText('原时间边界保留')
  await expect(vttPanel.locator('script')).toHaveCount(0)
  await vttPanel.getByRole('spinbutton', { name: '导入字幕时间偏移毫秒', exact: true }).fill('100')
  await expect(vttPanel).toContainText('选项已修改')
  await vttPanel.getByRole('button', { name: '重新预览字幕', exact: true }).click()
  await expect(vttPanel).toContainText('延后 100 毫秒')
  assert.deepEqual(await doc(), beforeReplay)
  await page.setViewportSize({ width: 720, height: 600 })
  await vttPanel
    .getByRole('button', { name: `替换当前版本 ${beforeReplay.revision} 并导入`, exact: true })
    .scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(directory, 'vtt-preview-720.png'), fullPage: true })
  await vttPanel
    .getByRole('button', { name: `替换当前版本 ${beforeReplay.revision} 并导入`, exact: true })
    .click()
  await expect(vttPanel).not.toBeVisible()
  const vttFormal = await doc()
  assert.deepEqual(vttFormal.document.coverage, [
    { startMs: 600, endMs: 3100 },
    { startMs: 5100, endMs: 6100 },
  ])
  assert.deepEqual(
    vttFormal.document.segments.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })),
    [
      { startMs: 600, endMs: 1600, text: '少年走进山谷。' },
      { startMs: 1600, endMs: 2100, text: '少年走进山谷。\n山中响起钟声。' },
      { startMs: 2100, endMs: 3100, text: '山中响起钟声。' },
      { startMs: 5100, endMs: 6100, text: '<script>字幕字面文字</script> & ≂̸' },
    ],
  )
  assert.deepEqual(await kept(), protectedState)
  const media = []
  for (const segment of vttFormal.document.segments) {
    await page
      .getByRole('slider', { name: '播放进度', exact: true })
      .fill(String(Math.floor((segment.startMs + segment.endMs) / 2)))
    await expect(page.locator('.transcript-sentence[aria-current="true"]')).toHaveAttribute(
      'data-segment-id',
      segment.id,
    )
    await page.locator(`.transcript-sentence[data-segment-id="${segment.id}"]`).click()
    await expect.poll(async () => (await clock()).positionMs).toBeCloseTo(segment.startMs, 1)
    media.push(await clock())
  }
  await page.getByRole('slider', { name: '播放进度', exact: true }).fill('4000')
  await expect(page.locator('.transcript-sentence[aria-current="true"]')).toHaveCount(0)
  assert.equal((await clock()).paused, true)
  assert.equal((await clock()).rate, 1.25)
  await expect(page.locator('audio[data-player="persistent"]')).toHaveCount(1)
  report.vtt = { formal: vttFormal, replay, media, gapClock: await clock(), kept: await kept() }
  await page.screenshot({ path: join(directory, 'imported-vtt-media-720.png'), fullPage: true })
  await stage('WebVTT-overlap-markup-offset-explicit-adoption-and-original-media-point-seeking')
  await close()
  const final = database()
  assert.deepEqual(final.bytes, vttBytes)
  assert.equal(final.state.source.encoding, 'utf-8')
  assert.equal(final.state.source.offset_ms, 100)
  assert.equal(final.state.source.document_hash, sha(JSON.stringify(vttFormal.document)))
  assert.equal(final.state.commands.length, 2)
  assert.deepEqual(final.state.history, [])
  report.closedVtt = final.state
  await launch()
  assert.deepEqual((await doc()).document, vttFormal.document)
  assert.deepEqual(await kept(), protectedState)
  report.restarted = { formal: await doc(), kept: await kept(), clock: await clock() }
  await close()
  for (const [path, expected] of Object.entries(protectedBefore))
    assert.equal(await hash(path), expected)
  for (const [name, expected] of Object.entries(build.outputHashes))
    assert.equal(await hash(join(appRoot, 'out', name)), expected)
  for (const [name, expected] of Object.entries(build.originalOutputHashes))
    assert.equal(await hash(resolve('out', name)), expected)
  assert.deepEqual(rendererErrors, [])
  report.rendererErrors = rendererErrors
  report.ownedProcessesRemaining = processes()
  assert.deepEqual(report.ownedProcessesRemaining, [])
  report.databaseSha256 = await hash(paths.database)
  report.status = 'passed'
  report.finishedAt = new Date().toISOString()
  await stage('passed')
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
  if (page!)
    await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true }).catch(() => {})
  await save()
  throw error
} finally {
  if (app)
    await close().catch(async (error) => {
      report.cleanupError = String(error)
      await save()
    })
  report.ownedProcessesRemaining = processes()
  await save()
}
