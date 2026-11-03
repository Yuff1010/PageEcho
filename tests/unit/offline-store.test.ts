import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import type { OfflineItemContext, StoredOfflineItem } from '../../src/main/offline-store'
import type { OfflinePlan } from '../../src/shared/offline'
import type { TranscriptDocument } from '../../src/shared/transcript'
import type { SourceBook, SourceEpisode } from '../../src/shared/sources'

const profile = { engine: 'paraformer', device: 'cpu' } as const
async function fixture(t: TestContext, online = false, count = 3, complete = true) {
  const root = await mkdtemp(join(tmpdir(), '听读 离线数据库 ')),
    filename = join(root, 'library.sqlite3')
  let store = new LibraryStore(filename)
  if (online) {
    const book: SourceBook = {
      sourceId: 'ting13',
      id: 'offline-book',
      title: '离线书',
      authors: [],
      narrators: [],
      description: '',
      pageUrl: 'https://www.ting13.cc/youshengxiaoshuo/39941/',
    }
    const episodes: SourceEpisode[] = Array.from({ length: count }, (_, i) => ({
      sourceId: 'ting13',
      bookId: book.id,
      id: `offline-${i}`,
      title: `第${i + 1}集`,
      order: i + 1,
      pageUrl: `https://www.ting13.cc/play/39941_1_${i + 1}.html`,
    }))
    store.rememberSourceBook(book, episodes, complete)
  } else {
    for (let i = 0; i < count; i++)
      await writeFile(join(root, `${i}.mp3`), `owned offline sample ${i}`)
    store.importBook(await scanBook(root, 'folder'))
  }
  const book = store.listBooks()[0]!,
    episodes = book.episodes
  t.after(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  const plan = (ids = episodes.map((e) => e.id), budget = online ? 1000 : 0) =>
    store.createOfflinePlan({
      bookId: book.id,
      episodeIds: ids,
      scope: 'ids',
      profile,
      audioBudgetBytes: budget,
    })
  const item = (p: OfflinePlan, index = 0) => store.storedOfflineItems(p.id)[index]!
  const context = (p: OfflinePlan, value: StoredOfflineItem): OfflineItemContext => ({
    planId: p.id,
    planRevision: p.revision,
    itemId: value.id,
    attempt: value.attempt,
  })
  const media = async (index = 0, bytes = 100, stem = `media-${index}`) => {
    const path = join(root, `${stem}.mp3`),
      body = Buffer.alloc(bytes, index + 1)
    await writeFile(path, body)
    return {
      path,
      name: episodes[index]!.title,
      sizeBytes: bytes,
      modifiedAt: (await stat(path)).mtimeMs,
      contentHash: createHash('sha256').update(body).digest('hex'),
    }
  }
  return {
    root,
    filename,
    book,
    episodes,
    plan,
    item,
    context,
    media,
    get store() {
      return store
    },
    reopen(beforeOpen?: () => void) {
      store.close()
      beforeOpen?.()
      store = new LibraryStore(filename)
      return store
    },
  }
}
function transcript(hash: string, endMs = 10000): TranscriptDocument {
  return {
    version: 1,
    audioHash: hash,
    kind: 'manual',
    coverage: [{ startMs: 0, endMs }],
    segments: [
      { id: 's', startMs: 100, endMs: Math.min(4500, endMs), text: '人工确认的原有文稿。' },
    ],
  }
}
const conflict = { code: 'CONFLICT' }

test('schema 12 upgrades atomically without changing book, player, manual text or processing policy', async (t) => {
  const f = await fixture(t),
    e = f.episodes[0]!
  f.store.saveProgress({
    sessionId: e.id,
    episodeId: e.id,
    positionMs: 2345,
    durationMs: 10000,
    rate: 1.5,
    volume: 0.4,
  })
  f.store.saveTranscript(e.id, transcript(e.contentHash))
  f.store.setProcessingPolicy({
    revision: 1,
    policy: { cpuThreads: 2, lowPriority: true, backgroundIdleOnly: true },
  })
  const job = f.store.createJob({ episodeId: e.id, audioHash: e.contentHash, ...profile })
  const reopened = f.reopen(() => {
    const db = new DatabaseSync(f.filename)
    db.exec(
      'DROP TABLE online_pending_progress; DROP TABLE subtitle_import_commands; DROP TABLE subtitle_import_sources; DROP TABLE transcript_edit_commands; DROP TABLE transcript_edit_members; DROP TABLE transcript_edit_heads; DROP TABLE transcript_edit_groups; DROP TABLE offline_media_refs; DROP TABLE offline_plan_items; DROP TABLE offline_job_owners; DROP TABLE offline_plans; PRAGMA user_version=12;',
    )
    db.close()
  })
  assert.equal(reopened.listBooks()[0]!.episodes.length, 3)
  assert.equal(reopened.getEpisode(e.id)!.positionMs, 2345)
  const saved = reopened.getTranscript(e.id, e.contentHash)
  assert.equal(saved.status, 'ready')
  if (saved.status === 'ready') assert.equal(saved.transcript.document.kind, 'manual')
  assert.equal(reopened.getJob(job.id)!.cpuThreads, 2)
  assert.equal(reopened.processingResources().policy.lowPriority, true)
  assert.equal(reopened.offlinePlans().total, 0)
  const check = new DatabaseSync(f.filename)
  assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 18)
  assert.equal(
    check
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'offline_%' AND type='table'",
      )
      .get()!.n,
    4,
  )
  check.close()
})

