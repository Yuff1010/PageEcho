import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LibraryStore } from '../../src/main/database'
import { parseOriginal } from '../../src/main/original/parse'
import { createDataPaths } from '../../src/main/paths'
import {
  BackupService,
  applyPendingRestoreAtStartup,
  validateBackupSettings,
} from '../../src/main/maintenance/backup'
import { packBackup, unpackBackup } from '../../src/main/maintenance/archive'
import { GeneratedStorageService } from '../../src/main/maintenance/storage-policy'
import { syntheticToken } from '../helpers/synthetic-auth'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ralb-backup-')),
    paths = createDataPaths(root),
    store = new LibraryStore(paths.database)
  store.importBook({
    id: 'audio-book',
    title: '合成音频',
    sourcePath: 'D:/synthetic',
    kind: 'folder',
    episodes: [
      {
        id: 'audio-episode',
        path: 'D:/synthetic/one.mp3',
        name: 'one.mp3',
        sizeBytes: 10,
        modifiedAt: 1,
        contentHash: 'a'.repeat(64),
      },
    ],
  })
  const episode = store.listBooks()[0]!.episodes[0]!
  store.saveProgress({
    episodeId: episode.id,
    sessionId: episode.id,
    positionMs: 1200,
    durationMs: 10000,
    rate: 1.5,
    volume: 0.4,
  })
  store.saveBookmark({
    episodeId: episode.id,
    audioHash: episode.contentHash,
    positionMs: 800,
    note: '合成书签',
  })
  store.saveTranscript(episode.id, {
    version: 1,
    kind: 'manual',
    audioHash: episode.contentHash,
    coverage: [{ startMs: 0, endMs: 10000 }],
    segments: [{ id: 'manual-segment', startMs: 100, endMs: 3000, text: '人工保留的合成文稿。' }],
  })
  const ebook = store.reading.import(
    parseOriginal(
      Buffer.from('第1章 起点\n少年沿着山路前进。\n清晨的阳光穿过树林。'),
      '合成小说.txt',
    ),
  )
  store.reading.savePosition(ebook.id, 1)
  const secret = syntheticToken()
  await writeFile(
    join(paths.data, 'text-libraries.json'),
    JSON.stringify({
      schemaVersion: 1,
      libraries: [
        {
          id: 'personal',
          kind: 'opds',
          label: '合成书库',
          baseUrl: 'https://books.example/opds?public=1',
          enabled: true,
          secret,
        },
      ],
      manifests: {},
      imports: {},
    }),
  )
  return { root, paths, store, episode, ebook, secret }
}

test('portable backup snapshots real SQLite progress, manual transcripts and source config without credentials; restore waits for startup and keeps old data', async () => {
  const original = await fixture(),
    archive = join(original.root, 'portable.zip')
  try {
    const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSMcAAAAASUVORK5CYII=',
        'base64',
      ),
      hash = createHash('sha256').update(png).digest('hex')
    const covers = join(original.paths.data, 'book-covers')
    await mkdir(covers)
    await writeFile(join(covers, hash + '.img'), png)
    await writeFile(
      join(covers, 'index.json'),
      JSON.stringify({
        schemaVersion: 1,
        bindings: [
          { kind: 'ebook', id: original.ebook.id, hash, bytes: png.length, usedAt: Date.now() },
        ],
      }),
    )
    const settings = {
      'ralb:app:theme:v1': 'dark',
      [`ralb:reading:bookmarks:${original.ebook.id}:v1`]: '[{"position":1,"note":"书签"}]',
    }
    const service = new BackupService({
      root: original.root,
      version: '0.35.0-dev.1',
      maxSchemaVersion: 17,
      publicPlugins: () => [{ id: 'sample', name: '合成插件', version: '1.0.0' }],
    })
    const result = await service.exportTo(archive, settings)
    assert.equal(result.files, 5)
    const files = await unpackBackup(await readFile(archive))
    assert.equal(files.get('data/text-libraries.json')!.includes(original.secret), false)
    assert.equal(files.get('data/text-libraries.json')!.includes('secret'), false)
    assert.equal(files.has('data/book-covers/' + hash + '.img'), true)
    assert.deepEqual(JSON.parse(files.get('preferences.json')!.toString()), settings)
    const destination = await fixture()
    const existingId = destination.ebook.id
    destination.store.close()
    const restoring = new BackupService({
      root: destination.root,
      version: '0.35.0-dev.1',
      maxSchemaVersion: 17,
    })
    const preview = await restoring.previewFile(archive)
    assert.equal(preview.books, 1)
    assert.equal(preview.readingBooks, 1)
    assert.equal(preview.transcripts, 1)
    assert.equal(preview.bookmarks, 1)
    assert.deepEqual(await restoring.stageRestore(preview.previewId), { needsRestart: true })
    const before = new LibraryStore(destination.paths.database)
    assert.equal(before.reading.get(existingId).id, existingId)
    before.close()
    const applied = await applyPendingRestoreAtStartup(destination.root)
    assert.equal(applied.applied, true, JSON.stringify(applied))
    const restored = new LibraryStore(destination.paths.database)
    try {
      assert.equal(restored.getEpisode(original.episode.id)!.positionMs, 1200)
      assert.equal(restored.listBookmarks('audio-book')[0]!.note, '合成书签')
      assert.equal(restored.reading.get(original.ebook.id).position, 1)
      assert.equal(
        restored.getTranscript(original.episode.id, original.episode.contentHash).status,
        'ready',
      )
      assert.deepEqual((await restoring.restoredSettings())!.settings, settings)
      await restoring.acknowledgeSettings()
      assert.equal((await restoring.restoredSettings())!.acknowledged, true)
      assert.equal((await readdir(join(destination.root, 'maintenance/rollback'))).length, 1)
      assert.equal((await applyPendingRestoreAtStartup(destination.root)).applied, false)
    } finally {
      restored.close()
    }
  } finally {
    original.store.close()
  }
})

