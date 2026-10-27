import { test, expect, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import { parseOriginal } from '../../src/main/original/parse'
import { CHANNELS } from '../../src/shared/contracts'
import { closeOwnedElectron } from '../model/electron-lifecycle'

let python: string | undefined
try {
  python = execFileSync('python', ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
} catch {
  /* Capability/queue workflow tests use stdlib Python, never actual ASR models. */
}

const probe = String.raw`
import argparse
import json
from pathlib import Path
import platform
import time

parser = argparse.ArgumentParser()
parser.add_argument('--models')
args, _ = parser.parse_known_args()
configuration = json.loads(Path(args.models).read_text(encoding='utf8'))
gate = Path(configuration['gate'])
Path(str(gate) + '.started').write_text('started', encoding='utf8')
while not gate.exists():
    time.sleep(0.02)
print(json.dumps({
    'level': 'imports-and-files',
    'pythonVersion': platform.python_version(),
    'cudaName': None,
    'freeBytes': 1073741824,
    'issues': ['受控流程诊断，未加载实际字幕模型。'],
    'capabilities': [
        {'engine': engine, 'device': device,
         'available': engine == 'paraformer' and device == 'cpu',
         'message': '测试 CPU 可用。' if engine == 'paraformer' and device == 'cpu' else '测试配置不可用。'}
        for engine in ['whisperx', 'paraformer'] for device in ['cpu', 'cuda']
    ],
}, ensure_ascii=False), flush=True)
`

const worker = String.raw`
from pathlib import Path
import json
import sys

print(json.dumps({'protocolVersion': 1, 'type': 'ready', 'configuration': {'fixture': True}}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    if request.get('type') == 'submit':
        Path(__file__).with_name('submission.json').write_text(json.dumps(request), encoding='utf8')
        with Path(__file__).with_name('submissions.jsonl').open('a', encoding='utf8') as history:
            history.write(json.dumps(request) + '\n')
        print(json.dumps({'protocolVersion': 1, 'type': 'accepted', 'jobId': request['jobId'], 'attempt': request['attempt']}), flush=True)
        print(json.dumps({'protocolVersion': 1, 'type': 'progress', 'jobId': request['jobId'], 'attempt': request['attempt'], 'stage': 'recognizing', 'processedUntilMs': 0}), flush=True)
    elif request.get('type') == 'cancel':
        print(json.dumps({'protocolVersion': 1, 'type': 'canceled', 'jobId': request['jobId'], 'attempt': request['attempt']}), flush=True)
`

async function fixture(
  options: {
    automatic?: boolean
    unmapped?: boolean
    manual?: boolean
    unconfigured?: boolean
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), '听读 播放意图 '))
  const folder = join(root, '山间来信')
  mkdirSync(folder)
  const wav = Buffer.alloc(44 + 16000 * 60)
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
  writeFileSync(join(folder, '第1集.wav'), wav)
  const store = new LibraryStore(createDataPaths(root).database)
  store.importBook(await scanBook(folder, 'folder'))
  const book = store.listBooks()[0]!
  if (options.manual)
    store.setSubtitlePreparation(book.id, {
      mode: 'manual',
      engine: 'paraformer',
      device: 'cpu',
      prepareNext: false,
    })
  const episode = book.episodes[0]!
  const parsed = parseOriginal(
    Buffer.from(
      '第1章 山路\n' +
        Array.from({ length: 90 }, (_, i) => `第${i}封信从山间寄来，清晨的风穿过树梢。`).join('\n'),
    ),
    '山间来信.txt',
  )
  const ebook = store.reading.import(parsed)
  store.reading.savePosition(ebook.id, options.unmapped ? 89 : 1)
  store.bookLinks.link({ bookId: book.id, readingBookId: ebook.id })
  const text = parsed.sentences[1]!.text
  if (!options.automatic && !options.unconfigured)
    store.saveTranscript(episode.id, {
      version: 1,
      kind: 'manual',
      audioHash: episode.contentHash,
      coverage: [{ startMs: 0, endMs: 60000 }],
      segments: [{ id: 's0', startMs: 2000, endMs: 4000, text }],
    })
  const saved = store.getTranscript(episode.id, episode.contentHash)
  if (!options.automatic && !options.unconfigured) {
    if (saved.status !== 'ready') throw new Error('missing fixture transcript')
    store.originals.saveAlignment(
      { episodeId: episode.id, audioHash: episode.contentHash },
      ebook.id,
      saved.transcript.id,
      saved.transcript.revision,
      0,
      [
        {
          segmentId: 's0',
          startMs: 2000,
          endMs: 4000,
          asrText: text,
          candidates: [],
          selected: { first: 1, last: 1, method: 'auto' },
          reviewed: false,
        },
      ],
    )
  }
  store.saveProgress({
    sessionId: '',
    episodeId: episode.id,
    positionMs: 5000,
    durationMs: 60000,
    rate: 1,
    volume: 0,
  })
  store.close()
  let appRoot = resolve(process.env.RALB_APP_ROOT ?? '.')
  const gate = join(root, 'release-capability-check')
  let submission = ''
  if (options.automatic) {
    if (!python) throw new Error('workflow fixture requires stdlib Python')
    appRoot = join(root, 'app')
    mkdirSync(appRoot)
    cpSync(resolve(process.env.RALB_APP_ROOT ?? '.', 'out'), join(appRoot, 'out'), {
      recursive: true,
    })
    symlinkSync(resolve('node_modules'), join(appRoot, 'node_modules'), 'junction')
    writeFileSync(
      join(appRoot, 'package.json'),
      JSON.stringify({
        name: 'playback-intent-fixture',
        type: 'module',
        main: './out/main/index.js',
      }),
    )
    const scripts = join(appRoot, 'python')
    mkdirSync(scripts)
    writeFileSync(join(scripts, 'asr_component_probe.py'), probe)
    writeFileSync(join(scripts, 'asr_worker.py'), worker)
    submission = join(scripts, 'submission.json')
    const component = join(root, 'component')
    mkdirSync(component)
    mkdirSync(join(component, 'cache'))
    writeFileSync(join(component, 'models.json'), JSON.stringify({ gate }))
    writeFileSync(
      join(root, 'asr-component.json'),
      JSON.stringify({
        version: 1,
        python,
        models: join(component, 'models.json'),
        cache: join(component, 'cache'),
        ffmpeg: python,
        ffprobe: python,
      }),
    )
  }
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [appRoot], env })
  const page = await app.firstWindow()
  await expect(
    page
      .getByRole('region', { name: '播放器', exact: true })
      .getByRole('button', { name: '播放', exact: true }),
  ).toBeEnabled()
  return { root, app, page, book, ebook, episode, gate, submission }
}

