import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import type { TranscriptRequest } from '../../src/shared/transcript'
import { menuAction } from '../helpers/ui'

// These tests exercise the real preload, IPC, SQLite persistence, process protocol,
// and renderer. Only model output/scheduling is synthetic: a stdlib Python worker
// in a disposable copy of the preview emits controlled JSONL partials and results.
// No production worker, existing out/, model, or network is changed or used.
const worker = String.raw`
import argparse
import json
from pathlib import Path
import sys
import threading
import time

parser = argparse.ArgumentParser()
parser.add_argument('--models')
args, _ = parser.parse_known_args()
gates = Path(json.loads(Path(args.models).read_text(encoding='utf8'))['gates'])
lock = threading.Lock()
cancelled = set()

def emit(value):
    with lock:
        print(json.dumps({'protocolVersion': 1, **value}, ensure_ascii=False), flush=True)

def run(request):
    identity = {key: request[key] for key in ['jobId', 'attempt']}
    key = (request['jobId'], request['attempt'])
    adaptive = (gates / 'adaptive-mode').exists()
    with (gates / 'requests.jsonl').open('a', encoding='utf8') as output:
        output.write(json.dumps(request) + '\n')
    def wait(name):
        while not (gates / name).exists():
            if key in cancelled:
                return False
            if (gates / 'fail').exists():
                emit({'type': 'error', **identity, 'code': 'FIXTURE_FAILURE',
                      'message': '测试组件生成失败，普通播放可以继续。'})
                return False
            time.sleep(0.02)
        return key not in cancelled
    def snapshot(end):
        return {'document': {'version': 1, 'audioHash': request['audioHash'],
                            'kind': 'transcript',
                            'coverage': [{'startMs': 0, 'endMs': end}],
                            'segments': [{'id': 's1', 'startMs': 0,
                                          'endMs': min(end, 4000), 'text': '测试伴读字幕。'}]},
                'processedUntilMs': end, 'cacheKey': 'a' * 64,
                'cacheHits': 0, 'totalChunks': 4 if adaptive else 3, 'issues': []}
    emit({'type': 'progress', **identity, 'stage': 'recognizing', 'processedUntilMs': 0})
    for gate, end, chunks in [('short', 5000, 1), ('ready', 30000, 2)]:
        if not wait(gate):
            return
        emit({'type': 'partial', **identity, **snapshot(end), 'completedChunks': chunks})
    if adaptive:
        if not wait('adaptive-ready'):
            return
        emit({'type': 'partial', **identity, **snapshot(60000), 'completedChunks': 3})
    if wait('finish'):
        emit({'type': 'result', **identity, **snapshot(90000), 'durationMs': 90000})

emit({'type': 'ready', 'configuration': {'fixture': 'subtitle-buffering'}})
for line in sys.stdin:
    value = json.loads(line)
    if value['type'] == 'cancel':
        cancelled.add((value['jobId'], value['attempt']))
        emit({'type': 'canceled', 'jobId': value['jobId'], 'attempt': value['attempt']})
    elif value['type'] == 'prioritize':
        # Scheduling control does not create another fixture recognition job.
        pass
    else:
        threading.Thread(target=run, args=(value,), daemon=True).start()
`