test('selection validation, stable source ordering, item bounds and five unfinished plans are atomic', async (t) => {
  const f = await fixture(t),
    ids = f.episodes.map((e) => e.id)
  for (const episodeIds of [[], [ids[0]!, ids[0]!], Array.from({ length: 1001 }, () => ids[0]!)])
    assert.throws(() => f.plan(episodeIds), { code: 'INVALID_REQUEST' })
  assert.throws(
    () =>
      f.store.createOfflinePlan({
        bookId: f.book.id,
        episodeIds: [ids[0]!, ids[2]!],
        scope: 'range',
        profile,
        audioBudgetBytes: 0,
      }),
    { code: 'INVALID_REQUEST' },
  )
  assert.throws(
    () =>
      f.store.createOfflinePlan({
        bookId: f.book.id,
        episodeIds: [ids[0]!],
        scope: 'all',
        profile,
        audioBudgetBytes: 0,
      }),
    { code: 'SOURCE_CHANGED' },
  )
  assert.equal(f.store.offlinePlans().total, 0)
  const ordered = f.plan([ids[2]!, ids[0]!])
  assert.deepEqual(
    f.store.storedOfflineItems(ordered.id).map((i) => i.episodeId),
    [ids[0], ids[2]],
  )
  const dto = f.store.offlineItems(ordered.id).items[0]!
  for (const key of ['path', 'file', 'audioVerified', 'retryRequested'])
    assert.equal(key in dto, false)
  for (let i = 0; i < 4; i++) f.plan([ids[0]!])
  assert.throws(() => f.plan([ids[0]!]), { code: 'BUSY' })
  f.store.updateOfflinePlan({ id: ordered.id, revision: ordered.revision, action: 'cancel' })
  assert.equal(f.plan([ids[0]!]).status, 'queued')
})

test('control revisions reject late writes, block does not consume control generation, and restart never revives cancellation', async (t) => {
  const f = await fixture(t),
    p = f.plan(),
    item = f.item(p),
    context = f.context(p, item)
  f.store.updateOfflineItem({ ...context, patch: { status: 'downloading' } })
  assert.equal(f.store.offlinePlan(p.id)!.revision, p.revision)
  const blocked = f.store.blockOfflinePlan(p.id, p.revision, '需要增加离线预算')
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.revision, p.revision)
  assert.throws(
    () => f.store.updateOfflineItem({ ...context, patch: { status: 'audio-ready' } }),
    conflict,
  )
  const budget = f.store.updateOfflinePlan({
    id: p.id,
    revision: p.revision,
    action: 'set-budget',
    audioBudgetBytes: 10,
  })
  assert.equal(budget.status, 'blocked')
  let resumed = f.store.updateOfflinePlan({ id: p.id, revision: budget.revision, action: 'resume' })
  const refreshed = f.item(resumed)
  f.store.updateOfflineItem({ ...f.context(resumed, refreshed), patch: { status: 'transcribing' } })
  const paused = f.store.updateOfflinePlan({
    id: p.id,
    revision: resumed.revision,
    action: 'pause',
  })
  assert.throws(
    () =>
      f.store.retainOfflineMedia(f.context(resumed, refreshed), f.store.getAudio(item.episodeId)!),
    conflict,
  )
  f.reopen()
  f.store.recoverOfflinePlans()
  assert.equal(f.store.offlinePlan(p.id)!.status, 'paused')
  resumed = f.store.updateOfflinePlan({ id: p.id, revision: paused.revision, action: 'resume' })
  const canceled = f.store.updateOfflinePlan({
    id: p.id,
    revision: resumed.revision,
    action: 'cancel',
  })
  f.reopen()
  f.store.recoverOfflinePlans()
  assert.equal(f.store.offlinePlan(p.id)!.status, 'canceled')
  assert.equal(f.item(canceled).status, 'canceled')
  assert.throws(
    () =>
      f.store.updateOfflinePlan({ id: p.id, revision: canceled.revision, action: 'retry-failed' }),
    conflict,
  )
  assert.throws(
    () => f.store.updateOfflinePlan({ id: p.id, revision: canceled.revision, action: 'resume' }),
    conflict,
  )
})

