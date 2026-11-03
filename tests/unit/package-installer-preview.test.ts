import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  assertInstallerRunner,
  copyLockedProductionModule,
  installerConfiguration,
  parseInstallerArguments,
  validateInstallerDependencyLock,
  verifyFrozenInstallerInput,
} from '../../scripts/build/package-installer-preview'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const previewVersion = '0.41.0-dev.1'
const dependencies = { react: '19.3.1' }
const legal = { LICENSE: 'MIT synthetic fixture', 'THIRD_PARTY_NOTICES.md': 'Synthetic notices' }
const appOutputs = {
  'main/index.js': 'console.log("synthetic")',
  'renderer/index.html': '<p>Test</p>',
}
const python = { 'asr_runtime.py': '# synthetic runtime', 'evaluation-models.json': '{}' }
const originalOutputs = { 'preserved.txt': 'existing output must remain untouched' }

async function write(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value)
}
async function writeJson(path: string, value: unknown) {
  await write(path, JSON.stringify(value))
}
const hashes = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([path, value]) => [path, digest(value)]))

function dependencyLock(current: {
  name: string
  version: string
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}) {
  return {
    name: current.name,
    version: current.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: current.name,
        version: current.version,
        dependencies: { ...current.dependencies },
        devDependencies: { ...current.devDependencies },
      },
      'node_modules/electron': { version: current.devDependencies.electron },
      'node_modules/react': { version: current.dependencies.react },
    },
  }
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'pageecho-installer-unit-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspace = join(directory, 'workspace')
  const appRoot = join(workspace, 'cache', 'frozen', 'app')
  const manifestPath = join(dirname(appRoot), 'manifest.json')
  for (const [path, value] of Object.entries(appOutputs))
    await write(join(appRoot, 'out', path), value)
  for (const [path, value] of Object.entries(python))
    await write(join(appRoot, 'python', path), value)
  for (const [path, value] of Object.entries(originalOutputs))
    await write(join(workspace, 'out', path), value)
  for (const [path, value] of Object.entries(legal)) {
    await write(join(appRoot, path), value)
    await write(join(workspace, path), value)
  }
  const pkg = {
    name: 'read-and-listen-book',
    version: previewVersion,
    license: 'MIT',
    type: 'module',
    main: './out/main/index.js',
    dependencies: { ...dependencies },
  }
  const current = { ...pkg, version: '0.8.4', devDependencies: { electron: '44.9.1' } }
  const manifest = {
    status: 'built',
    previewVersion,
    appRoot,
    originalOutputUnchanged: true,
    outputHashes: hashes(appOutputs),
    pythonHashes: hashes(python),
    originalOutputHashes: hashes(originalOutputs),
  }
  await writeJson(join(appRoot, 'package.json'), pkg)
  await writeJson(join(workspace, 'package.json'), current)
  const lock = dependencyLock(current)
  await writeJson(join(workspace, 'package-lock.json'), lock)
  await writeJson(manifestPath, manifest)
  return { directory, workspace, appRoot, manifestPath, pkg, current, manifest, lock }
}

function configuration() {
  return {
    appId: 'com.readandlistenbook.desktop',
    productName: 'PageEcho',
    directories: { output: 'release' },
    files: ['out/**/*', 'package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md'],
    asar: true,
    extraResources: [
      {
        from: 'python',
        to: 'asr',
        filter: ['asr_*.py', 'evaluation-models.json', 'asr-model-integrity.json'],
      },
    ],
    npmRebuild: false,
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      artifactName: 'PageEcho-${version}-win-${arch}-setup.${ext}',
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: true,
      deleteAppDataOnUninstall: false,
      createDesktopShortcut: true,
      runAfterFinish: false,
      shortcutName: '听见书页',
    },
  }
}

test('installer entry accepts only a frozen app root and optional local plan mode', () => {
  const appRoot = join(tmpdir(), 'synthetic preview with spaces', 'app')
  assert.deepEqual(parseInstallerArguments(['--app-root', appRoot]), {
    appRoot: resolve(appRoot),
    planOnly: false,
  })
  assert.deepEqual(parseInstallerArguments(['--app-root', appRoot, '--plan-only']), {
    appRoot: resolve(appRoot),
    planOnly: true,
  })
  for (const args of [
    [],
    ['--app-root'],
    ['--app-root', ''],
    ['--app-root', 'bad\0root'],
    ['--app-root', '--publish'],
    ['--directory', appRoot],
    ['--app-root', appRoot, '--force'],
    ['--app-root', appRoot, '--plan-only', '--publish'],
  ])
    assert.throws(() => parseInstallerArguments(args), JSON.stringify(args))
})

