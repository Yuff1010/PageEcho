import { openCompanionTools } from '../helpers/ui'
import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import type { TranscriptRequest } from '../../src/shared/transcript'

// Only model prerequisites and the child protocol are controlled, in a copied
// app. Main/preload/IPC, audio identity, lease, adoption, history and media clock
// remain real. The synthetic times prove UI behavior, never alignment quality.
const worker = String.raw`
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('--models')
args, _ = parser.parse_known_args()
gates = Path(json.loads(Path(args.models).read_text(encoding='utf8'))['gates'])
request = json.loads(sys.stdin.readline())
with (gates / 'requests.jsonl').open('a', encoding='utf8') as output:
    output.write(json.dumps(request, ensure_ascii=False) + '\n')
while not (gates / 'ready').exists():
    time.sleep(0.01)
text = request['text']
groups = [[]]
offset = 0
for char in text:
    size = len(char.encode('utf-16-le')) // 2
    if char == '\n':
        groups.append([])
    elif char.isalnum():
        groups[-1].append((char, offset, offset + size))
    offset += size
characters = []
for group, values in enumerate(groups):
    base = 500 if group == 0 else 2900
    for index, (char, start, end) in enumerate(values):
        characters.append({'text': char, 'textStart': start, 'textEnd': end,
                           'startMs': base + index * 900 // len(values),
                           'endMs': base + (index + 1) * 900 // len(values), 'score': 0.95})
rejected = (gates / 'reject').exists()
result = {'protocolVersion': 1, 'type': 'result', 'requestId': request['requestId'],
          'status': 'rejected' if rejected else 'accepted',
          'audioHash': request['audioHash'], 'range': request['range'],
          'textSha256': hashlib.sha256(text.encode('utf8')).hexdigest(),
          'contract': 'original-ctc-support-v1', 'ctcContract': 'ctc-complete-waveform-logodds-v1',
          'qualityPolicy': 'confirmed-original-acoustic-gate-v1', 'device': request['device'],
          'thresholds': {}, 'characters': [] if rejected else characters,
          'evidence': {'lexicalCharacters': len(characters), 'timedCharacters': 0 if rejected else len(characters),
                       'characterCoverage': 0 if rejected else 1, 'audioRms': 0.03,
                       'freePathCharacters': len(characters), 'freePathEditDistance': 5 if rejected else 0,
                       'freePathErrorRate': 0.8 if rejected else 0,
                       'minTokenPosterior': 0.9, 'meanTokenPosterior': 0.95},
          'reasons': [{'code': 'TEXT_AUDIO_MISMATCH', 'message': '受控界面测试：声音证据不符。'}] if rejected else [],
          'elapsedMs': 10}
if not rejected:
    result.update({'startMs': characters[0]['startMs'], 'endMs': characters[-1]['endMs'], 'confidence': 0.9})
print(json.dumps(result, ensure_ascii=False), flush=True)
`
const probe = `import json
print(json.dumps({"level":"imports-and-files", "pythonVersion":"fixture", "cudaName":None,
"freeBytes":1000000000, "issues":[], "capabilities":[{"engine":engine,"device":device,
"available":True,"message":"controlled UI fixture prerequisites"} for engine in ["whisperx","paraformer"]
for device in ["cpu","cuda"]]}))
`
let python: string | undefined, appRoot: string
try {
  python = execFileSync('python', ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
} catch {
  /* Child protocol fixture requires only Python stdlib. */
}
test.skip(!python || !!process.env.RALB_EXECUTABLE, 'Requires stdlib Python and a copied preview.')
test.beforeAll(() => {
  if (!python || process.env.RALB_EXECUTABLE) return
  appRoot = mkdtempSync(join(tmpdir(), '听读 字幕重对齐 UI '))
  cpSync(resolve(process.env.RALB_APP_ROOT ?? '.', 'out'), join(appRoot, 'out'), {
    recursive: true,
  })
  symlinkSync(resolve('node_modules'), join(appRoot, 'node_modules'), 'junction')
  writeFileSync(
    join(appRoot, 'package.json'),
    JSON.stringify({
      name: 'transcript-alignment-ui-fixture',
      type: 'module',
      main: './out/main/index.js',
    }),
  )
  mkdirSync(join(appRoot, 'python'))
  writeFileSync(
    join(appRoot, 'python/asr_worker.py'),
    '# No ASR recognition is used by this UI fixture.\n',
  )
  writeFileSync(join(appRoot, 'python/asr_original_alignment.py'), worker)
  writeFileSync(join(appRoot, 'python/asr_component_probe.py'), probe)
})
function wave(path: string) {
  const wav = Buffer.alloc(44 + 16000 * 16)
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
  writeFileSync(path, wav)
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), '听读 字幕重对齐 数据 ')),
    folder = join(root, '有声书'),
    gates = join(root, 'gates'),
    cache = join(root, 'component-cache'),
    models = join(root, 'models.json')
  for (const directory of [folder, gates, cache]) mkdirSync(directory)
  wave(join(folder, '第1集.wav'))
  writeFileSync(models, JSON.stringify({ gates }))
  writeFileSync(
    join(root, 'asr-component.json'),
    JSON.stringify({ version: 1, python, models, cache, ffmpeg: python, ffprobe: python }),
  )
  const store = new LibraryStore(createDataPaths(root).database)
  store.importBook(await scanBook(folder, 'folder'))
  const book = store.listBooks()[0]!,
    episode = book.episodes[0]!,
    target = { episodeId: episode.id, audioHash: episode.contentHash }
  store.setSubtitlePreparation(book.id, {
    mode: 'manual',
    engine: 'whisperx',
    device: 'cpu',
    prepareNext: false,
  })
  store.recordSourceDuration(episode.id, episode.contentHash, 16000)
  store.saveTranscript(episode.id, {
    version: 1,
    kind: 'manual',
    audioHash: episode.contentHash,
    coverage: [{ startMs: 0, endMs: 16000 }],
    segments: [
      { id: 's1', startMs: 100, endMs: 1900, text: '王林😀走进大殿。' },
      { id: 's2', startMs: 2500, endMs: 4300, text: '李明看向远方。' },
      { id: 's3', startMs: 4800, endMs: 6500, text: '故事仍在继续。' },
    ],
  })
  store.saveProgress({
    sessionId: '',
    episodeId: episode.id,
    positionMs: 0,
    durationMs: 16000,
    rate: 1,
    volume: 0,
  })
  store.close()
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [appRoot], env })
  return {
    app,
    root,
    gates,
    target,
    gate: (name: string) => writeFileSync(join(gates, name), ''),
    remove: (name: string) => unlinkSync(join(gates, name)),
  }
}
async function open(page: Page) {
  await page.getByRole('button', { name: '继续播放', exact: true }).click()
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  await openCompanionTools(page)
  await page.getByRole('button', { name: '字幕编辑与撤销', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '字幕编辑', exact: true })
  await dialog.getByRole('spinbutton', { name: '连续编辑句数', exact: true }).fill('2')
  await dialog.getByRole('button', { name: '按声音重对齐', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '生成字幕时间建议', exact: true })).toBeEnabled()
  return dialog
}
async function formal(page: Page, target: TranscriptRequest) {
  const result = await page.evaluate((target) => window.desktop.getTranscript(target), target)
  if (!result.ok || result.value.status !== 'ready')
    throw new Error('Expected real formal transcript')
  return result.value.transcript
}
async function alignment(page: Page, target: TranscriptRequest) {
  const result = await page.evaluate(
    (target) => window.desktop.getTranscriptAlignment(target),
    target,
  )
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
function requestCount(gates: string) {
  const path = join(gates, 'requests.jsonl')
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').length : 0
}
function evidence(path: string) {
  writeFileSync(
    path,
    JSON.stringify(
      {
        sourcePreview: resolve(process.env.RALB_APP_ROOT ?? '.'),
        copiedApp: appRoot,
        originalAlignmentSha256: createHash('sha256')
          .update(readFileSync('python/asr_original_alignment.py'))
          .digest('hex'),
        fixtureAlignmentSha256: createHash('sha256').update(worker).digest('hex'),
        fixtureProbeSha256: createHash('sha256').update(probe).digest('hex'),
        mainSha256: createHash('sha256')
          .update(readFileSync(join(appRoot, 'out/main/index.js')))
          .digest('hex'),
        scope:
          'Only Python prerequisite/protocol fixtures are substituted in a disposable copy. No production catalog, JS bundle, model quality or human reference is modified or asserted.',
      },
      null,
      2,
    ),
  )
}
test('subtitle acoustic suggestions stay separate until adoption, preserve gaps, undo exact manual times and stop audition on close at 720px', async ({}, info) => {
  const data = await fixture(),
    { app } = data
  try {
    evidence(info.outputPath('fixture-scope.json'))
    const page = await app.firstWindow(),
      dialog = await open(page),
      before = await formal(page, data.target)
    await dialog.getByRole('button', { name: '生成字幕时间建议', exact: true }).click()
    await expect.poll(() => requestCount(data.gates)).toBe(1)
    expect((await formal(page, data.target)).document).toEqual(before.document)
    const request = JSON.parse(readFileSync(join(data.gates, 'requests.jsonl'), 'utf8').trim()) as {
      text: string
      device: string
    }
    expect(request).toMatchObject({ text: '王林😀走进大殿。\n李明看向远方。', device: 'cpu' })
    data.gate('ready')
    const proposal = dialog.getByRole('region', { name: '字幕时间建议', exact: true })
    await expect(proposal).toContainText('建议已生成，尚未修改正式字幕。')
    expect((await formal(page, data.target)).revision).toBe(before.revision)
    await expect(proposal).toContainText('0.500 秒–1.400 秒')
    await expect(proposal).toContainText('2.900 秒–3.800 秒')
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setBounds({ width: 720, height: 600 }),
    )
    await proposal
      .getByRole('button', { name: '采用字幕时间建议', exact: true })
      .scrollIntoViewIfNeeded()
    await expect(
      proposal.getByRole('button', { name: '采用字幕时间建议', exact: true }),
    ).toBeInViewport()
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    await page.screenshot({
      path: info.outputPath('subtitle-alignment-720.png'),
      animations: 'disabled',
    })
    await proposal.getByRole('button', { name: '采用字幕时间建议', exact: true }).click()
    await expect
      .poll(async () =>
        (await formal(page, data.target)).document.segments
          .slice(0, 2)
          .map(({ startMs, endMs }) => [startMs, endMs]),
      )
      .toEqual([
        [500, 1400],
        [2900, 3800],
      ])
    await dialog.getByRole('button', { name: '撤销字幕修改', exact: true }).click()
    await expect
      .poll(async () => (await formal(page, data.target)).document)
      .toEqual(before.document)
    await dialog.getByRole('button', { name: '试听当前字幕范围', exact: true }).click()
    const audio = page.locator('audio[data-player="persistent"]')
    await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => node.paused)).toBe(false)
    await dialog.getByRole('button', { name: '关闭字幕编辑', exact: true }).click()
    await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => node.paused)).toBe(true)
    expect(await page.locator('audio').count()).toBe(1)
  } finally {
    await app.close()
  }
})
test('rejected subtitle alignment cannot be adopted and closing a running owned suggestion cancels its real child without pausing ordinary playback', async ({}, info) => {
  const data = await fixture(),
    { app } = data
  try {
    evidence(info.outputPath('fixture-scope.json'))
    const page = await app.firstWindow(),
      dialog = await open(page),
      before = await formal(page, data.target)
    data.gate('reject')
    data.gate('ready')
    await dialog.getByRole('button', { name: '生成字幕时间建议', exact: true }).click()
    await expect(dialog).toContainText('声音证据未通过，当前时间保留。')
    await expect(dialog.getByRole('button', { name: '采用字幕时间建议', exact: true })).toHaveCount(
      0,
    )
    expect((await formal(page, data.target)).document).toEqual(before.document)
    data.remove('ready')
    data.remove('reject')
    await dialog.getByRole('button', { name: '关闭字幕编辑', exact: true }).click()
    await page.getByRole('button', { name: '播放', exact: true }).click()
    const audio = page.locator('audio[data-player="persistent"]')
    await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => node.paused)).toBe(false)
    await openCompanionTools(page)
    await page.getByRole('button', { name: '字幕编辑与撤销', exact: true }).click()
    await dialog.getByRole('button', { name: '按声音重对齐', exact: true }).click()
    await dialog.getByRole('button', { name: '生成字幕时间建议', exact: true }).click()
    await expect.poll(() => requestCount(data.gates)).toBe(2)
    await expect.poll(async () => (await alignment(page, data.target)).job?.status).toBe('running')
    await dialog.getByRole('button', { name: '关闭字幕编辑', exact: true }).click()
    await expect.poll(async () => (await alignment(page, data.target)).job?.status).toBe('canceled')
    expect((await formal(page, data.target)).document).toEqual(before.document)
    await expect.poll(() => audio.evaluate((node: HTMLAudioElement) => node.paused)).toBe(false)
  } finally {
    await app.close()
  }
})