test('retention binds media, cache and exact refs atomically and checks projected unique budget', async (t) => {
  const f = await fixture(t, true),
    p = f.plan(undefined, 100),
    one = f.item(p),
    audio = await f.media(0)
  const retained = f.store.retainOfflineMedia(f.context(p, one), audio)
  assert.equal(retained.audioReady, true)
  assert.equal(f.store.sourceCacheFiles().length, 1)
  assert.equal(f.store.offlineRetainedFiles().length, 1)
  f.store.retainOfflineMedia(f.context(p, retained), audio)
  assert.equal(
    f.store.offlineRetainedFiles(p.id).reduce((n, v) => n + v.sizeBytes, 0),
    100,
  )
  const second = f.item(p, 1),
    other = await f.media(1)
  assert.throws(() => f.store.retainOfflineMedia(f.context(p, second), other), { code: 'BUSY' })
  assert.equal(f.store.getAudio(second.episodeId), undefined)
  assert.equal(f.store.sourceCacheFiles().length, 1)
  const sameBytes = await f.media(0, 100, 'replacement-same-content')
  f.store.retainOfflineMedia(f.context(p, retained), sameBytes)
  assert.deepEqual(
    f.store.offlineRetainedFiles(p.id).map((v) => v.path),
    [sameBytes.path],
  )
  assert.equal(f.store.offlineRetainedFiles(p.id)[0]!.contentHash, audio.contentHash)
  const canceled = f.store.updateOfflinePlan({ id: p.id, revision: p.revision, action: 'cancel' })
  assert.equal(f.store.offlineRetainedFiles().length, 1)
  assert.throws(() => f.store.retainOfflineMedia(f.context(p, second), other), conflict)
  assert.equal(
    f.store.releaseOfflineMedia(p.id, canceled.revision).retentionReleasedAt !== null,
    true,
  )
  assert.equal(f.store.offlineRetainedFiles().length, 0)
  assert.equal((await readFile(sameBytes.path)).length, 100)
})

test('shared files across plans have one physical identity and releasing one leaves the other pin', async (t) => {
  const f = await fixture(t, true),
    audio = await f.media(),
    p = f.plan(undefined, 100),
    first = f.item(p)
  f.store.retainOfflineMedia(f.context(p, first), audio)
  assert.equal(f.store.offlineMediaReferences().length, 1)
  assert.equal(f.store.offlineRetainedFiles(p.id).length, 1)
  const other = f.plan([first.episodeId], 100),
    otherItem = f.item(other)
  f.store.retainOfflineMedia(f.context(other, otherItem), audio)
  assert.equal(f.store.offlineMediaReferences().length, 2)
  assert.equal(f.store.offlineRetainedFiles().length, 1)
  assert.throws(() => f.store.releaseOfflineMedia(other.id, other.revision), conflict)
  const ended = f.store.updateOfflinePlan({ id: p.id, revision: p.revision, action: 'cancel' })
  f.store.releaseOfflineMedia(p.id, ended.revision)
  assert.equal(f.store.offlineRetainedFiles().length, 1)
  assert.equal(f.store.offlineMediaReferences()[0]!.planId, other.id)
  assert.equal((await readFile(audio.path)).length, 100)
})

test('a database failure after cache registration rolls the whole retained-media transaction back', async (t) => {
  const f = await fixture(t, true),
    p = f.plan(),
    item = f.item(p),
    audio = await f.media()
  const db = new DatabaseSync(f.filename)
  db.exec(
    "CREATE TRIGGER fail_offline_ref BEFORE INSERT ON offline_media_refs BEGIN SELECT RAISE(ABORT,'owned ref failure'); END;",
  )
  assert.throws(() => f.store.retainOfflineMedia(f.context(p, item), audio), /owned ref failure/)
  assert.equal(f.store.getAudio(item.episodeId), undefined)
  assert.equal(f.store.sourceCacheFiles().length, 0)
  assert.equal(f.store.offlineRetainedFiles().length, 0)
  assert.equal(f.item(p).audioHash, null)
  db.exec('DROP TRIGGER fail_offline_ref')
  db.close()
  assert.equal(f.store.retainOfflineMedia(f.context(p, item), audio).audioReady, true)
})

