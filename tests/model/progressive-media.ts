// Opt-in native Chromium prototype. A synthetic MP3 is served by one gated
// localhost GET; the final bytes are not sent until the early-play observation.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication } from '@playwright/test'
import ts from 'typescript'
import { closeOwnedElectron } from './electron-lifecycle'

assert.equal(
  process.argv.length,
  2,
  'Run this standalone prototype without app or user-data arguments.',
)
const parent = resolve('cache/progressive-media-prototype')
await mkdir(parent, { recursive: true })
const directory = await mkdtemp(join(parent, 'run-')),
  appRoot = join(directory, 'app')
await mkdir(appRoot)
const sources = [
  'src/main/media.ts',
  'src/main/sources/progressive-media.ts',
  ...(await readdir('src/shared'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `src/shared/${name}`),
]
const sourceHashes: Record<string, string> = {}
for (const name of sources) {
  const source = await readFile(name, 'utf8'),
    target = join(appRoot, name.replace(/\.ts$/, '.js'))
  sourceHashes[name] = createHash('sha256').update(source).digest('hex')
  await mkdir(dirname(target), { recursive: true })
  await writeFile(
    target,
    ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
    }).outputText,
  )
}
const fixture = resolve('tests/fixtures/tone.mp3'),
  fixtureBytes = await readFile(fixture)
