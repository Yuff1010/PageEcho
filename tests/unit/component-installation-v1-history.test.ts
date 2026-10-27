import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { AsrComponent } from '../../src/main/asr-component'
import { ComponentInstallationService } from '../../src/main/component-installation/service'
import type {
  ComponentInstallerCore,
  ManagedComponentReceipt,
} from '../../src/main/component-installation/core-types'
import type { ComponentCheck } from '../../src/shared/component'

test('v1 external configurations differing only by cache retain separate recovery histories and active identities across restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), '听读 v1 组件恢复 ')),
    user = join(root, 'user'),
    managed = join(root, 'managed'),
    candidate = join(root, 'candidate'),
    settings = join(user, 'asr-component.json'),
    worker = join(root, 'worker.py'),
    cacheA = join(root, 'cache-a'),
    cacheB = join(root, 'cache-b')
  await Promise.all(
    [user, candidate, cacheA, cacheB, join(candidate, 'resources')].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  )
  await writeFile(worker, '# Metadata-only fixture; no Python is executed.\n')
  for (const path of [root, candidate]) {
    await writeFile(join(path, 'runtime.exe'), 'Metadata-only fixture; not executable.')
    await writeFile(join(path, 'models.json'), JSON.stringify({ version: 1, models: {} }))
  }
  const configA = {
      version: 1,
      python: 'runtime.exe',
      models: 'models.json',
      cache: 'cache-a',
      ffmpeg: 'runtime.exe',
      ffprobe: 'runtime.exe',
    },
    configB = { ...configA, cache: 'cache-b' },
    sourceA = join(root, 'a.json'),
    sourceB = join(root, 'b.json'),
    candidateConfig = join(candidate, 'component.json')
  await writeFile(sourceA, JSON.stringify(configA))
  await writeFile(sourceB, JSON.stringify(configB))
  await writeFile(
    candidateConfig,
    JSON.stringify({
      version: 2,
      python: 'runtime.exe',
      models: 'models.json',
      resources: 'resources',
      ffmpeg: 'runtime.exe',
      ffprobe: 'runtime.exe',
    }),
  )
  assert.deepEqual({ ...configA, cache: configB.cache }, configB)
  const receipt: ManagedComponentReceipt = {
    id: randomUUID(),
    version: 'unit-v1-history',
    profile: { engine: 'paraformer', device: 'cpu' },
    bytes: 1,
    installedAt: new Date().toISOString(),
    componentPath: candidateConfig,
    receiptPath: join(root, 'receipt.json'),
  }
  const core: ComponentInstallerCore = {
    load: async () => [receipt],
    verify: async () => {},
    inspect: async () => {
      throw new Error('Unused: recovery identity test never installs archives.')
    },
    install: async () => {
      throw new Error('Unused: recovery identity test never installs archives.')
    },
  }
  const healthy: ComponentCheck = {
    checkedAt: new Date().toISOString(),
    ready: true,
    pythonVersion: 'controlled-probe',
    cudaName: null,
    freeBytes: 1024 ** 3,
    issues: [],
    level: 'imports-and-files',
    capabilities: (['whisperx', 'paraformer'] as const).flatMap((engine) =>
      (['cpu', 'cuda'] as const).map((device) => ({
        engine,
        device,
        available: device === 'cpu',
        message: 'Controlled probe; no process or inference.',
      })),
    ),
  }
  let component = new AsrComponent(settings, worker)
  const makeService = () =>
    new ComponentInstallationService({
      root: managed,
      settingsFile: settings,
      workerScript: worker,
      component,
      core,
      queue: { withMaintenance: async (action) => action() },
      probe: async () => healthy,
      notify: () => {},
      componentChanged: () => {},
      log: (error) => {
        throw error
      },
    })
  let service = makeService()
  t.after(async () => {
    await service.close()
    assert.equal(dirname(root), tmpdir())
    await rm(root, { recursive: true, force: true })
  })
  const cacheOf = async (id: string) =>
    (
      JSON.parse(await readFile(join(managed, 'external', `${id}.json`), 'utf8')) as {
        cache: string
      }
    ).cache
  const assertActive = (id: string) => {
    const records = service.state().installations
    assert.equal(records.filter((item) => item.active).length, 1)
    assert.equal(records.find((item) => item.id === id)?.active, true)
  }

  await component.configure(sourceA)
  await service.load()
  await service.activate(receipt.id)
  const snapshotA = service.state().installations.find((item) => !item.managed)!
  assert.equal(await cacheOf(snapshotA.id), cacheA)
  await component.configure(sourceB)
  assert.equal(component.describe()?.cache, cacheB)
  assert.equal(
    service.state().installations.find((item) => item.id === snapshotA.id)?.active,
    false,
  )
  assert.equal(
    service.state().installations.some((item) => item.active),
    false,
  )

  await service.activate(receipt.id)
  const snapshots = service.state().installations.filter((item) => !item.managed)
  assert.equal(snapshots.length, 2)
  const snapshotB = snapshots.find((item) => item.id !== snapshotA.id)!
  assert.equal(await cacheOf(snapshotB.id), cacheB)
  assert.notEqual(snapshotA.id, snapshotB.id)
  await service.activate(snapshotB.id)
  assert.equal(component.describe()?.cache, cacheB)
  assertActive(snapshotB.id)
  await service.close()

  component = new AsrComponent(settings, worker)
  await component.load()
  service = makeService()
  await service.load()
  assert.equal(service.state().installations.filter((item) => !item.managed).length, 2)
  assert.equal(component.describe()?.cache, cacheB)
  assertActive(snapshotB.id)
  await service.activate(snapshotA.id)
  assert.equal(component.describe()?.cache, cacheA)
  assertActive(snapshotA.id)
  await service.activate(snapshotB.id)
  assert.equal(component.describe()?.cache, cacheB)
  assertActive(snapshotB.id)
  assert.equal(service.state().installations.filter((item) => !item.managed).length, 2)
})
