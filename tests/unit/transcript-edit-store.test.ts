import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import { LibraryStore } from '../../src/main/database'
import type { AsrSnapshot } from '../../src/main/asr-process'
import { scanBook } from '../../src/main/files'
import { matchOriginal } from '../../src/main/original/match'
import { parseOriginal } from '../../src/main/original/parse'
import type { TranscriptDocument } from '../../src/shared/transcript'
import type { TranscriptEditOperation } from '../../src/shared/transcript-editing'

async function fixture(t: TestContext, count = 3) {
  const root = await mkdtemp(join(tmpdir(), '听读 持久字幕编辑 ')),
    filename = join(root, 'library.sqlite3')
  for (let i = 0; i < count; i++)
    await writeFile(join(root, `${i}.mp3`), `owned edit identity ${i}`)
  let store = new LibraryStore(filename)
  store.importBook(await scanBook(root, 'folder'))
  const book = store.listBooks()[0]!,
    episodes = book.episodes
  const document = (index = 0): TranscriptDocument => ({
    version: 1,
    kind: 'transcript',
    audioHash: episodes[index]!.contentHash,
    coverage: [{ startMs: 0, endMs: 20000 }],
    segments: [
      { id: 's1', startMs: 1000, endMs: 4000, text: '张三😀走进长长的山谷。' },
      { id: 's2', startMs: 5000, endMs: 8000, text: '张三把背包放在石头旁边。' },
      { id: 's3', startMs: 9000, endMs: 11000, text: '远方传来了悠长的钟声。' },
    ],
  })
  for (const [index, e] of episodes.entries()) {
    store.recordSourceDuration(e.id, e.contentHash, 20000)
    store.saveTranscript(e.id, document(index))
  }
  const saved = (index = 0) => {
    const state = store.getTranscript(episodes[index]!.id, episodes[index]!.contentHash)
    assert(state.status === 'ready')
    return state.transcript
  }
  const target = (index = 0) => ({
    episodeId: episodes[index]!.id,
    audioHash: episodes[index]!.contentHash,
    revision: saved(index).revision,
  })
  const edit = (operation: TranscriptEditOperation, index = 0, commandId = randomUUID()) =>
    store.performTranscriptEdit({ ...target(index), commandId, operation })
  const history = (undo = true, index = 0, commandId = randomUUID()) => {
    const state = store.transcriptEditingState(target(index)),
      item = undo ? state.undo : state.redo
    assert(item)
    return (undo ? store.undoTranscriptEdit.bind(store) : store.redoTranscriptEdit.bind(store))({
      ...target(index),
      commandId,
      historyId: item.id,
    })
  }
  const prepare = (
    find = '张三',
    replacement = '李四',
    initiator = 0,
    indices = episodes.map((_, i) => i),
  ) =>
    store.prepareTranscriptReplacement({
      ...target(initiator),
      requestId: randomUUID(),
      scope: { kind: 'book', bookId: book.id, episodeIds: indices.map((i) => episodes[i]!.id) },
      find,
      replacement,
    })
  t.after(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    filename,
    book,
    episodes,
    document,
    saved,
    target,
    edit,
    history,
    prepare,
    get store() {
      return store
    },
    reopen(beforeOpen?: () => void) {
      store.close()
      beforeOpen?.()
      store = new LibraryStore(filename)
    },
  }
}
const snapshot = (document: TranscriptDocument): AsrSnapshot => ({
  document,
  processedUntilMs: document.coverage[0]?.startMs === 0 ? document.coverage[0].endMs : 0,
  totalChunks: 2,
  cacheHits: 0,
  cacheKey: 'a'.repeat(64),
  issues: [],
})
function sql(store: LibraryStore) {
  return Reflect.get(store, 'db') as DatabaseSync
}
function automaticJob(f: Awaited<ReturnType<typeof fixture>>, index = 0) {
  const target = f.target(index),
    job = f.store.createJob({ ...target, engine: 'paraformer', device: 'cpu' })
  // Recreate an existing auto-applied prefix whose formal revision is current.
  sql(f.store)
    .prepare('UPDATE transcription_jobs SET auto_apply=1,applied_revision=? WHERE id=?')
    .run(target.revision, job.id)
  f.store.setJobStatus(job.id, job.attempt, 'running')
  return job
}
test('split and merge persist fresh IDs with exact times; undo and redo restore the same historical IDs and monotonically increase revision', async (t) => {
  const f = await fixture(t),
    original = f.saved().document
  f.edit({ kind: 'split', segmentId: 's1', offset: 3, atMs: 2100 })
  const split = f.saved().document,
    ids = split.segments.slice(0, 2).map((s) => s.id)
  assert(!ids.includes('s1'))
  assert.notEqual(ids[0], ids[1])
  assert.equal(split.segments[0]!.text, '张三😀')
  assert.equal(split.segments[0]!.endMs, 2100)
  assert.equal(split.segments[1]!.startMs, 2100)
  assert.deepEqual(split.coverage, original.coverage)
  assert.equal(split.segments[2]!.id, 's2')
  f.edit({ kind: 'merge', firstId: ids[0]!, secondId: ids[1]!, separator: '' })
  const merged = f.saved().document,
    mergedId = merged.segments[0]!.id
  assert(!ids.includes(mergedId))
  assert.equal(merged.segments[0]!.text, original.segments[0]!.text)
  f.reopen()
  f.history()
  assert.deepEqual(f.saved().document, split)
  f.history()
  assert.deepEqual(f.saved().document, original)
  f.history(false)
  assert.deepEqual(f.saved().document, split)
  f.history(false)
  assert.deepEqual(f.saved().document, merged)
  assert.equal(f.saved().revision, 7)
})

