import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import type { BigIntStatsFs, PathLike, StatFsOptions, StatsFs } from 'node:fs'
import fs, { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'
import { AsrComponent } from '../../src/main/asr-component'
import { ComponentInstallerCore } from '../../src/main/component-installation/core'
import { ComponentInstallationService } from '../../src/main/component-installation/service'
import type { TrustedBundle } from '../../src/main/component-installation/core-types'
import type { ComponentProfile } from '../../src/shared/component-installation'

// Only Node unit tests supply this synthetic trust catalog to the real core.
// There is no renderer path, runtime switch, alternate production catalog, model,
// executable Python, network request, or large real component in these fixtures.
const whisper: ComponentProfile = { engine: 'whisperx', device: 'cpu' },
  paraformer: ComponentProfile = { engine: 'paraformer', device: 'cpu' },
  sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex'),
  signal = () => new AbortController().signal,
  progress = () => {}

interface ZipEntry {
  path: string
  bytes: Buffer
  mode?: number
  flags?: number
}
interface Manifest {
  version: number
  platform: string
  complete: boolean
  bytes: number
  files: { path: string; bytes: number; sha256: string }[]
}
function zip(entries: readonly ZipEntry[], zip64 = false) {
  const local: Buffer[] = [],
    central: Buffer[] = [],
    locations = new Map<string, number>()
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.path),
      payload = deflateRawSync(entry.bytes),
      localExtra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0),
      centralExtra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0)
    if (zip64) {
      localExtra.writeUInt16LE(1)
      localExtra.writeUInt16LE(16, 2)
      localExtra.writeBigUInt64LE(BigInt(entry.bytes.length), 4)
      localExtra.writeBigUInt64LE(BigInt(payload.length), 12)
      centralExtra.writeUInt16LE(1)
      centralExtra.writeUInt16LE(24, 2)
      centralExtra.writeBigUInt64LE(BigInt(entry.bytes.length), 4)
      centralExtra.writeBigUInt64LE(BigInt(payload.length), 12)
      centralExtra.writeBigUInt64LE(BigInt(offset), 20)
    }
    const header = Buffer.alloc(30),
      directory = Buffer.alloc(46),
      flags = entry.flags ?? 0x800
    header.writeUInt32LE(0x04034b50)
    header.writeUInt16LE(zip64 ? 45 : 20, 4)
    header.writeUInt16LE(flags, 6)
    header.writeUInt16LE(8, 8)
    header.writeUInt32LE(crc32(entry.bytes), 14)
    header.writeUInt32LE(zip64 ? 0xffffffff : payload.length, 18)
    header.writeUInt32LE(zip64 ? 0xffffffff : entry.bytes.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(localExtra.length, 28)
    directory.writeUInt32LE(0x02014b50)
    directory.writeUInt16LE(0x300 | (zip64 ? 45 : 20), 4)
    directory.writeUInt16LE(zip64 ? 45 : 20, 6)
    directory.writeUInt16LE(flags, 8)
    directory.writeUInt16LE(8, 10)
    directory.writeUInt32LE(crc32(entry.bytes), 16)
    directory.writeUInt32LE(zip64 ? 0xffffffff : payload.length, 20)
    directory.writeUInt32LE(zip64 ? 0xffffffff : entry.bytes.length, 24)
    directory.writeUInt16LE(name.length, 28)
    directory.writeUInt16LE(centralExtra.length, 30)
    directory.writeUInt32LE(((entry.mode ?? 0o100644) * 65536) >>> 0, 38)
    directory.writeUInt32LE(zip64 ? 0xffffffff : offset, 42)
    locations.set(entry.path, offset + header.length + name.length + localExtra.length)
    local.push(header, name, localExtra, payload)
    central.push(directory, name, centralExtra)
    offset += header.length + name.length + localExtra.length + payload.length
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22),
    extra: Buffer[] = []
  if (zip64) {
    const extended = Buffer.alloc(56),
      locator = Buffer.alloc(20)
    extended.writeUInt32LE(0x06064b50)
    extended.writeBigUInt64LE(44n, 4)
    extended.writeUInt16LE(45, 12)
    extended.writeUInt16LE(45, 14)
    extended.writeBigUInt64LE(BigInt(entries.length), 24)
    extended.writeBigUInt64LE(BigInt(entries.length), 32)
    extended.writeBigUInt64LE(BigInt(directory.length), 40)
    extended.writeBigUInt64LE(BigInt(offset), 48)
    locator.writeUInt32LE(0x07064b50)
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8)
    locator.writeUInt32LE(1, 16)
    extra.push(extended, locator)
  }
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8)
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10)
  end.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12)
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16)
  return { bytes: Buffer.concat([...local, directory, ...extra, end]), locations }
}
async function fixture(
  options: {
    zip64?: boolean
    extras?: ZipEntry[]
    largeWhisper?: boolean
    manifest?: (value: Manifest) => void
    archive?: (value: Buffer, locations: Map<string, number>) => void
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), '听读 安装安全 ')),
    managed = join(root, 'managed'),
    oldSettings = join(root, 'asr-component.json'),
    oldSettingsBytes = Buffer.from('existing manually selected component configuration')
  await mkdir(managed)
  await writeFile(oldSettings, oldSettingsBytes)
  const files = new Map<string, Buffer>([
    ['python/python.exe', Buffer.from('unit fixture, never executable')],
    ['tools/ffmpeg.exe', Buffer.from('fixture ffmpeg')],
    ['tools/ffprobe.exe', Buffer.from('fixture ffprobe')],
    ['resources/nltk/tokenizers/punkt_tab/english/abbrev_types.txt', Buffer.from('etc\n')],
    [
      'component.json',
      Buffer.from(
        JSON.stringify({
          version: 2,
          python: '../../outside.exe',
          models: '../../models.json',
          resources: '../..',
          ffmpeg: '../../outside.exe',
          ffprobe: '../../outside.exe',
        }),
      ),
    ],
  ])
  const roles = ['paraformer', 'vad', 'punctuation', 'whisper', 'alignment']
  files.set(
    'models.json',
    Buffer.from(
      JSON.stringify({
        version: 1,
        models: Object.fromEntries(
          roles.map((role) => [
            role,
            { repository: `fixture/${role}`, revision: 'a'.repeat(40), path: `models/${role}` },
          ]),
        ),
      }),
    ),
  )
  for (const role of roles)
    files.set(
      `models/${role}/weights.bin`,
      role === 'whisper' && options.largeWhisper
        ? randomBytes(2 * 1024 * 1024)
        : Buffer.from(`model fixture ${role}`),
    )
  const manifest: Manifest = {
    version: 1,
    platform: 'win-amd64',
    complete: true,
    bytes: [...files.values()].reduce((sum, value) => sum + value.length, 0),
    files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes) })),
  }
  options.manifest?.(manifest)
  const manifestBytes = Buffer.from(JSON.stringify(manifest)),
    archive = zip(
      [
        { path: 'bundle-manifest.json', bytes: manifestBytes },
        ...[...files].map(([path, bytes]) => ({ path, bytes })),
        ...(options.extras ?? []),
      ],
      options.zip64,
    )
  options.archive?.(archive.bytes, archive.locations)
  const path = join(root, 'trusted-fixture.zip'),
    catalog: TrustedBundle = {
      id: 'unit-bundle',
      version: '0.0.0-unit',
      archiveBytes: archive.bytes.length,
      archiveSha256: sha(archive.bytes),
      manifestSha256: sha(manifestBytes),
    }
  await writeFile(path, archive.bytes)
  return {
    root,
    managed,
    oldSettings,
    oldSettingsBytes,
    path,
    catalog,
    archiveBytes: archive.bytes,
    files,
    core: new ComponentInstallerCore(managed, [catalog]),
  }
}
async function tree(root: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) result.push(...(await tree(path)))
    else result.push(path)
  }
  return result
}
async function install(t: Awaited<ReturnType<typeof fixture>>, profile = whisper) {
  const plan = await t.core.inspect(t.path, profile, signal(), progress)
  return t.core.install(plan, signal(), progress)
}
async function preserveSource(t: Awaited<ReturnType<typeof fixture>>) {
  assert.equal(sha(await readFile(t.path)), t.catalog.archiveSha256)
  assert.deepEqual(await readFile(t.oldSettings), t.oldSettingsBytes)
}
async function noSpace(t: TestContext, path: string) {
  const actual = await fs.statfs(path),
    actualBigInt = await fs.statfs(path, { bigint: true })
  function emptyDisk(path: PathLike, options?: StatFsOptions & { bigint?: false }): Promise<StatsFs>
  function emptyDisk(
    path: PathLike,
    options: StatFsOptions & { bigint: true },
  ): Promise<BigIntStatsFs>
  function emptyDisk(path: PathLike, options?: StatFsOptions): Promise<StatsFs | BigIntStatsFs>
  async function emptyDisk(_path: PathLike, options?: StatFsOptions) {
    return options?.bigint
      ? { ...actualBigInt, bavail: 0n, bfree: 0n }
      : { ...actual, bavail: 0, bfree: 0 }
  }
  t.mock.method(fs, 'statfs', emptyDisk)
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
}