test('NSIS execution requires every disposable Windows runner opt-in; plans do not enable it', () => {
  const environment = {
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    RUNNER_OS: 'Windows',
    RUNNER_TEMP: resolve(tmpdir(), 'synthetic-runner'),
    PAGEECHO_INSTALLER_BUILD: '1',
  }
  assert.doesNotThrow(() => assertInstallerRunner(environment, 'win32'))
  assert.throws(() => assertInstallerRunner({}, 'win32'), /disposable Windows Actions runner/)
  assert.throws(() => assertInstallerRunner(environment, 'linux'), /disposable/)
  for (const key of Object.keys(environment)) {
    const missing: NodeJS.ProcessEnv = { ...environment }
    Reflect.deleteProperty(missing, key)
    assert.throws(() => assertInstallerRunner(missing, 'win32'), /disposable/, key)
  }
  for (const changes of [
    { CI: 'false' },
    { GITHUB_ACTIONS: 'false' },
    { RUNNER_OS: 'Linux' },
    { RUNNER_TEMP: 'relative-runner-temp' },
    { PAGEECHO_INSTALLER_BUILD: 'true' },
  ])
    assert.throws(
      () => assertInstallerRunner({ ...environment, ...changes }, 'win32'),
      /disposable/,
    )
})

test('frozen installer input uses the preview release version and records reproducible digests', async (t) => {
  const f = await fixture(t)
  const result = await verifyFrozenInstallerInput(f.appRoot, f.workspace)
  assert.equal(result.pkg.version, previewVersion)
  assert.notEqual(result.pkg.version, f.current.version)
  assert.equal(result.electronVersion, '44.9.1')
  assert.equal(result.manifestSha256, digest(await readFile(f.manifestPath, 'utf8')))
  assert.equal(
    result.lockSha256,
    digest(await readFile(join(f.workspace, 'package-lock.json'), 'utf8')),
  )
  assert.deepEqual(result.build.outputHashes, hashes(appOutputs))
  assert.deepEqual(result.build.pythonHashes, hashes(python))
  assert.deepEqual(result.build.originalOutputHashes, hashes(originalOutputs))
  assert.deepEqual(await verifyFrozenInstallerInput(f.appRoot, f.workspace), result)
})

test('an empty protected root out inventory is supported for a new runner checkout', async (t) => {
  const f = await fixture(t)
  await rm(join(f.workspace, 'out', 'preserved.txt'))
  f.manifest.originalOutputHashes = {}
  await writeJson(f.manifestPath, f.manifest)
  const result = await verifyFrozenInstallerInput(f.appRoot, f.workspace)
  assert.deepEqual(result.build.originalOutputHashes, {})
})

test('installer accepts only a v3 lock bound to the current root, Electron and production versions', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(validateInstallerDependencyLock(f.lock, f.current), f.lock.packages)
  const changeRoot = (changes: Record<string, unknown>) => ({
    ...f.lock,
    packages: { ...f.lock.packages, '': { ...f.lock.packages[''], ...changes } },
  })
  for (const invalid of [
    {},
    { lockfileVersion: 3, packages: {} },
    { ...f.lock, lockfileVersion: 2 },
    { ...f.lock, packages: { ...f.lock.packages, '': null } },
    { ...f.lock, packages: { ...f.lock.packages, 'node_modules/electron': null } },
    changeRoot({ name: 'different-root' }),
    changeRoot({ version: '0.8.3' }),
    changeRoot({ dependencies: { react: '19.3.2' } }),
    changeRoot({ devDependencies: { electron: '44.9.0' } }),
    {
      ...f.lock,
      packages: { ...f.lock.packages, 'node_modules/electron': { version: '44.9.0' } },
    },
    {
      ...f.lock,
      packages: { ...f.lock.packages, 'node_modules/react': { version: '19.3.2' } },
    },
  ]) {
    assert.throws(() => validateInstallerDependencyLock(invalid, f.current))
    await writeJson(join(f.workspace, 'package-lock.json'), invalid)
    await assert.rejects(verifyFrozenInstallerInput(f.appRoot, f.workspace))
  }
})