let python: string | undefined
try {
  python = execFileSync('python', ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
} catch {
  /* Source-only protocol acceptance needs Python stdlib, without ML dependencies. */
}
let appRoot: string
test.beforeAll(() => {
  if (!python || process.env.RALB_EXECUTABLE) return
  appRoot = mkdtempSync(join(tmpdir(), '听读 字幕准备 应用 '))
  cpSync(resolve(process.env.RALB_APP_ROOT ?? '.', 'out'), join(appRoot, 'out'), {
    recursive: true,
  })
  writeFileSync(
    join(appRoot, 'package.json'),
    JSON.stringify({
      name: 'subtitle-buffering-fixture',
      type: 'module',
      main: './out/main/index.js',
    }),
  )
  symlinkSync(resolve('node_modules'), join(appRoot, 'node_modules'), 'junction')
  mkdirSync(join(appRoot, 'python'))
  writeFileSync(join(appRoot, 'python', 'asr_worker.py'), worker)
  writeFileSync(
    join(appRoot, 'python', 'asr_component_probe.py'),
    `import json\nprint(json.dumps({
    "level":"imports-and-files", "pythonVersion":"fixture", "cudaName":None, "freeBytes":1000000000, "issues":[],
    "capabilities":[{"engine":engine,"device":device,"available":True,"message":"controlled fixture prerequisites"}
                    for engine in ["whisperx","paraformer"] for device in ["cpu","cuda"]]}))\n`,
  )
})
test.skip(
  !python || !!process.env.RALB_EXECUTABLE,
  'Requires a source/preview application and stdlib Python; never modifies a packaged runtime.',
)

function silentAudio(path: string) {
  const samples = 8000 * 90,
    bytes = samples * 2,
    wav = Buffer.alloc(44 + bytes)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + bytes, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24)
  wav.writeUInt32LE(16000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(bytes, 40)
  writeFileSync(path, wav)
}

async function createCase(configured = true) {
  const root = mkdtempSync(join(tmpdir(), '听读 字幕准备 数据 '))
  const gates = join(root, 'gates')
  mkdirSync(gates)
  const audio = join(root, '第1集-缓冲测试.wav')
  silentAudio(audio)
  const paths = createDataPaths(root),
    store = new LibraryStore(paths.database)
  store.importBook(await scanBook(audio, 'file'))
  const book = store.listBooks()[0]!,
    episode = book.episodes[0]!
  // Leave currentEpisodeId null so the first open is the explicit UI click.
  store.close()
  if (configured) {
    const models = join(root, 'models.json'),
      cache = join(root, 'component-cache')
    mkdirSync(cache)
    writeFileSync(models, JSON.stringify({ gates }))
    writeFileSync(
      join(root, 'asr-component.json'),
      JSON.stringify({
        version: 1,
        python,
        models,
        cache,
        ffmpeg: python,
        ffprobe: python,
      }),
    )
  }
  return {
    root,
    gates,
    bookId: book.id,
    target: { episodeId: episode.id, audioHash: episode.contentHash },
    gate: (name: string) => writeFileSync(join(gates, name), ''),
  }
}
const launch = (root: string) => {
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  return electron.launch({ args: [appRoot], env })
}
async function selectAhead(page: Page, bookId: string) {
  await page.waitForLoadState('load')
  await expect(page.getByRole('button', { name: '继续播放', exact: true })).toBeVisible()
  const settings = { mode: 'ahead', engine: 'whisperx', device: 'cpu', prepareNext: false } as const
  const saved = await page.evaluate((request) => window.desktop.setSubtitlePreparation(request), {
    id: bookId,
    settings,
  })
  expect(saved.ok).toBe(true)
  if (!saved.ok) throw new Error(saved.error.message)
  expect(saved.value.books.find((book) => book.id === bookId)?.subtitlePreparation).toEqual(
    settings,
  )
  await page.reload()
  const persisted = await page.evaluate(() => window.desktop.getState())
  expect(persisted.ok && persisted.value.books[0]?.subtitlePreparation).toEqual(settings)
}
async function state(page: Page, target: TranscriptRequest) {
  const response = await page.evaluate(
    (target) => window.desktop.getTranscriptionState(target),
    target,
  )
  if (!response.ok) throw new Error(response.error.message)
  return response.value
}
const paused = (page: Page) =>
  page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)
async function waiting(page: Page) {
  await expect(page.getByRole('button', { name: '立即播放', exact: true })).toBeVisible()
  expect(await paused(page)).toBe(true)
}
async function releaseLead(page: Page, fixture: Awaited<ReturnType<typeof createCase>>) {
  fixture.gate('short')
  await expect
    .poll(async () => (await state(page, fixture.target)).job?.processedUntilMs)
    .toBe(5000)
  await waiting(page)
  fixture.gate('ready')
  await expect
    .poll(async () => (await state(page, fixture.target)).job?.processedUntilMs)
    .toBe(30000)
}

