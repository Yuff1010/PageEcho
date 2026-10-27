import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { parseOriginal } from '../../src/main/original/parse'
import { createDataPaths } from '../../src/main/paths'
import { CHANNELS } from '../../src/shared/contracts'
import type { OriginalTarget } from '../../src/shared/original'
import {
  closeCompanionPanel,
  closeOriginalPanel,
  menuAction,
  openCompanionSettings,
  openOriginalTools,
  useOriginalText,
} from '../helpers/ui'

// Acoustic output and prerequisite checks are controlled in a disposable app
// copy. Real preload/IPC, child-process cancellation, SQLite adoption/restoration,
// original reading and the actual media clock execute unchanged. These tests
// prove application behavior, never model quality or human timing accuracy.
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
characters = []
offset = 0
group = 0
groups = [[], []]
for char in text:
    size = len(char.encode('utf-16-le')) // 2
    if char.isalnum():
        groups[min(group, 1)].append((char, offset, offset + size))
    elif char == '。':
        group += 1
    offset += size
for group, values in enumerate(groups):
    base = 2000 if group == 0 else 4000
    for index, (char, start, end) in enumerate(values):
        characters.append({'text': char, 'textStart': start, 'textEnd': end,
                           'startMs': base + index * 800 // len(values),
                           'endMs': base + (index + 1) * 800 // len(values), 'score': 0.95})
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
          'reasons': [{'code': 'TEXT_AUDIO_MISMATCH', 'message': '测试声音与确认原文不一致。'}] if rejected else [],
          'elapsedMs': 10}
if not rejected:
    result.update({'startMs': 2000, 'endMs': 4800, 'confidence': 0.9})
print(json.dumps(result, ensure_ascii=False), flush=True)
`

let python: string | undefined, appRoot: string
try {
  python = execFileSync('python', ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
} catch {
  /* The isolated protocol fixture needs only Python stdlib. */
}
test.skip(
  !python || !!process.env.RALB_EXECUTABLE,
  'Requires stdlib Python and a disposable preview copy.',
)
test.beforeAll(() => {
  if (!python || process.env.RALB_EXECUTABLE) return
  appRoot = mkdtempSync(join(tmpdir(), '听读 声学校准 应用 '))
  cpSync(resolve(process.env.RALB_APP_ROOT ?? '.', 'out'), join(appRoot, 'out'), {
    recursive: true,
  })
  writeFileSync(
    join(appRoot, 'package.json'),
    JSON.stringify({
      name: 'original-acoustic-fixture',
      type: 'module',
      main: './out/main/index.js',
    }),
  )
  symlinkSync(resolve('node_modules'), join(appRoot, 'node_modules'), 'junction')
  mkdirSync(join(appRoot, 'python'))
  writeFileSync(
    join(appRoot, 'python', 'asr_worker.py'),
    '# No ASR recognition is used by this fixture.\n',
  )
  writeFileSync(join(appRoot, 'python', 'asr_original_alignment.py'), worker)
  writeFileSync(
    join(appRoot, 'python', 'asr_component_probe.py'),
    `import json\nprint(json.dumps({"level":"imports-and-files", "pythonVersion":"fixture", "cudaName":None,
      "freeBytes":1000000000, "issues":[], "capabilities":[{"engine":engine,"device":device,
      "available":True,"message":"controlled fixture prerequisites"} for engine in ["whisperx","paraformer"]
      for device in ["cpu","cuda"]]}))\n`,
  )
})

function audio(path: string) {
  const bytes = 8000 * 10 * 2,
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
  writeFileSync(path, wav)
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), '听读 声学校准 数据 ')),
    folder = join(root, '有声书'),
    gates = join(root, 'gates'),
    cache = join(root, 'component-cache'),
    models = join(root, 'models.json')
  for (const directory of [folder, gates, cache]) mkdirSync(directory)
  for (const name of ['第1集.wav', '第2集.wav']) audio(join(folder, name))
  writeFileSync(models, JSON.stringify({ gates }))
  writeFileSync(
    join(root, 'asr-component.json'),
    JSON.stringify({ version: 1, python, models, cache, ffmpeg: python, ffprobe: python }),
  )
  const store = new LibraryStore(createDataPaths(root).database)
  store.importBook(await scanBook(folder, 'folder'))
  const episodes = store.listBooks()[0]!.episodes,
    parsed = parseOriginal(Buffer.from('春风吹过山谷。\n小船驶向远方。'), '原文.txt')
  const targets: OriginalTarget[] = []
  for (const episode of episodes) {
    const target = { episodeId: episode.id, audioHash: episode.contentHash }
    targets.push(target)
    store.recordSourceDuration(episode.id, episode.contentHash, 10000)
    const transcript = store.saveTranscript(episode.id, {
      version: 1,
      kind: 'manual',
      audioHash: episode.contentHash,
      coverage: [{ startMs: 0, endMs: 10000 }],
      segments: [{ id: 's1', startMs: 1000, endMs: 6000, text: '春风吹过山谷。小船驶向远方。' }],
    })
    if (transcript.status !== 'ready') throw new Error('Seeded transcript unavailable')
    const original = store.originals.import(target, parsed)
    store.originals.saveAlignment(
      target,
      original.info!.id,
      transcript.transcript.id,
      transcript.transcript.revision,
      0,
      [
        {
          segmentId: 's1',
          startMs: 1000,
          endMs: 6000,
          asrText: '春风吹过山谷。小船驶向远方。',
          reviewed: false,
          candidates: [],
          selected: { first: 0, last: 1, method: 'auto' },
        },
      ],
    )
    store.originals.correct({
      ...target,
      originalId: original.info!.id,
      revision: 1,
      segmentId: 's1',
      selection: { first: 0, last: 1 },
      startMs: 1000,
      endMs: 6000,
    })
  }
  store.saveProgress({
    sessionId: '',
    episodeId: episodes[0]!.id,
    positionMs: 0,
    durationMs: 10000,
    rate: 1,
    volume: 0,
  })
  store.close()
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [appRoot], env })
  return {
    app,
    targets,
    episodes,
    gate: (name: string) => writeFileSync(join(gates, name), ''),
    remove: (name: string) => unlinkSync(join(gates, name)),
  }
}
async function getOriginal(page: Page, target: OriginalTarget) {
  const result = await page.evaluate((input) => window.desktop.getOriginalState(input), target)
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
async function getAcoustic(page: Page, target: OriginalTarget) {
  const result = await page.evaluate(
    (input) => window.desktop.getOriginalAcousticState(input),
    target,
  )
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
async function openAcoustic(app: ElectronApplication) {
  const page = await app.firstWindow()
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  await useOriginalText(page)
  await openOriginalTools(page)
  await page.locator('.original-review > summary').click()
  const article = page.locator('.original-review > article').first(),
    acoustic = article.locator('.original-acoustic-alignment')
  await acoustic.locator(':scope > summary').click()
  await expect(
    acoustic.getByRole('button', { name: '生成声音对齐建议', exact: true }),
  ).toBeEnabled()
  return { page, article, acoustic }
}

test('acoustic suggestions preserve manual drafts and timings until adoption, synchronize individual sentences with gaps, and restore the manual range', async ({}, info) => {
  const fixtureCase = await fixture(),
    { app, targets } = fixtureCase
  try {
    const { page, article, acoustic } = await openAcoustic(app),
      before = await getOriginal(page, targets[0]!)
    await article.getByRole('button', { name: '校正原文与同步点', exact: true }).click()
    await article.getByLabel('查找原文', { exact: true }).fill('尚未提交的人工草稿')
    await acoustic.getByRole('button', { name: '生成声音对齐建议', exact: true }).click()
    await expect(acoustic.getByRole('button', { name: '取消声音对齐', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    fixtureCase.gate('ready')
    await expect(acoustic).toContainText('声音对齐建议待试听，尚未更改同步点。')
    await expect(acoustic.getByRole('table')).toContainText('2.000 秒')
    await expect(acoustic.getByRole('table')).toContainText('4.800 秒')
    await expect(acoustic.getByRole('table')).toContainText('+1.000 秒')
    await expect(acoustic.getByRole('table')).toContainText('-1.200 秒')
    expect((await getOriginal(page, targets[0]!)).alignment).toEqual(before.alignment)
    await acoustic.getByRole('button', { name: '试听原文第 2 句的新边界', exact: true }).click()
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
      .toBeGreaterThanOrEqual(4)
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused))
      .toBe(true)
    expect((await getOriginal(page, targets[0]!)).alignment).toEqual(before.alignment)
    await acoustic.getByRole('button', { name: '拒绝此建议', exact: true }).click()
    await expect(acoustic.locator('.original-acoustic-result')).toHaveCount(0)
    expect((await getOriginal(page, targets[0]!)).alignment).toEqual(before.alignment)
    await acoustic.getByRole('button', { name: '生成声音对齐建议', exact: true }).click()
    await expect(acoustic.getByRole('button', { name: '采用新同步点', exact: true })).toBeEnabled()
    await acoustic
      .getByRole('button', { name: '采用新同步点', exact: true })
      .scrollIntoViewIfNeeded()
    await page.screenshot({
      path: info.outputPath('original-acoustic-proposal.png'),
      animations: 'disabled',
    })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 600))
    await acoustic
      .getByRole('button', { name: '采用新同步点', exact: true })
      .evaluate((element) => element.scrollIntoView({ block: 'center' }))
    await expect(
      acoustic.getByRole('button', { name: '采用新同步点', exact: true }),
    ).toBeInViewport({ ratio: 1 })
    await page.screenshot({
      path: info.outputPath('original-acoustic-enabled-small.png'),
      animations: 'disabled',
    })
    await closeOriginalPanel(page)
    await openCompanionSettings(page)
    await page
      .getByRole('dialog', { name: '伴读阅读设置', exact: true })
      .getByRole('tab', { name: '外观', exact: true })
      .click()
    await page.getByRole('button', { name: '主题：夜间', exact: true }).click()
    await closeCompanionPanel(page)
    await openOriginalTools(page)
    await acoustic
      .getByRole('button', { name: '采用新同步点', exact: true })
      .scrollIntoViewIfNeeded()
    await page.screenshot({
      path: info.outputPath('original-acoustic-enabled-night-small.png'),
      animations: 'disabled',
    })
    await closeOriginalPanel(page)
    await openCompanionSettings(page)
    await page
      .getByRole('dialog', { name: '伴读阅读设置', exact: true })
      .getByRole('tab', { name: '外观', exact: true })
      .click()
    await page.getByRole('button', { name: '主题：纸白', exact: true }).click()
    await closeCompanionPanel(page)
    await openOriginalTools(page)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1160, 800))
    await acoustic.getByRole('button', { name: '采用新同步点', exact: true }).click()
    await expect(
      acoustic.getByRole('button', { name: '恢复此前人工同步点', exact: true }),
    ).toBeVisible()
    await expect(article.getByLabel('查找原文', { exact: true })).toHaveValue('尚未提交的人工草稿')
    const applied = (await getOriginal(page, targets[0]!)).alignment!.matches[0]!
    expect({ startMs: applied.startMs, endMs: applied.endMs }).toEqual({
      startMs: 2000,
      endMs: 4800,
    })
    expect(applied.acoustic?.manualRange).toEqual({ startMs: 1000, endMs: 6000 })
    await closeOriginalPanel(page)
    const current = page.locator('.original-sentence[aria-current="true"]'),
      seek = page.getByRole('slider', { name: '播放进度', exact: true })
    await seek.fill('2200')
    await expect(current).toHaveCount(1)
    await expect(current).toHaveAttribute('data-ordinal', '0')
    await seek.fill('3300')
    await expect(current).toHaveCount(0)
    await seek.fill('4200')
    await expect(current).toHaveCount(1)
    await expect(current).toHaveAttribute('data-ordinal', '1')
    await page.locator('.original-sentence[data-ordinal="0"]').click()
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
      .toBeCloseTo(2, 1)
    await page.locator('.original-sentence[data-ordinal="1"]').click()
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
      .toBeCloseTo(4, 1)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 600))
    await openOriginalTools(page)
    await acoustic
      .getByRole('button', { name: '恢复此前人工同步点', exact: true })
      .evaluate((element) => element.scrollIntoView({ block: 'center' }))
    await expect(
      acoustic.getByRole('button', { name: '恢复此前人工同步点', exact: true }),
    ).toBeInViewport({ ratio: 1 })
    await page.screenshot({
      path: info.outputPath('original-acoustic-sentences-small.png'),
      animations: 'disabled',
    })
    await acoustic.getByRole('button', { name: '恢复此前人工同步点', exact: true }).click()
    await expect(
      acoustic.getByRole('button', { name: '恢复此前人工同步点', exact: true }),
    ).toHaveCount(0)
    const restored = (await getOriginal(page, targets[0]!)).alignment!.matches[0]!
    expect({ startMs: restored.startMs, endMs: restored.endMs }).toEqual({
      startMs: 1000,
      endMs: 6000,
    })
    expect(restored.acoustic).toBeUndefined()
    await expect(article.getByLabel('查找原文', { exact: true })).toHaveValue('尚未提交的人工草稿')
    await expect(page.getByRole('button', { name: '播放', exact: true })).toBeInViewport({
      ratio: 1,
    })
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await page.getByRole('button', { name: '暂停', exact: true }).click()
  } finally {
    await app.close()
  }
})

test('a rejected result cannot be adopted, and canceling a live acoustic process preserves manual timing and ordinary playback', async () => {
  const fixtureCase = await fixture(),
    { app, targets } = fixtureCase
  try {
    const { page, acoustic } = await openAcoustic(app),
      before = (await getOriginal(page, targets[0]!)).alignment
    fixtureCase.gate('reject')
    fixtureCase.gate('ready')
    await acoustic.getByRole('button', { name: '生成声音对齐建议', exact: true }).click()
    await expect(acoustic).toContainText('声音对齐被拒绝，保留当前人工同步点。')
    await expect(acoustic).toContainText('测试声音与确认原文不一致。')
    await expect(acoustic.getByRole('button', { name: '采用新同步点', exact: true })).toHaveCount(0)
    expect((await getOriginal(page, targets[0]!)).alignment).toEqual(before)
    fixtureCase.remove('ready')
    fixtureCase.remove('reject')
    await acoustic.getByRole('button', { name: '生成声音对齐建议', exact: true }).click()
    await expect(acoustic.getByRole('button', { name: '取消声音对齐', exact: true })).toBeVisible()
    await acoustic.getByRole('button', { name: '取消声音对齐', exact: true }).click()
    await expect(acoustic).toContainText('声音对齐已取消，保留当前人工同步点。')
    fixtureCase.gate('ready')
    await expect
      .poll(async () => (await getAcoustic(page, targets[0]!)).job?.status)
      .toBe('canceled')
    expect((await getOriginal(page, targets[0]!)).alignment).toEqual(before)
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '暂停', exact: true }).click()
  } finally {
    await app.close()
  }
})

test('a delayed start response is canceled after switching episodes and cannot replace the next episode manual draft', async () => {
  const fixtureCase = await fixture(),
    { app, targets, episodes } = fixtureCase
  try {
    const { page, acoustic } = await openAcoustic(app),
      before = (await getOriginal(page, targets[0]!)).alignment
    // Delay only the real start handler's response, after it has created its job.
    // This explicitly synthetic IPC schedule exercises the late-response guard;
    // the child process, cancellation, task events and saved data stay real.
    await app.evaluate(({ ipcMain }, channel) => {
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
          string,
          (...args: unknown[]) => unknown
        >,
        original = handlers.get(channel)!
      if (!original) throw new Error('Acoustic start handler unavailable')
      handlers.set(channel, async (...args) => {
        const result = await original(...args)
        await new Promise((resolve) => setTimeout(resolve, 700))
        return result
      })
    }, CHANNELS.originalAcousticStart)
    await acoustic.getByRole('button', { name: '生成声音对齐建议', exact: true }).click()
    await closeOriginalPanel(page)
    await menuAction(page, '播放选项', '下一集')
    await expect(page.locator('.player-heading h2')).toHaveText(episodes[1]!.title)
    await useOriginalText(page)
    await openOriginalTools(page)
    await page.locator('.original-review > summary').click()
    const nextArticle = page.locator('.original-review > article').first()
    await nextArticle.getByRole('button', { name: '校正原文与同步点', exact: true }).click()
    await nextArticle.getByLabel('查找原文', { exact: true }).fill('下一集未提交草稿')
    await expect
      .poll(async () => (await getAcoustic(page, targets[0]!)).job?.status)
      .toBe('canceled')
    fixtureCase.gate('ready')
    expect((await getOriginal(page, targets[0]!)).alignment).toEqual(before)
    await expect(nextArticle.getByLabel('查找原文', { exact: true })).toHaveValue(
      '下一集未提交草稿',
    )
    await expect(nextArticle.locator('.original-acoustic-result')).toHaveCount(0)
    expect((await getOriginal(page, targets[1]!)).alignment?.matches[0]?.startMs).toBe(1000)
  } finally {
    await app.close()
  }
})
