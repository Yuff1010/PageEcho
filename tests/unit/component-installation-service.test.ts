import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { AsrComponent } from '../../src/main/asr-component'
import type { ComponentProbe } from '../../src/main/component-setup'
import { ComponentInstallationService } from '../../src/main/component-installation/service'
import type {
  ComponentInstallerCore,
  ComponentInstallPlan,
  ManagedComponentReceipt,
} from '../../src/main/component-installation/core-types'
import type { ComponentCheck } from '../../src/shared/component'
import type { ComponentInstallationActivity } from '../../src/shared/component-installation'
import { AppError } from '../../src/shared/validation'

const profile = { engine: 'paraformer', device: 'cpu' } as const
function healthy(): ComponentCheck {
  return {
    checkedAt: new Date().toISOString(),
    ready: true,
    pythonVersion: '3.12.10',
    cudaName: null,
    freeBytes: 1024 ** 3,
    issues: [],
    level: 'imports-and-files',
    capabilities: (['whisperx', 'paraformer'] as const).flatMap((engine) =>
      (['cpu', 'cuda'] as const).map((device) => ({
        engine,
        device,
        available: device === 'cpu',
        message: device === 'cpu' ? 'Fixture import check, no model inference.' : 'No CUDA.',
      })),
    ),
  }
}
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function until(predicate: () => boolean, message: string) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return
    await delay(5)
  }
  assert.fail(message)
}
async function componentAt(root: string) {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'runtime.exe'), 'Fixture only; never executable.')
  await writeFile(join(root, 'models.json'), JSON.stringify({ version: 1, models: {} }))
  const path = join(root, 'component.json')
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      python: 'runtime.exe',
      models: 'models.json',
      cache: '.',
      ffmpeg: 'runtime.exe',
      ffprobe: 'runtime.exe',
    }),
  )
  return path
}
async function fixture(t: TestContext, loaded = false) {
  const root = await mkdtemp(join(tmpdir(), '听读 installer service ')),
    managed = join(root, 'managed'),
    user = join(root, 'user'),
    settings = join(user, 'asr-component.json'),
    worker = join(root, 'asr_worker.py')
  await mkdir(user)
  await writeFile(worker, '# Unit fixture; no Python or ML process is launched.\n')
  const externalPath = await componentAt(join(root, 'external-original')),
    componentPath = await componentAt(join(root, 'managed-candidate')),
    component = new AsrComponent(settings, worker)
  await component.configure(externalPath)
  const originalSettings = await readFile(settings),
    originalPaths = component.describe()
  const receipt: ManagedComponentReceipt = {
      id: randomUUID(),
      version: '0.0.0-unit',
      profile,
      bytes: 31,
      installedAt: new Date().toISOString(),
      componentPath,
      receiptPath: join(managed, 'receipts', 'fixture', 'receipt.json'),
    },
    plan: ComponentInstallPlan = {
      archivePath: join(root, 'fixture.zip'),
      bundle: {
        id: 'unit-service',
        version: receipt.version,
        archiveBytes: 123,
        archiveSha256: 'a'.repeat(64),
        manifestSha256: 'b'.repeat(64),
      },
      profile,
      files: [],
      requiredBytes: 31,
      freeBytes: 1024 ** 3,
      sourceSize: 123,
      sourceModifiedMs: 0,
    }
  const events: string[] = [],
    errors: unknown[] = []
  let changed = 0,
    notifications = 0,
    busy = false
  const hooks: {
    inspect: ComponentInstallerCore['inspect']
    install: ComponentInstallerCore['install']
    verify: ComponentInstallerCore['verify']
    probe: ComponentProbe
  } = {
    inspect: async () => plan,
    install: async () => receipt,
    verify: async () => undefined,
    probe: async () => healthy(),
  }
  const persisted = new Map(loaded ? [[receipt.id, receipt]] : [])
  const core: ComponentInstallerCore = {
    inspect: (...args) => {
      events.push('inspect')
      return hooks.inspect(...args)
    },
    install: async (...args) => {
      events.push('install')
      const installed = await hooks.install(...args)
      persisted.set(installed.id, installed)
      return installed
    },
    verify: (...args) => {
      events.push('verify')
      return hooks.verify(...args)
    },
    load: async () => [...persisted.values()],
  }
  const serviceOptions: ConstructorParameters<typeof ComponentInstallationService>[0] = {
    root: managed,
    settingsFile: settings,
    workerScript: worker,
    component,
    core,
    queue: {
      withMaintenance: async (action) => {
        events.push('maintenance')
        if (busy) throw new AppError('BUSY', 'Owned unit queue is busy.')
        return action()
      },
    },
    probe: (...args) => {
      events.push('probe')
      return hooks.probe(...args)
    },
    notify: () => {
      notifications++
    },
    componentChanged: () => {
      changed++
      events.push('changed')
    },
    log: (error) => errors.push(error),
  }
  const service = new ComponentInstallationService(serviceOptions)
  await service.load()
  t.after(async () => {
    await service.close()
    await rm(root, { recursive: true, force: true })
  })
  const waitStatus = async (status: ComponentInstallationActivity['status']) => {
    await until(
      () => service.state().activity?.status === status,
      `Expected ${status}, got ${JSON.stringify(service.state())}`,
    )
  }
  return {
    root,
    managed,
    user,
    settings,
    originalSettings,
    originalPaths,
    component,
    receipt,
    plan,
    hooks,
    events,
    errors,
    service,
    serviceOptions,
    waitStatus,
    setBusy: (value: boolean) => {
      busy = value
    },
    changed: () => changed,
    notifications: () => notifications,
  }
}