test('ordinary lock-matching production modules copy their exact nested and binary bytes', async (t) => {
  const f = await fixture(t)
  const source = join(f.workspace, 'node_modules', 'react')
  const destination = join(f.directory, 'isolated-project', 'node_modules', 'react')
  const packageBytes = JSON.stringify({ name: 'react', version: '19.3.1', main: './lib/index.js' })
  const moduleBytes = 'export const sample = "synthetic module"\n'
  const binaryBytes = Buffer.from([0, 1, 127, 128, 255, 0, 33])
  await write(join(source, 'package.json'), packageBytes)
  await write(join(source, 'lib', 'index.js'), moduleBytes)
  await writeFile(join(source, 'lib', 'synthetic.bin'), binaryBytes)
  const result = await copyLockedProductionModule(
    source,
    destination,
    validateInstallerDependencyLock(f.lock, f.current),
    f.workspace,
  )
  assert.equal(result.path, 'node_modules/react')
  assert.equal(result.version, '19.3.1')
  assert.equal(result.files, 3)
  assert.match(result.inventorySha256, /^[a-f0-9]{64}$/)
  for (const [path, expected] of [
    ['package.json', Buffer.from(packageBytes)],
    ['lib/index.js', Buffer.from(moduleBytes)],
    ['lib/synthetic.bin', binaryBytes],
  ] as const) {
    assert.deepEqual(await readFile(join(destination, path)), expected)
    assert.deepEqual(await readFile(join(source, path)), expected)
  }
})

test('production copying refuses modules outside node_modules, absent locks and stale installed versions', async (t) => {
  const f = await fixture(t)
  const source = join(f.workspace, 'node_modules', 'react')
  const destination = join(f.directory, 'isolated-project', 'node_modules', 'react')
  const packages = validateInstallerDependencyLock(f.lock, f.current)
  await writeJson(join(source, 'package.json'), { name: 'react', version: '19.3.0' })
  await assert.rejects(
    copyLockedProductionModule(source, destination, packages, f.workspace),
    /Installed production module version differs/,
  )
  await assert.rejects(readFile(join(destination, 'package.json')), { code: 'ENOENT' })
  await assert.rejects(
    copyLockedProductionModule(source, destination, {}, f.workspace),
    /no ordinary locked package/,
  )
  await assert.rejects(
    copyLockedProductionModule(
      source,
      destination,
      { ...packages, 'node_modules/react': { version: '19.3.0', link: true } },
      f.workspace,
    ),
    /no ordinary locked package/,
  )
  for (const outside of [
    f.workspace,
    join(f.workspace, 'node_modules'),
    join(f.workspace, 'node_modules-adjacent', 'react'),
    join(f.directory, 'external-react'),
  ])
    await assert.rejects(
      copyLockedProductionModule(outside, destination, packages, f.workspace),
      /escaped node_modules/,
    )
})

test('production copying refuses a junction module and linked descendants', async (t) => {
  for (const linkedModule of [true, false]) {
    await t.test(linkedModule ? 'module junction' : 'descendant junction', async (subtest) => {
      const f = await fixture(subtest)
      const source = join(f.workspace, 'node_modules', 'react')
      const outside = join(f.directory, 'synthetic-external-package')
      const destination = join(f.directory, 'isolated-project', 'node_modules', 'react')
      await writeJson(join(outside, 'package.json'), { name: 'react', version: '19.3.1' })
      await mkdir(dirname(source), { recursive: true })
      try {
        if (linkedModule)
          await symlink(outside, source, process.platform === 'win32' ? 'junction' : 'dir')
        else {
          await writeJson(join(source, 'package.json'), { name: 'react', version: '19.3.1' })
          await symlink(
            outside,
            join(source, 'linked-content'),
            process.platform === 'win32' ? 'junction' : 'dir',
          )
        }
      } catch (error) {
        if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          subtest.skip('Host does not allow creating a synthetic directory link')
          return
        }
        throw error
      }
      await assert.rejects(
        copyLockedProductionModule(
          source,
          destination,
          validateInstallerDependencyLock(f.lock, f.current),
          f.workspace,
        ),
        linkedModule ? /must not traverse links or aliases/ : /must not contain links/,
      )
      await assert.rejects(readFile(join(destination, 'package.json')), { code: 'ENOENT' })
    })
  }
})

