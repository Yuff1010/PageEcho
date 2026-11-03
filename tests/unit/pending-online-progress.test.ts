import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { LibraryStore } from '../../src/main/database'
import { LIBRARY_SCHEMA_VERSION } from '../../src/main/database-schema'
import { createDataPaths } from '../../src/main/paths'
import { BackupService, applyPendingRestoreAtStartup } from '../../src/main/maintenance/backup'
import type { ProgressUpdate } from '../../src/shared/contracts'
import type { SourceBook, SourceEpisode } from '../../src/shared/sources'
import type { PendingOnlineProof } from '../../src/shared/pending-online-progress'

const book: SourceBook = {
  sourceId: 'ting13',
  id: 'synthetic-pending-book',
  title: '合成渐进播放',
  authors: [],
  narrators: [],
  description: 'Database-only fixture; no network or media is loaded.',
  pageUrl: 'https://www.ting13.cc/youshengxiaoshuo/synthetic/',
}
const episodes: SourceEpisode[] = [1, 2].map((order) => ({
  sourceId: 'ting13',
  bookId: book.id,
  id: `synthetic-${order}`,
  order,
  title: `第${order}集`,
  pageUrl: `https://www.ting13.cc/play/synthetic-${order}.html`,
}))
const proof: PendingOnlineProof = { bytes: 100, totalBytes: 1000, sha256: 'a'.repeat(64) }
const full = (hash = 'c') => ({
  path: `D:/synthetic/complete-${hash}.mp3`,
  name: 'complete.mp3',
  sizeBytes: 1000,
  modifiedAt: 1,
  contentHash: hash.repeat(64),
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ralb-pending-progress-')),
    paths = createDataPaths(root)
  const store = new LibraryStore(paths.database)
  const bookId = store.rememberSourceBook(book, episodes, true)
  const ids = store.listBooks()[0]!.episodes.map((episode) => episode.id)
  return { root, paths, store, bookId, ids }
}
function update(episodeId: string, sessionId: string, positionMs = 4000): ProgressUpdate {
  return { episodeId, sessionId, positionMs, durationMs: 10000, rate: 1.5, volume: 0.4 }
}
function database(store: LibraryStore): DatabaseSync {
  return Reflect.get(store, 'db') as DatabaseSync
}

test('schema 17 migration preserves existing books and verified progress while adding pending storage', () => {
  const f = fixture(),
    id = f.ids[0]!
  f.store.cacheSourceEpisode(id, full())
  f.store.saveProgress(update(id, randomUUID(), 3100))
  f.store.close()
  const prior = new DatabaseSync(f.paths.database)
  prior.exec('DROP TABLE online_pending_progress; PRAGMA user_version=17;')
  prior.close()
  const reopened = new LibraryStore(f.paths.database)
  try {
    assert.equal(database(reopened).prepare('PRAGMA user_version').get()!.user_version, 18)
    assert.equal(reopened.getEpisode(id)!.positionMs, 3100)
    assert.equal(reopened.getAudio(id)!.contentHash, full().contentHash)
    assert.equal(reopened.getPendingOnlineProgress(id), null)
    assert.throws(() => reopened.beginPendingOnlinePlayback(id, randomUUID()), {
      code: 'INVALID_REQUEST',
    })
  } finally {
    reopened.close()
  }
})

test('pending progress is durable and visible without registering audio, and importing another book keeps its current pointer', () => {
  const f = fixture(),
    id = f.ids[0]!,
    session = randomUUID()
  try {
    assert.deepEqual(f.store.beginPendingOnlinePlayback(id, session), { resume: null })
    f.store.savePendingOnlineProgress(update(id, session), proof)
    assert.equal(f.store.getAudio(id), undefined)
    assert.equal(database(f.store).prepare('SELECT count(*) AS n FROM episodes').get()!.n, 0)
    assert.equal(f.store.getEpisode(id)!.contentHash, '')
    assert.equal(f.store.getEpisode(id)!.positionMs, 4000)
    f.store.importBook({
      id: randomUUID(),
      title: '合成本地书',
      sourcePath: 'D:/synthetic/local',
      kind: 'folder',
      episodes: [],
    })
    assert.equal(f.store.getPlayerState().currentEpisodeId, id)
    assert.deepEqual(f.store.getPlayerState().preferences, { rate: 1.5, volume: 0.4 })
    f.store.endPendingOnlinePlayback(session)
    assert.throws(() => f.store.savePendingOnlineProgress(update(id, session, 5000), proof), {
      code: 'INVALID_REQUEST',
    })
  } finally {
    f.store.close()
  }
  const reopened = new LibraryStore(f.paths.database)
  try {
    assert.equal(reopened.getPendingOnlineProgress(id)!.positionMs, 4000)
    assert.equal(reopened.getEpisode(id)!.positionMs, 4000)
    assert.equal(reopened.getAudio(id), undefined)
    assert.throws(() => reopened.savePendingOnlineProgress(update(id, session), proof), {
      code: 'INVALID_REQUEST',
    })
    assert.equal(
      reopened.beginPendingOnlinePlayback(id, randomUUID()).resume!.proof.sha256,
      proof.sha256,
    )
  } finally {
    reopened.close()
  }
})

test('a new lease preserves its old snapshot but rejects stale saves and old completion transactions', () => {
  const f = fixture(),
    id = f.ids[0]!,
    old = randomUUID(),
    next = randomUUID()
  try {
    f.store.beginPendingOnlinePlayback(id, old)
    f.store.savePendingOnlineProgress(update(id, old), proof)
    const prior = f.store.getPendingOnlineProgress(id)!
    assert.deepEqual(f.store.beginPendingOnlinePlayback(id, next).resume, prior)
    assert.deepEqual(f.store.getPendingOnlineProgress(id), prior)
    assert.throws(() => f.store.savePendingOnlineProgress(update(id, old, 9000), proof), {
      code: 'INVALID_REQUEST',
    })
    assert.throws(() => f.store.cacheSourceEpisode(id, full(), { kind: 'live', sessionId: old }), {
      code: 'INVALID_REQUEST',
    })
    assert.throws(
      () =>
        f.store.cacheSourceEpisode(id, full(), {
          kind: 'resume',
          sessionId: old,
          revision: prior.revision,
          observedProof: proof,
        }),
      { code: 'INVALID_REQUEST' },
    )
    assert.equal(f.store.getAudio(id), undefined)
    assert.deepEqual(f.store.getPendingOnlineProgress(id), prior)
    f.store.endPendingOnlinePlayback(old)
    f.store.cacheSourceEpisode(id, full(), {
      kind: 'resume',
      sessionId: next,
      revision: prior.revision,
      observedProof: proof,
    })
    assert.equal(f.store.getEpisode(id)!.positionMs, 4000)
    assert.equal(f.store.getPendingOnlineProgress(id), null)
  } finally {
    f.store.close()
  }
})

test('same-response completion migrates the saved position but never overwrites a later chapter selection or preferences', () => {
  const f = fixture(),
    id = f.ids[0]!,
    next = f.ids[1]!,
    session = randomUUID()
  try {
    f.store.beginPendingOnlinePlayback(id, session)
    f.store.savePendingOnlineProgress(update(id, session), proof)
    f.store.cacheSourceEpisode(next, full('d'))
    f.store.saveProgress({ ...update(next, randomUUID(), 900), rate: 2, volume: 0.8 })
    f.store.cacheSourceEpisode(id, full(), { kind: 'live', sessionId: session })
    assert.equal(f.store.getEpisode(id)!.positionMs, 4000)
    assert.equal(f.store.getEpisode(id)!.durationMs, 10000)
    assert.equal(f.store.getEpisode(id)!.contentHash, full().contentHash)
    assert.equal(f.store.getPendingOnlineProgress(id), null)
    assert.deepEqual(f.store.getPlayerState(), {
      currentEpisodeId: next,
      preferences: { rate: 2, volume: 0.8 },
    })
    assert.equal(f.store.listBooks()[0]!.currentEpisodeId, next)
  } finally {
    f.store.close()
  }
})

test('prefix or entity-length mismatch keeps the new verified audio but does not bind the old position', () => {
  for (const observed of [
    { ...proof, sha256: 'b'.repeat(64) },
    { ...proof, totalBytes: 1001 },
  ]) {
    const f = fixture(),
      id = f.ids[0]!,
      old = randomUUID(),
      session = randomUUID()
    try {
      f.store.beginPendingOnlinePlayback(id, old)
      f.store.savePendingOnlineProgress(update(id, old), proof)
      const saved = f.store.beginPendingOnlinePlayback(id, session).resume!
      f.store.cacheSourceEpisode(id, full(), {
        kind: 'resume',
        sessionId: session,
        revision: saved.revision,
        observedProof: observed,
      })
      assert.equal(f.store.getAudio(id)!.contentHash, full().contentHash)
      assert.equal(f.store.getEpisode(id)!.positionMs, 0)
      assert.equal(f.store.getEpisode(id)!.durationMs, null)
      assert.equal(f.store.getPendingOnlineProgress(id), null)
    } finally {
      f.store.close()
    }
  }
})

test('background caching does not apply an unverified pending position; a later current opening can verify and migrate it', () => {
  const f = fixture(),
    id = f.ids[0]!,
    old = randomUUID(),
    session = randomUUID()
  try {
    f.store.beginPendingOnlinePlayback(id, old)
    f.store.savePendingOnlineProgress(update(id, old), proof)
    f.store.endPendingOnlinePlayback(old)
    f.store.cacheSourceEpisode(id, full())
    assert.equal(f.store.getEpisode(id)!.positionMs, 0)
    assert.equal(f.store.getPendingOnlineProgress(id)!.positionMs, 4000)
    const saved = f.store.beginPendingOnlinePlayback(id, session).resume!
    f.store.cacheSourceEpisode(id, full(), {
      kind: 'resume',
      sessionId: session,
      revision: saved.revision,
      observedProof: proof,
    })
    assert.equal(f.store.getEpisode(id)!.positionMs, 4000)
    assert.equal(f.store.getPendingOnlineProgress(id), null)
  } finally {
    f.store.close()
  }
})

test('failed atomic completion restores the pending row, audio registration and cache availability and can retry', () => {
  const f = fixture(),
    id = f.ids[0]!,
    session = randomUUID()
  try {
    f.store.beginPendingOnlinePlayback(id, session)
    f.store.savePendingOnlineProgress(update(id, session), proof)
    const saved = f.store.getPendingOnlineProgress(id)
    database(f.store)
      .exec(`CREATE TRIGGER abort_pending_commit BEFORE DELETE ON online_pending_progress
      BEGIN SELECT RAISE(ABORT,'synthetic failed pending transfer'); END;`)
    assert.throws(
      () => f.store.cacheSourceEpisode(id, full(), { kind: 'live', sessionId: session }),
      /synthetic failed/,
    )
    assert.equal(f.store.getAudio(id), undefined)
    assert.equal(f.store.getEpisode(id)!.online!.cached, false)
    assert.equal(f.store.sourceCacheFiles().length, 0)
    assert.deepEqual(f.store.getPendingOnlineProgress(id), saved)
    database(f.store).exec('DROP TRIGGER abort_pending_commit')
    f.store.cacheSourceEpisode(id, full(), { kind: 'live', sessionId: session })
    assert.equal(f.store.getEpisode(id)!.positionMs, 4000)
    assert.equal(f.store.getPendingOnlineProgress(id), null)
  } finally {
    f.store.close()
  }
})

test('pending save rolls back every selection write on failure; removing a book cascades snapshots', () => {
  const f = fixture(),
    id = f.ids[0]!,
    session = randomUUID()
  try {
    f.store.beginPendingOnlinePlayback(id, session)
    f.store.savePendingOnlineProgress(update(id, session), proof)
    const saved = f.store.getPendingOnlineProgress(id),
      prefs = f.store.getPlayerState()
    database(f.store).exec(`CREATE TRIGGER abort_pending_save BEFORE UPDATE ON player_settings
      BEGIN SELECT RAISE(ABORT,'synthetic failed settings update'); END;`)
    assert.throws(
      () => f.store.savePendingOnlineProgress({ ...update(id, session, 6000), rate: 2 }, proof),
      /synthetic failed/,
    )
    assert.deepEqual(f.store.getPendingOnlineProgress(id), saved)
    assert.deepEqual(f.store.getPlayerState(), prefs)
    database(f.store).exec('DROP TRIGGER abort_pending_save')
    f.store.removeBook(f.bookId)
    assert.equal(f.store.getPendingOnlineProgress(id), null)
    assert.equal(f.store.getPlayerState().currentEpisodeId, null)
    assert.throws(() => f.store.savePendingOnlineProgress(update(id, session), proof), {
      code: 'INVALID_REQUEST',
    })
  } finally {
    f.store.close()
  }
})

test('prefix proof bounds, same-session rollback and stale resume revisions are rejected without losing the snapshot', () => {
  const f = fixture(),
    id = f.ids[0]!,
    session = randomUUID()
  try {
    f.store.beginPendingOnlinePlayback(id, session)
    f.store.savePendingOnlineProgress(update(id, session), proof)
    const saved = f.store.getPendingOnlineProgress(id)
    for (const invalid of [
      { ...proof, bytes: 99 },
      { ...proof, sha256: 'not-a-digest' },
      { ...proof, totalBytes: 256 * 1024 * 1024 + 1 },
      { ...proof, bytes: 11 },
      { ...proof, sha256: 'b'.repeat(64) },
    ])
      assert.throws(() => f.store.savePendingOnlineProgress(update(id, session), invalid), {
        code: 'INVALID_REQUEST',
      })
    assert.deepEqual(f.store.getPendingOnlineProgress(id), saved)
    const next = randomUUID()
    f.store.beginPendingOnlinePlayback(id, next)
    assert.throws(
      () =>
        f.store.cacheSourceEpisode(id, full(), {
          kind: 'resume',
          sessionId: next,
          revision: saved!.revision + 1,
          observedProof: proof,
        }),
      { code: 'INVALID_REQUEST' },
    )
    assert.equal(f.store.getAudio(id), undefined)
    assert.deepEqual(f.store.getPendingOnlineProgress(id), saved)
  } finally {
    f.store.close()
  }
})

test('schema 18 portable backup preserves pending proof and position but restores no live lease', async () => {
  const f = fixture(),
    id = f.ids[0]!,
    session = randomUUID(),
    archive = join(f.root, 'pending.zip')
  let destination: LibraryStore | undefined
  try {
    f.store.beginPendingOnlinePlayback(id, session)
    f.store.savePendingOnlineProgress(update(id, session), proof)
    f.store.endPendingOnlinePlayback(session)
    const exported = new BackupService({
      root: f.root,
      version: '0.38.0-dev.1',
      maxSchemaVersion: LIBRARY_SCHEMA_VERSION,
    })
    await exported.exportTo(archive, {})
    await assert.rejects(
      new BackupService({ root: f.root, version: 'old', maxSchemaVersion: 17 }).previewFile(
        archive,
      ),
      { code: 'INVALID_REQUEST' },
    )
    const target = mkdtempSync(join(tmpdir(), 'ralb-pending-restore-')),
      paths = createDataPaths(target)
    new LibraryStore(paths.database).close()
    const restoring = new BackupService({
      root: target,
      version: '0.38.0-dev.1',
      maxSchemaVersion: LIBRARY_SCHEMA_VERSION,
    })
    const preview = await restoring.previewFile(archive)
    await restoring.stageRestore(preview.previewId)
    assert.equal((await applyPendingRestoreAtStartup(target)).applied, true)
    destination = new LibraryStore(paths.database)
    assert.deepEqual(destination.getPendingOnlineProgress(id), f.store.getPendingOnlineProgress(id))
    assert.equal(destination.getAudio(id), undefined)
    assert.equal(destination.getEpisode(id)!.positionMs, 4000)
    assert.throws(() => destination!.savePendingOnlineProgress(update(id, session), proof), {
      code: 'INVALID_REQUEST',
    })
    const next = randomUUID(),
      saved = destination.beginPendingOnlinePlayback(id, next).resume!
    destination.cacheSourceEpisode(id, full(), {
      kind: 'resume',
      sessionId: next,
      revision: saved.revision,
      observedProof: proof,
    })
    assert.equal(destination.getEpisode(id)!.positionMs, 4000)
  } finally {
    destination?.close()
    f.store.close()
  }
})
