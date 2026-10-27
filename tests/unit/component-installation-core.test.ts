import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { ComponentInstallerCore } from '../../src/main/component-installation/core'
import type { TrustedBundle } from '../../src/main/component-installation/core-types'

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const signal = () => new AbortController().signal
const progress = () => undefined
const choice = { engine: 'paraformer', device: 'cpu' } as const

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), '听读 managed core ')),
    managed = join(root, 'managed')
  const files = new Map<string, Buffer>([
    ['python/python.exe', Buffer.from('never executed')],
    ['tools/ffmpeg.exe', Buffer.from('ffmpeg fixture')],
    ['tools/ffprobe.exe', Buffer.from('ffprobe fixture')],
    ['resources/nltk/fixture.txt', Buffer.from('resource')],
    ['component.json', Buffer.from('{"version":2,"python":"C:/untrusted.exe"}')],
  ])
  const models: Record<string, unknown> = {}
  for (const role of ['paraformer', 'vad', 'punctuation', 'whisper', 'alignment']) {
    models[role] = {
      repository: `fixture/${role}`,
      revision: 'a'.repeat(40),
      path: `models/${role}`,
    }
    files.set(`models/${role}/model.bin`, Buffer.from(`verified ${role}`))
  }
  files.set('models.json', Buffer.from(JSON.stringify({ version: 1, models })))
  const inventory = [...files].map(([path, bytes]) => ({
    path,
    bytes: bytes.length,
    sha256: digest(bytes),
  }))
  const manifest = Buffer.from(
    JSON.stringify({
      version: 1,
      complete: true,
      platform: 'win-amd64',
      files: inventory,
      bytes: inventory.reduce((sum, file) => sum + file.bytes, 0),
    }),
  )
  files.set('bundle-manifest.json', manifest)
  const local: Buffer[] = [],
    central: Buffer[] = []
  let offset = 0
  for (const [path, bytes] of files) {
    const name = Buffer.from(path),
      compressed = deflateRawSync(bytes),
      header = Buffer.alloc(30),
      entry = Buffer.alloc(46)
    header.writeUInt32LE(0x04034b50)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(8, 8)
    header.writeUInt32LE(crc32(bytes), 14)
    header.writeUInt32LE(compressed.length, 18)
    header.writeUInt32LE(bytes.length, 22)
    header.writeUInt16LE(name.length, 26)
    entry.writeUInt32LE(0x02014b50)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(8, 10)
    entry.writeUInt32LE(crc32(bytes), 16)
    entry.writeUInt32LE(compressed.length, 20)
    entry.writeUInt32LE(bytes.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    local.push(header, name, compressed)
    central.push(entry, name)
    offset += header.length + name.length + compressed.length
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(files.size, 8)
  end.writeUInt16LE(files.size, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  const bytes = Buffer.concat([...local, directory, end]),
    path = join(root, 'bundle.zip')
  await writeFile(path, bytes)
  const bundle: TrustedBundle = {
    id: 'unit-core-1',
    version: '1.0.0',
    archiveBytes: bytes.length,
    archiveSha256: digest(bytes),
    manifestSha256: digest(manifest),
  }
  return { root, managed, path, bundle, core: new ComponentInstallerCore(managed, [bundle]) }
}

test('managed install generates its own v2 config, survives restart and verifies all referenced content', async () => {
  const f = await fixture()
  try {
    const plan = await f.core.inspect(f.path, choice, signal(), progress)
    assert(plan.requiredBytes > 0)
    assert(!plan.files.some((file) => file.path.startsWith('models/whisper/')))
    // A renderer-shaped plan cannot add archive paths or use the source configuration.
    plan.files.push({ path: '../external.exe', bytes: 1, sha256: '0'.repeat(64) })
    const receipt = await f.core.install(plan, signal(), progress)
    const config = JSON.parse(await readFile(receipt.componentPath, 'utf8'))
    assert.equal(config.version, 2)
    assert.match(
      relative(f.managed, config.python).replaceAll('\\', '/'),
      new RegExp(
        `^a/${f.bundle.archiveSha256.slice(0, 12)}/[a-z]/[a-f0-9]{16}/python/python\\.exe$`,
      ),
    )
    assert.equal(await readFile(config.python, 'utf8'), 'never executed')
    assert(!config.python.includes('untrusted'))
    const models = JSON.parse(await readFile(config.models, 'utf8'))
    assert.deepEqual(Object.keys(models.models), ['paraformer', 'vad', 'punctuation', 'alignment'])
    const reopened = new ComponentInstallerCore(f.managed, [f.bundle])
    assert.deepEqual(await reopened.load(), [receipt])
    await reopened.verify(receipt, signal(), progress)
    assert.deepEqual(await readdir(join(f.managed, 'staging')), [])
    await writeFile(config.python, 'tampered same or different size')
    await assert.rejects(reopened.verify(receipt, signal(), progress), /大小|校验/)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('generated config changes and unmanaged receipt paths cannot become executable candidates', async () => {
  const f = await fixture()
  try {
    const receipt = await f.core.install(
      await f.core.inspect(f.path, choice, signal(), progress),
      signal(),
      progress,
    )
    const outside = join(f.root, 'outside.json')
    await writeFile(outside, '{}')
    await assert.rejects(f.core.verify({ ...receipt, componentPath: outside }, signal(), progress))
    await writeFile(receipt.componentPath, '{"version":2,"python":"C:/outside.exe"}')
    assert.deepEqual(await f.core.load(), [])
    await assert.rejects(f.core.verify(receipt, signal(), progress), /配置/)
    // A random folder is not adopted by load(), even if named like a component.
    await mkdir(join(f.managed, 'receipts', 'external-component'))
    assert.deepEqual(await f.core.load(), [])
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('cancel during extraction cleans staging and permits a fresh attempt without touching external files', async () => {
  const f = await fixture()
  try {
    const external = join(f.root, 'external.txt')
    await writeFile(external, 'keep')
    const plan = await f.core.inspect(f.path, choice, signal(), progress),
      controller = new AbortController()
    await assert.rejects(
      f.core.install(plan, controller.signal, (stage, processed) => {
        if (stage === 'installing' && processed > 0) controller.abort()
      }),
    )
    assert.equal(await readFile(external, 'utf8'), 'keep')
    assert.deepEqual(await f.core.load(), [])
    assert.deepEqual(await readdir(join(f.managed, 'staging')), [])
    const receipt = await f.core.install(plan, signal(), progress)
    await f.core.verify(receipt, signal(), progress)
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})