test('a small genuine ZIP64 archive installs, then adding another engine reuses shared runtime and existing model groups', async () => {
  const t = await fixture({ zip64: true }),
    first = await install(t)
  await t.core.verify(first, signal(), progress)
  const initial = await tree(join(t.managed, 'a')),
    python = initial.filter((path) => basename(path) === 'python.exe')
  assert.equal(python.length, 1)
  assert.equal(
    initial.some((path) => path.includes(`${join('models', 'paraformer')}`)),
    false,
  )
  assert.equal(
    initial.some((path) => path.includes(`${join('models', 'vad')}`)),
    false,
  )
  const before = await stat(python[0]!),
    beforeHash = sha(await readFile(python[0]!)),
    second = await install(t, paraformer)
  await t.core.verify(second, signal(), progress)
  await t.core.verify(first, signal(), progress)
  const after = await tree(join(t.managed, 'a'))
  assert.deepEqual(
    after.filter((path) => basename(path) === 'python.exe'),
    python,
  )
  assert.equal(sha(await readFile(python[0]!)), beforeHash)
  assert.equal((await stat(python[0]!)).mtimeMs, before.mtimeMs)
  const firstAssets = JSON.parse(await readFile(first.receiptPath, 'utf8')).assets as Record<
      string,
      string
    >,
    secondAssets = JSON.parse(await readFile(second.receiptPath, 'utf8')).assets as Record<
      string,
      string
    >,
    assets = { ...firstAssets, ...secondAssets }
  assert.deepEqual(Object.keys(assets).sort(), [
    'alignment',
    'paraformer',
    'punctuation',
    'shared',
    'vad',
    'whisper',
  ])
  for (const role of ['shared', 'punctuation', 'alignment'])
    assert.equal(firstAssets[role], secondAssets[role], role)
  for (const [role, asset] of Object.entries(assets)) {
    assert.match(
      asset,
      new RegExp(`^a/${t.catalog.archiveSha256.slice(0, 12)}/[a-z]/[a-f0-9]{16}$`),
    )
    assert.equal(
      (await readdir(dirname(join(t.managed, asset)), { withFileTypes: true })).filter((entry) =>
        entry.isDirectory(),
      ).length,
      1,
      role,
    )
  }
  const loaded = await new ComponentInstallerCore(t.managed, [t.catalog]).load()
  assert.ok(loaded.some((receipt) => receipt.profile.engine === 'whisperx'))
  assert.ok(loaded.some((receipt) => receipt.profile.engine === 'paraformer'))
  await preserveSource(t)
})