test('command IDs deduplicate semantic retries, reject changed payloads and leave no-op history untouched', async (t) => {
  const f = await fixture(t),
    request = {
      ...f.target(),
      commandId: randomUUID(),
      operation: { kind: 'text' as const, segmentId: 's1', text: '李三😀走进长长的山谷。' },
    }
  const first = f.store.performTranscriptEdit(request)
  assert.equal(first.replayed, false)
  const replay = f.store.performTranscriptEdit({
    ...request,
    operation: { text: request.operation.text, segmentId: 's1', kind: 'text' },
  })
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.changed, [])
  assert.equal(f.saved().revision, 2)
  assert.throws(
    () =>
      f.store.performTranscriptEdit({
        ...request,
        operation: { ...request.operation, text: '王三😀走进长长的山谷。' },
      }),
    { code: 'CONFLICT' },
  )
  const before = f.store.transcriptEditingState(f.target())
  const noOp = f.edit({ kind: 'text', segmentId: 's1', text: f.saved().document.segments[0]!.text })
  assert.equal(noOp.changed.length, 0)
  assert.equal(f.saved().revision, 2)
  assert.deepEqual(noOp.history, before)
  const historyRequest = { ...f.target(), commandId: randomUUID(), historyId: before.undo!.id }
  f.store.undoTranscriptEdit(historyRequest)
  assert.equal(f.store.undoTranscriptEdit(historyRequest).replayed, true)
  assert.equal(f.saved().revision, 3)
})

test('twenty-step history remains bounded across restart, and a new edit deletes the redo branch', async (t) => {
  const f = await fixture(t)
  for (let i = 0; i < 25; i++)
    f.edit({
      kind: 'text',
      segmentId: 's3',
      text: i % 2 ? '远方传来了悠长的钟声。' : '远处传来了悠长的钟声。',
    })
  assert.equal(f.store.transcriptEditingState(f.target()).historyCount, 20)
  f.reopen()
  for (let i = 0; i < 20; i++) f.history()
  const state = f.store.transcriptEditingState(f.target())
  assert.equal(state.undo, null)
  assert(state.redo)
  f.history(false)
  assert.equal(f.saved().revision, 47)
  f.edit({ kind: 'text', segmentId: 's3', text: '近处传来了悠长的钟声。' })
  assert.equal(f.store.transcriptEditingState(f.target()).redo, null)
  const db = new DatabaseSync(f.filename, { readOnly: true })
  assert(
    Number(
      db
        .prepare('SELECT sum(length(CAST(delta_json AS BLOB))) AS n FROM transcript_edit_members')
        .get()!.n,
    ) < 20000,
  )
  db.close()
})

test('literal book replacement is one atomic group and unrelated later edits block the entire group until undone', async (t) => {
  const f = await fixture(t),
    plan = f.prepare(),
    result = f.store.commitTranscriptReplacement(plan, randomUUID())
  assert.equal(result.changed.length, 3)
  assert.equal(result.history.undo!.episodes, 3)
  assert.equal(plan.segments, 6)
  assert.equal(plan.occurrences, 6)
  for (let i = 0; i < 3; i++) assert(f.saved(i).document.segments[0]!.text.startsWith('李四'))
  f.edit({ kind: 'text', segmentId: 's3', text: '远处传来了悠长的钟声。' }, 1)
  assert(f.store.transcriptEditingState(f.target()).undoBlocked)
  const before = [f.saved().revision, f.saved(1).revision, f.saved(2).revision]
  assert.throws(() => f.history(), { code: 'CONFLICT' })
  assert.deepEqual([f.saved().revision, f.saved(1).revision, f.saved(2).revision], before)
  f.history(true, 1)
  assert.equal(f.store.transcriptEditingState(f.target()).undoBlocked, null)
  f.history()
  for (let i = 0; i < 3; i++)
    assert.equal(f.saved(i).document.segments[0]!.text, f.document(i).segments[0]!.text)
  f.reopen()
  f.history(false)
  for (let i = 0; i < 3; i++) assert(f.saved(i).document.segments[0]!.text.startsWith('李四'))
})

