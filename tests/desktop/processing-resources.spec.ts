import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { constants, getPriority, tmpdir } from 'node:os'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import type { ProcessingPolicy } from '../../src/shared/processing-resources'
import type { TranscriptRequest } from '../../src/shared/transcript'
import { menuAction } from '../helpers/ui'

// Model work and its checkpoint are deterministic stdlib fixtures in a disposable
// preview copy. Queue/attempt persistence, IPC, playback and OS process priority
// remain real. Reported thread counts exercise the protocol, not Torch/model load.
const worker = String.raw`
import argparse
import json
import os
from pathlib import Path
import sys
import threading
import time

parser = argparse.ArgumentParser()
parser.add_argument('--models')
parser.add_argument('--cache')
parser.add_argument('--cpu-threads', type=int, default=4)
args, _ = parser.parse_known_args()
gates = Path(json.loads(Path(args.models).read_text(encoding='utf8'))['gates'])
cache = Path(args.cache)
lock = threading.Lock()
cancelled = set()

def emit(value):
    with lock:
        print(json.dumps({'protocolVersion': 1,
                          'executionResources': {'requestedCpuThreads': args.cpu_threads,
                                                 'torchThreads': args.cpu_threads, 'torchInteropThreads': 1},
                          **value}, ensure_ascii=False), flush=True)

def run(request):
    identity = {key: request[key] for key in ['jobId', 'attempt']}
    key = (request['jobId'], request['attempt'])
    checkpoint = cache / ('resource-checkpoint-' + request['audioHash'] + '.json')
    reused = checkpoint.exists()
    with lock:
        with (gates / 'requests.jsonl').open('a', encoding='utf8') as output:
            output.write(json.dumps({**request, 'cpuThreads': args.cpu_threads, 'pid': os.getpid(),
                                    'ompThreads': os.environ.get('OMP_NUM_THREADS'), 'reusedCheckpoint': reused}) + '\n')
    def wait(suffix):
        while not (gates / (request['audioHash'] + '.' + suffix)).exists():
            if key in cancelled:
                return False
            time.sleep(0.01)
        return key not in cancelled
    def snapshot(end, hits):
        return {'document': {'version': 1, 'kind': 'transcript', 'audioHash': request['audioHash'],
                             'coverage': [{'startMs': 0, 'endMs': end}],
                             'segments': [{'id': 's1', 'startMs': 0, 'endMs': 4000, 'text': '资源控制分块测试。'}]},
                'processedUntilMs': end, 'cacheKey': 'a' * 64, 'cacheHits': hits, 'totalChunks': 2, 'issues': []}
    emit({'type': 'progress', **identity, 'stage': 'recognizing', 'processedUntilMs': 0})
    if reused:
        partial = json.loads(checkpoint.read_text(encoding='utf8'))
        partial['cacheHits'] = 1
    elif wait('partial'):
        partial = snapshot(5000, 0)
        checkpoint.write_text(json.dumps(partial), encoding='utf8')
    else:
        return
    emit({'type': 'partial', **identity, **partial, 'completedChunks': 1})
    if wait('finish'):
        emit({'type': 'result', **identity, **snapshot(90000, 1 if reused else 0), 'durationMs': 90000})

emit({'type': 'ready', 'configuration': {'fixture': 'processing-resources-v1', 'threads': args.cpu_threads}})
for line in sys.stdin:
    value = json.loads(line)
    if value['type'] == 'cancel':
        cancelled.add((value['jobId'], value['attempt']))
        emit({'type': 'canceled', 'jobId': value['jobId'], 'attempt': value['attempt']})
    elif value['type'] == 'prioritize':
        pass
    else:
        threading.Thread(target=run, args=(value,), daemon=True).start()
`
let python: string | undefined, appRoot: string
try {
  python = execFileSync('python', ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
} catch {
  /* Acceptance requires only a local stdlib interpreter, never ML or network. */
}
test.skip(
  !python || !!process.env.RALB_EXECUTABLE,
  'Requires stdlib Python and a disposable preview copy.',
)
test.beforeAll(() => {
  if (!python || process.env.RALB_EXECUTABLE) return
  appRoot = mkdtempSync(join(tmpdir(), '听读 处理资源 应用 '))
  cpSync(resolve(process.env.RALB_APP_ROOT ?? '.', 'out'), join(appRoot, 'out'), {
    recursive: true,
  })
  writeFileSync(
    join(appRoot, 'package.json'),
    JSON.stringify({
      name: 'processing-resources-fixture',
      type: 'module',
      main: './out/main/index.js',
    }),
  )
  symlinkSync(resolve('node_modules'), join(appRoot, 'node_modules'), 'junction')
  mkdirSync(join(appRoot, 'python'))
  writeFileSync(join(appRoot, 'python', 'asr_worker.py'), worker)
  writeFileSync(
    join(appRoot, 'python', 'asr_component_probe.py'),
    `import json\nprint(json.dumps({"level":"imports-and-files", "pythonVersion":"fixture", "cudaName":None, "freeBytes":1000000000, "issues":[], "capabilities":[{"engine":engine,"device":device,"available":True,"message":"controlled fixture prerequisites"} for engine in ["whisperx","paraformer"] for device in ["cpu","cuda"]]}))\n`,
  )
})
function audio(path: string, marker: number) {
  const bytes = 8000 * 90 * 2,
    wav = Buffer.alloc(44 + bytes)
  wav.write('RIFF')
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
  wav.writeInt16LE(marker, 44)
  writeFileSync(path, wav)
}
interface FixtureRequest {
  jobId: string
  attempt: number
  audioHash: string
  cpuThreads: number
  ompThreads: string
  reusedCheckpoint: boolean
  pid: number
}
async function fixture(idleBackground = false) {
  const root = mkdtempSync(join(tmpdir(), '听读 处理资源 数据 ')),
    folder = join(root, '有声书'),
    gates = join(root, 'gates'),
    cache = join(root, 'component-cache'),
    models = join(root, 'models.json')
  for (const directory of [folder, gates, cache]) mkdirSync(directory)
  for (let i = 0; i < 2; i++) audio(join(folder, `第${i + 1}集.wav`), i + 1)
  writeFileSync(models, JSON.stringify({ gates }))
  writeFileSync(
    join(root, 'asr-component.json'),
    JSON.stringify({ version: 1, python, models, cache, ffmpeg: python, ffprobe: python }),
  )
  const store = new LibraryStore(createDataPaths(root).database)
  store.importBook(await scanBook(folder, 'folder'))
  const episodes = store.listBooks()[0]!.episodes,
    targets = episodes.map((episode) => ({ episodeId: episode.id, audioHash: episode.contentHash }))
  for (const episode of episodes) store.recordSourceDuration(episode.id, episode.contentHash, 90000)
  let backgroundId: string | undefined
  if (idleBackground) {
    // A durable offline task isolates resource scheduling from playback's
    // deliberate rule that restoring a paused book does not activate prefetch.
    store.setSubtitlePreparation(episodes[0]!.bookId, {
      mode: 'manual',
      engine: 'whisperx',
      device: 'cpu',
      prepareNext: false,
    })
    store.saveTranscript(episodes[0]!.id, {
      version: 1,
      kind: 'manual',
      audioHash: targets[0]!.audioHash,
      coverage: [{ startMs: 0, endMs: 90000 }],
      segments: [{ id: 'manual', startMs: 0, endMs: 4000, text: '当前集保留的人工字幕。' }],
    })
    const saved = store.setProcessingPolicy({
      revision: store.processingResources().revision,
      policy: { cpuThreads: 1, lowPriority: true, backgroundIdleOnly: true },
    })
    store.setProcessingPaused({ revision: saved.revision, paused: true })
    const plan = store.createOfflinePlan({
      bookId: episodes[0]!.bookId,
      episodeIds: [episodes[1]!.id],
      scope: 'ids',
      profile: { engine: 'whisperx', device: 'cpu' },
      audioBudgetBytes: 2 * 1024 ** 3,
    })
    const item = store.storedOfflineItems(plan.id)[0]!
    backgroundId = store.createOrAttachOfflineJob(item.id, {
      ...targets[1]!,
      engine: 'whisperx',
      device: 'cpu',
    }).job.id
  }
  store.saveProgress({
    sessionId: '',
    episodeId: episodes[0]!.id,
    positionMs: 0,
    durationMs: 90000,
    rate: 1,
    volume: 0,
  })
  store.close()
  const launch = () => {
    const env = { ...process.env, RALB_USER_DATA: root }
    Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
    return electron.launch({ args: [appRoot], env })
  }
  return {
    root,
    targets,
    backgroundId,
    launch,
    gate: (index: number, suffix: string) =>
      writeFileSync(join(gates, `${targets[index]!.audioHash}.${suffix}`), ''),
    requests: (): FixtureRequest[] => {
      const path = join(gates, 'requests.jsonl')
      return existsSync(path)
        ? readFileSync(path, 'utf8')
            .split(/\r?\n|\\n/u)
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : []
    },
  }
}
async function resources(page: Page) {
  const result = await page.evaluate(() => window.desktop.getProcessingResources())
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
async function pause(page: Page, paused: boolean) {
  const current = await resources(page),
    result = await page.evaluate((request) => window.desktop.setProcessingPaused(request), {
      revision: current.revision,
      paused,
    })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
async function policy(page: Page, change: Partial<ProcessingPolicy>) {
  const current = await resources(page),
    result = await page.evaluate((request) => window.desktop.setProcessingResources(request), {
      revision: current.revision,
      policy: { ...current.policy, ...change },
    })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
async function state(page: Page, target: TranscriptRequest) {
  const result = await page.evaluate((input) => window.desktop.getTranscriptionState(input), target)
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
async function start(page: Page, target: TranscriptRequest) {
  const result = await page.evaluate((input) => window.desktop.startTranscription(input), {
    ...target,
    engine: 'whisperx' as const,
    device: 'cpu' as const,
  })
  if (!result.ok) throw new Error(result.error.message)
  return result.value.job!
}

test('the low-occupancy preset reaches the worker; resource pause preserves partial work and playback, restart stays paused, and resume reuses the same job before permanent cancellation', async ({}, info) => {
  const t = await fixture()
  let app = await t.launch()
  try {
    let page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
    await menuAction(page, '应用设置', '缓存与任务')
    const dialog = page.getByRole('dialog', { name: '缓存与任务', exact: true })
    await dialog.getByRole('tab', { name: /^转写任务/ }).click()
    const panel = dialog.getByRole('region', { name: '处理资源与暂停', exact: true })
    await panel.getByRole('button', { name: '低占用预设', exact: true }).click()
    await panel.getByRole('button', { name: '保存资源设置', exact: true }).click()
    await expect(panel.getByLabel('当前生效资源', { exact: true })).toContainText('1 线程')
    expect((await resources(page)).policy).toMatchObject({ cpuThreads: 1, lowPriority: true })
    await dialog.getByRole('button', { name: '关闭缓存与任务', exact: true }).click()
    await page.getByRole('button', { name: '播放', exact: true }).click()
    // Establish actual native playback before attributing a later pause to the
    // resource scheduler; click completion alone does not await audio.play().
    await expect
      .poll(() =>
        page
          .locator('audio')
          .evaluate((element: HTMLAudioElement) => !element.paused && element.currentTime > 0),
      )
      .toBe(true)
    const job = await start(page, t.targets[0]!)
    await expect.poll(() => t.requests().length).toBe(1)
    expect(t.requests()[0]).toMatchObject({
      jobId: job.id,
      attempt: 1,
      cpuThreads: 1,
      ompThreads: '1',
      reusedCheckpoint: false,
    })
    await expect.poll(async () => (await resources(page)).worker?.cpuThreads).toBe(1)
    const low = (await resources(page)).worker!
    expect(low.priority).toBe('low')
    expect(getPriority(low.pid)).toBe(constants.priority.PRIORITY_BELOW_NORMAL)
    await policy(page, { lowPriority: false })
    await expect.poll(async () => (await resources(page)).worker?.priority).toBe('normal')
    expect(getPriority(low.pid)).toBe(constants.priority.PRIORITY_NORMAL)
    await policy(page, { lowPriority: true })
    t.gate(0, 'partial')
    await expect.poll(async () => (await state(page, t.targets[0]!)).job?.completedChunks).toBe(1)
    const partial = await state(page, t.targets[0]!)
    await pause(page, true)
    await expect.poll(async () => (await state(page, t.targets[0]!)).job?.attempt).toBe(2)
    expect((await state(page, t.targets[0]!)).job).toMatchObject({
      id: job.id,
      status: 'queued',
      cpuThreads: 1,
      completedChunks: 1,
    })
    await expect.poll(async () => (await resources(page)).worker).toBeNull()

    expect(
      await page.locator('audio').evaluate((element: HTMLAudioElement) => element.paused),
    ).toBe(false)
    const position = await page
      .locator('audio')
      .evaluate((element: HTMLAudioElement) => element.currentTime)
    await expect
      .poll(() =>
        page.locator('audio').evaluate((element: HTMLAudioElement) => element.currentTime),
      )
      .toBeGreaterThan(position)
    await app.close()
    app = await t.launch()
    page = await app.firstWindow()
    expect((await resources(page)).paused).toBe(true)
    expect((await resources(page)).worker).toBeNull()
    expect((await state(page, t.targets[0]!)).job).toMatchObject({
      id: job.id,
      status: 'queued',
      attempt: 2,
      completedChunks: 1,
    })
    expect((await state(page, t.targets[0]!)).transcript).toEqual(partial.transcript)
    expect(t.requests()).toHaveLength(1)
    await pause(page, false)
    await expect.poll(() => t.requests().length).toBe(2)
    expect(t.requests()[1]).toMatchObject({
      jobId: job.id,
      attempt: 2,
      cpuThreads: 1,
      ompThreads: '1',
      reusedCheckpoint: true,
    })
    await expect.poll(async () => (await state(page, t.targets[0]!)).job?.cacheHits).toBe(1)
    const canceled = await page.evaluate((input) => window.desktop.cancelTranscription(input), {
      id: job.id,
    })
    expect(canceled.ok).toBe(true)
    await expect.poll(async () => (await state(page, t.targets[0]!)).job?.status).toBe('canceled')
    await pause(page, true)
    await pause(page, false)
    t.gate(0, 'finish')
    await expect.poll(async () => (await resources(page)).status).toBe('ready')
    expect((await state(page, t.targets[0]!)).job).toMatchObject({
      id: job.id,
      status: 'canceled',
      attempt: 2,
    })
    expect(t.requests()).toHaveLength(2)
    await info.attach('actual-resource-observations', {
      body: Buffer.from(
        JSON.stringify(
          { worker: low, requests: t.requests(), final: await resources(page) },
          null,
          2,
        ),
      ),
      contentType: 'application/json',
    })
  } finally {
    await app.close()
  }
})

test('idle-only background work yields to current manual work and to renewed user activity without pausing the audio', async () => {
  const t = await fixture(true),
    app = await t.launch()
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.getSystemIdleTime = () => 0
    })
    await expect(page.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
    await pause(page, false)
    await expect.poll(async () => (await resources(page)).status).toBe('waiting-idle')
    expect(t.requests()).toHaveLength(0)
    expect((await state(page, t.targets[1]!)).job).toMatchObject({
      id: t.backgroundId,
      background: true,
      status: 'queued',
    })
    const manual = await start(page, t.targets[0]!)
    await expect.poll(() => t.requests().length).toBe(1)
    expect(t.requests()[0]!.jobId).toBe(manual.id)
    t.gate(0, 'partial')
    t.gate(0, 'finish')
    await expect.poll(async () => (await state(page, t.targets[0]!)).job?.status).toBe('completed')
    await expect.poll(async () => (await resources(page)).status).toBe('waiting-idle')
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.getSystemIdleTime = () => 120
    })
    await expect.poll(() => t.requests().length).toBe(2)
    expect(t.requests()[1]).toMatchObject({ jobId: t.backgroundId, attempt: 1 })
    t.gate(1, 'partial')
    await expect.poll(async () => (await state(page, t.targets[1]!)).job?.completedChunks).toBe(1)
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.getSystemIdleTime = () => 0
    })
    await expect.poll(async () => (await state(page, t.targets[1]!)).job?.attempt).toBe(2)
    await expect.poll(async () => (await resources(page)).status).toBe('waiting-idle')
    await expect.poll(async () => (await resources(page)).worker).toBeNull()
    expect((await state(page, t.targets[1]!)).job).toMatchObject({
      id: t.backgroundId,
      status: 'queued',
      completedChunks: 1,
    })
    expect(
      await page.locator('audio').evaluate((element: HTMLAudioElement) => element.paused),
    ).toBe(false)
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.getSystemIdleTime = () => 120
    })
    await expect.poll(() => t.requests().length).toBe(3)
    expect(t.requests()[2]).toMatchObject({
      jobId: t.backgroundId,
      attempt: 2,
      reusedCheckpoint: true,
    })
    await expect.poll(async () => (await state(page, t.targets[1]!)).job?.cacheHits).toBe(1)
    t.gate(1, 'finish')
    await expect.poll(async () => (await state(page, t.targets[1]!)).job?.status).toBe('completed')
    expect(
      await page.locator('audio').evaluate((element: HTMLAudioElement) => element.paused),
    ).toBe(false)
  } finally {
    await app.close()
  }
})