test('ZIP64 offsets outside the physical archive and local/central filename disagreement are rejected before extraction', async () => {
  const offset = await fixture({
    zip64: true,
    archive: (bytes) => {
      const locator = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]))
      bytes.writeBigUInt64LE(2n ** 63n, locator + 8)
    },
  })
  await assert.rejects(offset.core.inspect(offset.path, whisper, signal(), progress))
  assert.deepEqual(await offset.core.load(), [])
  const mismatch = await fixture({
    archive: (bytes) => {
      bytes[30] = 0x78
    },
  })
  await assert.rejects(mismatch.core.inspect(mismatch.path, whisper, signal(), progress))
  assert.deepEqual(await mismatch.core.load(), [])
  await preserveSource(offset)
  await preserveSource(mismatch)
})

test('traversal, Windows absolute paths, backslashes, streams, reserved names and invisible path aliases never become installed files', async () => {
  for (const path of [
    '../escape.exe',
    '/absolute.exe',
    'C:/outside.exe',
    '\\server\\share\\outside.exe',
    'python/../outside.exe',
    'python\\outside.exe',
    'python/python.exe:stream',
    'python/CON',
    'python/trailing. ',
    'python/empty//name',
    'python/\u0000hidden',
  ]) {
    const t = await fixture({ extras: [{ path, bytes: Buffer.from('unsafe') }] })
    await assert.rejects(t.core.inspect(t.path, whisper, signal(), progress), path)
    assert.deepEqual(await t.core.load(), [])
    assert.equal(
      (await tree(t.managed)).some((file) => /escape|outside|hidden/u.test(file)),
      false,
      path,
    )
    await preserveSource(t)
  }
})

