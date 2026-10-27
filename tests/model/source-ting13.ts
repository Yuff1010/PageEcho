// Opt-in actual-site adapter check; regular CI never contacts the source.
import { _electron as electron } from '@playwright/test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import type { Ting13Adapter } from '../../src/main/sources/ting13'
import type { Ting13Session } from '../../src/main/sources/ting13-session'
import { closeOwnedElectron } from './electron-lifecycle'

const directory = resolve(
  'cache/asr-evaluation/online-source-runs',
  new Date().toISOString().replaceAll(':', '-'),
)
const appRoot = join(directory, 'app')
await mkdir(appRoot, { recursive: true })
const modules = [
  'src/shared/sources.ts',
  ...['ting13', 'ting13-dom', 'ting13-session', 'ting13-policy'].map(
    (name) => `src/main/sources/${name}.ts`,
  ),
]
const sourceHashes: Record<string, string> = {}
for (const name of modules) {
  const text = await readFile(name, 'utf8')
  sourceHashes[name] = createHash('sha256').update(text).digest('hex')
  const target = join(appRoot, name.replace(/\.ts$/, '.js'))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(
    target,
    ts.transpileModule(text, {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
    }).outputText,
  )
}
await writeFile(
  join(appRoot, 'package.json'),
  JSON.stringify({
    name: 'readlisten-source-adapter-check',
    version: '0.8.4',
    type: 'commonjs',
    main: 'main.cjs',
  }),
)
const userData = await mkdtemp(join(tmpdir(), '听读书源独立检查 '))
await writeFile(
  join(appRoot, 'main.cjs'),
  `
const { app, BrowserWindow, session } = require('electron');
app.setPath('userData', ${JSON.stringify(userData)});
app.on('window-all-closed', () => {});
globalThis.sourceSecurity = [];
globalThis.sourceSecurityPending = [];
app.on('browser-window-created', (_event, window) => {
  window.webContents.on('did-finish-load', () => {
    if (!window.webContents.getURL().startsWith('https://www.ting13.cc/')) return;
    const preferences = window.webContents.getLastWebPreferences();
    const check = { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration, preload: Boolean(preferences.preload),
      defaultSession: window.webContents.session === session.defaultSession };
    globalThis.sourceSecurityPending.push(window.webContents.executeJavaScript('({ desktop: typeof window.desktop, require: typeof require, process: typeof process })')
      .then(exposed => globalThis.sourceSecurity.push({...check, exposed})).catch(() => {}));
  });
});
app.whenReady().then(async () => {
  const { Ting13Session } = require('./src/main/sources/ting13-session.js');
  const { Ting13Adapter } = require('./src/main/sources/ting13.js');
  globalThis.sourceSession = new Ting13Session();
  globalThis.sourceAdapter = new Ting13Adapter(globalThis.sourceSession);
  globalThis.makeSourceSession = (suffix, timeout) => new Ting13Session('persist:readlisten-source-ting13-' + suffix, timeout);
  const window = new BrowserWindow({show:false, webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await window.loadURL('about:blank');
});
`,
)
const env: Record<string, string> = {}
for (const [key, value] of Object.entries(process.env))
  if (value !== undefined && key.toLowerCase() !== 'electron_run_as_node') env[key] = value
