import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AsrComponent } from '../../src/main/asr-component'
import {
  ComponentSetup,
  componentDiscoveryRoots,
  parseComponentCheck,
  runComponentProbe,
} from '../../src/main/component-setup'
import type { AsrRuntime } from '../../src/main/asr-process'
import type { ComponentCheck } from '../../src/shared/component'
import { validateRequest } from '../../src/shared/validation'

function healthy(): ComponentCheck {
  return {
    checkedAt: '2026-10-23T15:00:00.000Z',
    ready: true,
    pythonVersion: '3.12.10',
    cudaName: null,
    freeBytes: 1024 ** 3,
    issues: ['CUDA 不可用，可使用 CPU。'],
    capabilities: ['whisperx', 'paraformer'].flatMap((engine) =>
      ['cpu', 'cuda'].map((device) => ({
        engine: engine as 'whisperx' | 'paraformer',
        device: device as 'cpu' | 'cuda',
        available: device === 'cpu',
        message: device === 'cpu' ? '文件和依赖导入通过，未运行模型推理。' : 'CUDA 不可用。',
      })),
    ),
    level: 'imports-and-files',
  }
}
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), '听读 组件发现 ')),
    worker = join(root, 'asr_worker.py'),
    user = join(root, 'user'),
    settings = join(user, 'asr-component.json')
  await mkdir(user)
  await writeFile(worker, '# Fixture path; discovery does not execute this file.\n')
  return { root, worker, settings, component: new AsrComponent(settings, worker) }
}
async function componentAt(directory: string) {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'runtime.exe'), 'Fixture path; never executed.\n')
  await writeFile(join(directory, 'models.json'), JSON.stringify({ version: 1, models: {} }))
  const config = {
    version: 1,
    python: 'runtime.exe',
    models: 'models.json',
    cache: '.',
    ffmpeg: 'runtime.exe',
    ffprobe: 'runtime.exe',
  }
  const path = join(directory, 'component.json')
  await writeFile(path, JSON.stringify(config))
  return path
}

test('component IPC accepts only no-argument discovery/folder/check and opaque candidate identifiers', () => {
  for (const channel of [
    'transcription:components-detect',
    'transcription:component-folder',
    'transcription:component-check',
  ]) {
    assert.doesNotThrow(() => validateRequest(channel, []))
    for (const args of [
      [undefined],
      [{}],
      ['C:\\component'],
      [{ path: 'C:\\component' }],
      [null, null],
    ])
      assert.throws(() => validateRequest(channel, args), { code: 'INVALID_REQUEST' })
  }
  const channel = 'transcription:component-use',
    id = '9b46ea29-11f3-438e-8c41-d7c4355d3316'
  assert.doesNotThrow(() => validateRequest(channel, [{ id }]))
  for (const args of [
    [],
    [{ id: 'C:\\component\\component.json' }],
    [{ id, path: 'C:\\component' }],
    [{ configPath: 'component.json' }],
    [{ id }, 'extra'],
    [{ id: '' }],
  ])
    assert.throws(() => validateRequest(channel, args), { code: 'INVALID_REQUEST' })
})

test('subtitle priority IPC accepts exact identities and bounded integer media positions only', () => {
  const channel = 'transcription:prioritize',
    request = {
      episodeId: '9b46ea29-11f3-438e-8c41-d7c4355d3316',
      audioHash: 'a'.repeat(64),
      positionMs: 0,
    }
  for (const positionMs of [0, 30_000, 3.6e10])
    assert.doesNotThrow(() => validateRequest(channel, [{ ...request, positionMs }]))
  for (const value of [
    { ...request, positionMs: -1 },
    { ...request, positionMs: 3.6e10 + 1 },
    { ...request, positionMs: 0.5 },
    { ...request, positionMs: Infinity },
    { ...request, positionMs: Number.NaN },
    { ...request, positionMs: '30000' },
    { ...request, episodeId: 'renderer-supplied-path.wav' },
    { ...request, audioHash: 'old-or-invalid-hash' },
    { ...request, audioHash: 'A'.repeat(64) },
    { ...request, path: 'C:\\arbitrary.wav' },
  ])
    assert.throws(() => validateRequest(channel, [value]), { code: 'INVALID_REQUEST' })
  assert.throws(() => validateRequest(channel, [request, {}]), { code: 'INVALID_REQUEST' })
})