test('changed and undeclared application or Python files are rejected', async (t) => {
  for (const [area, path] of [
    ['out', 'main/index.js'],
    ['out', 'private-download.txt'],
    ['python', 'asr_runtime.py'],
    ['python', 'unlisted-model.bin'],
  ]) {
    await t.test(`${area}/${path}`, async (subtest) => {
      const f = await fixture(subtest)
      await write(join(f.appRoot, area!, path!), 'changed synthetic bytes')
      await assert.rejects(
        verifyFrozenInstallerInput(f.appRoot, f.workspace),
        area === 'out' ? /Frozen application outputs changed/ : /Frozen Python resources changed/,
      )
    })
  }
})

test('the original root out cannot be modified, extended or removed by a package run', async (t) => {
  for (const action of ['change', 'add', 'remove']) {
    await t.test(action, async (subtest) => {
      const f = await fixture(subtest)
      if (action === 'remove') await rm(join(f.workspace, 'out', 'preserved.txt'))
      else
        await write(
          join(f.workspace, 'out', action === 'add' ? 'unexpected.txt' : 'preserved.txt'),
          'new synthetic output',
        )
      await assert.rejects(
        verifyFrozenInstallerInput(f.appRoot, f.workspace),
        /Protected root out\/ changed/,
      )
    })
  }
})

test('a failed, mismatched or non-release preview manifest cannot be packaged', async (t) => {
  const cases = [
    { status: 'failed' },
    { originalOutputUnchanged: false },
    { previewVersion: '0.41.0' },
    { previewVersion: '0.41.0-dev.1\n' },
    { previewVersion: '0.41.0-dev.2' },
    { appRoot: tmpdir() },
  ]
  for (const changes of cases) {
    await t.test(JSON.stringify(changes), async (subtest) => {
      const f = await fixture(subtest)
      await writeJson(f.manifestPath, { ...f.manifest, ...changes })
      await assert.rejects(verifyFrozenInstallerInput(f.appRoot, f.workspace))
    })
  }
})

test('frozen inventories reject path traversal, Windows aliases and invalid digests', async (t) => {
  for (const outputHashes of [
    { '../outside.js': digest('outside') },
    { '/absolute.js': digest('outside') },
    { 'C:/absolute.js': digest('outside') },
    { 'main\\index.js': digest('outside') },
    { 'main/./index.js': digest('outside') },
    { 'main//index.js': digest('outside') },
    { 'bad\0name': digest('outside') },
    { 'main/index.js': digest('one'), 'MAIN/INDEX.JS': digest('two') },
    { 'main/index.js': 'not-a-sha256' },
    {},
  ]) {
    await t.test(JSON.stringify(outputHashes), async (subtest) => {
      const f = await fixture(subtest)
      await writeJson(f.manifestPath, { ...f.manifest, outputHashes })
      await assert.rejects(verifyFrozenInstallerInput(f.appRoot, f.workspace), /Invalid/)
    })
  }
})