test('a nonmatching initiator remains an undo entry without freezing its ASR or blocking edited members after its background update', async (t) => {
  const f = await fixture(t),
    initial = {
      ...f.document(),
      segments: f
        .document()
        .segments.map((s) => ({ ...s, text: s.text.replaceAll('张三', '赵五') })),
    }
  f.store.saveTranscript(f.episodes[0]!.id, initial)
  const target = f.target(),
    job = f.store.createJob({ ...target, engine: 'paraformer', device: 'cpu' })
  const db = new DatabaseSync(f.filename)
  db.prepare('UPDATE transcription_jobs SET auto_apply=1,applied_revision=? WHERE id=?').run(
    target.revision,
    job.id,
  )
  db.close()
  const result = f.store.commitTranscriptReplacement(f.prepare(), randomUUID())
  assert.equal(result.changed.length, 2)
  assert(result.history.undo)
  assert.equal(f.saved().revision, target.revision)
  assert.equal(f.store.getJob(job.id)!.autoApply, true)
  f.store.setJobStatus(job.id, job.attempt, 'running')
  const next = {
    ...initial,
    segments: initial.segments.map((s) =>
      s.id === 's3' ? { ...s, text: '远处传来了悠长的钟声。' } : s,
    ),
  }
  f.store.acceptJobSnapshot(
    job.id,
    job.attempt,
    {
      document: next,
      processedUntilMs: 20000,
      totalChunks: 1,
      cacheHits: 0,
      cacheKey: 'a'.repeat(64),
      issues: [],
    },
    1,
    false,
  )
  assert.equal(f.store.transcriptEditingState(f.target()).undo, null)
  assert.equal(f.store.transcriptEditingState(f.target(1)).undoBlocked, null)
  f.history(true, 1)
  assert(f.saved(1).document.segments[0]!.text.startsWith('张三'))
  assert(f.saved(2).document.segments[0]!.text.startsWith('张三'))
  assert.equal(f.saved().document.segments[2]!.text, next.segments[2]!.text)
})

test('replacement adoption CAS includes unchanged selected members and the initiating transcript, with no partial writes', async (t) => {
  const f = await fixture(t),
    unmatched = { ...f.document(2), segments: [f.document(2).segments[2]!] }
  f.store.saveTranscript(f.episodes[2]!.id, unmatched)
  const plan = f.prepare(),
    before = [f.saved(), f.saved(1)]
  f.edit({ kind: 'text', segmentId: 's3', text: '远处传来了悠长的钟声。' }, 2)
  assert.throws(() => f.store.commitTranscriptReplacement(plan, randomUUID()), { code: 'CONFLICT' })
  assert.deepEqual([f.saved(), f.saved(1)], before)
  assert.equal(f.store.transcriptEditingState(f.target()).undo, null)
  const outside = f.prepare('张三', '李四', 2, [0, 1])
  f.edit({ kind: 'text', segmentId: 's3', text: '近处传来了悠长的钟声。' }, 2)
  assert.throws(() => f.store.commitTranscriptReplacement(outside, randomUUID()), {
    code: 'CONFLICT',
  })
  assert.deepEqual([f.saved(), f.saved(1)], before)
})

test('commit and group undo roll back documents, history, command IDs and job protection together; notifications observe committed revisions', async (t) => {
  const f = await fixture(t),
    jobs = f.episodes.map((_, i) => automaticJob(f, i)),
    db = sql(f.store),
    commandId = randomUUID(),
    plan = f.prepare(),
    before = f.episodes.map((_, i) => f.saved(i)),
    notices: string[] = []
  f.store.originals.onTranscriptChanged((target) => {
    const observer = new DatabaseSync(f.filename, { readOnly: true })
    try {
      const revision = observer
        .prepare('SELECT revision FROM transcripts WHERE episode_id=?')
        .get(target.episodeId)!.revision
      assert.equal(
        revision,
        f.saved(f.episodes.findIndex((e) => e.id === target.episodeId)).revision,
      )
    } finally {
      observer.close()
    }
    notices.push(target.episodeId)
  })
  const failOnSecond = () =>
    db.exec(
      `CREATE TRIGGER fail_edit BEFORE UPDATE OF document_json ON transcripts WHEN OLD.episode_id='${f.episodes[1]!.id}' BEGIN SELECT RAISE(ABORT,'injected second-member failure'); END`,
    )
  failOnSecond()
  assert.throws(() => f.store.commitTranscriptReplacement(plan, commandId), /injected/)
  assert.deepEqual(
    f.episodes.map((_, i) => f.saved(i)),
    before,
  )
  assert.equal(db.prepare('SELECT count(*) AS n FROM transcript_edit_groups').get()!.n, 0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM transcript_edit_commands').get()!.n, 0)
  assert(jobs.every((job) => f.store.getJob(job.id)!.autoApply))
  assert.deepEqual(notices, [])
  db.exec('DROP TRIGGER fail_edit')
  const applied = f.store.commitTranscriptReplacement(plan, commandId)
  assert.equal(applied.changed.length, 3)
  assert.equal(notices.length, 3)
  assert(jobs.every((job) => !f.store.getJob(job.id)!.autoApply))
  const after = f.episodes.map((_, i) => f.saved(i)),
    undo = { ...f.target(), historyId: applied.history.undo!.id, commandId: randomUUID() }
  failOnSecond()
  assert.throws(() => f.store.undoTranscriptEdit(undo), /injected/)
  assert.deepEqual(
    f.episodes.map((_, i) => f.saved(i)),
    after,
  )
  assert.equal(notices.length, 3)
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM transcript_edit_commands WHERE id=?').get(undo.commandId)!
      .n,
    0,
  )
  db.exec('DROP TRIGGER fail_edit')
  f.store.undoTranscriptEdit(undo)
  assert.equal(notices.length, 6)
  for (let i = 0; i < 3; i++) assert.deepEqual(f.saved(i).document, before[i]!.document)
})