test('ahead preparation starts from saved partial coverage while the rest keeps running and reuses the finished document', async ({}, info) => {
  const fixture = await createCase()
  let app: ElectronApplication = await launch(fixture.root)
  try {
    let page = await app.firstWindow()
    await selectAhead(page, fixture.bookId)
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await waiting(page)
    await page.screenshot({
      path: info.outputPath('ahead-preparation-waiting.png'),
      animations: 'disabled',
    })
    await releaseLead(page, fixture)
    await expect.poll(() => paused(page)).toBe(false)
    const partial = await state(page, fixture.target)
    expect(partial.job?.status).toBe('running')
    expect(partial.transcript.status).toBe('ready')
    if (partial.transcript.status !== 'ready') throw new Error('Missing persisted partial')
    expect(partial.transcript.transcript.document.coverage).toEqual([{ startMs: 0, endMs: 30000 }])
    fixture.gate('finish')
    await expect.poll(async () => (await state(page, fixture.target)).job?.status).toBe('completed')
    const completed = await state(page, fixture.target)
    expect(
      completed.transcript.status === 'ready' && completed.transcript.transcript.document.coverage,
    ).toEqual([{ startMs: 0, endMs: 90000 }])
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await app.close()
    app = await launch(fixture.root)
    page = await app.firstWindow()
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await expect.poll(() => paused(page)).toBe(false)
    await expect(page.getByRole('button', { name: '立即播放', exact: true })).toHaveCount(0)
    expect((await state(page, fixture.target)).job?.id).toBe(completed.job?.id)
    expect(
      readFileSync(join(fixture.gates, 'requests.jsonl'), 'utf8').trim().split('\n'),
    ).toHaveLength(1)
  } finally {
    await app.close()
  }
})