test('Unix symbolic links, special files, encrypted entries and duplicate case-folded Windows paths are rejected', async () => {
  for (const entry of [
    { path: 'python/link', bytes: Buffer.from('../../outside'), mode: 0o120777 },
    { path: 'python/fifo', bytes: Buffer.from(''), mode: 0o010644 },
    { path: 'python/encrypted', bytes: Buffer.from('x'), flags: 0x801 },
    { path: 'python/python.exe', bytes: Buffer.from('duplicate') },
    { path: 'PYTHON/PYTHON.EXE', bytes: Buffer.from('case duplicate') },
  ]) {
    const t = await fixture({ extras: [entry] })
    await assert.rejects(t.core.inspect(t.path, whisper, signal(), progress), entry.path)
    assert.deepEqual(await t.core.load(), [])
    await preserveSource(t)
  }
})

test('archive size and SHA, raw manifest SHA, listed file size and inflated payload integrity are all independently enforced', async () => {
  const t = await fixture()
  for (const catalog of [
    { ...t.catalog, archiveBytes: t.catalog.archiveBytes + 1 },
    { ...t.catalog, archiveSha256: '0'.repeat(64) },
    { ...t.catalog, manifestSha256: '0'.repeat(64) },
  ])
    await assert.rejects(
      new ComponentInstallerCore(t.managed, [catalog]).inspect(t.path, whisper, signal(), progress),
    )
  const wrongSize = await fixture({
    manifest: (manifest) => {
      const file = manifest.files.find((value) => value.path === 'models/whisper/weights.bin')!
      file.bytes++
      manifest.bytes++
    },
  })
  await assert.rejects(install(wrongSize))
  const wrongDigest = await fixture({
    manifest: (manifest) => {
      manifest.files.find((value) => value.path === 'models/whisper/weights.bin')!.sha256 =
        'f'.repeat(64)
    },
  })
  await assert.rejects(install(wrongDigest))
  const corrupt = await fixture({
    archive: (bytes, locations) => {
      bytes[locations.get('models/whisper/weights.bin')!]! ^= 0xff
    },
  })
  await assert.rejects(install(corrupt))
  for (const value of [t, wrongSize, wrongDigest, corrupt]) {
    assert.deepEqual(await value.core.load(), [])
    await preserveSource(value)
  }
})

