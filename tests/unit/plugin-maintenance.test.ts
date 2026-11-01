import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { PluginMaintenance, cleanPluginUpdateUrl } from '../../src/main/plugins/maintenance'
import { PluginService, type PluginExecutor } from '../../src/main/plugins/service'
import { validatePluginArgs } from '../../src/main/plugins/validation'
import { PLUGIN_CHANNELS } from '../../src/shared/plugins'
import { SourceError } from '../../src/shared/sources'
import { pluginFiles, pluginPackage } from '../fixtures/source-plugin'
import { zip } from '../fixtures/original-epub'

const origin = 'https://synthetic.example'
const address = `${origin}/source.zip`
const id = 'synthetic.books'
const sourceId = `plugin:${id}:text`
const invalid = (error: unknown) =>
  error instanceof SourceError && error.code === 'INVALID_SOURCE_REQUEST'

async function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ralb-plugin-maintenance-'))
  let inspected = 0
  let fail = false
  const book = { id: 'one', title: '合成书籍', pageUrl: origin }
  const runtime: PluginExecutor = {
    inspect: async () => {
      inspected++
      return [
        { id: 'audio', methods: ['search', 'getBook', 'getEpisodes', 'resolveAudio'] },
        { id: 'text', methods: ['search', 'getBook', 'getChapters', 'getChapterText'] },
      ]
    },
    execute: async (request) => {
      if (fail)
        throw new SourceError('SOURCE_UNAVAILABLE', `连接 ${origin}/private?token=synthetic 已失败`)
      switch (request.method) {
        case 'search':
          return { items: [book], nextCursor: null }
        case 'getBook':
          return book
        case 'getChapters':
          return { items: [{ id: 'chapter-one', title: '第一章' }], nextCursor: null }
        case 'getChapterText':
          return '合成正文。'
        default:
          throw new Error('Unused synthetic method')
      }
    },
  }
  const service = new PluginService({ directory: join(directory, 'plugins'), runtime })
  const maintenance = new PluginMaintenance({ directory: join(directory, 'metadata'), service })
  const preview = maintenance.decoratePreview(service.previewFile(pluginPackage(origin)))
  await maintenance.install({ previewId: preview.previewId })
  t.after(() => {
    maintenance.close()
    service.close()
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.match(basename(directory), /^ralb-plugin-maintenance-/)
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    directory,
    service,
    maintenance,
    inspected: () => inspected,
    fail: () => {
      fail = true
    },
  }
}

test('plugin health persists by source and version, with sanitized failures and corrupt metadata retained', async (t) => {
  const fixture = await setup(t)
  const first = await fixture.maintenance.test({ requestId: 'health-first', id, sourceId })
  assert.equal(first.passed, true)
  assert.ok(first.checkedAt)
  const reopened = new PluginMaintenance({
    directory: join(fixture.directory, 'metadata'),
    service: fixture.service,
  })
  t.after(() => reopened.close())
  assert.equal(reopened.state().plugins[0]!.health?.[0]?.passed, true)
  fixture.fail()
  const failed = await fixture.maintenance.test({ requestId: 'health-fail', id, sourceId })
  assert.equal(failed.passed, false)
  const persisted = readFileSync(join(fixture.directory, 'metadata', 'maintenance.json'), 'utf8')
  assert.ok(!persisted.includes('token='))
  assert.ok(persisted.includes('[网址已隐藏]'))
  const health = fixture.maintenance.state().plugins[0]!.health!
  assert.equal(health.length, 1)
  assert.equal(health[0]!.version, '1.0.0')
  assert.equal(health[0]!.passed, false)
  const corruptFile = join(fixture.directory, 'metadata', 'maintenance.json')
  writeFileSync(corruptFile, '{broken')
  const corrupt = new PluginMaintenance({
    directory: join(fixture.directory, 'metadata'),
    service: fixture.service,
  })
  t.after(() => corrupt.close())
  assert.match(corrupt.state().maintenanceNotice!, /原文件已保留/)
  assert.throws(() => corrupt.setUpdateUrl({ id, url: address }))
  assert.equal(readFileSync(corruptFile, 'utf8'), '{broken')
})