test('install remains inactive until explicit verified activation; the external configuration can be restored after restart', async (t) => {
  const f = await fixture(t),
    selected = f.service.select(f.plan.archivePath, profile)
  assert.equal(selected.activity?.status, 'inspecting')
  await f.waitStatus('ready')
  f.service.start(selected.activity!.id)
  await f.waitStatus('installed')
  assert.deepEqual(await readFile(f.settings), f.originalSettings)
  assert.deepEqual(f.component.describe(), f.originalPaths)
  assert.equal(f.changed(), 0)
  assert.equal(f.service.state().installations[0]?.active, false)
  f.events.length = 0
  const activated = await f.service.activate(f.receipt.id)
  assert.equal(activated.activating, null)
  assert.deepEqual(f.events, ['maintenance', 'verify', 'probe', 'changed'])
  assert.equal(
    f.component.describe()?.python,
    join(dirname(f.receipt.componentPath), 'runtime.exe'),
  )
  const external = activated.installations.find((entry) => !entry.managed)
  assert(external)
  assert.equal(activated.installations.find((entry) => entry.managed)?.active, true)
  await f.service.close()
  // A fresh service reads the persisted external snapshot, without rediscovery or
  // relying on an in-memory reference to the previous component's paths.
  const reloaded = new ComponentInstallationService({
    root: f.managed,
    settingsFile: f.settings,
    workerScript: join(f.root, 'asr_worker.py'),
    component: f.component,
    core: {
      inspect: f.hooks.inspect,
      install: f.hooks.install,
      verify: f.hooks.verify,
      load: async () => [f.receipt],
    },
    queue: { withMaintenance: async (action) => action() },
    probe: async () => healthy(),
    notify: () => {},
    componentChanged: () => {},
    log: () => {},
  })
  t.after(() => reloaded.close())
  await reloaded.load()
  assert(reloaded.state().installations.some((entry) => entry.id === external.id))
  await reloaded.activate(external.id)
  assert.deepEqual(f.component.describe(), f.originalPaths)
  assert.deepEqual(await readFile(f.settings), f.originalSettings)
  assert.equal(
    reloaded.state().installations.find((entry) => entry.id === external.id)?.active,
    true,
  )
})