test('app discovery roots are absolute, unique, and bounded across overlapping locations', async () => {
  const fixture = await makeFixture(),
    location = join(fixture.root, 'a', 'b', 'c', 'd', 'e', 'f', 'g'),
    roots = componentDiscoveryRoots(location, location, join(location, 'child'))
  assert.equal(roots[0], location)
  assert.equal(new Set(roots).size, roots.length)
  assert.ok(roots.length <= 24)
  assert.ok(!roots.includes(fixture.root))
  assert.equal(componentDiscoveryRoots(location).length, 6)
})

test('discovery finds only supported shallow layouts, deduplicates real paths, and never configures implicitly', async () => {
  const fixture = await makeFixture(),
    root = join(fixture.root, 'near-app')
  const paths = await Promise.all([
    componentAt(root),
    componentAt(join(root, 'asr-component')),
    componentAt(join(root, 'components', '中文 组件')),
    componentAt(join(root, 'release', 'asr-component-one')),
  ])
  await componentAt(join(root, 'unrelated', 'deep', 'component'))
  const alias = join(fixture.root, 'near-app-alias')
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const setup = new ComponentSetup(fixture.component, [root, root, alias], async () => healthy())
  const detected = await setup.detect()
  assert.equal(detected.configured, false)
  assert.equal(fixture.component.configured, false)
  assert.equal(detected.check, null)
  assert.deepEqual(
    detected.candidates.map((candidate) => candidate.configPath).sort(),
    paths.sort(),
  )
  assert.equal(new Set(detected.candidates.map((candidate) => candidate.id)).size, paths.length)
  assert.ok(detected.candidates.every((candidate) => candidate.available && !candidate.problem))
  const again = await setup.detect()
  for (const candidate of detected.candidates)
    assert.equal(
      again.candidates.find((value) => value.configPath === candidate.configPath)?.id,
      candidate.id,
    )
})

test('discovery bounds large component directories and exposes malformed candidates without replacing saved configuration', async () => {
  const fixture = await makeFixture(),
    root = join(fixture.root, 'near-app'),
    selected = await componentAt(join(fixture.root, 'previous'))
  await fixture.component.configure(selected)
  const persisted = await readFile(fixture.settings, 'utf8')
  await mkdir(root)
  await writeFile(join(root, 'component.json'), '{not-json')
  await Promise.all(
    Array.from({ length: 52 }, (_, index) =>
      componentAt(join(root, 'components', `component-${String(index).padStart(2, '0')}`)),
    ),
  )
  const setup = new ComponentSetup(fixture.component, [root], async () => healthy())
  const detected = await setup.detect()
  assert.ok(detected.candidates.length <= 16)
  const invalid = detected.candidates.find(
    (candidate) => candidate.configPath === join(root, 'component.json'),
  )
  assert.ok(invalid)
  assert.equal(invalid.available, false)
  assert.ok(invalid.problem)
  await assert.rejects(setup.useCandidate(invalid.id))
  assert.equal(await readFile(fixture.settings, 'utf8'), persisted)
  assert.equal(
    fixture.component.runtime('whisperx', 'cpu').python,
    join(fixture.root, 'previous', 'runtime.exe'),
  )
})

test('candidate use rejects unknown identities, revalidates removed files, and persists an explicitly selected component', async () => {
  const fixture = await makeFixture(),
    root = join(fixture.root, 'near-app'),
    candidatePath = await componentAt(root),
    setup = new ComponentSetup(fixture.component, [root], async () => healthy())
  const detected = await setup.detect(),
    candidate = detected.candidates[0]!
  await assert.rejects(setup.useCandidate('00000000-0000-4000-8000-000000000000'))
  await unlink(join(root, 'runtime.exe'))
  await assert.rejects(setup.useCandidate(candidate.id))
  assert.equal(fixture.component.configured, false)
  await componentAt(root)
  const selected = await setup.useCandidate(candidate.id)
  assert.equal(selected.configured, true)
  assert.equal(selected.check, null)
  const reopened = new AsrComponent(fixture.settings, fixture.worker)
  await reopened.load()
  assert.equal(reopened.configured, true)
  assert.equal(
    reopened.runtime('whisperx', 'cpu').python,
    join(resolve(candidatePath, '..'), 'runtime.exe'),
  )
})