test('update checks preview permission differences without executing or activating scripts; explicit install retains rollback', async (t) => {
  const fixture = await setup(t)
  const files = pluginFiles(origin, { version: '1.1.0' })
  const manifest = JSON.parse(files['manifest.json'])
  manifest.sources[1].allowedOrigins.push('https://extra.synthetic.example')
  files['manifest.json'] = JSON.stringify(manifest)
  let bytes = zip(files)
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes.length) } }),
  )
  fixture.maintenance.setUpdateUrl({ id, url: address })
  const checked = await fixture.maintenance.checkUpdate({ requestId: 'check-one', id })
  assert.equal(checked.status.status, 'update')
  assert.equal(fixture.inspected(), 1)
  assert.equal(fixture.service.list().plugins[0]!.version, '1.0.0')
  assert.ok(checked.preview)
  assert.ok(
    checked.preview.permissionChanges?.some(
      (change) =>
        change.change === 'added' &&
        change.kind === 'request' &&
        change.origin === 'https://extra.synthetic.example',
    ),
  )
  const installed = await fixture.maintenance.install({
    previewId: checked.preview.previewId,
    updateUrl: address,
  })
  assert.equal(installed.plugins[0]!.version, '1.1.0')
  assert.equal(installed.plugins[0]!.previousVersion, '1.0.0')
  assert.equal(installed.plugins[0]!.updateUrl, address)
  assert.equal(fixture.inspected(), 2)
  const current = await fixture.maintenance.checkUpdate({ requestId: 'check-current', id })
  assert.equal(current.status.status, 'current')
  assert.equal(current.preview, null)
  bytes = pluginPackage(origin, { version: '1.0.0' })
  const older = await fixture.maintenance.checkUpdate({ requestId: 'check-old', id })
  assert.equal(older.preview, null)
  assert.equal(fixture.inspected(), 2)
  assert.equal(fixture.service.list().plugins[0]!.version, '1.1.0')
  const reopened = new PluginMaintenance({
    directory: join(fixture.directory, 'metadata'),
    service: fixture.service,
  })
  t.after(() => reopened.close())
  assert.equal(reopened.state().plugins[0]!.updateCheck?.status, 'current')
  assert.equal(reopened.state().plugins[0]!.updateUrl, address)
})

test('update failures, wrong plugin identity, cancellation and unavailable addresses preserve installed version', async (t) => {
  const fixture = await setup(t)
  fixture.maintenance.setUpdateUrl({ id, url: address })
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new Uint8Array(pluginPackage(origin, { id: 'different.plugin', version: '2.0.0' })),
      ),
  )
  const wrong = await fixture.maintenance.checkUpdate({ requestId: 'check-wrong', id })
  assert.equal(wrong.status.status, 'failed')
  assert.match(wrong.status.message, /其他插件/)
  assert.equal(wrong.preview, null)
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error(`${origin}/private?token=synthetic`)
  })
  const failed = await fixture.maintenance.checkUpdate({ requestId: 'check-failed', id })
  assert.equal(failed.status.status, 'failed')
  assert.ok(!failed.status.message.includes('token='))
  t.mock.method(
    globalThis,
    'fetch',
    (_url: unknown, options?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        })
      }),
  )
  const pending = fixture.maintenance.checkUpdate({ requestId: 'check-cancel', id })
  fixture.maintenance.cancel('check-cancel')
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof SourceError && error.code === 'SOURCE_CANCELED',
  )
  assert.equal(
    fixture.maintenance.state().plugins[0]!.updateCheck?.status,
    'failed',
    'cancellation must not overwrite the last completed check',
  )
  assert.equal(fixture.service.list().plugins[0]!.version, '1.0.0')
  assert.equal(fixture.inspected(), 1)
})

test('maintenance IPC accepts exact requests and rejects query credentials, non-HTTPS, injected fields and missing values', () => {
  assert.equal(cleanPluginUpdateUrl(address), address)
  validatePluginArgs(PLUGIN_CHANNELS.setUpdateUrl, [{ id, url: address }])
  validatePluginArgs(PLUGIN_CHANNELS.setUpdateUrl, [{ id, url: null }])
  validatePluginArgs(PLUGIN_CHANNELS.checkUpdate, [{ id, requestId: 'check' }])
  validatePluginArgs(PLUGIN_CHANNELS.install, [
    { previewId: '12345678-1234-1234-1234-123456789012', updateUrl: address },
  ])
  for (const url of [
    `${address}?v=1`,
    `${address}#fragment`,
    'http://synthetic.example/source.zip',
    'https://user:synthetic@synthetic.example/source.zip',
    'https://synthetic.example/home',
    'file:///source.zip',
    undefined,
  ])
    assert.throws(() => validatePluginArgs(PLUGIN_CHANNELS.setUpdateUrl, [{ id, url }]), invalid)
  assert.throws(
    () =>
      validatePluginArgs(PLUGIN_CHANNELS.checkUpdate, [
        { id, requestId: 'check', path: '/arbitrary' },
      ]),
    invalid,
  )
  assert.throws(
    () =>
      validatePluginArgs(PLUGIN_CHANNELS.install, [
        {
          previewId: '12345678-1234-1234-1234-123456789012',
          updateUrl: `${address}?token=synthetic`,
        },
      ]),
    invalid,
  )
})