test('a changed managed receipt is rejected by verification before any candidate probe or configuration write', async (t) => {
  const f = await fixture(t, true)
  f.hooks.verify = async () => {
    throw new AppError('FILE_CHANGED', 'Owned receipt hash changed.')
  }
  await assert.rejects(f.service.activate(f.receipt.id), { code: 'FILE_CHANGED' })
  assert.deepEqual(f.events, ['maintenance', 'verify'])
  assert.deepEqual(await readFile(f.settings), f.originalSettings)
  assert.deepEqual(f.component.describe(), f.originalPaths)
  assert.equal(f.changed(), 0)
  assert.equal(f.service.state().activating, null)
  assert.equal(f.service.state().installations[0]?.active, false)
})

test('a missing installed Python does not prevent service startup or hide the version, and activation preserves the working external component', async (t) => {
  const f = await fixture(t),
    id = f.service.select(f.plan.archivePath, profile).activity!.id
  await f.waitStatus('ready')
  f.service.start(id)
  await f.waitStatus('installed')
  await f.service.close()
  await unlink(join(dirname(f.receipt.componentPath), 'runtime.exe'))
  const reopened = new ComponentInstallationService(f.serviceOptions)
  t.after(() => reopened.close())
  await reopened.load()
  const state = reopened.state()
  assert.equal(state.installations.length, 1)
  assert.equal(state.installations[0]!.id, f.receipt.id)
  assert.equal(state.installations[0]!.active, false)
  assert.deepEqual(await readFile(f.settings), f.originalSettings)
  assert.deepEqual(f.component.describe(), f.originalPaths)
  f.events.length = 0
  await assert.rejects(reopened.activate(f.receipt.id), { code: 'RUNTIME_UNAVAILABLE' })
  assert.deepEqual(f.events, ['maintenance', 'verify'])
  assert.deepEqual(await readFile(f.settings), f.originalSettings)
  assert.deepEqual(f.component.describe(), f.originalPaths)
  assert.equal(reopened.state().activating, null)
  assert.equal(f.changed(), 0)
  assert(
    f.errors.length >= 1,
    'The broken candidate is logged without blocking application startup.',
  )
})

test('activation refuses a tampered external recovery snapshot before probing and preserves the currently active managed version', async (t) => {
  const f = await fixture(t, true)
  const state = await f.service.activate(f.receipt.id),
    external = state.installations.find((entry) => !entry.managed)
  assert(external)
  const current = await readFile(f.settings),
    paths = f.component.describe(),
    count = f.changed()
  await writeFile(join(f.managed, 'external', `${external.id}.json`), '{"python":"outside.exe"}')
  f.events.length = 0
  await assert.rejects(f.service.activate(external.id), { code: 'FILE_CHANGED' })
  assert.deepEqual(f.events, ['maintenance'])
  assert.deepEqual(await readFile(f.settings), current)
  assert.deepEqual(f.component.describe(), paths)
  assert.equal(f.changed(), count)
})

test('canceling a ready plan revokes installation, and a fresh selection can be installed', async (t) => {
  const f = await fixture(t),
    id = f.service.select(f.plan.archivePath, profile).activity!.id
  await f.waitStatus('ready')
  await f.service.cancel(id)
  assert.equal(f.service.state().activity?.status, 'canceled')
  assert.throws(() => f.service.start(id), { code: 'CONFLICT' })
  assert(!f.events.includes('install'))
  assert.deepEqual(await readFile(f.settings), f.originalSettings)
  const next = f.service.select(f.plan.archivePath, profile).activity!.id
  assert.notEqual(next, id)
  await f.waitStatus('ready')
  f.service.start(next)
  await f.waitStatus('installed')
  assert.deepEqual(await readFile(f.settings), f.originalSettings)
})