test('manual history and undo permanently protect formal text from late partial/final ASR while its preview can still finish', async (t) => {
  const f = await fixture(t),
    job = automaticJob(f),
    before = f.saved()
  f.edit({ kind: 'text', segmentId: 's1', text: '李三😀走进长长的山谷。' })
  f.history()
  const restored = f.saved(),
    late = {
      ...f.document(),
      segments: [{ ...f.document().segments[0]!, text: '王三😀走进长长的山谷。' }],
    }
  assert.deepEqual(restored.document, before.document)
  assert.equal(f.store.getJob(job.id)!.autoApply, false)
  assert.equal(f.store.acceptJobSnapshot(job.id, job.attempt, snapshot(late), 1, false), true)
  assert.deepEqual(f.saved(), restored)
  assert(f.store.transcriptEditingState(f.target()).redo)
  assert.equal(f.store.acceptJobSnapshot(job.id, job.attempt, snapshot(late), 2, true), true)
  assert.equal(f.store.getJob(job.id)!.status, 'completed')
  assert.deepEqual(f.store.jobDocument(job.id), late)
  assert.deepEqual(f.saved(), restored)
  f.history(false)
  assert(f.saved().document.segments[0]!.text.startsWith('李三'))
  assert.equal(f.store.getJob(job.id)!.autoApply, false)
})

test('legacy small corrections enter history; external saves and adopted job baselines clear it without reapplying old commands', async (t) => {
  const f = await fixture(t)
  f.store.editTranscript({ ...f.target(), segmentId: 's1', text: '李三😀走进长长的山谷。' })
  assert.equal(f.store.transcriptEditingState(f.target()).undo!.label, '纠正文字')
  const request = {
    ...f.target(),
    commandId: randomUUID(),
    operation: { kind: 'text' as const, segmentId: 's3', text: '远处传来了悠长的钟声。' },
  }
  f.store.performTranscriptEdit(request)
  f.store.saveTranscript(f.episodes[0]!.id, f.document())
  const baseline = f.saved()
  assert.equal(f.store.transcriptEditingState(f.target()).historyCount, 0)
  assert.equal(f.store.performTranscriptEdit(request).replayed, true)
  assert.deepEqual(f.saved(), baseline)
  f.edit({ kind: 'text', segmentId: 's3', text: '远处传来了悠长的钟声。' })
  const job = f.store.createJob({ ...f.target(), engine: 'paraformer', device: 'cpu' })
  f.store.setJobStatus(job.id, job.attempt, 'running')
  f.store.acceptJobSnapshot(job.id, job.attempt, snapshot(f.document()), 2, true)
  assert(f.store.transcriptEditingState(f.target()).undo)
  f.store.applyJob(job.id, f.target().revision)
  assert.equal(f.store.transcriptEditingState(f.target()).historyCount, 0)
  assert.deepEqual(f.saved().document, f.document())
})

test('replacement rejects the total delta budget across episodes rather than silently truncating or partially applying', async (t) => {
  const f = await fixture(t)
  for (const [index, episode] of f.episodes.entries())
    f.store.saveTranscript(episode.id, {
      ...f.document(index),
      segments: Array.from({ length: 200 }, (_, i) => ({
        id: `large-${i}`,
        startMs: i * 80,
        endMs: i * 80 + 50,
        text: '张三' + 'x'.repeat(1998),
      })),
    })
  const revisions = f.episodes.map((_, i) => f.saved(i).revision)
  assert.throws(() => f.prepare(), /2 MiB/)
  assert.deepEqual(
    f.episodes.map((_, i) => f.saved(i).revision),
    revisions,
  )
  assert.equal(f.store.transcriptEditingState(f.target()).historyCount, 0)
})

test('the 64 MiB replacement scan guard runs in SQL before loading any selected document', async (t) => {
  const f = await fixture(t, 5)
  for (const [index, episode] of f.episodes.entries())
    f.store.saveTranscript(episode.id, {
      ...f.document(index),
      segments: Array.from({ length: 1500 }, (_, i) => ({
        id: `scan-${i}`,
        startMs: i * 10,
        endMs: i * 10 + 9,
        text: '张三' + 'x'.repeat(8998),
      })),
    })
  const target = f.target(),
    original = f.store.getTranscript
  f.store.getTranscript = () => {
    throw new Error('full document must not be loaded before the scan guard')
  }
  try {
    assert.throws(
      () =>
        f.store.prepareTranscriptReplacement({
          ...target,
          requestId: randomUUID(),
          scope: { kind: 'book', bookId: f.book.id, episodeIds: f.episodes.map((e) => e.id) },
          find: '张三',
          replacement: '李四',
        }),
      /64 MiB/,
    )
  } finally {
    f.store.getTranscript = original
  }
})