test('only verified audio and formal full coverage with actual duration can complete an item', async (t) => {
  const f = await fixture(t),
    p = f.plan([f.episodes[0]!.id]),
    item = f.item(p),
    e = f.episodes[0]!,
    context = f.context(p, item)
  assert.equal(item.audioHash, e.contentHash)
  f.store.retainOfflineMedia(context, f.store.getAudio(e.id)!)
  assert.equal(f.store.sourceCacheFiles().length, 0)
  assert.equal(f.store.offlineRetainedFiles().length, 0)
  f.store.saveTranscript(e.id, transcript(e.contentHash))
  assert.equal(f.store.getOfflineReadiness(item.id).subtitleState, 'unknown-duration')
  assert.throws(
    () => f.store.updateOfflineItem({ ...context, patch: { status: 'ready' } }),
    conflict,
  )
  f.store.updateOfflineItem({ ...context, patch: { durationMs: 20000 } })
  assert.equal(f.store.getOfflineReadiness(item.id).subtitleState, 'partial')
  assert.throws(
    () => f.store.updateOfflineItem({ ...context, patch: { status: 'ready' } }),
    conflict,
  )
  f.store.saveTranscript(e.id, {
    ...transcript(e.contentHash),
    coverage: [
      { startMs: 0, endMs: 9999 },
      { startMs: 10000, endMs: 20000 },
    ],
  })
  assert.equal(
    f.store.getOfflineReadiness(item.id).subtitleReady,
    false,
    'one millisecond internal gap is still a real gap',
  )
  f.store.saveTranscript(e.id, transcript(e.contentHash, 20000))
  const ready = f.store.updateOfflineItem({ ...context, patch: { status: 'ready' } })
  assert.equal(ready.subtitleSource, 'manual')
  assert.equal(f.store.offlinePlan(p.id)!.status, 'completed')
  assert.equal(f.store.offlinePlan(p.id)!.revision, p.revision)
})

test('completed generated preview does not replace manual text or count as formal completion', async (t) => {
  const f = await fixture(t),
    e = f.episodes[0]!,
    p = f.plan([e.id]),
    item = f.item(p),
    context = f.context(p, item)
  f.store.retainOfflineMedia(context, f.store.getAudio(e.id)!)
  f.store.updateOfflineItem({ ...context, patch: { durationMs: 10000 } })
  f.store.saveTranscript(e.id, transcript(e.contentHash, 5000))
  const { job } = f.store.createOrAttachOfflineJob(item.id, {
    episodeId: e.id,
    audioHash: e.contentHash,
    ...profile,
  })
  f.store.setJobStatus(job.id, job.attempt, 'running')
  const document = { ...transcript(e.contentHash), kind: 'transcript' as const }
  f.store.acceptJobSnapshot(
    job.id,
    job.attempt,
    {
      document,
      processedUntilMs: 10000,
      totalChunks: 1,
      cacheHits: 0,
      cacheKey: 'a'.repeat(64),
      issues: [],
    },
    1,
    true,
    10000,
  )
  assert.equal(f.store.getJob(job.id)!.status, 'completed')
  assert.equal(f.store.getJob(job.id)!.autoApply, false)
  assert.equal(f.store.getOfflineReadiness(item.id).subtitleReady, false)
  assert.throws(
    () => f.store.updateOfflineItem({ ...context, patch: { status: 'ready' } }),
    conflict,
  )
  const saved = f.store.getTranscript(e.id, e.contentHash)
  assert(saved.status === 'ready')
  assert.equal(saved.transcript.document.coverage[0]!.endMs, 5000)
})

test('ownership persists manual takeover before attachment and distinguishes historical planned jobs', async (t) => {
  const f = await fixture(t),
    e = f.episodes[0]!,
    request = { episodeId: e.id, audioHash: e.contentHash, ...profile }
  const manual = f.store.createJob(request)
  f.store.claimJobForManual(manual.id)
  assert.deepEqual(f.store.offlineJobOwnership(manual.id), {
    planned: false,
    runnable: false,
    manual: true,
  })
  f.store.demoteJob(manual.id)
  const p = f.plan([e.id]),
    other = f.plan([e.id]),
    item = f.item(p),
    otherItem = f.item(other)
  assert.equal(f.store.createOrAttachOfflineJob(item.id, request).job.id, manual.id)
  assert.equal(f.store.createOrAttachOfflineJob(otherItem.id, request).job.id, manual.id)
  assert.deepEqual(f.store.offlineJobOwnership(manual.id), {
    planned: true,
    runnable: true,
    manual: true,
  })
  f.store.updateOfflinePlan({ id: p.id, revision: p.revision, action: 'pause' })
  assert.equal(f.store.offlineJobOwnership(manual.id).runnable, true)
  f.store.updateOfflinePlan({ id: other.id, revision: other.revision, action: 'cancel' })
  f.reopen()
  assert.deepEqual(f.store.offlineJobOwnership(manual.id), {
    planned: true,
    runnable: false,
    manual: true,
  })
})