test('subtitle setup stays inside the small player instead of covering reading controls', async ({}, info) => {
  const { app, page } = await fixture({ unconfigured: true })
  try {
    await page.locator('.bookshelf .card-play').first().click()
    const notice = page.locator('.player-subtitle-notice')
    await expect(notice).toContainText('尚未找到字幕组件')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 600))
    const player = page.getByRole('region', { name: '播放器', exact: true })
    await expect(notice.getByRole('button', { name: '配置字幕组件', exact: true })).toBeInViewport({
      ratio: 1,
    })
    const bounds = await notice.boundingBox()
    const parent = await player.boundingBox()
    expect(bounds).not.toBeNull()
    expect(parent).not.toBeNull()
    expect(bounds!.y).toBeGreaterThanOrEqual(parent!.y)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(parent!.y + parent!.height)
    await page.screenshot({
      path: info.outputPath('subtitle-status-small.png'),
      animations: 'disabled',
    })
  } finally {
    await closeOwnedElectron(app)
  }
})

test('closing to tray and showing the window keeps subtitle preparation available', async () => {
  const { app, page, episode } = await fixture()
  try {
    const opened = await page.evaluate((id) => window.desktop.openEpisode({ id }), episode.id)
    if (!opened.ok) throw new Error(opened.error.message)
    const hidden = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!
      window.close()
      return !window.isDestroyed() && !window.isVisible()
    })
    expect(hidden).toBe(true)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.show())
    const prepared = await page.evaluate(
      (request) => window.desktop.startAutomaticSubtitles(request),
      {
        episodeId: episode.id,
        audioHash: episode.contentHash,
        sessionId: opened.value.sessionId,
        positionMs: 5000,
      },
    )
    expect(prepared.ok && prepared.value.status).toBe('reused')
  } finally {
    await closeOwnedElectron(app)
  }
})