test('playback never adopts nearby components and reuses checks only after explicit selection', async () => {
  const fixture = await makeFixture(),
    directory = join(fixture.root, 'asr-component')
  await componentAt(directory)
  let probes = 0
  const setup = new ComponentSetup(fixture.component, [fixture.root], async () => {
    probes++
    return healthy()
  })
  try {
    assert.equal(fixture.component.configured, false)
    assert.equal(await setup.checkAutomatic(new AbortController().signal), null)
    assert.equal(fixture.component.configured, false)
    assert.equal(probes, 0)
    const detected = await setup.detect()
    assert.equal(detected.candidates.length, 1)
    assert.equal(detected.candidates[0]!.available, true)
    assert.equal(await setup.checkAutomatic(new AbortController().signal), null)
    assert.equal(fixture.component.configured, false)
    assert.equal(probes, 0)
    await assert.rejects(readFile(fixture.settings, 'utf8'), { code: 'ENOENT' })
    await setup.useCandidate(detected.candidates[0]!.id)
    const first = await setup.checkAutomatic(new AbortController().signal)
    assert.equal(first?.ready, true)
    assert.equal(fixture.component.configured, true)
    assert.equal(probes, 1)
    assert.equal(await setup.checkAutomatic(new AbortController().signal), first)
    assert.equal(probes, 1)
    await writeFile(
      join(directory, 'models.json'),
      JSON.stringify({ version: 1, models: {}, changed: 1 }),
    )
    assert.equal((await setup.checkAutomatic(new AbortController().signal))?.ready, true)
    assert.equal(probes, 2)
  } finally {
    setup.close()
  }
})

test('playback capability probes cancel independently and never cache a late result', async () => {
  const fixture = await makeFixture(),
    selected = await componentAt(join(fixture.root, 'component'))
  await fixture.component.configure(selected)
  const ui = deferred<ComponentCheck>(),
    automatic = deferred<ComponentCheck>(),
    uiStarted = deferred<AbortSignal>(),
    automaticStarted = deferred<AbortSignal>()
  let probes = 0
  const setup = new ComponentSetup(fixture.component, [], async (_runtime, _script, options) => {
    assert.ok(options?.signal)
    if (++probes === 1) {
      uiStarted.resolve(options.signal)
      return ui.promise
    }
    automaticStarted.resolve(options.signal)
    return automatic.promise
  })
  try {
    const uiChecking = setup.check()
    const uiSignal = await uiStarted.promise
    const controller = new AbortController()
    const preparing = setup.checkAutomatic(controller.signal)
    const automaticSignal = await automaticStarted.promise
    controller.abort()
    await assert.rejects(preparing, { name: 'AbortError' })
    assert.equal(automaticSignal.aborted, true)
    assert.equal(uiSignal.aborted, false)
    automatic.resolve(healthy())
    await new Promise<void>((done) => setImmediate(done))
    assert.equal((await setup.detect()).check, null)
    ui.resolve(healthy())
    assert.equal((await uiChecking).ready, true)
    setup.close()
    await assert.rejects(setup.checkAutomatic(new AbortController().signal), { name: 'AbortError' })
  } finally {
    setup.close()
  }
})