test('profile conflicts and stopped jobs do not create an orphan job; explicit failed retry preserves original CPU identity', async (t) => {
  const f = await fixture(t),
    p = f.plan([f.episodes[0]!.id]),
    item = f.item(p),
    e = f.episodes[0]!,
    request = { episodeId: e.id, audioHash: e.contentHash, ...profile }
  const job = f.store.createJob({ ...request, engine: 'whisperx' }, true)
  assert.throws(() => f.store.createOrAttachOfflineJob(item.id, request), { code: 'BUSY' })
  assert.equal(f.item(p).jobId, null)
  f.store.setJobStatus(job.id, job.attempt, 'canceled')
  assert.throws(() => f.store.createOrAttachOfflineJob(item.id, request), conflict)
  assert.equal(f.store.listJobs({ page: 0, activeOnly: false }).total, 1)
  const e2 = f.episodes[1]!,
    p2 = f.plan([e2.id]),
    i2 = f.item(p2),
    r2 = { ...request, episodeId: e2.id, audioHash: e2.contentHash }
  const created = f.store.createOrAttachOfflineJob(i2.id, r2).job
  f.store.setJobStatus(created.id, created.attempt, 'failed', 'fixture')
  f.store.updateOfflineItem({
    ...f.context(p2, f.item(p2)),
    patch: { status: 'failed', error: 'fixture' },
  })
  assert.throws(() => f.store.createOrAttachOfflineJob(i2.id, r2), conflict)
  f.store.setProcessingPolicy({
    revision: 1,
    policy: { cpuThreads: 1, lowPriority: true, backgroundIdleOnly: true },
  })
  const retry = f.store.updateOfflinePlan({
    id: p2.id,
    revision: p2.revision,
    action: 'retry-failed',
  })
  const resumed = f.store.createOrAttachOfflineJob(i2.id, r2, {
    planRevision: retry.revision,
    attempt: f.item(retry).attempt,
  }).job
  assert.equal(resumed.id, created.id)
  assert.equal(resumed.cpuThreads, 4)
  assert.equal(resumed.attempt, created.attempt + 1)
})

test('unknown duration container fallback and formal publication roll back together without changing playback position', async (t) => {
  const f = await fixture(t),
    e = f.episodes[0]!,
    p = f.plan([e.id]),
    item = f.item(p)
  f.store.saveProgress({
    sessionId: e.id,
    episodeId: e.id,
    positionMs: 2000,
    durationMs: null,
    rate: 1,
    volume: 1,
  })
  const job = f.store.createOrAttachOfflineJob(item.id, {
    episodeId: e.id,
    audioHash: e.contentHash,
    ...profile,
  }).job
  f.store.setJobStatus(job.id, job.attempt, 'running')
  const snapshot = {
    document: { ...transcript(e.contentHash), kind: 'transcript' as const },
    processedUntilMs: 10000,
    totalChunks: 1,
    cacheHits: 0,
    cacheKey: 'a'.repeat(64),
    issues: [],
  }
  const db = new DatabaseSync(f.filename)
  db.exec(
    "CREATE TRIGGER fail_duration_snapshot BEFORE INSERT ON transcripts BEGIN SELECT RAISE(ABORT,'owned transcript failure'); END;",
  )
  assert.throws(
    () => f.store.acceptJobSnapshot(job.id, job.attempt, snapshot, 1, true, 10000.25),
    /owned transcript failure/,
  )
  assert.equal(f.store.getEpisode(e.id)!.durationMs, null)
  assert.equal(f.store.getStoredOfflineItem(item.id)!.durationMs, null)
  assert.equal(f.store.getJob(job.id)!.status, 'running')
  db.exec('DROP TRIGGER fail_duration_snapshot')
  db.close()
  assert.equal(f.store.acceptJobSnapshot(job.id, job.attempt, snapshot, 1, true, 10000.25), true)
  assert.equal(f.store.getEpisode(e.id)!.durationMs, 10000.25)
  assert.equal(f.store.getStoredOfflineItem(item.id)!.durationMs, 10000.25)
  assert.equal(f.store.getEpisode(e.id)!.positionMs, 2000)
})