test('real SQLITE_FULL rolls back a bounded replacement and permits the exact same command after storage recovers', async (t) => {
  const f = await fixture(t, 1),
    db = sql(f.store)
  f.store.saveTranscript(f.episodes[0]!.id, {
    ...f.document(),
    segments: Array.from({ length: 200 }, (_, i) => ({
      id: `full-${i}`,
      startMs: i * 80,
      endMs: i * 80 + 50,
      text: '张三' + 'x'.repeat(1998),
    })),
  })
  const job = automaticJob(f),
    before = f.saved(),
    plan = f.prepare(),
    commandId = randomUUID(),
    pageCount = Number(db.prepare('PRAGMA page_count').get()!.page_count)
  db.exec(`PRAGMA max_page_count=${pageCount}`)
  try {
    assert.throws(
      () => f.store.commitTranscriptReplacement(plan, commandId),
      (error: unknown) => error instanceof Error && Reflect.get(error, 'errcode') === 13,
    )
    assert.equal(db.isTransaction, false)
    assert.deepEqual(f.saved(), before)
    assert.equal(f.store.transcriptEditingState(f.target()).historyCount, 0)
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM transcript_edit_commands WHERE id=?').get(commandId)!.n,
      0,
    )
    assert.equal(f.store.getJob(job.id)!.autoApply, true)
  } finally {
    db.exec('PRAGMA max_page_count=1073741823')
  }
  assert.equal(f.store.commitTranscriptReplacement(plan, commandId).replayed, false)
  assert.equal(f.saved().revision, before.revision + 1)
  assert(f.saved().document.segments.every((s) => s.text.startsWith('李四')))
})

test('subtitle split/undo preserve concurrent reviewed original anchors, manual gaps and times, while rejecting an old incremental response', async (t) => {
  const f = await fixture(t),
    target = f.target(),
    parsed = parseOriginal(
      Buffer.from(
        f
          .document()
          .segments.map((s) => s.text)
          .join('\n'),
      ),
      '原文.txt',
    ),
    id = f.store.originals.import(target, parsed).info!.id,
    saved = f.saved()
  f.store.originals.saveAlignment(
    target,
    id,
    saved.id,
    saved.revision,
    0,
    matchOriginal(parsed, saved.document),
  )
  f.store.originals.correct({
    ...target,
    originalId: id,
    revision: 1,
    segmentId: 's1',
    selection: { first: 0, last: 0 },
    startMs: 1100,
    endMs: 3900,
  })
  f.store.originals.correct({
    ...target,
    originalId: id,
    revision: 2,
    segmentId: 's2',
    selection: null,
    startMs: 5100,
    endMs: 7900,
  })
  const snapshot = f.store.originals.acousticSnapshot({
    ...target,
    originalId: id,
    revision: 3,
    segmentId: 's1',
    device: 'cpu',
  })
  f.edit({ kind: 'split', segmentId: 's1', offset: 3, atMs: 2100 })
  f.store.originals.correct({
    ...target,
    originalId: id,
    revision: 3,
    segmentId: 's2',
    selection: null,
    startMs: 5200,
    endMs: 7800,
  })
  const during = f.store.originals.state(target).alignment!,
    pending = f.store.originals.prepareIncremental(target)
  assert(pending)
  assert.equal(during.matches.find((m) => m.segmentId === 's1')!.sourceState, 'retained')
  assert.equal(during.matches.find((m) => m.segmentId === 's2')!.startMs, 5200)
  f.history()
  assert.throws(() => f.store.originals.saveIncremental(pending, []), { code: 'CONFLICT' })
  // The old acoustic proposal is rejected at its revision/identity guard before
  // any model result is read. No synthetic times are claimed as model evidence.
  assert.throws(
    () =>
      f.store.originals.applyAcoustic(
        snapshot,
        randomUUID(),
        undefined as never,
        snapshot.revision,
      ),
    { code: 'CONFLICT' },
  )
  const fresh = f.store.originals.prepareIncremental(target)
  assert(fresh)
  f.store.originals.saveIncremental(fresh, [])
  const final = f.store.originals.state(target),
    anchor = final.alignment!.matches.find((m) => m.segmentId === 's1')!,
    gap = final.alignment!.matches.find((m) => m.segmentId === 's2')!
  assert.equal(final.stale, false)
  assert.equal(anchor.sourceState, 'current')
  assert.equal(anchor.reviewed, true)
  assert.equal(anchor.selected!.method, 'manual')
  assert.equal(anchor.startMs, 1100)
  assert.equal(anchor.endMs, 3900)
  assert.equal(gap.reviewed, true)
  assert.equal(gap.selected, null)
  assert.equal(gap.startMs, 5200)
  assert.equal(gap.endMs, 7800)
  f.reopen()
  assert.deepEqual(f.store.originals.state(target), final)
})

test('a changed group member removed by reimport blocks all undo, while deleting a readonly anchor leaves edited members undoable', async (t) => {
  const f = await fixture(t)
  f.store.commitTranscriptReplacement(f.prepare(), randomUUID())
  const before = f.saved(),
    removed = f.episodes[1]!
  await rm(join(f.root, '1.mp3'))
  f.store.importBook(await scanBook(f.root, 'folder'))
  assert.equal(f.store.getEpisode(removed.id), undefined)
  assert(f.store.transcriptEditingState(f.target()).undoBlocked)
  assert.throws(() => f.history(), { code: 'CONFLICT' })
  assert.deepEqual(f.saved(), before)

  const g = await fixture(t)
  g.store.saveTranscript(g.episodes[0]!.id, {
    ...g.document(),
    segments: [g.document().segments[2]!],
  })
  g.store.commitTranscriptReplacement(g.prepare(), randomUUID())
  await rm(join(g.root, '0.mp3'))
  g.store.importBook(await scanBook(g.root, 'folder'))
  assert.equal(g.store.transcriptEditingState(g.target(1)).undoBlocked, null)
  g.history(true, 1)
  assert(g.saved(1).document.segments[0]!.text.startsWith('张三'))
  assert(g.saved(2).document.segments[0]!.text.startsWith('张三'))
})