test('restore rolls back the original SQLite directory when commit rename fails and blocks active work', async () => {
  const original = await fixture(),
    archive = join(original.root, 'rollback.zip')
  try {
    const busy = new BackupService({
      root: original.root,
      version: '0.35.0-dev.1',
      maxSchemaVersion: 17,
      isBusy: () => true,
    })
    await assert.rejects(busy.exportTo(archive, {}), { code: 'BUSY' })
    const service = new BackupService({
      root: original.root,
      version: '0.35.0-dev.1',
      maxSchemaVersion: 17,
    })
    await service.exportTo(archive, {})
    const preview = await service.previewFile(archive)
    await service.stageRestore(preview.previewId)
    original.store.close()
    let failed = false
    const result = await applyPendingRestoreAtStartup(original.root, {
      move: async (source, target) => {
        if (String(source).includes('staged') && String(source).endsWith('data') && !failed) {
          failed = true
          throw new Error('synthetic commit failure')
        }
        await rename(source, target)
      },
    })
    assert.equal(result.applied, false)
    assert.equal(failed, true, JSON.stringify(result))
    const preserved = new LibraryStore(original.paths.database)
    assert.equal(preserved.getEpisode(original.episode.id)!.positionMs, 1200)
    preserved.close()
  } finally {
    try {
      original.store.close()
    } catch {
      /* already closed for simulated restart */
    }
  }
})

test('backup ZIP rejects traversal, corrupted bytes, unknown settings and newer database versions before restore', async () => {
  assert.throws(() => validateBackupSettings({ 'user-password': 'not-exported' }), {
    code: 'INVALID_REQUEST',
  })
  await assert.rejects(packBackup(new Map([['../escape', Buffer.from('invalid')]])), {
    code: 'INVALID_REQUEST',
  })
  const valid = await packBackup(new Map([['manifest.json', Buffer.from('synthetic')]]))
  const bad = Buffer.from(valid)
  bad[35] = bad[35]! ^ 1
  await assert.rejects(unpackBackup(bad), { code: 'INVALID_REQUEST' })
  const original = await fixture(),
    archive = join(original.root, 'newer.zip')
  try {
    const exporter = new BackupService({
      root: original.root,
      version: '0.35.0-dev.1',
      maxSchemaVersion: 17,
    })
    await exporter.exportTo(archive, {})
    const old = new BackupService({
      root: original.root,
      version: '0.35.0-dev.1',
      maxSchemaVersion: 16,
    })
    await assert.rejects(old.previewFile(archive), { code: 'INVALID_REQUEST' })
  } finally {
    original.store.close()
  }
})

