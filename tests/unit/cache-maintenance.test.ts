import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  symlink,
  appendFile,
  rename,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AsrComponent } from '../../src/main/asr-component'
import { CacheMaintenance, directoryUsage, scanCheckpoints } from '../../src/main/cache-maintenance'
import { validateRequest } from '../../src/shared/validation'
import { checkpointFixture, checkpointKey, cacheManifest } from '../fixtures/checkpoint-cache'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), '听读 缓存管理 ')),
    cache = join(root, 'resources'),
    logs = join(root, 'logs')
  await mkdir(cache)
  await mkdir(logs)
  const runtime = join(root, 'runtime.exe'),
    worker = join(root, 'asr_worker.py'),
    models = join(root, 'models.json'),
    selected = join(root, 'component.json')
  await writeFile(runtime, 'not executed')
  await writeFile(worker, '# not executed')
  await writeFile(
    models,
    JSON.stringify({
      version: 1,
      models: { fixture: { repository: 'fixture/repository', revision: 'fixed', path: cache } },
    }),
  )
  const config = { version: 1, python: runtime, models, cache, ffmpeg: runtime, ffprobe: runtime }
  await writeFile(selected, JSON.stringify(config))
  const component = new AsrComponent(join(root, 'saved.json'), worker)
  await component.configure(selected)
  return {
    root,
    cache,
    logs,
    selected,
    config,
    component,
    manager: new CacheMaintenance(component, root, logs),
  }
}

test('cache preview and explicit clear remove only identified worker files, preserving models, unknown data and linked targets', async () => {
  const t = await setup(),
    group = await checkpointFixture(t.cache)
  await writeFile(
    join(group, 'chunk-000001.json.5cd6b9c2-7d12-4234-8d80-464014161e77.tmp'),
    'interrupted atomic write',
  )
  await mkdir(join(t.cache, 'huggingface'))
  await writeFile(join(t.cache, 'huggingface', 'model.bin'), 'weight data')
  const foreign = join(t.cache, 'jobs', 'b'.repeat(64))
  await mkdir(foreign)
  await writeFile(join(foreign, 'notes.txt'), 'user data')
  const outside = join(t.root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'keep.txt'), 'must survive')
  await symlink(outside, join(t.cache, 'jobs', 'c'.repeat(64)), 'junction')
  const preview = await t.manager.prepare()
  assert.equal(preview.groups, 1)
  assert.equal(preview.files, 3)
  assert.equal(preview.retained, 2)
  const cleared = await t.manager.clear(preview.token)
  assert.equal(cleared.files, 3)
  assert.equal(cleared.bytes, preview.bytes)
  await assert.rejects(access(group))
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'must survive')
  assert.equal(await readFile(join(foreign, 'notes.txt'), 'utf8'), 'user data')
  assert.equal(await readFile(join(t.cache, 'huggingface', 'model.bin'), 'utf8'), 'weight data')
  await assert.rejects(t.manager.clear(preview.token), { code: 'CONFLICT' })
})

test('a changed checkpoint or component invalidates its preview without deleting remaining data', async () => {
  const t = await setup(),
    group = await checkpointFixture(t.cache)
  const preview = await t.manager.prepare()
  await appendFile(join(group, 'chunk-000000.json'), 'changed')
  await assert.rejects(t.manager.clear(preview.token), { code: 'CONFLICT' })
  await access(join(group, 'manifest.json'))
  const next = await t.manager.prepare(),
    another = join(t.root, 'different-models.json')
  await writeFile(another, await readFile(t.config.models, 'utf8'))
  await writeFile(t.selected, JSON.stringify({ ...t.config, models: another }))
  await t.component.configure(t.selected)
  await assert.rejects(t.manager.clear(next.token), { code: 'CONFLICT' })
  await access(join(group, 'chunk-000000.json'))
})

test('a junction replacing jobs is refused; usage never expands linked targets', async () => {
  const t = await setup(),
    outside = join(t.root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'unrelated.txt'), 'outside content')
  await symlink(outside, join(t.cache, 'jobs'), 'junction')
  await assert.rejects(t.manager.prepare(), { code: 'CONFLICT' })
  const usage = await directoryUsage(t.cache)
  assert.equal(usage.bytes, 0)
  assert.equal(usage.skipped, 1)
  assert.equal(await readFile(join(outside, 'unrelated.txt'), 'utf8'), 'outside content')
})

test('unexpected nested data and forged ownership stay untouched, and model inspection never starts a worker', async () => {
  const t = await setup(),
    group = await checkpointFixture(t.cache)
  await mkdir(join(group, 'nested'))
  await writeFile(join(group, 'nested', 'keep.txt'), 'do not remove')
  const forged = join(t.cache, 'jobs', '0'.repeat(64))
  await mkdir(forged)
  await writeFile(join(forged, 'manifest.json'), JSON.stringify(cacheManifest))
  await writeFile(join(forged, 'chunk-000000.json'), 'unowned')
  const scan = await scanCheckpoints(t.cache)
  assert.equal(scan.groups.length, 0)
  assert.equal(scan.retained, 2)
  const state = await t.manager.state()
  assert.equal(state.models[0]!.available, true)
  assert.equal(state.models[0]!.repository, 'fixture/repository')
  assert.equal(state.usage!.complete, true)
  assert.equal(checkpointKey, '38f6461b0b8bcc5222fcf4acee3041c5b3a3356d854fa08fa1e376e74d09bb8e')
})

test('replacing the previewed jobs directory with a junction cannot redirect deletion', async () => {
  const t = await setup()
  await checkpointFixture(t.cache)
  const preview = await t.manager.prepare(),
    outside = join(t.root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'keep.txt'), 'unrelated files')
  await rename(join(t.cache, 'jobs'), join(t.cache, 'held-jobs'))
  await symlink(outside, join(t.cache, 'jobs'), 'junction')
  await assert.rejects(t.manager.clear(preview.token), { code: 'CONFLICT' })
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'unrelated files')
  await access(join(t.cache, 'held-jobs', checkpointKey, 'chunk-000000.json'))
})

test('the app log tail is bounded and returned as literal text', async () => {
  const t = await setup()
  assert.deepEqual(await t.manager.log(), { text: '', truncated: false })
  await writeFile(
    join(t.logs, 'app.log'),
    'X'.repeat(70000) + '\nFailure <script>literal log</script>',
  )
  const result = await t.manager.log()
  assert.equal(result.truncated, true)
  assert.equal(Buffer.byteLength(result.text), 65536)
  assert.ok(result.text.endsWith('Failure <script>literal log</script>'))
})

test('maintenance IPC accepts only fixed locations, bounded pages and one-use opaque tokens', () => {
  const token = '5cd6b9c2-7d12-4234-8d80-464014161e77'
  validateRequest('maintenance:clear', [{ token }])
  validateRequest('maintenance:tasks', [{ page: 0, activeOnly: true }])
  for (const request of [{ token, path: 'D:/private' }, { token: 'D:/private' }])
    assert.throws(() => validateRequest('maintenance:clear', [request]), {
      code: 'INVALID_REQUEST',
    })
  for (const target of ['D:/private', 'python', 'https://example.com'])
    assert.throws(() => validateRequest('maintenance:show-location', [{ target }]), {
      code: 'INVALID_REQUEST',
    })
  for (const page of [-1, 0.5, Infinity, 1000001])
    assert.throws(() => validateRequest('maintenance:tasks', [{ page, activeOnly: false }]), {
      code: 'INVALID_REQUEST',
    })
})