test('worker container padding never overwrites known Chromium duration or creates a false missing tail', async (t) => {
  const f = await fixture(t),
    cases = [
      [474384, 474436],
      [431424, 431464],
      [398232, 398263],
    ]
  for (const [index, [chromiumMs, containerMs]] of cases.entries()) {
    const e = f.episodes[index]!
    f.store.recordSourceDuration(e.id, e.contentHash, chromiumMs!)
    const p = f.plan([e.id]),
      item = f.item(p)
    f.store.retainOfflineMedia(f.context(p, item), f.store.getAudio(e.id)!)
    const job = f.store.createOrAttachOfflineJob(item.id, {
      episodeId: e.id,
      audioHash: e.contentHash,
      ...profile,
    }).job
    f.store.setJobStatus(job.id, job.attempt, 'running')
    const snapshot = {
      document: { ...transcript(e.contentHash, chromiumMs), kind: 'transcript' as const },
      processedUntilMs: chromiumMs!,
      totalChunks: 1,
      cacheHits: 0,
      cacheKey: 'a'.repeat(64),
      issues: [],
    }
    assert.throws(
      () => f.store.acceptJobSnapshot(job.id, job.attempt, snapshot, 1, true, Infinity),
      { code: 'INVALID_REQUEST' },
    )
    assert.equal(f.store.getEpisode(e.id)!.durationMs, chromiumMs)
    assert.equal(f.store.getJob(job.id)!.status, 'running')
    assert.equal(
      f.store.acceptJobSnapshot(job.id, job.attempt, snapshot, 1, true, containerMs),
      true,
    )
    assert.equal(f.store.getEpisode(e.id)!.durationMs, chromiumMs)
    assert.equal(f.store.getStoredOfflineItem(item.id)!.durationMs, chromiumMs)
    assert.equal(f.store.getJob(job.id)!.status, 'completed')
    assert.equal(f.store.getOfflineReadiness(item.id).subtitleReady, true)
    f.store.updateOfflineItem({ ...f.context(p, item), patch: { status: 'ready' } })
    assert.equal(f.store.offlinePlan(p.id)!.status, 'completed')
  }
})

test('changed locked media is reported without rebinding and removing a book preserves terminal history and pins', async (t) => {
  const f = await fixture(t, true),
    audio = await f.media(),
    p = f.plan(),
    item = f.item(p)
  f.store.retainOfflineMedia(f.context(p, item), audio)
  const replacement = await f.media(0, 120, 'new-version')
  f.store.cacheSourceEpisode(item.episodeId, replacement)
  assert.equal(f.store.getOfflineReadiness(item.id).changed, true)
  assert.throws(() => f.store.retainOfflineMedia(f.context(p, f.item(p)), replacement), {
    code: 'FILE_CHANGED',
  })
  const attention = f.store.updateOfflineItem({
    ...f.context(p, f.item(p)),
    patch: { status: 'needs-attention', error: '原媒体版本变化' },
  })
  assert.equal(attention.audioHash, audio.contentHash)
  f.store.removeBook(f.book.id)
  const canceled = f.store.offlinePlan(p.id)!
  assert.equal(canceled.status, 'canceled')
  assert(canceled.revision > p.revision)
  assert.equal(f.store.offlineRetainedFiles().length, 1)
  f.store.releaseOfflineMedia(p.id, canceled.revision)
  assert.equal(f.store.offlineRetainedFiles().length, 0)
  assert.equal((await readFile(audio.path)).length, 100)
})

test('metadata invalidation is exact, persistent and never releases pins or revives canceled items', async (t) => {
  const f = await fixture(t, true),
    audio = await f.media(),
    p = f.plan([f.episodes[0]!.id]),
    item = f.item(p)
  f.store.retainOfflineMedia(f.context(p, item), audio)
  f.store.updateOfflineItem({ ...f.context(p, item), patch: { durationMs: 10000 } })
  f.store.saveTranscript(item.episodeId, transcript(audio.contentHash))
  f.store.updateOfflineItem({ ...f.context(p, item), patch: { status: 'ready' } })
  assert.equal(f.store.offlinePlan(p.id)!.status, 'completed')
  const other = f.plan([item.episodeId]),
    otherItem = f.item(other)
  f.store.retainOfflineMedia(f.context(other, otherItem), audio)
  const canceled = f.store.updateOfflinePlan({
    id: other.id,
    revision: other.revision,
    action: 'cancel',
  })
  assert.deepEqual(
    f.store.invalidateOfflineMedia(
      { ...audio, modifiedAt: audio.modifiedAt + 1 },
      '旧元数据不应碰新身份',
    ),
    { items: 0, planIds: [] },
  )
  const invalidated = f.store.invalidateOfflineMedia(audio, '保留文件已丢失')
  assert.equal(invalidated.items, 2)
  assert.deepEqual(new Set(invalidated.planIds), new Set([p.id, other.id]))
  assert.equal(f.store.offlinePlan(p.id)!.status, 'completed-with-issues')
  assert.equal(f.store.offlinePlan(p.id)!.revision, p.revision)
  assert.equal(f.store.getStoredOfflineItem(item.id)!.status, 'needs-attention')
  assert.equal(f.store.getOfflineReadiness(item.id).audioReady, false)
  assert.equal(f.store.getStoredOfflineItem(otherItem.id)!.status, 'canceled')
  assert.equal(f.store.offlinePlan(other.id)!.revision, canceled.revision)
  assert.equal(f.store.offlineRetainedFiles().length, 1)
  assert.equal(f.store.offlineMediaReferences().length, 2)
  const attempt = f.store.getStoredOfflineItem(item.id)!.attempt
  assert.equal(f.store.invalidateOfflineMedia(audio, '仍然丢失').items, 0)
  assert.equal(f.store.getStoredOfflineItem(item.id)!.attempt, attempt)
  f.reopen()
  f.store.recoverOfflinePlans()
  assert.equal(f.store.getOfflineReadiness(item.id).audioReady, false)
  assert.equal(f.store.offlinePlan(other.id)!.status, 'canceled')
  assert.throws(
    () => f.store.updateOfflineItem({ ...f.context(p, item), patch: { status: 'ready' } }),
    conflict,
  )
})