test('startup validates staged files again and preserves current installed plugins without importing scripts from backup', async () => {
  const original = await fixture(),
    archive = join(original.root, 'plugins.zip'),
    service = new BackupService({
      root: original.root,
      version: '0.35.0-dev.1',
      maxSchemaVersion: 17,
    })
  try {
    const installed = join(original.paths.data, 'source-plugins')
    await mkdir(installed)
    await writeFile(join(installed, 'registry.json'), '{"current":"local-only"}')
    const maintenance = join(original.paths.data, 'plugin-maintenance')
    await mkdir(maintenance)
    await writeFile(
      join(maintenance, 'state.json'),
      '{"updateUrl":"https://plugins.example/current.zip"}',
    )
    await service.exportTo(archive, {})
    const entries = await unpackBackup(await readFile(archive))
    assert.equal(
      [...entries.keys()].some((path) => path.includes('source-plugins')),
      false,
    )
    assert.equal(
      [...entries.keys()].some((path) => path.includes('plugin-maintenance')),
      false,
    )
    const preview = await service.previewFile(archive)
    await service.stageRestore(preview.previewId)
    original.store.close()
    const applied = await applyPendingRestoreAtStartup(original.root)
    assert.equal(applied.applied, true, JSON.stringify(applied))
    assert.equal(
      await readFile(join(installed, 'registry.json'), 'utf8'),
      '{"current":"local-only"}',
    )
    assert.equal(
      await readFile(join(maintenance, 'state.json'), 'utf8'),
      '{"updateUrl":"https://plugins.example/current.zip"}',
    )
  } finally {
    try {
      original.store.close()
    } catch {
      /* closed for restart */
    }
  }

  const altered = await fixture(),
    alteredArchive = join(altered.root, 'altered.zip'),
    alteredService = new BackupService({
      root: altered.root,
      version: '0.35.0-dev.1',
      maxSchemaVersion: 17,
    })
  try {
    await alteredService.exportTo(alteredArchive, {})
    const preview = await alteredService.previewFile(alteredArchive)
    await alteredService.stageRestore(preview.previewId)
    const pending = JSON.parse(
      await readFile(join(altered.root, 'maintenance/pending-restore.json'), 'utf8'),
    )
    await writeFile(
      join(altered.root, 'maintenance/staged', pending.token, 'data/unlisted.json'),
      'extra',
    )
    altered.store.close()
    const applied = await applyPendingRestoreAtStartup(altered.root)
    assert.equal(applied.applied, false)
    assert.match(applied.notice!, /未列入清单/)
    const preserved = new LibraryStore(altered.paths.database)
    assert.equal(preserved.getEpisode(altered.episode.id)!.positionMs, 1200)
    preserved.close()
  } finally {
    try {
      altered.store.close()
    } catch {
      /* closed for restart */
    }
  }
})

test('startup recovers either interrupted rename phase and applies large preference snapshots once', async () => {
  for (const phase of ['old-moved', 'both-moved'] as const) {
    const original = await fixture(),
      archive = join(original.root, 'restart.zip'),
      service = new BackupService({
        root: original.root,
        version: '0.35.0-dev.1',
        maxSchemaVersion: 17,
      })
    try {
      const settings: Record<string, string> = {}
      for (let i = 0; i < 12; i++) settings[`ralb:reader:fixture:${i}`] = 'x'.repeat(100 * 1024)
      await service.exportTo(archive, settings)
      const preview = await service.previewFile(archive)
      await service.stageRestore(preview.previewId)
      original.store.close()
      const pending = JSON.parse(
          await readFile(join(original.root, 'maintenance/pending-restore.json'), 'utf8'),
        ),
        rollback = join(original.root, 'maintenance/rollback', pending.token)
      await mkdir(rollback, { recursive: true })
      await rename(original.paths.data, join(rollback, 'data'))
      if (phase === 'both-moved')
        await rename(
          join(original.root, 'maintenance/staged', pending.token, 'data'),
          original.paths.data,
        )
      else await mkdir(original.paths.data)
      const applied = await applyPendingRestoreAtStartup(original.root)
      assert.equal(applied.applied, phase === 'both-moved', JSON.stringify(applied))
      const restored = new LibraryStore(original.paths.database)
      assert.equal(restored.getEpisode(original.episode.id)!.positionMs, 1200)
      restored.close()
      if (phase === 'both-moved') {
        assert.deepEqual((await service.restoredSettings())!.settings, settings)
        await service.acknowledgeSettings()
        assert.equal((await service.restoredSettings())!.acknowledged, true)
      }
      assert.equal((await applyPendingRestoreAtStartup(original.root)).applied, false)
    } finally {
      try {
        original.store.close()
      } catch {
        /* closed for restart */
      }
    }
  }
})