test('component checks cache only the selected component and reject late results after selection changes', async () => {
  const fixture = await makeFixture(),
    first = await componentAt(join(fixture.root, 'first')),
    second = await componentAt(join(fixture.root, 'second'))
  await fixture.component.configure(first)
  let release: (value: ComponentCheck) => void = () => undefined,
    entered: () => void = () => undefined
  const pending = new Promise<ComponentCheck>((resolve) => {
      release = resolve
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve
    })
  const setup = new ComponentSetup(fixture.component, [], async (runtime, script) => {
    assert.equal(runtime.python, join(fixture.root, 'first', 'runtime.exe'))
    assert.equal(script, fixture.component.probeScript)
    entered()
    return pending
  })
  const checking = setup.check()
  await started
  await fixture.component.configure(second)
  release(healthy())
  await assert.rejects(checking, { code: 'CONFLICT' })
  assert.equal((await setup.detect()).check, null)
  const current = new ComponentSetup(fixture.component, [], async () => healthy())
  const checked = await current.check()
  assert.deepEqual(checked, { ...healthy(), checkedAt: checked.checkedAt })
  assert.deepEqual((await current.detect()).check, checked)
})

test('preflight parsing validates per-device results and derives readiness instead of trusting worker flags', () => {
  const checked = parseComponentCheck(healthy())
  assert.ok(Number.isFinite(Date.parse(checked.checkedAt)))
  assert.deepEqual(checked, { ...healthy(), checkedAt: checked.checkedAt })
  assert.equal(parseComponentCheck({ ...healthy(), ready: 'untrusted' }).ready, true)
  assert.equal(
    parseComponentCheck({
      ...healthy(),
      ready: true,
      capabilities: healthy().capabilities.map((value) => ({ ...value, available: false })),
    }).ready,
    false,
  )
  const malformed = [
    null,
    {},
    { ...healthy(), level: 'model-inference' },
    { ...healthy(), freeBytes: -1 },
    { ...healthy(), freeBytes: Infinity },
    { ...healthy(), capabilities: healthy().capabilities.slice(1) },
    { ...healthy(), capabilities: Array(4).fill(healthy().capabilities[0]) },
  ]
  for (const value of malformed) assert.throws(() => parseComponentCheck(value))
})

test('automatic preflight reuses only a fresh positive report and invalidates changed model and sentence files', async (context) => {
  const fixture = await makeFixture(),
    directory = join(fixture.root, 'component'),
    selected = await componentAt(directory),
    model = join(directory, 'alignment-model'),
    sentence = join(directory, 'nltk', 'tokenizers', 'punkt_tab', 'english')
  await mkdir(model)
  await writeFile(join(model, 'pytorch_model.bin'), 'Fixture bytes; no weight loading.')
  await writeFile(
    join(directory, 'models.json'),
    JSON.stringify({ version: 1, models: { alignment: { path: model } } }),
  )
  await fixture.component.configure(selected)
  let calls = 0,
    now = Date.now()
  context.mock.method(Date, 'now', () => now)
  const setup = new ComponentSetup(fixture.component, [], async () => {
      calls++
      return healthy()
    }),
    runtime = fixture.component.runtime('whisperx', 'cpu'),
    signal = new AbortController().signal
  await setup.check()
  await setup.ensureRuntime(runtime, signal)
  await setup.ensureRuntime(runtime, signal)
  assert.equal(calls, 1)
  await writeFile(join(model, 'pytorch_model.bin'), 'Changed fixture model bytes; metadata only.')
  await setup.ensureRuntime(runtime, signal)
  assert.equal(calls, 2)
  await mkdir(sentence, { recursive: true })
  await writeFile(join(sentence, 'abbrev_types.txt'), 'New sentence resource.')
  await setup.ensureRuntime(runtime, signal)
  assert.equal(calls, 3)
  await writeFile(join(fixture.root, 'asr_security.py'), '# changed component patch policy')
  await setup.ensureRuntime(runtime, signal)
  assert.equal(calls, 4)
  await writeFile(join(fixture.root, 'asr-model-integrity.json'), '{"version":1}')
  await setup.ensureRuntime(runtime, signal)
  assert.equal(calls, 5)
  now += 5 * 60_000 + 1
  await setup.ensureRuntime(runtime, signal)
  assert.equal(calls, 6)
  setup.close()
})