const report: Record<string, unknown> = {
  status: 'running',
  source: 'ting13',
  directory,
  userData,
  sourceHashes,
  scope:
    'Actual anonymous isolated source session and adapter, not a complete bookshelf/stream/cache/ASR acceptance.',
}
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
await save()
console.log(JSON.stringify({ stage: 'starting', report: join(directory, 'report.json') }))
const app = await electron.launch({ args: [appRoot], env })
try {
  await app.firstWindow()
  const search = await app.evaluate(
    async () =>
      await (Reflect.get(globalThis, 'sourceAdapter') as Ting13Adapter).search('众仙俯首'),
  )
  assert.ok(search.items.some((book) => book.id === '39941'))
  report.search = search
  console.log(JSON.stringify({ stage: 'search-complete' }))
  await save()
  report.book = await app.evaluate(
    async () => await (Reflect.get(globalThis, 'sourceAdapter') as Ting13Adapter).getBook('39941'),
  )
  const first = await app.evaluate(
    async () =>
      await (Reflect.get(globalThis, 'sourceAdapter') as Ting13Adapter).getEpisodes('39941'),
  )
  assert.equal(first.items.length, 60)
  assert.equal(first.items[0]?.order, 1)
  assert.equal(first.items.at(-1)?.order, 60)
  assert.ok(first.nextCursor)
  const second = await app.evaluate(
    async (_, cursor) =>
      await (Reflect.get(globalThis, 'sourceAdapter') as Ting13Adapter).getEpisodes(
        '39941',
        cursor,
      ),
    first.nextCursor,
  )
  assert.equal(second.items[0]?.order, 61)
  assert.equal(second.items.at(-1)?.order, 120)
  report.directoryPages = [first, second]
  console.log(
    JSON.stringify({
      stage: 'directory-pages-complete',
      counts: [first.items.length, second.items.length],
    }),
  )
  await save()
  const resolved = await app.evaluate(
    async (_, id) =>
      await (Reflect.get(globalThis, 'sourceAdapter') as Ting13Adapter).resolveAudio('39941', id),
    first.items[0]!.id,
  )
  const response = await fetch(resolved.url, {
    method: 'HEAD',
    headers: resolved.headers,
    signal: AbortSignal.timeout(20000),
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^audio\//)
  report.media = {
    episodeId: resolved.episodeId,
    pageUrl: resolved.pageUrl,
    host: new URL(resolved.url).hostname,
    urlSha256: createHash('sha256').update(resolved.url).digest('hex'),
    headStatus: response.status,
    contentType: response.headers.get('content-type'),
    length: response.headers.get('content-length'),
    acceptRanges: response.headers.get('accept-ranges'),
    expirationKnown: resolved.expiresAt !== null,
  }
  const size = Number(response.headers.get('content-length'))
  assert.ok(Number.isSafeInteger(size) && size > 4096)
  const ranges = []
  for (const start of [0, Math.floor(size / 2)]) {
    const bytes = await fetch(resolved.url, {
      headers: { ...resolved.headers, Range: `bytes=${start}-${start + 1023}` },
      signal: AbortSignal.timeout(20000),
    })
    try {
      assert.equal(bytes.status, 206)
      assert.equal(bytes.headers.get('content-range'), `bytes ${start}-${start + 1023}/${size}`)
      const reader = bytes.body!.getReader(),
        digest = createHash('sha256')
      let count = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          count += chunk.value.byteLength
          assert.ok(count <= 1024)
          digest.update(chunk.value)
        }
      } finally {
        await reader.cancel()
      }
      assert.equal(count, 1024)
      ranges.push({ start, status: bytes.status, count, sha256: digest.digest('hex') })
    } catch (error) {
      await bytes.body?.cancel().catch(() => undefined)
      throw error
    }
  }
  report.rangeChecks = ranges
  report.sessionChecks = await app.evaluate(async ({ BrowserWindow }) => {
    const make = Reflect.get(globalThis, 'makeSourceSession') as (
      suffix: string,
      timeout: number,
    ) => Ting13Session
    const before = BrowserWindow.getAllWindows().length
    const canceled = make('cancel', 10000),
      controller = new AbortController()
    const pending = canceled.read(
      { kind: 'page', url: 'https://www.ting13.cc/youshengxiaoshuo/39941/', expect: 'book' },
      controller.signal,
    )
    controller.abort()
    let cancelCode = ''
    try {
      await pending
    } catch (error) {
      cancelCode = (error as { code: string }).code
    }
    canceled.close()
    canceled.close()
    const timed = make('timeout', 1000),
      started = Date.now()
    let timeoutCode = ''
    try {
      await timed.read({
        kind: 'page',
        url: 'https://www.ting13.cc/youshengxiaoshuo/39941/',
        expect: 'media',
      })
    } catch (error) {
      timeoutCode = (error as { code: string }).code
    }
    const elapsedMs = Date.now() - started
    timed.close()
    timed.close()
    await Promise.all(Reflect.get(globalThis, 'sourceSecurityPending') as Promise<unknown>[])
    return {
      cancelCode,
      timeoutCode,
      elapsedMs,
      before,
      after: BrowserWindow.getAllWindows().length,
      security: Reflect.get(globalThis, 'sourceSecurity') as {
        sandbox: boolean
        contextIsolation: boolean
        nodeIntegration: boolean
        preload: boolean
        defaultSession: boolean
        exposed: { desktop: string; require: string; process: string }
      }[],
    }
  })
  const checks = report.sessionChecks as {
    cancelCode: string
    timeoutCode: string
    elapsedMs: number
    before: number
    after: number
    security: {
      sandbox: boolean
      contextIsolation: boolean
      nodeIntegration: boolean
      preload: boolean
      defaultSession: boolean
      exposed: { desktop: string; require: string; process: string }
    }[]
  }
  assert.equal(checks.cancelCode, 'SOURCE_CANCELED')
  assert.ok(['SOURCE_TIMEOUT', 'SOURCE_VERIFICATION_REQUIRED'].includes(checks.timeoutCode))
  assert.ok(checks.elapsedMs < 5000)
  assert.equal(checks.before, checks.after)
  assert.ok(checks.security.length >= 5)
  for (const check of checks.security) {
    assert.ok(
      check.sandbox &&
        check.contextIsolation &&
        !check.nodeIntegration &&
        !check.preload &&
        !check.defaultSession,
    )
    assert.deepEqual(check.exposed, {
      desktop: 'undefined',
      require: 'undefined',
      process: 'undefined',
    })
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.stack : String(error)
  process.exitCode = 1
} finally {
  report.blockedResources = await app
    .evaluate(() => {
      const source = Reflect.get(globalThis, 'sourceSession') as Ting13Session
      const result = source.diagnostics()
      source.close()
      return result
    })
    .catch((error) => [{ error: String(error) }])
  const cleanup = await closeOwnedElectron(app)
  report.cleanup = cleanup
  if (cleanup.kind !== 'graceful') {
    report.status = 'failed'
    report.error = 'Source test application did not close gracefully'
    process.exitCode = 1
  }
  report.finishedAt = new Date().toISOString()
  await save()
}
console.log(
  JSON.stringify({
    status: report.status,
    report: join(directory, 'report.json'),
    error: report.error,
  }),
)