test('cancel waits for owned extraction cleanup, rejects concurrent work, and cannot publish a late receipt', async (t) => {
  const f = await fixture(t),
    started = deferred(),
    cleanup = deferred()
  f.hooks.install = async (_plan, signal) => {
    started.resolve()
    await new Promise<void>((done) =>
      signal.addEventListener('abort', () => done(), { once: true }),
    )
    await cleanup.promise
    signal.throwIfAborted()
    return f.receipt
  }
  const id = f.service.select(f.plan.archivePath, profile).activity!.id
  await f.waitStatus('ready')
  f.service.start(id)
  await started.promise
  let canceled = false
  const cancel = f.service.cancel(id).then(() => {
    canceled = true
  })
  try {
    await delay(10)
    assert.equal(canceled, false)
    assert.throws(() => f.service.select(f.plan.archivePath, profile), { code: 'BUSY' })
    assert.throws(() => f.service.start(id), { code: 'BUSY' })
  } finally {
    cleanup.resolve()
  }
  await cancel
  assert.equal(f.service.state().activity?.status, 'canceled')
  assert.deepEqual(f.service.state().installations, [])
  assert(!f.events.includes('probe'))
  assert.deepEqual(await readFile(f.settings), f.originalSettings)
})

test('a busy queue refuses activation before verification; close aborts an owned candidate probe and prevents further work', async (t) => {
  const f = await fixture(t, true)
  f.setBusy(true)
  await assert.rejects(f.service.activate(f.receipt.id), { code: 'BUSY' })
  assert.deepEqual(f.events, ['maintenance'])
  assert.equal(f.service.state().activating, null)
  f.setBusy(false)
  const started = deferred<AbortSignal>()
  f.hooks.probe = async (_runtime, _script, options) => {
    const signal = options!.signal!
    started.resolve(signal)
    await new Promise<void>((done) =>
      signal.addEventListener('abort', () => done(), { once: true }),
    )
    signal.throwIfAborted()
    return healthy()
  }
  const activation = f.service.activate(f.receipt.id)
  const rejected = assert.rejects(activation, { name: 'AbortError' })
  const signal = await started.promise
  await f.service.close()
  await rejected
  assert.equal(signal.aborted, true)
  assert.deepEqual(await readFile(f.settings), f.originalSettings)
  assert.equal(f.changed(), 0)
  assert.throws(() => f.service.select(f.plan.archivePath, profile), { code: 'BUSY' })
  await assert.rejects(f.service.activate(f.receipt.id), { code: 'BUSY' })
  assert(!(await readdir(f.user)).some((name) => name.startsWith('.component-candidate-')))
  const notifications = f.notifications()
  await delay(10)
  assert.equal(f.notifications(), notifications)
})

test('cancel during candidate checking waits for the probe cleanup before becoming idle', async (t) => {
  const f = await fixture(t),
    started = deferred<AbortSignal>(),
    cleanup = deferred()
  let cleaned = false
  f.hooks.probe = async (_runtime, _script, options) => {
    const signal = options!.signal!
    started.resolve(signal)
    await new Promise<void>((done) =>
      signal.addEventListener('abort', () => done(), { once: true }),
    )
    await cleanup.promise
    cleaned = true
    signal.throwIfAborted()
    return healthy()
  }
  const id = f.service.select(f.plan.archivePath, profile).activity!.id
  await f.waitStatus('ready')
  f.service.start(id)
  await started.promise
  let finished = false
  const canceled = f.service.cancel(id).then(() => {
    finished = true
  })
  try {
    await delay(10)
    assert.equal(
      finished,
      false,
      'Cancel must await the owned probe promise, including process cleanup.',
    )
    assert.equal(cleaned, false)
    assert.throws(() => f.service.select(f.plan.archivePath, profile), { code: 'BUSY' })
  } finally {
    cleanup.resolve()
  }
  await canceled
  assert.equal(cleaned, true)
  assert.equal(f.service.state().activity?.status, 'canceled')
  assert.deepEqual(await readFile(f.settings), f.originalSettings)
})