test('automatic preflight rejects an unavailable requested profile and never reuses a non-cacheable manifest', async () => {
  const fixture = await makeFixture(),
    directory = join(fixture.root, 'component'),
    selected = await componentAt(directory)
  await fixture.component.configure(selected)
  let calls = 0
  const setup = new ComponentSetup(fixture.component, [], async () => {
      calls++
      return healthy()
    }),
    controller = new AbortController()
  await setup.check()
  await assert.rejects(
    setup.ensureRuntime(fixture.component.runtime('whisperx', 'cuda'), controller.signal),
    { code: 'RUNTIME_UNAVAILABLE' },
  )
  assert.equal(calls, 2)
  await writeFile(join(directory, 'models.json'), 'x'.repeat(65_537))
  await setup.ensureRuntime(fixture.component.runtime('whisperx', 'cpu'), controller.signal)
  await setup.ensureRuntime(fixture.component.runtime('whisperx', 'cpu'), controller.signal)
  assert.equal(calls, 4)
  setup.close()
})

test('canceling automatic preflight promptly rejects without late submit or canceling an independent UI check', async () => {
  const fixture = await makeFixture(),
    selected = await componentAt(join(fixture.root, 'component'))
  await fixture.component.configure(selected)
  const ui = deferred<ComponentCheck>(),
    job = deferred<ComponentCheck>(),
    uiStarted = deferred<AbortSignal>(),
    jobStarted = deferred<AbortSignal>()
  let calls = 0,
    lateSubmits = 0
  const setup = new ComponentSetup(fixture.component, [], async (_runtime, _script, options) => {
    calls++
    assert.ok(options?.signal)
    if (calls === 1) {
      uiStarted.resolve(options.signal)
      return ui.promise
    }
    jobStarted.resolve(options.signal)
    return job.promise
  })
  const uiChecking = setup.check(),
    uiSignal = await uiStarted.promise,
    controller = new AbortController(),
    preparing = setup
      .ensureRuntime(fixture.component.runtime('whisperx', 'cpu'), controller.signal)
      .then(() => {
        lateSubmits++
      })
  const jobSignal = await jobStarted.promise
  controller.abort()
  await assert.rejects(preparing, { name: 'AbortError' })
  assert.equal(jobSignal.aborted, true)
  assert.equal(uiSignal.aborted, false)
  job.resolve(healthy())
  await new Promise<void>((done) => setImmediate(done))
  assert.equal(lateSubmits, 0)
  assert.equal((await setup.detect()).check, null)
  ui.resolve(healthy())
  assert.equal((await uiChecking).ready, true)
  assert.equal((await setup.detect()).check?.ready, true)
  setup.close()
})

test('closing component setup aborts its UI probe and rejects new checks without caching late results', async () => {
  const fixture = await makeFixture(),
    selected = await componentAt(join(fixture.root, 'component'))
  await fixture.component.configure(selected)
  const result = deferred<ComponentCheck>(),
    started = deferred<AbortSignal>()
  const setup = new ComponentSetup(fixture.component, [], async (_runtime, _script, options) => {
    assert.ok(options?.signal)
    started.resolve(options.signal)
    return result.promise
  })
  const checking = setup.check(),
    signal = await started.promise
  setup.close()
  assert.equal(signal.aborted, true)
  await assert.rejects(checking, { name: 'AbortError' })
  result.resolve(healthy())
  await new Promise<void>((done) => setImmediate(done))
  assert.equal((await setup.detect()).check, null)
  await assert.rejects(setup.check(), { name: 'AbortError' })
  await assert.rejects(
    setup.ensureRuntime(fixture.component.runtime('whisperx', 'cpu'), new AbortController().signal),
    { name: 'AbortError' },
  )
})