test('the current bookshelf play button pauses and resumes without reopening its media or losing its position', async () => {
  const { app, page } = await fixture()
  try {
    await app.evaluate(({ ipcMain }, channel) => {
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
        string,
        (...args: unknown[]) => unknown
      >
      const original = handlers.get(channel)!
      Reflect.set(globalThis, 'playbackIntentOpens', 0)
      handlers.set(channel, (...args) => {
        Reflect.set(
          globalThis,
          'playbackIntentOpens',
          Number(Reflect.get(globalThis, 'playbackIntentOpens')) + 1,
        )
        return original(...args)
      })
    }, CHANNELS.openEpisode)
    const before = await page.locator('audio').evaluate((audio: HTMLAudioElement) => {
      Reflect.set(audio, 'playbackIntentLoadStarts', 0)
      audio.addEventListener('loadstart', () => {
        Reflect.set(
          audio,
          'playbackIntentLoadStarts',
          Number(Reflect.get(audio, 'playbackIntentLoadStarts')) + 1,
        )
      })
      return { src: audio.currentSrc, position: audio.currentTime }
    })
    expect(before.position).toBeCloseTo(5, 1)
    const card = page.locator('.bookshelf .book-card').first()
    const action = card.locator('.card-play')
    await action.click()
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused))
      .toBe(false)
    await expect(action).toHaveAttribute('aria-label', /暂停/)
    await action.click()
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused))
      .toBe(true)
    const paused = await page
      .locator('audio')
      .evaluate((audio: HTMLAudioElement) => audio.currentTime)
    expect(paused).toBeGreaterThanOrEqual(before.position)
    expect(paused).toBeLessThan(before.position + 5)
    await action.click()
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused))
      .toBe(false)
    const after = await page.locator('audio').evaluate((audio: HTMLAudioElement) => ({
      src: audio.currentSrc,
      position: audio.currentTime,
      loadStarts: Number(Reflect.get(audio, 'playbackIntentLoadStarts')),
    }))
    expect(after.src).toBe(before.src)
    expect(after.position).toBeGreaterThanOrEqual(paused)
    expect(after.loadStarts).toBe(0)
    expect(await app.evaluate(() => Reflect.get(globalThis, 'playbackIntentOpens'))).toBe(0)
  } finally {
    await closeOwnedElectron(app)
  }
})

test('listen from this reading position starts the mapped recording even when its previous state was paused', async () => {
  const { app, page, ebook } = await fixture()
  try {
    expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(
      true,
    )
    await page.evaluate((id) => {
      location.hash = `/read/${id}`
    }, ebook.id)
    await expect(page.locator('.book-viewport')).toHaveAttribute('aria-busy', 'false')
    await expect(page.locator('.reader-progress-label')).toHaveAttribute('data-position', '1')
    await page.mouse.move(80, 15)
    await page.getByRole('button', { name: '从此处听书', exact: true }).click()
    await expect(page).toHaveURL(/#\/listening$/)
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused))
      .toBe(false)
    const position = await page
      .locator('audio')
      .evaluate((audio: HTMLAudioElement) => audio.currentTime)
    expect(position).toBeGreaterThanOrEqual(2)
    expect(position).toBeLessThan(4)
  } finally {
    await closeOwnedElectron(app)
  }
})

test('first playback starts audio before a delayed capability check and automatically prepares subtitles without another generation click', async () => {
  test.skip(
    !python || !!process.env.RALB_EXECUTABLE,
    'Requires stdlib Python and a copied preview; this fixture never loads real models.',
  )
  const { app, page, episode, book, gate, submission } = await fixture({ automatic: true })
  try {
    const target = { episodeId: episode.id, audioHash: episode.contentHash }
    const before = await page.evaluate(
      (target) => window.desktop.getTranscriptionState(target),
      target,
    )
    expect(before.ok && before.value.job).toBeNull()
    expect(existsSync(`${gate}.started`)).toBe(false)
    await page.locator('.bookshelf .card-play').first().click()
    await expect.poll(() => existsSync(`${gate}.started`)).toBe(true)
    // The real capability subprocess is still waiting. Audio must already be
    // playing; starting transcription must not take over the playback button.
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused))
      .toBe(false)
    expect(existsSync(submission)).toBe(false)
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime))
      .toBeGreaterThan(5)
    writeFileSync(gate, '')
    await expect.poll(() => existsSync(submission)).toBe(true)
    const request = JSON.parse(readFileSync(submission, 'utf8'))
    expect(request.audioHash).toBe(episode.contentHash)
    expect(request.priorityMs).toBeGreaterThanOrEqual(5000)
    const state = await page.evaluate(() => window.desktop.getState())
    expect(
      state.ok && state.value.books.find((item) => item.id === book.id)?.subtitlePreparation,
    ).toMatchObject({ mode: 'auto', engine: 'paraformer', device: 'cpu' })
    const generated = await page.evaluate(
      (target) => window.desktop.getTranscriptionState(target),
      target,
    )
    expect(generated.ok && generated.value.job?.status).toBe('running')
    expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(
      false,
    )
  } finally {
    writeFileSync(gate, '')
    await closeOwnedElectron(app)
  }
})