test('exact document and delta hashes prevent history replay after silent storage changes', async (t) => {
  const f = await fixture(t),
    db = sql(f.store)
  f.store.commitTranscriptReplacement(f.prepare(), randomUUID())
  const applied = f.episodes.map((_, i) => f.saved(i)),
    altered = structuredClone(applied[1]!.document)
  altered.segments[2]!.text = '近处传来了悠长的钟声。'
  db.prepare('UPDATE transcripts SET document_json=? WHERE episode_id=?').run(
    JSON.stringify(altered),
    f.episodes[1]!.id,
  )
  assert.throws(() => f.history(), { code: 'CONFLICT' })
  assert.deepEqual(f.saved(), applied[0])
  db.prepare('UPDATE transcripts SET document_json=? WHERE episode_id=?').run(
    JSON.stringify(applied[1]!.document),
    f.episodes[1]!.id,
  )
  const member = db
      .prepare(
        'SELECT group_id,transcript_id,delta_json FROM transcript_edit_members WHERE episode_id=?',
      )
      .get(f.episodes[1]!.id)!,
    patch = JSON.parse(String(member.delta_json))
  patch.splices[0].before[0].text = '伪造的历史文本'
  db.prepare(
    'UPDATE transcript_edit_members SET delta_json=? WHERE group_id=? AND transcript_id=?',
  ).run(JSON.stringify(patch), String(member.group_id), String(member.transcript_id))
  assert.throws(() => f.history(), { code: 'CONFLICT' })
  assert.deepEqual(
    f.episodes.map((_, i) => f.saved(i)),
    applied,
  )
})

test('schema 13 migration preserves offline plans, bookmarks, manual original points and application settings; failed migration rolls back and reopens', async (t) => {
  const f = await fixture(t),
    target = f.target(),
    parsed = parseOriginal(
      Buffer.from(
        f
          .document()
          .segments.map((s) => s.text)
          .join('\n'),
      ),
      '迁移原文.txt',
    ),
    originalId = f.store.originals.import(target, parsed).info!.id,
    saved = f.saved()
  f.store.originals.saveAlignment(
    target,
    originalId,
    saved.id,
    saved.revision,
    0,
    matchOriginal(parsed, saved.document),
  )
  f.store.originals.correct({
    ...target,
    originalId,
    revision: 1,
    segmentId: 's1',
    selection: { first: 0, last: 0 },
    startMs: 1150,
    endMs: 3850,
  })
  f.store.saveBookmark({ ...target, positionMs: 2500, note: '迁移前人工书签' })
  f.store.saveProgress({
    sessionId: '',
    episodeId: target.episodeId,
    positionMs: 2700,
    durationMs: 20000,
    rate: 1.5,
    volume: 0.35,
  })
  f.store.setSubtitlePreparation(f.book.id, {
    mode: 'manual',
    engine: 'whisperx',
    device: 'cpu',
    prepareNext: false,
  })
  f.store.setBookSkips(f.book.id, { introMs: 400, outroMs: 500 })
  f.store.setProcessingPolicy({
    revision: 1,
    policy: { cpuThreads: 2, lowPriority: true, backgroundIdleOnly: true },
  })
  const resource = f.store.processingResources()
  f.store.setProcessingPaused({ revision: resource.revision, paused: true })
  const reading = f.store.reading.import(parsed)
  f.store.reading.savePosition(reading.id, 1)
  const plan = f.store.createOfflinePlan({
    bookId: f.book.id,
    episodeIds: f.episodes.map((e) => e.id),
    scope: 'ids',
    profile: { engine: 'paraformer', device: 'cpu' },
    audioBudgetBytes: 0,
  })
  f.store.updateOfflinePlan({ id: plan.id, revision: plan.revision, action: 'pause' })
  const prior = {
    books: f.store.listBooks(),
    player: f.store.getPlayerState(),
    bookmarks: f.store.listBookmarks(f.book.id),
    original: f.store.originals.state(target),
    policy: f.store.processingResources(),
    reading: f.store.reading.list(),
    plan: f.store.offlinePlan(plan.id),
    items: f.store.storedOfflineItems(plan.id),
    transcript: f.saved(),
  }
  f.reopen(() => {
    let db = new DatabaseSync(f.filename)
    db.exec(
      "DROP TABLE subtitle_import_commands; DROP TABLE subtitle_import_sources; DROP TABLE transcript_edit_commands; DROP TABLE transcript_edit_members; DROP TABLE transcript_edit_heads; DROP TABLE transcript_edit_groups; PRAGMA user_version=13; CREATE TABLE transcript_edit_groups(sentinel TEXT); INSERT INTO transcript_edit_groups VALUES('keep migration sentinel');",
    )
    db.close()
    assert.throws(() => new LibraryStore(f.filename), /already exists/)
    db = new DatabaseSync(f.filename)
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 13)
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='transcript_edit_heads'")
        .get()!.n,
      0,
    )
    assert.equal(
      db.prepare('SELECT sentinel FROM transcript_edit_groups').get()!.sentinel,
      'keep migration sentinel',
    )
    assert.equal(db.prepare('SELECT count(*) AS n FROM offline_plans').get()!.n, 1)
    db.exec('DROP TABLE transcript_edit_groups')
    db.close()
  })
  const verify = () => {
    assert.deepEqual(
      {
        books: f.store.listBooks(),
        player: f.store.getPlayerState(),
        bookmarks: f.store.listBookmarks(f.book.id),
        original: f.store.originals.state(target),
        policy: f.store.processingResources(),
        reading: f.store.reading.list(),
        plan: f.store.offlinePlan(plan.id),
        items: f.store.storedOfflineItems(plan.id),
        transcript: f.saved(),
      },
      prior,
    )
    assert.equal(sql(f.store).prepare('PRAGMA user_version').get()!.user_version, 15)
    assert.equal(f.store.transcriptEditingState(target).historyCount, 0)
  }
  verify()
  f.edit({ kind: 'text', segmentId: 's3', text: '远处传来了悠长的钟声。' })
  f.reopen()
  f.history()
  assert.deepEqual(f.saved().document, saved.document)
  assert.deepEqual(f.store.offlinePlan(plan.id), prior.plan)
  assert.deepEqual(f.store.listBookmarks(f.book.id), prior.bookmarks)
  assert.deepEqual(
    f.store.originals.state(target).alignment!.matches,
    prior.original.alignment!.matches,
  )
})