test('installer input rejects symlinked frozen roots and linked content', async (t) => {
  const f = await fixture(t)
  const outside = join(f.directory, 'external-content')
  await mkdir(outside)
  await write(join(outside, 'private.txt'), 'synthetic external content')
  const linkedRoot = join(f.directory, 'app-junction')
  try {
    await symlink(f.appRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(
      outside,
      join(f.appRoot, 'out', 'external-junction'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('Host does not allow creating a synthetic directory link')
      return
    }
    throw error
  }
  await assert.rejects(
    verifyFrozenInstallerInput(linkedRoot, f.workspace),
    /ordinary frozen directory/,
  )
  await assert.rejects(verifyFrozenInstallerInput(f.appRoot, f.workspace), /must not contain links/)
})

test('MIT notices, dependency pins and internal identity remain bound to the frozen preview', async (t) => {
  const cases = [
    { name: 'different-internal-identity' },
    { version: '0.8.4' },
    { license: 'UNLICENSED' },
    { main: './alternate.js' },
    { dependencies: { react: '^19.3.1' } },
    { dependencies: { react: '19.3.2' } },
  ]
  for (const changes of cases) {
    await t.test(JSON.stringify(changes), async (subtest) => {
      const f = await fixture(subtest)
      await writeJson(join(f.appRoot, 'package.json'), { ...f.pkg, ...changes })
      await assert.rejects(verifyFrozenInstallerInput(f.appRoot, f.workspace))
    })
  }
  for (const name of Object.keys(legal)) {
    await t.test(name, async (subtest) => {
      const f = await fixture(subtest)
      await write(join(f.appRoot, name), 'replaced license or notice')
      await assert.rejects(verifyFrozenInstallerInput(f.appRoot, f.workspace), /Frozen .* changed/)
    })
  }
})

test('frozen package metadata rejects scripts, build settings and private fields', async (t) => {
  for (const extra of [
    { scripts: { postinstall: 'synthetic hook that must never execute' } },
    { build: { afterPack: './synthetic-hook.js' } },
    { privateNotes: { token: 'synthetic-placeholder' } },
    { credentials: { profile: 'synthetic-only' } },
  ]) {
    await t.test(Object.keys(extra)[0]!, async (subtest) => {
      const f = await fixture(subtest)
      await writeJson(join(f.appRoot, 'package.json'), { ...f.pkg, ...extra })
      await assert.rejects(
        verifyFrozenInstallerInput(f.appRoot, f.workspace),
        /must not contain scripts, build hooks or private fields/,
      )
    })
  }
})

test('installer configuration fixes NSIS identity and retention while overriding only the output', () => {
  const original = configuration()
  const snapshot = structuredClone(original)
  const output = resolve(tmpdir(), 'fresh generated installer output')
  const result = installerConfiguration(original, output, '44.9.1')
  assert.deepEqual(result, { ...snapshot, directories: { output }, electronVersion: '44.9.1' })
  assert.deepEqual(original, snapshot)
  assert.equal(result.appId, 'com.readandlistenbook.desktop')
  assert.equal(original.nsis.deleteAppDataOnUninstall, false)
  assert.equal(original.nsis.runAfterFinish, false)
  assert.equal(original.nsis.perMachine, false)
})

test('installer configuration refuses publishers, build hooks, data inclusion and installer policy changes', () => {
  for (const mutate of [
    (value: ReturnType<typeof configuration>) => ({ ...value, publish: ['github'] }),
    (value: ReturnType<typeof configuration>) => ({ ...value, afterPack: './hook.js' }),
    (value: ReturnType<typeof configuration>) => ({ ...value, appId: 'new.identity' }),
    (value: ReturnType<typeof configuration>) => ({ ...value, files: ['**/*'] }),
    (value: ReturnType<typeof configuration>) => ({ ...value, asar: false }),
    (value: ReturnType<typeof configuration>) => ({ ...value, npmRebuild: true }),
    (value: ReturnType<typeof configuration>) => ({
      ...value,
      extraResources: [
        ...value.extraResources,
        { from: 'data', to: 'user-data', filter: ['**/*'] },
      ],
    }),
    (value: ReturnType<typeof configuration>) => ({
      ...value,
      nsis: { ...value.nsis, deleteAppDataOnUninstall: true },
    }),
    (value: ReturnType<typeof configuration>) => ({
      ...value,
      nsis: { ...value.nsis, perMachine: true },
    }),
    (value: ReturnType<typeof configuration>) => ({
      ...value,
      nsis: { ...value.nsis, runAfterFinish: true },
    }),
    (value: ReturnType<typeof configuration>) => ({
      ...value,
      nsis: { ...value.nsis, allowElevation: true },
    }),
    (value: ReturnType<typeof configuration>) => ({
      ...value,
      win: { target: [{ target: 'dir' }] },
    }),
  ])
    assert.throws(() =>
      installerConfiguration(mutate(configuration()), resolve(tmpdir(), 'output'), '44.9.1'),
    )
})