test('free-space checks fail safely even when a previously inspected plan is forged to claim zero work and unlimited space', async (context) => {
  const t = await fixture(),
    plan = await t.core.inspect(t.path, whisper, signal(), progress)
  await noSpace(context, t.managed)
  await assert.rejects(t.core.inspect(t.path, whisper, signal(), progress), /空间|space|磁盘/iu)
  await assert.rejects(
    t.core.install(
      { ...plan, files: [], requiredBytes: 0, freeBytes: Number.MAX_SAFE_INTEGER },
      signal(),
      progress,
    ),
    /空间|space|磁盘/iu,
  )
  assert.deepEqual(await t.core.load(), [])
  await preserveSource(t)
})

test('cancellation during streamed model extraction retains prior assets, receipts and manual configuration, then can retry', async () => {
  const t = await fixture({ largeWhisper: true }),
    first = await install(t, paraformer),
    oldReceiptBytes = await readFile(first.receiptPath),
    oldComponentBytes = await readFile(first.componentPath),
    oldAssets = await tree(join(t.managed, 'a')),
    oldHashes = Object.fromEntries(
      await Promise.all(oldAssets.map(async (path) => [path, sha(await readFile(path))])),
    ),
    plan = await t.core.inspect(t.path, whisper, signal(), progress),
    controller = new AbortController()
  await assert.rejects(
    t.core.install(plan, controller.signal, (stage, processed) => {
      if (stage === 'installing' && processed > 128 * 1024) controller.abort()
    }),
  )
  assert.equal(controller.signal.aborted, true)
  assert.deepEqual(await readFile(first.receiptPath), oldReceiptBytes)
  assert.deepEqual(await readFile(first.componentPath), oldComponentBytes)
  for (const [path, hash] of Object.entries(oldHashes))
    assert.equal(sha(await readFile(path)), hash)
  await t.core.verify(first, signal(), progress)
  assert.equal(
    (await t.core.load()).some((receipt) => receipt.profile.engine === 'whisperx'),
    false,
  )
  const retry = await t.core.install(plan, signal(), progress)
  await t.core.verify(retry, signal(), progress)
  assert.equal(
    (await tree(join(t.managed, 'a'))).filter((path) => basename(path) === 'python.exe').length,
    1,
  )
  await preserveSource(t)
})

test('a tampered receipt or generated configuration cannot redirect verification to an external executable', async () => {
  const t = await fixture(),
    receipt = await install(t),
    outside = join(t.root, 'outside-component.json'),
    marker = join(t.root, 'must-not-execute')
  await writeFile(
    outside,
    JSON.stringify({
      version: 2,
      python: marker,
      models: marker,
      resources: t.root,
      ffmpeg: marker,
      ffprobe: marker,
    }),
  )
  const originalReceipt = await readFile(receipt.receiptPath),
    altered = JSON.parse(originalReceipt.toString('utf8'))
  altered.componentPath = outside
  await writeFile(receipt.receiptPath, JSON.stringify(altered))
  await assert.rejects(t.core.verify({ ...receipt, componentPath: outside }, signal(), progress))
  assert.equal(
    (await new ComponentInstallerCore(t.managed, [t.catalog]).load()).some(
      (value) => value.id === receipt.id,
    ),
    false,
  )
  await writeFile(receipt.receiptPath, originalReceipt)
  const generated = await readFile(receipt.componentPath)
  await writeFile(receipt.componentPath, await readFile(outside))
  await assert.rejects(t.core.verify(receipt, signal(), progress))
  await writeFile(receipt.componentPath, generated)
  await t.core.verify(receipt, signal(), progress)
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
  await preserveSource(t)
})