test('adopted multi-sentence times use the same undo history and preserve playback, bookmarks, regions and book settings', async (t) => {
  const f = await fixture(t),
    target = f.target(),
    before = f.saved().document
  f.store.saveProgress({
    sessionId: '',
    episodeId: target.episodeId,
    positionMs: 2300,
    durationMs: 20000,
    rate: 1.5,
    volume: 0.25,
  })
  f.store.saveBookmark({ ...target, positionMs: 2500, note: '试听点' })
  f.store.markTranscriptRegion({
    ...target,
    revision: 0,
    startMs: 1000,
    endMs: 4000,
    kind: 'intro',
  })
  f.store.setSubtitlePreparation(f.book.id, {
    mode: 'manual',
    engine: 'whisperx',
    device: 'cpu',
    prepareNext: false,
  })
  const saved = {
    player: f.store.getPlayerState(),
    bookmark: f.store.listBookmarks(f.book.id),
    regions: f.store.getTranscriptRegions(target.episodeId, target.audioHash),
    preparation: f.store.getSubtitlePreparation(f.book.id),
  }
  const applied = f.store.performTranscriptEdit(
    {
      ...f.target(),
      commandId: randomUUID(),
      operation: {
        kind: 'timing',
        ranges: [
          { segmentId: 's1', startMs: 1200, endMs: 3800 },
          { segmentId: 's2', startMs: 5200, endMs: 7800 },
        ],
      },
    },
    '采用声音重对齐',
  )
  assert.equal(applied.history.undo!.label, '采用声音重对齐')
  assert.equal(applied.history.undo!.segments, 2)
  assert.deepEqual(f.saved().document.coverage, before.coverage)
  assert.deepEqual(
    f.saved().document.segments.map((s) => s.id),
    before.segments.map((s) => s.id),
  )
  assert.equal(f.saved().document.segments[0]!.startMs, 1200)
  f.history()
  assert.deepEqual(f.saved().document, before)
  f.reopen()
  f.history(false)
  assert.equal(f.saved().document.segments[1]!.endMs, 7800)
  assert.deepEqual(
    {
      player: f.store.getPlayerState(),
      bookmark: f.store.listBookmarks(f.book.id),
      regions: f.store.getTranscriptRegions(target.episodeId, target.audioHash),
      preparation: f.store.getSubtitlePreparation(f.book.id),
    },
    saved,
  )
})

test('structural history preserves discontiguous coverage exactly and cannot merge across an uncovered gap', async (t) => {
  const f = await fixture(t),
    partial = {
      ...f.document(),
      coverage: [
        { startMs: 0, endMs: 4000 },
        { startMs: 5000, endMs: 12000 },
      ],
    }
  f.store.saveTranscript(f.episodes[0]!.id, partial)
  assert.throws(() => f.edit({ kind: 'merge', firstId: 's1', secondId: 's2', separator: ' ' }), {
    code: 'INVALID_TRANSCRIPT',
  })
  assert.deepEqual(f.saved().document, partial)
  assert.equal(f.store.transcriptEditingState(f.target()).historyCount, 0)
  f.edit({ kind: 'merge', firstId: 's2', secondId: 's3', separator: ' ' })
  const merged = f.saved().document
  assert.equal(merged.segments.length, 2)
  assert.deepEqual(merged.coverage, partial.coverage)
  f.history()
  assert.deepEqual(f.saved().document, partial)
  f.reopen()
  f.history(false)
  assert.deepEqual(f.saved().document, merged)
})