assert(fixtureBytes.length > 32768)
await writeFile(
  join(appRoot, 'package.json'),
  JSON.stringify({
    name: 'pageecho-progressive-media-prototype',
    type: 'commonjs',
    main: 'main.cjs',
  }),
)
await writeFile(
  join(appRoot, 'main.cjs'),
  `
const { app, BrowserWindow, protocol } = require('electron');
const { createServer } = require('node:http');
const { mkdir, open, readFile, rename } = require('node:fs/promises');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))});
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
protocol.registerSchemesAsPrivileged([{scheme:'readlisten',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const { ProgressiveMedia } = require('./src/main/sources/progressive-media.js');
  const folder = ${JSON.stringify(join(directory, 'spool'))};
  await mkdir(folder);
  const temporary = join(folder, 'test.part');
  const writer = await open(temporary, 'wx');
  const bytes = await readFile(${JSON.stringify(fixture)});
  const registry = new ProgressiveMedia(folder, {waitTimeoutMs:10000});
  const spool = await registry.create(randomUUID(), temporary, bytes.length);
  const evidence = globalThis.prototypeEvidence = {totalBytes:bytes.length,prefixBytes:32768,serverFinishedAt:null,downloadCompleteAt:null,downloadRequests:0,receivedBytes:0,ranges:[]};
  Object.defineProperty(evidence, 'spoolState', {get: () => spool.state, enumerable:true});
  let releaseTail;
  const gate = new Promise(done => { releaseTail = done });
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' || request.url !== '/synthetic.mp3') { response.writeHead(404);response.end();return; }
    evidence.downloadRequests++;
    response.writeHead(200, {'Content-Type':'audio/mpeg','Content-Length':String(bytes.length)});
    response.write(bytes.subarray(0, evidence.prefixBytes));
    await gate;
    response.end(bytes.subarray(evidence.prefixBytes), () => { evidence.serverFinishedAt=Date.now() });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  globalThis.releasePrototypeTail = () => releaseTail();
  globalThis.startPrototypeDownload = () => {
    if (globalThis.prototypeDownload) throw Error('Only one full GET is allowed');
    globalThis.prototypeDownload = (async () => {
      try {
        const response = await fetch('http://127.0.0.1:'+server.address().port+'/synthetic.mp3', {signal:AbortSignal.timeout(15000)});
        for await (const chunk of response.body) {
          await writer.writeFile(chunk);
          evidence.receivedBytes += chunk.byteLength;
          spool.markWritten(evidence.receivedBytes);
        }
        await writer.sync();await writer.close();
        await rename(temporary, join(folder, 'complete.mp3'));
        await spool.complete();
        evidence.downloadCompleteAt=Date.now();
      } catch (error) {await spool.fail(error);throw error;}
    })();
    void globalThis.prototypeDownload.catch(error => { evidence.error=error.message });
  };
  globalThis.finishPrototype = async () => {
    releaseTail();
    await globalThis.prototypeDownload?.catch(() => {});
    await registry.close();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    await writer.close();
  };
  protocol.handle('readlisten', async request => {
    if (new URL(request.url).pathname === '/fixture') return new Response('<!doctype html><meta charset="UTF-8"><audio></audio>', {headers:{'Content-Type':'text/html'}});
    evidence.ranges.push({method:request.method,range:request.headers.get('range')});
    return registry.serve(request, 'readlisten://app');
  });
  globalThis.prototypeStreamUrl = spool.url;
  const window = new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  window.webContents.setAudioMuted(true);
  await window.loadURL('readlisten://app/fixture');
});
`,
)
const report: Record<string, unknown> = {
  status: 'running',
  directory,
  sourceHashes,
  fixtureSha256: createHash('sha256').update(fixtureBytes).digest('hex'),
  scope:
    'One project synthetic silent MP3, native Chromium decoder, hidden isolated app/data, one gated localhost GET and sequential spool. No actual-source, recognition-quality, clean-device or universal MP3 startup claim.',
}
let app: ElectronApplication | undefined
try {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  app = await electron.launch({ args: [appRoot], env, timeout: 15000 })
  app
    .process()
    .stderr?.on('data', (bytes: Buffer) =>
      appendFileSync(join(directory, 'electron.stderr.log'), bytes),
    )
  const page = await app.firstWindow()
  const url = await app.evaluate(() => Reflect.get(globalThis, 'prototypeStreamUrl') as string)
  assert(typeof url === 'string' && url.startsWith('readlisten://app/stream/'))
  await page.evaluate((url) => {
    const audio = document.querySelector('audio')!
    audio.preload = 'none'
    audio.src = url
    audio.addEventListener(
      'playing',
      () => Reflect.set(window, 'prototypeFirstPlayingAt', Date.now()),
      { once: true },
    )
    audio.addEventListener('error', () =>
      Reflect.set(window, 'prototypeMediaError', {
        code: audio.error?.code,
        message: audio.error?.message,
        readyState: audio.readyState,
        networkState: audio.networkState,
      }),
    )
  }, url)
  await app.evaluate(() => Reflect.get(globalThis, 'startPrototypeDownload')())
  await page.evaluate(() => {
    void document
      .querySelector('audio')!
      .play()
      .catch((error) => Reflect.set(window, 'prototypePlayError', String(error)))
  })
  let early = false
  try {
    await page.waitForFunction(
      () => {
        const audio = document.querySelector('audio')!
        return !audio.paused && audio.currentTime > 0.12
      },
      undefined,
      { timeout: 4000 },
    )
    early = true
  } catch {
    /* Release the gate and retain a failed observation if the decoder needs the tail. */
  }
  report.beforeTail = await app.evaluate(() => Reflect.get(globalThis, 'prototypeEvidence'))
  report.playerBeforeTail = await page.evaluate(() => ({
    positionMs: document.querySelector('audio')!.currentTime * 1000,
    playingAt: Reflect.get(window, 'prototypeFirstPlayingAt'),
    error: Reflect.get(window, 'prototypePlayError'),
    mediaError: Reflect.get(window, 'prototypeMediaError'),
    canPlayMp3: document.querySelector('audio')!.canPlayType('audio/mpeg'),
  }))
  report.rendererPrefix = await page.evaluate(async (url) => {
    const response = await fetch(url, { headers: { Range: 'bytes=0-63' } })
    return {
      status: response.status,
      bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
    }
  }, url)
  const prefix = report.rendererPrefix as { status: number; bytes: number[] }
  assert.equal(prefix.status, 206)
  assert.deepEqual(Buffer.from(prefix.bytes), fixtureBytes.subarray(0, 64))
  await app.evaluate(() => Reflect.get(globalThis, 'releasePrototypeTail')())
  await app.evaluate(async () => {
    await Reflect.get(globalThis, 'prototypeDownload')
  })
  report.afterTail = await app.evaluate(() => Reflect.get(globalThis, 'prototypeEvidence'))
  assert(
    early,
    'The synthetic MP3 required its tail; this prototype did not prove earlier playback.',
  )
  const before = report.beforeTail as {
    serverFinishedAt: number | null
    receivedBytes: number
    totalBytes: number
    downloadRequests: number
  }
  assert.equal(before.serverFinishedAt, null)
  assert(before.receivedBytes > 0 && before.receivedBytes < before.totalBytes)
  assert.equal(before.downloadRequests, 1)
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.stack : String(error)
  process.exitCode = 1
} finally {
  if (app) {
    await app
      .evaluate(async () => {
        await Reflect.get(globalThis, 'finishPrototype')?.()
      })
      .catch(() => {})
    report.cleanup = await closeOwnedElectron(app)
  }
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify({ status: report.status, directory, error: report.error }))