test('canceling or seeking clears pending autoplay; immediate play overrides preparation and later results preserve pause', async () => {
  const fixture = await createCase(),
    app = await launch(fixture.root)
  try {
    const page = await app.firstWindow()
    await selectAhead(page, fixture.bookId)
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await waiting(page)
    await page.getByRole('button', { name: '取消等待', exact: true }).click()
    fixture.gate('short')
    fixture.gate('ready')
    await expect
      .poll(async () => (await state(page, fixture.target)).job?.processedUntilMs)
      .toBe(30000)
    await expect(page.getByRole('button', { name: '播放', exact: true })).toBeVisible()
    expect(await paused(page)).toBe(true)
    await page.getByRole('slider', { name: '播放进度', exact: true }).fill('45000')
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await waiting(page)
    await page.getByRole('slider', { name: '播放进度', exact: true }).fill('60000')
    await expect(page.getByRole('button', { name: '立即播放', exact: true })).toHaveCount(0)
    expect(await paused(page)).toBe(true)
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await waiting(page)
    await page.getByRole('button', { name: '立即播放', exact: true }).click()
    await expect.poll(() => paused(page)).toBe(false)
    expect((await state(page, fixture.target)).job?.status).toBe('running')
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    fixture.gate('finish')
    await expect.poll(async () => (await state(page, fixture.target)).job?.status).toBe('completed')
    expect(await paused(page)).toBe(true)
    await expect(page.getByRole('button', { name: '播放', exact: true })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('2x playback waits for 60 seconds of media coverage, warns about observed slow generation, and starts before the whole episode finishes', async ({}, info) => {
  const fixture = await createCase()
  fixture.gate('adaptive-mode')
  const app = await launch(fixture.root)
  try {
    const page = await app.firstWindow()
    await selectAhead(page, fixture.bookId)
    await page.clock.install()
    await page.getByRole('combobox', { name: '播放倍速', exact: true }).selectOption('2')
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await waiting(page)
    // Advance renderer performance time while audio remains paused. This gives
    // a measured 5-second coverage gain over 6 seconds, without sleeping or
    // pretending the controlled worker demonstrates actual inference speed.
    // The initial component check runs in the background; start the measurement
    // only after the player has observed the zero-coverage job baseline.
    await expect(page.locator('.player-notice')).toContainText('正在提前准备')
    await page.clock.runFor(6000)
    fixture.gate('short')
    await expect
      .poll(async () => (await state(page, fixture.target)).job?.processedUntilMs)
      .toBe(5000)
    await waiting(page)
    await expect(page.locator('.player-notice')).toContainText('字幕可能落后于播放')
    fixture.gate('ready')
    await expect
      .poll(async () => (await state(page, fixture.target)).job?.processedUntilMs)
      .toBe(30000)
    await waiting(page)
    await expect(page.locator('.player-notice')).toContainText('约 60 秒音频的字幕')
    const before = await state(page, fixture.target)
    expect(before.job?.status).toBe('running')
    expect(
      before.transcript.status === 'ready' && before.transcript.transcript.document.coverage,
    ).toEqual([{ startMs: 0, endMs: 30000 }])
    fixture.gate('adaptive-ready')
    await expect.poll(() => paused(page)).toBe(false)
    await expect(page.getByRole('button', { name: '立即播放', exact: true })).toHaveCount(0)
    const after = await state(page, fixture.target)
    expect(after.job?.id).toBe(before.job?.id)
    expect(after.job?.status).toBe('running')
    expect(
      after.transcript.status === 'ready' && after.transcript.transcript.document.coverage,
    ).toEqual([{ startMs: 0, endMs: 60000 }])
    expect(
      await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.playbackRate),
    ).toBe(2)
    expect(
      readFileSync(join(fixture.gates, 'requests.jsonl'), 'utf8').trim().split('\n'),
    ).toHaveLength(1)
    await page.screenshot({
      path: info.outputPath('adaptive-2x-starts-with-partial-coverage.png'),
      animations: 'disabled',
    })
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    fixture.gate('finish')
    await expect.poll(async () => (await state(page, fixture.target)).job?.status).toBe('completed')
    expect(await paused(page)).toBe(true)
  } finally {
    await app.close()
  }
})

test('a worker failure releases subtitle waiting and leaves ordinary playback usable', async () => {
  const fixture = await createCase(),
    app = await launch(fixture.root)
  try {
    const page = await app.firstWindow()
    await selectAhead(page, fixture.bookId)
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await waiting(page)
    fixture.gate('fail')
    await expect.poll(async () => (await state(page, fixture.target)).job?.status).toBe('failed')
    await expect.poll(() => paused(page)).toBe(false)
    await expect(page.getByRole('button', { name: '立即播放', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await expect.poll(() => paused(page)).toBe(false)
  } finally {
    await app.close()
  }
})

test('a minute timer expiring during preparation prevents later partials and completion from autoplaying', async () => {
  const fixture = await createCase(),
    app = await launch(fixture.root)
  try {
    const page = await app.firstWindow()
    await selectAhead(page, fixture.bookId)
    await page.clock.install()
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await waiting(page)
    await menuAction(page, '播放选项', '收听工具')
    const dialog = page.getByRole('dialog', { name: '收听工具', exact: true })
    await dialog.getByRole('spinbutton', { name: '定时分钟' }).fill('1')
    await dialog.getByRole('button', { name: '启动定时', exact: true }).click()
    await dialog.getByRole('button', { name: '关闭收听工具', exact: true }).click()
    // Advance only the renderer wall clock. The media is paused, and Python/IPC,
    // document persistence, and later worker partial/result delivery remain real.
    const now = await page.evaluate(() => Date.now())
    await page.clock.setSystemTime(new Date(now + 61000))
    await page.clock.runFor(600)
    const timerFeedback = page
      .getByRole('region', { name: '播放器', exact: true })
      .getByRole('status')
      .filter({ hasText: '已定时停止' })
    await expect(timerFeedback).toHaveText('已定时停止')
    await expect(timerFeedback).toBeVisible()
    await expect(page.getByRole('button', { name: '立即播放', exact: true })).toHaveCount(0)
    fixture.gate('short')
    fixture.gate('ready')
    await expect
      .poll(async () => (await state(page, fixture.target)).job?.processedUntilMs)
      .toBe(30000)
    expect(await paused(page)).toBe(true)
    fixture.gate('finish')
    await expect.poll(async () => (await state(page, fixture.target)).job?.status).toBe('completed')
    expect(await paused(page)).toBe(true)
    await expect(page.getByRole('button', { name: '播放', exact: true })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('ahead mode without configured components starts ordinary playback without waiting', async () => {
  const fixture = await createCase(false),
    app = await launch(fixture.root)
  try {
    const page = await app.firstWindow()
    await selectAhead(page, fixture.bookId)
    await page.getByRole('button', { name: '继续播放', exact: true }).click()
    await expect.poll(() => paused(page)).toBe(false)
    await expect(page.getByRole('button', { name: '立即播放', exact: true })).toHaveCount(0)
    const value = await state(page, fixture.target)
    expect(value.configured).toBe(false)
    expect(value.job).toBeNull()
  } finally {
    await app.close()
  }
})