test('malformed pending restores cannot prevent opening an unchanged library', async () => {
  const original = await fixture()
  try {
    await mkdir(join(original.root, 'maintenance'))
    await writeFile(join(original.root, 'maintenance/pending-restore.json'), 'malformed')
    const result = await applyPendingRestoreAtStartup(original.root)
    assert.equal(result.applied, false)
    assert.match(result.notice!, /原书库未替换/)
    assert.equal(original.store.getEpisode(original.episode.id)!.positionMs, 1200)
    assert.equal((await applyPendingRestoreAtStartup(original.root)).applied, false)
    assert.equal(
      (await readdir(join(original.root, 'maintenance'))).some((name) =>
        name.startsWith('failed-invalid-'),
      ),
      true,
    )
  } finally {
    original.store.close()
  }
})

async function owned(service: GeneratedStorageService, label: string) {
  const item = await service.create('build', label)
  await writeFile(join(item.directory, 'output.js'), label)
  const path = join(item.directory, '.generated-receipt.json')
  const receipt = JSON.parse(await readFile(path, 'utf8'))
  receipt.createdAt = new Date(Date.now() - 10 * 86400_000 + Number(label) * 1000).toISOString()
  await writeFile(path, JSON.stringify(receipt))
  await service.complete(item.id)
  return item
}
test('generated cleanup only handles receipt-owned future outputs, retains newest two and supports preview tokens across CLI instances', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ralb-owned-')),
    service = new GeneratedStorageService({ directory })
  await service.savePolicy({
    automatic: false,
    keepLatest: 2,
    maxBytes: 64 * 1024 ** 2,
    maxAgeDays: 1,
  })
  const items: Array<Awaited<ReturnType<typeof owned>>> = []
  for (let i = 0; i < 4; i++) items.push(await owned(service, String(i)))
  await mkdir(join(directory, 'unmanaged-models'))
  await writeFile(join(directory, 'unmanaged-models', 'keep.bin'), 'unique model bytes')
  const preview = await service.preview()
  assert.equal(preview.items, 2)
  assert.equal(preview.retained, 2)
  assert.equal(
    (await readdir(directory)).filter((x) => items.some((item) => item.id === x)).length,
    4,
  )
  const another = new GeneratedStorageService({ directory })
  const result = await another.clear(preview.token)
  assert.equal(result.items, 2)
  assert.equal(
    await readFile(join(directory, 'unmanaged-models', 'keep.bin'), 'utf8'),
    'unique model bytes',
  )
  assert.equal(await readFile(join(items[3]!.directory, 'output.js'), 'utf8'), '3')
  assert.equal((await another.state()).protectedItems, 1)
  await assert.rejects(another.clear(preview.token), { code: 'CONFLICT' })
})

test('changed policies, active outputs and mutated files invalidate generated cleanup before deletion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ralb-owned-race-')),
    service = new GeneratedStorageService({ directory })
  await service.savePolicy({
    automatic: false,
    keepLatest: 2,
    maxBytes: 64 * 1024 ** 2,
    maxAgeDays: 1,
  })
  const items: Array<Awaited<ReturnType<typeof owned>>> = []
  for (let i = 0; i < 3; i++) items.push(await owned(service, String(i)))
  const plan = await service.preview()
  await writeFile(join(items[0]!.directory, 'output.js'), 'changed after preview')
  await assert.rejects(service.clear(plan.token), { code: 'CONFLICT' })
  const next = await service.preview()
  await service.savePolicy({
    automatic: false,
    keepLatest: 3,
    maxBytes: 64 * 1024 ** 2,
    maxAgeDays: 1,
  })
  await assert.rejects(service.clear(next.token), { code: 'CONFLICT' })
  const active = new GeneratedStorageService({ directory, isActive: () => true })
  assert.equal((await active.preview()).items, 0)
  for (const item of items) assert.ok((await readdir(item.directory)).includes('output.js'))
})