test('zero-byte online budget blocks positive retention without partially registering or locking audio', async (t) => {
  const f = await fixture(t, true),
    p = f.plan(undefined, 0),
    item = f.item(p),
    audio = await f.media()
  assert.throws(() => f.store.retainOfflineMedia(f.context(p, item), audio), { code: 'BUSY' })
  assert.equal(f.item(p).audioHash, null)
  assert.equal(f.store.sourceCacheFiles().length, 0)
  assert.equal(f.store.offlineRetainedFiles().length, 0)
})

test('a thousand-item complete catalog persists and pages without returning hidden media paths', async (t) => {
  const f = await fixture(t, true, 1000),
    ids = f.episodes.map((e) => e.id)
  const p = f.store.createOfflinePlan({
    bookId: f.book.id,
    episodeIds: ids,
    scope: 'all',
    profile,
    audioBudgetBytes: 0,
  })
  assert.equal(p.counts.total, 1000)
  assert.equal(f.store.offlineItems(p.id, 0).items.length, 100)
  const last = f.store.offlineItems(p.id, 9)
  assert.equal(last.total, 1000)
  assert.equal(last.items.length, 100)
  assert.equal(last.items[99]!.episodeId, ids[999])
  assert.equal(last.items[99]!.ordinal, 1000)
  assert.equal('file' in last.items[99]!, false)
  assert.deepEqual(f.store.offlineItems(p.id, 10).items, [])
  f.reopen()
  assert.equal(f.store.offlinePlan(p.id)!.counts.total, 1000)
})

test('an incomplete online catalog cannot become a whole-book plan but explicit known episodes remain usable', async (t) => {
  const f = await fixture(t, true, 3, false),
    ids = f.episodes.map((e) => e.id)
  assert.throws(
    () =>
      f.store.createOfflinePlan({
        bookId: f.book.id,
        episodeIds: ids,
        scope: 'all',
        profile,
        audioBudgetBytes: 1000,
      }),
    { code: 'SOURCE_CHANGED' },
  )
  assert.equal(f.store.offlinePlans().total, 0)
  assert.equal(f.plan(ids).counts.total, 3)
})

test('a rescanned-away episode can only record its failure, while old completion and canceled writes remain rejected', async (t) => {
  const f = await fixture(t),
    p = f.plan(),
    item = f.item(p),
    context = f.context(p, item),
    audio = f.store.getAudio(item.episodeId)!
  await rm(audio.path)
  f.store.importBook(await scanBook(f.root, 'folder'))
  assert.equal(f.store.getEpisode(item.episodeId), undefined)
  assert.throws(() => f.store.retainOfflineMedia(context, audio), { code: 'SOURCE_CHANGED' })
  assert.throws(
    () =>
      f.store.updateOfflineItem({
        ...context,
        patch: { status: 'needs-attention', durationMs: 10000 },
      }),
    { code: 'SOURCE_CHANGED' },
  )
  assert.throws(
    () =>
      f.store.updateOfflineItem({
        ...context,
        patch: { status: 'needs-attention', audioReady: true },
      }),
    { code: 'SOURCE_CHANGED' },
  )
  const attention = f.store.updateOfflineItem({
    ...context,
    patch: { status: 'needs-attention', error: '原分集已在重扫后移除' },
  })
  assert.equal(attention.audioHash, audio.contentHash)
  assert.equal(attention.status, 'needs-attention')
  const paused = f.store.updateOfflinePlan({ id: p.id, revision: p.revision, action: 'pause' })
  assert.throws(
    () =>
      f.store.updateOfflineItem({ ...context, patch: { status: 'failed', error: '旧失败响应' } }),
    conflict,
  )
  f.store.updateOfflinePlan({ id: p.id, revision: paused.revision, action: 'cancel' })
  assert.throws(
    () => f.store.updateOfflineItem({ ...context, patch: { status: 'needs-attention' } }),
    conflict,
  )
})

