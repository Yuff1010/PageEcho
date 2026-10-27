import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AsrComponent } from '../../src/main/asr-component'

test('component paths come from a bounded native-selected config, persist and reject custom worker commands', async () => {
  const root = await mkdtemp(join(tmpdir(), '听读 component '))
  const worker = join(root, 'asr_worker.py'),
    executable = join(root, 'runtime.exe')
  await writeFile(worker, '# fixture file, never executed')
  await writeFile(executable, 'fixture, never executed')
  const selected = join(root, 'component.json'),
    settings = join(root, 'saved.json')
  const value = {
    version: 1,
    python: 'runtime.exe',
    models: 'component.json',
    cache: '.',
    ffmpeg: 'runtime.exe',
    ffprobe: 'runtime.exe',
  }
  await writeFile(selected, JSON.stringify(value))
  const component = new AsrComponent(settings, worker)
  await component.load()
  assert.equal(component.configured, false)
  await component.configure(selected)
  assert.equal(component.runtime('whisperx', 'cpu').script, worker)
  assert.equal(component.runtime('whisperx', 'cpu').python, executable)
  const persisted = await readFile(settings, 'utf8')
  await writeFile(selected, JSON.stringify({ ...value, script: 'arbitrary.py' }))
  await assert.rejects(component.configure(selected), { code: 'RUNTIME_UNAVAILABLE' })
  assert.equal(await readFile(settings, 'utf8'), persisted)
  const reopened = new AsrComponent(settings, worker)
  await reopened.load()
  assert.equal(reopened.configured, true)
})

test('portable v2 keeps resources beside the bundle and puts writable cache under user data', async () => {
  const root = await mkdtemp(join(tmpdir(), '听读 便携组件 ')),
    assets = join(root, 'component'),
    user = join(root, 'user')
  await mkdir(assets)
  await mkdir(user)
  await mkdir(join(assets, 'resources'))
  await writeFile(join(assets, 'runtime.exe'), 'not executed')
  await writeFile(join(assets, 'models.json'), '{"version":1,"models":{}}')
  const worker = join(root, 'asr_worker.py'),
    settings = join(user, 'asr-component.json'),
    selected = join(assets, 'component.json')
  await writeFile(worker, '# not executed')
  const config = {
    version: 2,
    python: 'runtime.exe',
    models: 'models.json',
    resources: 'resources',
    ffmpeg: 'runtime.exe',
    ffprobe: 'runtime.exe',
  }
  await writeFile(selected, JSON.stringify(config))
  const component = new AsrComponent(settings, worker)
  await component.configure(selected)
  const runtime = component.runtime('whisperx', 'cpu')
  assert.equal(runtime.resources, join(assets, 'resources'))
  assert.equal(runtime.cache, join(user, 'cache', 'asr'))
  await access(runtime.cache)
  const saved = JSON.parse(await readFile(settings, 'utf8'))
  assert.equal(saved.version, 2)
  assert.equal(Object.hasOwn(saved, 'cache'), false)
  const reopened = new AsrComponent(settings, worker)
  await reopened.load()
  assert.deepEqual(reopened.describe(), component.describe())
  await writeFile(selected, JSON.stringify({ ...config, cache: 'arbitrary' }))
  await assert.rejects(component.configure(selected), { code: 'RUNTIME_UNAVAILABLE' })
})

test('a late startup load cannot overwrite a component chosen while it was reading', async () => {
  const root = await mkdtemp(join(tmpdir(), '听读 组件加载竞争 ')),
    worker = join(root, 'worker.py'),
    settings = join(root, 'saved.json')
  await writeFile(worker, '# not executed')
  for (const name of ['first.exe', 'second.exe']) await writeFile(join(root, name), 'not executed')
  const first = join(root, 'first.json'),
    second = join(root, 'second.json')
  const config = {
    version: 1,
    python: 'first.exe',
    models: 'first.json',
    cache: '.',
    ffmpeg: 'first.exe',
    ffprobe: 'first.exe',
  }
  await writeFile(first, JSON.stringify(config))
  await writeFile(second, JSON.stringify({ ...config, python: 'second.exe' }))
  const initial = new AsrComponent(settings, worker)
  await initial.configure(first)
  const component = new AsrComponent(settings, worker)
  const original = Reflect.get(component, 'read').bind(component)
  let release: () => void = () => undefined,
    entered: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
      release = resolve
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve
    })
  Reflect.set(component, 'read', async (path: string) => {
    const value = await original(path)
    if (path === settings) {
      entered()
      await gate
    }
    return value
  })
  const loading = component.load()
  await started
  await component.configure(second)
  release()
  await loading
  assert.equal(component.runtime('whisperx', 'cpu').python, join(root, 'second.exe'))
})
