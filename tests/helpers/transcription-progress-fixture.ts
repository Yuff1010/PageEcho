import { expect, _electron as electron } from '@playwright/test'
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
import { createDataPaths } from '../../src/main/paths'
import { scanBook } from '../../src/main/files'
import { parseOriginal } from '../../src/main/original/parse'
import { closeOwnedElectron } from '../model/electron-lifecycle'

// Uses the actual Electron renderer/preload/IPC, SQLite queue, component probe,
// and worker protocol. Only prerequisites/model output are controlled stdlib
// processes, each gated independently. No actual ASR model or network is used.
let python: string | undefined
try {
  python = execFileSync('python', ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
} catch {
  /* The gated process fixtures require Python stdlib, never ML dependencies. */
}
export const transcriptionProgressFixtureAvailable = !!python && !process.env.RALB_EXECUTABLE
export const transcriptionProgressFixtureRequirement =
  'Requires stdlib Python and a disposable source/preview copy; packaged runtimes are not modified.'

const probe = String.raw`
import argparse
import json
from pathlib import Path
import platform
import time

parser = argparse.ArgumentParser()
parser.add_argument('--models')
args, _ = parser.parse_known_args()
gates = Path(json.loads(Path(args.models).read_text(encoding='utf8'))['gates'])
(gates / 'probe-started').write_text('started', encoding='utf8')
while not (gates / 'probe-release').exists():
    time.sleep(0.02)
print(json.dumps({
    'level': 'imports-and-files', 'pythonVersion': platform.python_version(),
    'cudaName': None, 'freeBytes': 1073741824,
    'issues': ['受控进度测试，未运行实际字幕模型。'],
    'capabilities': [
        {'engine': engine, 'device': device,
         'available': engine == 'paraformer' and device == 'cpu',
         'message': '受控 CPU 可用。' if engine == 'paraformer' and device == 'cpu' else '受控配置不可用。'}
        for engine in ['whisperx', 'paraformer'] for device in ['cpu', 'cuda']
    ],
}, ensure_ascii=False), flush=True)
`

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
    with (gates / 'submissions.jsonl').open('a', encoding='utf8') as history:
        history.write(json.dumps(request) + '\n')
    def wait(name):
        while not (gates / name).exists():
            if key in cancelled:
                return False
            time.sleep(0.02)
        return key not in cancelled
    def snapshot(end, count):
        segments = [
            {'id': 's1', 'startMs': 0, 'endMs': 4000, 'text': '第一段已经生成的字幕。'},
            {'id': 's2', 'startMs': 5000, 'endMs': 9000, 'text': '第二段字幕也可以继续阅读。'},
            {'id': 's3', 'startMs': 20000, 'endMs': 24000, 'text': '最后一段字幕生成完成。'},
        ]
        return {
            'document': {'version': 1, 'audioHash': request['audioHash'], 'kind': 'transcript',
                         'coverage': [{'startMs': 0, 'endMs': end}], 'segments': segments[:count]},
            'processedUntilMs': end, 'cacheKey': 'b' * 64, 'cacheHits': 0,
            'totalChunks': 3, 'issues': [],
        }
    emit({'type': 'accepted', **identity})
    emit({'type': 'progress', **identity, 'stage': 'loading', 'processedUntilMs': 0})
    if not wait('recognize'):
        return
    emit({'type': 'progress', **identity, 'stage': 'recognizing', 'processedUntilMs': 0})
    if not wait('first'):
        return
    emit({'type': 'partial', **identity, **snapshot(5000, 1), 'completedChunks': 1})
    if not wait('second'):
        return
    emit({'type': 'partial', **identity, **snapshot(15000, 2), 'completedChunks': 2})
    if wait('finish'):
        emit({'type': 'result', **identity, **snapshot(90000, 3), 'durationMs': 90000})

def cancel(request):
    while not (gates / 'cancel-ack').exists():
        time.sleep(0.02)
    emit({'type': 'canceled', 'jobId': request['jobId'], 'attempt': request['attempt']})

emit({'type': 'ready', 'configuration': {'fixture': 'transcription-progress-ui'}})
for line in sys.stdin:
    request = json.loads(line)
    if request['type'] == 'submit':
        threading.Thread(target=run, args=(request,), daemon=True).start()
    elif request['type'] == 'cancel':
        cancelled.add((request['jobId'], request['attempt']))
        threading.Thread(target=cancel, args=(request,), daemon=True).start()
    elif request['type'] == 'prioritize':
        pass
`

export async function transcriptionProgressFixture(
  options: { releaseProbe?: boolean; holdCancelAck?: boolean; linkedOriginal?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), '听读 字幕进度 '))
  const gates = join(root, 'gates')
  mkdirSync(gates)
  const gate = (name: string) => writeFileSync(join(gates, name), '')
  if (options.releaseProbe) gate('probe-release')
  if (!options.holdCancelAck) gate('cancel-ack')
  const audio = join(root, '第1集-字幕进度.wav')
  const wav = Buffer.alloc(44 + 16000 * 90)
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
  writeFileSync(audio, wav)
  const store = new LibraryStore(createDataPaths(root).database)
  store.importBook(await scanBook(audio, 'file'))
  const book = store.listBooks()[0]!
  const episode = book.episodes[0]!
  if (options.linkedOriginal) {
    const ebook = store.reading.import(
      parseOriginal(
        Buffer.from(
          '第一章 山间来信\n' +
            Array.from(
              { length: 80 },
              (_, index) => `第${index}封信从山间寄来，清晨的风穿过树梢。`,
            ).join('\n'),
        ),
        '山间来信.txt',
      ),
    )
    store.reading.savePosition(ebook.id, 30)
    store.bookLinks.link({ bookId: book.id, readingBookId: ebook.id })
  }
  store.close() // No restored episode or book profile: playback is the first trigger.
  const appRoot = join(root, 'app')
  mkdirSync(appRoot)
  cpSync(resolve(process.env.RALB_APP_ROOT ?? '.', 'out'), join(appRoot, 'out'), {
    recursive: true,
  })
  symlinkSync(resolve('node_modules'), join(appRoot, 'node_modules'), 'junction')
  writeFileSync(
    join(appRoot, 'package.json'),
    JSON.stringify({
      name: 'transcription-progress-ui-fixture',
      type: 'module',
      main: './out/main/index.js',
    }),
  )
  const scripts = join(appRoot, 'python')
  mkdirSync(scripts)
  writeFileSync(join(scripts, 'asr_component_probe.py'), probe)
  writeFileSync(join(scripts, 'asr_worker.py'), worker)
  const component = join(root, 'component')
  mkdirSync(component)
  mkdirSync(join(component, 'cache'))
  writeFileSync(join(component, 'models.json'), JSON.stringify({ gates }))
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
  const env = { ...process.env, RALB_USER_DATA: root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  const app = await electron.launch({ args: [appRoot], env })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.focus())
    await expect(page.getByRole('button', { name: '继续播放', exact: true })).toBeEnabled()
    return {
      app,
      page,
      gate,
      gates,
      target: { episodeId: episode.id, audioHash: episode.contentHash },
      submissions: () =>
        existsSync(join(gates, 'submissions.jsonl'))
          ? readFileSync(join(gates, 'submissions.jsonl'), 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean).length
          : 0,
      close: async () => {
        gate('cancel-ack')
        await closeOwnedElectron(app)
      },
    }
  } catch (error) {
    gate('cancel-ack')
    await closeOwnedElectron(app)
    throw error
  }
}