test('changing budget invalidates active item attempts and requeues them without implicitly resuming blocked plans', async (t) => {
  const f = await fixture(t, true),
    p = f.plan(),
    item = f.item(p),
    context = f.context(p, item)
  f.store.updateOfflineItem({ ...context, patch: { status: 'downloading' } })
  const changed = f.store.updateOfflinePlan({
    id: p.id,
    revision: p.revision,
    action: 'set-budget',
    audioBudgetBytes: 50,
  })
  assert.equal(changed.revision, p.revision + 1)
  assert.equal(f.item(changed).status, 'queued')
  assert.equal(f.item(changed).attempt, item.attempt + 1)
  assert.throws(
    () => f.store.updateOfflineItem({ ...context, patch: { status: 'failed' } }),
    conflict,
  )
  const blocked = f.store.blockOfflinePlan(p.id, changed.revision, '预算不足')
  const adjusted = f.store.updateOfflinePlan({
    id: p.id,
    revision: blocked.revision,
    action: 'set-budget',
    audioBudgetBytes: 1000,
  })
  assert.equal(adjusted.status, 'blocked')
})

test('scheduler control queries exclude terminal, paused and blocked plans without reading any media or coverage', async (t) => {
  const f = await fixture(t),
    queued = f.plan(),
    running = f.plan(),
    paused = f.plan(),
    blocked = f.plan(),
    canceled = f.plan()
  const active = f.item(running)
  f.store.updateOfflineItem({ ...f.context(running, active), patch: { status: 'downloading' } })
  f.store.updateOfflinePlan({ id: paused.id, revision: paused.revision, action: 'pause' })
  f.store.blockOfflinePlan(blocked.id, blocked.revision, '未配置组件')
  f.store.updateOfflinePlan({ id: canceled.id, revision: canceled.revision, action: 'cancel' })
  const getEpisode = f.store.getEpisode,
    getAudio = f.store.getAudio,
    latestJob = f.store.latestJob
  try {
    const forbidden = () => {
      throw new Error('Scheduler must not resolve assets or transcript coverage')
    }
    f.store.getEpisode = forbidden
    f.store.getAudio = forbidden
    f.store.latestJob = forbidden
    assert.deepEqual(f.store.offlinePlanControl(queued.id), {
      id: queued.id,
      revision: queued.revision,
      status: 'queued',
      profile,
      audioBudgetBytes: 0,
    })
    assert.equal(f.store.offlinePlanControl(paused.id)!.status, 'paused')
    assert.equal(f.store.offlinePlanControl('missing'), null)
    const scheduled = f.store.offlineSchedulingPlans()
    assert.deepEqual(
      scheduled.map((plan) => plan.id),
      [running.id, queued.id],
    )
    assert.deepEqual(
      scheduled.map((plan) => plan.status),
      ['running', 'queued'],
    )
    assert(
      scheduled.every(
        (plan) =>
          Object.keys(plan).sort().join(',') === 'audioBudgetBytes,id,profile,revision,status',
      ),
    )
  } finally {
    f.store.getEpisode = getEpisode
    f.store.getAudio = getAudio
    f.store.latestJob = latestJob
  }
})

test('invalidating the final runnable item finishes with issues while preserving paused, blocked and canceled intent', async (t) => {
  const f = await fixture(t, true),
    audio = await f.media(),
    plans = Array.from({ length: 5 }, () => f.plan([f.episodes[0]!.id]))
  for (const plan of plans) f.store.retainOfflineMedia(f.context(plan, f.item(plan)), audio)
  const [queued, running, paused, blocked, canceled] = plans as [
    OfflinePlan,
    OfflinePlan,
    OfflinePlan,
    OfflinePlan,
    OfflinePlan,
  ]
  f.store.updateOfflineItem({
    ...f.context(running, f.item(running)),
    patch: { status: 'transcribing' },
  })
  const pausedControl = f.store.updateOfflinePlan({
    id: paused.id,
    revision: paused.revision,
    action: 'pause',
  })
  f.store.blockOfflinePlan(blocked.id, blocked.revision, '组件暂不可用')
  const canceledControl = f.store.updateOfflinePlan({
    id: canceled.id,
    revision: canceled.revision,
    action: 'cancel',
  })
  f.store.invalidateOfflineMedia(audio, '启动检查发现文件丢失')
  assert.equal(f.store.offlinePlanControl(queued.id)!.status, 'completed-with-issues')
  assert.equal(f.store.offlinePlanControl(running.id)!.status, 'completed-with-issues')
  assert.equal(f.store.offlinePlanControl(queued.id)!.revision, queued.revision)
  assert.equal(f.store.offlinePlanControl(paused.id)!.status, 'paused')
  assert.equal(f.store.offlinePlanControl(paused.id)!.revision, pausedControl.revision)
  assert.equal(f.store.offlinePlanControl(blocked.id)!.status, 'blocked')
  assert.equal(f.store.offlinePlanControl(canceled.id)!.status, 'canceled')
  assert.equal(f.store.offlinePlanControl(canceled.id)!.revision, canceledControl.revision)
  assert.equal(f.store.offlineSchedulingPlans().length, 0)
  assert.equal(f.store.offlineMediaReferences().length, 5)
})