test('replacement command replay after restart returns current state without repeating a batch or restoring an obsolete preview', async (t) => {
  const f = await fixture(t),
    plan = f.prepare(),
    commandId = randomUUID()
  f.store.commitTranscriptReplacement(plan, commandId)
  f.reopen()
  f.edit({ kind: 'text', segmentId: 's3', text: '远处传来了悠长的钟声。' })
  const current = f.episodes.map((_, i) => f.saved(i)),
    replay = f.store.commitTranscriptReplacement(plan, commandId)
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.changed, [])
  assert.deepEqual(replay.transcript, { status: 'ready', transcript: current[0] })
  assert.deepEqual(
    f.episodes.map((_, i) => f.saved(i)),
    current,
  )
  assert.throws(
    () =>
      f.store.commitTranscriptReplacement(
        { ...plan, request: { ...plan.request, replacement: '王五' } },
        commandId,
      ),
    { code: 'CONFLICT' },
  )
})

test('new edits clear an actual member batch redo atomically, but changing only its readonly anchor keeps other members redoable', async (t) => {
  const f = await fixture(t)
  f.store.commitTranscriptReplacement(f.prepare(), randomUUID())
  f.history()
  f.edit({ kind: 'text', segmentId: 's3', text: '远处传来了悠长的钟声。' }, 1)
  for (let i = 0; i < 3; i++) assert.equal(f.store.transcriptEditingState(f.target(i)).redo, null)

  const g = await fixture(t)
  g.store.saveTranscript(g.episodes[0]!.id, {
    ...g.document(),
    segments: [g.document().segments[2]!],
  })
  g.store.commitTranscriptReplacement(g.prepare(), randomUUID())
  g.history(true, 1)
  g.edit({ kind: 'text', segmentId: 's3', text: '远处传来了悠长的钟声。' })
  assert.equal(g.store.transcriptEditingState(g.target()).redo, null)
  assert.equal(g.store.transcriptEditingState(g.target(1)).redoBlocked, null)
  g.history(false, 1)
  assert(g.saved(1).document.segments[0]!.text.startsWith('李四'))
  assert(g.saved(2).document.segments[0]!.text.startsWith('李四'))
  assert(g.saved().document.segments[0]!.text.startsWith('远处'))
})

test('replacement rejects duplicate, over-limit and foreign-book selection before writing anything', async (t) => {
  const f = await fixture(t),
    request = { ...f.target(), requestId: randomUUID(), find: '张三', replacement: '李四' }
  for (const ids of [
    [],
    [f.episodes[0]!.id, f.episodes[0]!.id],
    Array.from({ length: 1001 }, () => randomUUID()),
  ])
    assert.throws(
      () =>
        f.store.prepareTranscriptReplacement({
          ...request,
          scope: { kind: 'book', bookId: f.book.id, episodeIds: ids },
        }),
      { code: 'INVALID_REQUEST' },
    )
  const separate = join(f.root, 'foreign.mp3')
  await writeFile(separate, 'different book identity')
  f.store.importBook(await scanBook(separate, 'file'))
  const foreign = f.store.listBooks().find((b) => b.id !== f.book.id)!.episodes[0]!
  assert.throws(
    () =>
      f.store.prepareTranscriptReplacement({
        ...request,
        scope: { kind: 'book', bookId: f.book.id, episodeIds: [foreign.id] },
      }),
    { code: 'FILE_CHANGED' },
  )
  assert.equal(f.store.transcriptEditingState(f.target()).historyCount, 0)
  assert.equal(f.saved().revision, 1)
})

test('history state remains a metadata-only read even for available multi-episode undo', async (t) => {
  const f = await fixture(t)
  f.store.commitTranscriptReplacement(f.prepare(), randomUUID())
  const target = f.target(),
    original = f.store.getTranscript
  f.store.getTranscript = () => {
    throw new Error('history state must not deserialize any transcript')
  }
  try {
    const state = f.store.transcriptEditingState(target)
    assert.equal(state.undo!.episodes, 3)
    assert.equal(state.undoBlocked, null)
    assert.equal(state.historyCount, 1)
  } finally {
    f.store.getTranscript = original
  }
})

test('even empty selected drafts validate literal inputs when the initiating transcript is outside the selection', async (t) => {
  const f = await fixture(t),
    target = f.target(),
    request = {
      ...target,
      requestId: randomUUID(),
      scope: { kind: 'book' as const, bookId: f.book.id, episodeIds: [f.episodes[1]!.id] },
      find: '张三',
      replacement: '李四',
    }
  sql(f.store).prepare('DELETE FROM transcripts WHERE episode_id=?').run(f.episodes[1]!.id)
  for (const value of ['', '   ', 'a'.repeat(101), '\u0000', '\u007f', '\ud800']) {
    assert.throws(() => f.store.prepareTranscriptReplacement({ ...request, find: value }), {
      code: 'INVALID_REQUEST',
    })
    assert.throws(() => f.store.prepareTranscriptReplacement({ ...request, replacement: value }), {
      code: 'INVALID_REQUEST',
    })
  }
  assert.throws(
    () => f.store.prepareTranscriptReplacement({ ...request, replacement: request.find }),
    { code: 'INVALID_REQUEST' },
  )
  const plan = f.store.prepareTranscriptReplacement({ ...request, find: '😀'.repeat(100) })
  assert.equal(plan.skippedEpisodes, 1)
  assert.equal(plan.episodes, 0)
  const result = f.store.commitTranscriptReplacement(plan, randomUUID())
  assert.equal(result.changed.length, 0)
  assert.equal(f.saved().revision, target.revision)
  assert.equal(result.history.historyCount, 0)
})