test('automatic preflight rejects a different runtime before probing and rejects files changed during a probe', async () => {
  const fixture = await makeFixture(),
    directory = join(fixture.root, 'component'),
    selected = await componentAt(directory)
  await fixture.component.configure(selected)
  const result = deferred<ComponentCheck>(),
    started = deferred<void>()
  let calls = 0
  const setup = new ComponentSetup(fixture.component, [], async () => {
      calls++
      started.resolve()
      return result.promise
    }),
    runtime = fixture.component.runtime('whisperx', 'cpu'),
    signal = new AbortController().signal
  await assert.rejects(
    setup.ensureRuntime({ ...runtime, python: join(fixture.root, 'different.exe') }, signal),
    { code: 'CONFLICT' },
  )
  assert.equal(calls, 0)
  const checking = setup.ensureRuntime(runtime, signal)
  await started.promise
  await writeFile(runtime.models, JSON.stringify({ version: 1, models: {}, changed: true }))
  result.resolve(healthy())
  await assert.rejects(checking, { code: 'CONFLICT' })
  assert.equal((await setup.detect()).check, null)
  setup.close()
})

let stdlibPython: string | undefined
try {
  stdlibPython = execFileSync('python', ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
} catch {
  /* Optional isolated process-protocol check; ordinary unit tests need no Python. */
}

test(
  'the bounded probe process handles valid output, failures, malformed JSON, excess output, and timeout without claiming readiness',
  { skip: !stdlibPython },
  async () => {
    const fixture = await makeFixture(),
      runtime: AsrRuntime = {
        python: stdlibPython!,
        script: fixture.worker,
        models: join(fixture.root, 'models.json'),
        cache: fixture.root,
        ffmpeg: stdlibPython!,
        ffprobe: stdlibPython!,
        engine: 'whisperx',
        device: 'cpu',
        compute: 'int8',
      }
    await writeFile(runtime.models, JSON.stringify({ version: 1, models: {} }))
    const script = fixture.component.probeScript
    await writeFile(script, `print(${JSON.stringify(JSON.stringify(healthy()))})\n`)
    const checked = await runComponentProbe(runtime, script)
    assert.deepEqual(checked, { ...healthy(), checkedAt: checked.checkedAt })
    for (const code of [
      'import sys\nprint("fixture failure", file=sys.stderr)\nsys.exit(7)\n',
      'print("not json")\n',
      'print("x" * 100000)\n',
      'import time\ntime.sleep(10)\n',
    ]) {
      await writeFile(script, code)
      const failed = await runComponentProbe(runtime, script, { timeoutMs: 300, maxBuffer: 4096 })
      assert.equal(failed.ready, false)
      assert.equal(failed.level, 'imports-and-files')
      assert.equal(failed.capabilities.length, 4)
      assert.ok(failed.capabilities.every((value) => !value.available))
      assert.ok(failed.issues.length)
    }
  },
)

test(
  'a real probe child is canceled promptly and a pre-aborted request never launches it',
  { skip: !stdlibPython },
  async () => {
    const fixture = await makeFixture(),
      script = fixture.component.probeScript,
      marker = join(fixture.root, 'probe-started'),
      runtime: AsrRuntime = {
        python: stdlibPython!,
        script: fixture.worker,
        models: join(fixture.root, 'models.json'),
        cache: fixture.root,
        ffmpeg: stdlibPython!,
        ffprobe: stdlibPython!,
        engine: 'whisperx',
        device: 'cpu',
        compute: 'int8',
      }
    await writeFile(
      script,
      `from pathlib import Path\nimport time\nPath(${JSON.stringify(marker).replaceAll('\\', '\\\\')}).write_text('started')\ntime.sleep(10)\n`,
    )
    const controller = new AbortController(),
      checking = runComponentProbe(runtime, script, { signal: controller.signal })
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      try {
        await readFile(marker)
        break
      } catch {
        await new Promise<void>((done) => setTimeout(done, 20))
      }
    }
    await readFile(marker)
    const canceledAt = Date.now()
    controller.abort()
    const value = await checking
    assert.ok(Date.now() - canceledAt < 1500)
    assert.equal(value.ready, false)
    await unlink(marker)
    const alreadyCanceled = new AbortController()
    alreadyCanceled.abort()
    assert.equal(
      (await runComponentProbe(runtime, script, { signal: alreadyCanceled.signal })).ready,
      false,
    )
    await assert.rejects(readFile(marker), { code: 'ENOENT' })
  },
)