test(
  'Windows native-library paths that are too long are rejected before extraction creates any file',
  { skip: process.platform !== 'win32' },
  async () => {
    const t = await fixture(),
      longRoot = join(t.root, 'isolated-user-data-'.repeat(6), 'managed-directory-'.repeat(5)),
      core = new ComponentInstallerCore(longRoot, [t.catalog])
    const stages: string[] = []
    await assert.rejects(
      core.inspect(t.path, whisper, signal(), (stage) => stages.push(stage)),
      /目录.*长|路径.*长/u,
    )
    assert(!stages.includes('installing'))
    assert.deepEqual(await tree(longRoot), [])
    const plan = await t.core.inspect(t.path, whisper, signal(), progress)
    await assert.rejects(core.install(plan, signal(), progress), /目录.*长|路径.*长/u)
    assert.deepEqual(await tree(longRoot), [])
    assert.deepEqual(await core.load(), [])
    await preserveSource(t)
  },
)

test('a publisher CPU-only catalog rejects CUDA during inspection and revalidates a forged install profile before writing', async () => {
  const t = await fixture(),
    cpuBundle = { ...t.catalog, devices: ['cpu'] as const },
    core = new ComponentInstallerCore(t.managed, [cpuBundle]),
    cuda = { ...paraformer, device: 'cuda' as const }
  await assert.rejects(core.inspect(t.path, cuda, signal(), progress), /CPU|CUDA|设备|不支持/u)
  assert.deepEqual(await tree(t.managed), [])
  const plan = await core.inspect(t.path, paraformer, signal(), progress)
  await assert.rejects(
    core.install({ ...plan, profile: cuda }, signal(), progress),
    /CPU|CUDA|设备|不支持/u,
  )
  assert.deepEqual(await tree(t.managed), [])
  assert.deepEqual(await core.load(), [])
  await preserveSource(t)
})

test('real core plus service identity discovery and install preserve the strict four-file receipt across restart', async (context) => {
  const t = await fixture(),
    first = await install(t),
    worker = join(t.root, 'asr_worker.py'),
    settings = join(t.root, 'selected-component.json')
  await writeFile(worker, '# Unit fixture; injected probe never executes Python.\n')
  const errors: unknown[] = [],
    createService = () =>
      new ComponentInstallationService({
        root: t.managed,
        settingsFile: settings,
        workerScript: worker,
        component: new AsrComponent(settings, worker),
        core: t.core,
        queue: { withMaintenance: async (action) => action() },
        notify: () => {},
        componentChanged: () => {},
        log: (error) => errors.push(error),
        probe: async () => ({
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
              message: 'Fixture imports; no model inference.',
            })),
          ),
        }),
      }),
    expectedFiles = ['bundle-manifest.json', 'component.json', 'models.json', 'receipt.json']
  const assertReceipt = async (id: string) => {
    assert.deepEqual((await readdir(join(t.managed, 'receipts', id))).sort(), expectedFiles)
  }
  await assertReceipt(first.id)
  const service = createService()
  context.after(() => service.close())
  await service.load()
  assert.equal(service.state().installations.length, 1)
  await assertReceipt(first.id)
  assert.equal((await t.core.load()).length, 1)
  const id = service.select(t.path, paraformer).activity!.id
  const wait = async (status: string) => {
    for (let index = 0; index < 500; index++) {
      const activity = service.state().activity
      if (activity?.status === status) return
      assert.notEqual(activity?.status, 'failed', activity?.error ?? 'Unexpected install failure')
      await delay(10)
    }
    assert.fail(`Expected ${status}: ${JSON.stringify(service.state())}`)
  }
  await wait('ready')
  service.start(id)
  await wait('installed')
  assert.equal(service.state().installations.length, 2)
  for (const receipt of await t.core.load()) {
    await assertReceipt(receipt.id)
    await t.core.verify(receipt, signal(), progress)
  }
  assert.equal((await t.core.load()).length, 2)
  await service.close()
  const reopened = createService()
  context.after(() => reopened.close())
  await reopened.load()
  assert.equal(reopened.state().installations.length, 2)
  for (const receipt of await t.core.load()) await assertReceipt(receipt.id)
  assert.deepEqual(errors, [])
  await preserveSource(t)
})