test('unmapped reading offers one preparation action that starts subtitle work while preserving the original audio position', async () => {
  test.skip(
    !python || !!process.env.RALB_EXECUTABLE,
    'Requires stdlib Python and a copied preview; this fixture never loads real models.',
  )
  const { app, page, ebook, episode, gate, submission } = await fixture({
    automatic: true,
    unmapped: true,
  })
  try {
    writeFileSync(gate, '')
    await page.evaluate((id) => {
      location.hash = `/read/${id}`
    }, ebook.id)
    await expect(page.locator('.book-viewport')).toHaveAttribute('aria-busy', 'false')
    await expect(page.locator('.reader-progress-label')).toHaveAttribute('data-position', '89')
    await page.mouse.move(80, 15)
    await page.getByRole('button', { name: '从此处听书', exact: true }).click()
    const choice = page.getByRole('dialog', { name: '选择对应的声音位置' })
    await expect(choice).toContainText('这段文字还没有声音同步点')
    await choice.getByRole('button', { name: '准备字幕并匹配', exact: true }).click()
    await expect(page).toHaveURL(/#\/listening$/)
    await expect.poll(() => existsSync(submission)).toBe(true)
    const request = JSON.parse(readFileSync(submission, 'utf8'))
    expect(request.audioHash).toBe(episode.contentHash)
    expect(request.priorityMs).toBeGreaterThanOrEqual(5000)
    expect(request.priorityMs).toBeLessThan(6000)
    expect(
      await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime),
    ).toBeCloseTo(5, 1)
    expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(
      true,
    )
    const state = await page.evaluate(() => window.desktop.getReadingBooks())
    expect(state.ok && state.value.find((item) => item.id === ebook.id)?.position).toBe(89)
  } finally {
    writeFileSync(gate, '')
    await closeOwnedElectron(app)
  }
})

test('manual subtitle mode stays idle on playback but its generation action starts preparation in one click', async () => {
  test.skip(
    !python || !!process.env.RALB_EXECUTABLE,
    'Requires stdlib Python and a copied preview; this fixture never loads real models.',
  )
  const { app, page, book, episode, gate, submission } = await fixture({
    automatic: true,
    manual: true,
  })
  try {
    await app.evaluate(({ ipcMain }, channel) => {
      const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
        string,
        (...args: unknown[]) => Promise<unknown>
      >
      const original = handlers.get(channel)!
      Reflect.set(globalThis, 'manualPlaybackAutomaticReplies', [])
      handlers.set(channel, async (...args) => {
        const result = await original(...args)
        const results = Reflect.get(globalThis, 'manualPlaybackAutomaticReplies') as unknown[]
        results.push(result)
        return result
      })
    }, CHANNELS.startAutomaticSubtitles)
    await page.locator('.bookshelf .card-play').first().click()
    await expect
      .poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused))
      .toBe(false)
    await expect
      .poll(() =>
        app.evaluate(() => {
          const replies = Reflect.get(globalThis, 'manualPlaybackAutomaticReplies') as {
            ok: boolean
            value?: { status?: string }
          }[]
          return replies.some((reply) => reply.ok && reply.value?.status === 'disabled')
        }),
      )
      .toBe(true)
    expect(existsSync(`${gate}.started`)).toBe(false)
    expect(existsSync(submission)).toBe(false)
    await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
    await page.getByRole('button', { name: '生成本集字幕', exact: true }).click()
    await expect.poll(() => existsSync(`${gate}.started`)).toBe(true)
    await expect(page.getByRole('button', { name: '保存并生成本集', exact: true })).toBeHidden()
    expect(existsSync(submission)).toBe(false)
    writeFileSync(gate, '')
    await expect.poll(() => existsSync(submission)).toBe(true)
    const requests = readFileSync(join(submission, '..', 'submissions.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(requests).toHaveLength(1)
    expect(requests[0].audioHash).toBe(episode.contentHash)
    const state = await page.evaluate(() => window.desktop.getState())
    expect(
      state.ok && state.value.books.find((item) => item.id === book.id)?.subtitlePreparation,
    ).toEqual({ mode: 'manual', engine: 'paraformer', device: 'cpu', prepareNext: false })
    expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(
      false,
    )
  } finally {
    writeFileSync(gate, '')
    await closeOwnedElectron(app)
  }
})
