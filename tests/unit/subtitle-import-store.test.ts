import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { matchOriginal } from '../../src/main/original/match'
import { parseOriginal } from '../../src/main/original/parse'
import type { CommitSubtitleImport } from '../../src/main/subtitle-import-store'
import { parseTimedSubtitles } from '../../src/main/subtitle-import-parser'
import type { TranscriptDocument } from '../../src/shared/transcript'

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const raw = Buffer.from(
  'WEBVTT\r\n\r\nSTYLE\r\n::cue { color: lime }\r\n\r\nNOTE imported original bytes\r\nkeep this note\r\n\r\ncue-a\r\n00:00:01.000 --> 00:00:04.000 align:start\r\n<c.green>少年走进山谷。</c>\r\n\r\ncue-b\r\n00:00:02.000 --> 00:00:05.000\r\n山中响起钟声。\r\n',
)
function db(store: LibraryStore) {
  return Reflect.get(store, 'db') as DatabaseSync
}
async function fixture(t: TestContext, formal = true) {
  const root = await mkdtemp(join(tmpdir(), '听读 字幕来源原子导入 ')),
    filename = join(root, 'library.sqlite3')
  await writeFile(join(root, 'one.mp3'), 'owned identity import one')
  await writeFile(join(root, 'two.mp3'), 'owned identity import two')
  let store = new LibraryStore(filename)
  store.importBook(await scanBook(root, 'folder'))
  const book = store.listBooks()[0]!,
    episode = book.episodes[0]!,
    target = { episodeId: episode.id, audioHash: episode.contentHash },
    original: TranscriptDocument = {
      version: 1,
      audioHash: target.audioHash,
      kind: 'manual',
      coverage: [{ startMs: 0, endMs: 20000 }],
      segments: [
        { id: 'old-1', startMs: 1000, endMs: 4000, text: '少年走进长长的山谷。' },
        { id: 'old-2', startMs: 5000, endMs: 8000, text: '远方传来了悠长的钟声。' },
      ],
    },
    converted: TranscriptDocument = {
      version: 1,
      audioHash: target.audioHash,
      kind: 'transcript',
      coverage: [{ startMs: 1000, endMs: 5000 }],
      segments: [
        { id: 'cue-only-a', startMs: 1000, endMs: 2000, text: '少年走进山谷。' },
        { id: 'cue-overlap', startMs: 2000, endMs: 4000, text: '少年走进山谷。\n山中响起钟声。' },
        { id: 'cue-only-b', startMs: 4000, endMs: 5000, text: '山中响起钟声。' },
      ],
    }
  store.recordSourceDuration(target.episodeId, target.audioHash, 20000)
  if (formal) store.saveTranscript(target.episodeId, original)
  const saved = () => {
    const current = store.getTranscript(target.episodeId, target.audioHash)
    assert(current.status === 'ready')
    return current.transcript
  }
  const request = (): CommitSubtitleImport => ({
    target: { ...target },
    baseline: store.transcriptImportBaseline(target),
    document: structuredClone(converted),
    token: randomUUID(),
    previewRevision: 1,
    commandId: randomUUID(),
    source: {
      fileName: '中文重叠.vtt',
      format: 'vtt',
      encoding: 'utf-8',
      bytes: Buffer.from(raw),
      sha256: sha(raw),
      offsetMs: 0,
      metadata: {
        format: 'vtt',
        cueCount: 2,
        outputSegments: 3,
        overlappingCues: 2,
        overlapSegments: 1,
        multilineCues: 0,
        markupCues: 1,
        inlineTimestamps: 0,
        notes: 1,
        styles: 1,
        regions: 0,
        settingsCues: 1,
        documentBytes: Buffer.byteLength(JSON.stringify(converted)),
        warnings: [{ code: 'OVERLAPPING_CUES', count: 2, firstLine: 9 }],
      },
    },
  })
  const edit = () =>
    store.performTranscriptEdit({
      ...target,
      revision: saved().revision,
      commandId: randomUUID(),
      operation: { kind: 'text', segmentId: 'old-1', text: '少年走进深深的山谷。' },
    })
  t.after(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    filename,
    book,
    episode,
    target,
    original,
    converted,
    saved,
    request,
    edit,
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

test('atomic import preserves the exact original WebVTT bytes including STYLE, NOTE, settings, markup and overlap provenance', async (t) => {
  const f = await fixture(t),
    request = f.request(),
    result = f.store.commitSubtitleImport(request)
  assert.equal(result.replayed, false)
  assert.deepEqual(f.saved().document, f.converted)
  const origin = f.store.subtitleImportSource(f.target)!
  assert.equal(origin.importRevision, 2)
  assert.equal(origin.transcriptId, f.saved().id)
  assert.deepEqual(origin.bytes, raw)
  assert.equal(origin.sha256, sha(raw))
  assert.equal(origin.importedDocumentHash, sha(JSON.stringify(f.converted)))
  assert.deepEqual(origin.metadata, request.source.metadata)
  assert.equal(origin.fileName, request.source.fileName)
  request.source.bytes.fill(0)
  origin.bytes.fill(1)
  assert.deepEqual(f.store.subtitleImportSource(f.target)!.bytes, raw)
  f.reopen()
  assert.deepEqual(f.store.subtitleImportSource(f.target)!.bytes, raw)
})

test('UTF16 original bytes remain a BLOB rather than normalized or re-encoded subtitle text', async (t) => {
  const f = await fixture(t, false),
    request = f.request(),
    body = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('1\r\n00:00:01,000 --> 00:00:02,000\r\n原始中文😀\r\n', 'utf16le'),
    ])
  request.source = {
    ...request.source,
    fileName: '原始.srt',
    format: 'srt',
    encoding: 'utf-16le',
    bytes: body,
    sha256: sha(body),
    offsetMs: -1000,
    metadata: { ...request.source.metadata, format: 'srt' },
  }
  f.store.commitSubtitleImport(request)
  const origin = f.store.subtitleImportSource(f.target)!
  assert.deepEqual(origin.bytes, body)
  assert.equal(origin.encoding, 'utf-16le')
  assert.equal(origin.offsetMs, -1000)
  assert.equal(
    db(f.store).prepare('SELECT typeof(source_bytes) AS t FROM subtitle_import_sources').get()!.t,
    'blob',
  )
})

test('source, formal baseline, manual protection and old history are one transaction; notifications can only observe committed data', async (t) => {
  const f = await fixture(t),
    job = f.store.createJob({ ...f.target, engine: 'paraformer', device: 'cpu' })
  f.edit()
  db(f.store).prepare('UPDATE transcription_jobs SET auto_apply=1 WHERE id=?').run(job.id)
  const before = f.saved(),
    history = f.store.transcriptEditingState(f.target),
    request = f.request(),
    notices: string[] = []
  f.store.originals.onTranscriptChanged((target) => {
    const observer = new DatabaseSync(f.filename, { readOnly: true })
    try {
      assert.equal(
        observer.prepare('SELECT count(*) AS n FROM subtitle_import_sources').get()!.n,
        1,
      )
      assert.equal(
        observer.prepare('SELECT count(*) AS n FROM transcript_edit_members WHERE visible=1').get()!
          .n,
        0,
      )
      assert.equal(
        observer.prepare('SELECT auto_apply FROM transcription_jobs WHERE id=?').get(job.id)!
          .auto_apply,
        0,
      )
      notices.push(target.episodeId)
    } finally {
      observer.close()
    }
  })
  db(f.store).exec(
    "CREATE TRIGGER fail_origin BEFORE INSERT ON subtitle_import_sources BEGIN SELECT RAISE(ABORT,'source write failed'); END",
  )
  assert.throws(() => f.store.commitSubtitleImport(request), /source write failed/)
  assert.deepEqual(f.saved(), before)
  assert.deepEqual(f.store.transcriptEditingState(f.target), history)
  assert.equal(f.store.getJob(job.id)!.autoApply, true)
  assert.equal(f.store.subtitleImportSource(f.target), null)
  assert.equal(
    db(f.store).prepare('SELECT count(*) AS n FROM subtitle_import_commands').get()!.n,
    0,
  )
  assert.deepEqual(notices, [])
  db(f.store).exec('DROP TRIGGER fail_origin')
  f.store.commitSubtitleImport(request)
  assert.deepEqual(notices, [f.target.episodeId])
  assert.equal(f.saved().revision, before.revision + 1)
  assert.equal(f.store.transcriptEditingState(f.target).historyCount, 0)
})

test('an imported baseline preserves original manual anchors, gaps, bookmarks, marked regions, player and application settings', async (t) => {
  const f = await fixture(t),
    parsed = parseOriginal(
      Buffer.from(f.original.segments.map((s) => s.text).join('\n')),
      '人工原文.txt',
    ),
    id = f.store.originals.import(f.target, parsed).info!.id,
    saved = f.saved()
  f.store.originals.saveAlignment(
    f.target,
    id,
    saved.id,
    saved.revision,
    0,
    matchOriginal(parsed, saved.document),
  )
  f.store.originals.correct({
    ...f.target,
    originalId: id,
    revision: 1,
    segmentId: 'old-1',
    selection: { first: 0, last: 0 },
    startMs: 1100,
    endMs: 3900,
  })
  f.store.originals.correct({
    ...f.target,
    originalId: id,
    revision: 2,
    segmentId: 'old-2',
    selection: null,
    startMs: 5100,
    endMs: 7900,
  })
  f.store.saveBookmark({ ...f.target, positionMs: 2700, note: '保留人工点' })
  f.store.markTranscriptRegion({ ...f.target, revision: 0, startMs: 0, endMs: 500, kind: 'intro' })
  f.store.saveProgress({
    sessionId: '',
    episodeId: f.target.episodeId,
    positionMs: 2400,
    durationMs: 20000,
    rate: 1.5,
    volume: 0.2,
  })
  f.store.setSubtitlePreparation(f.book.id, {
    mode: 'manual',
    engine: 'whisperx',
    device: 'cpu',
    prepareNext: false,
  })
  f.store.setProcessingPolicy({
    revision: 1,
    policy: { cpuThreads: 2, lowPriority: true, backgroundIdleOnly: true },
  })
  const state = () => ({
      original: f.store.originals.state(f.target).alignment!.matches,
      bookmarks: f.store.listBookmarks(f.book.id),
      regions: f.store.getTranscriptRegions(f.target.episodeId, f.target.audioHash),
      player: f.store.getPlayerState(),
      preparation: f.store.getSubtitlePreparation(f.book.id),
      resources: f.store.processingResources(),
    }),
    prior = state()
  f.store.commitSubtitleImport(f.request())
  assert.deepEqual(state(), prior)
  const plan = f.store.originals.prepareIncremental(f.target)!
  f.store.originals.saveIncremental(plan, [])
  const matches = f.store.originals.state(f.target).alignment!.matches
  assert(matches.every((match) => match.reviewed && match.sourceState === 'retained'))
  assert.equal(matches[0]!.startMs, 1100)
  assert.equal(matches[1]!.selected, null)
  f.reopen()
  assert.equal(f.store.originals.state(f.target).alignment!.matches[1]!.endMs, 7900)
  assert.deepEqual(f.store.getPlayerState(), prior.player)
})

test('ready baseline checks revision, exact persisted bytes and transcript identity before adopting a picker preview', async (t) => {
  const f = await fixture(t),
    request = f.request()
  f.edit()
  const edited = f.saved()
  assert.throws(() => f.store.commitSubtitleImport(request), { code: 'CONFLICT' })
  assert.deepEqual(f.saved(), edited)
  const silent = f.request(),
    altered = structuredClone(edited.document)
  altered.segments[1]!.text = '没有更新修订号的外部更改。'
  db(f.store)
    .prepare('UPDATE transcripts SET document_json=? WHERE id=?')
    .run(JSON.stringify(altered), edited.id)
  assert.throws(() => f.store.commitSubtitleImport(silent), { code: 'CONFLICT' })
  const replaced = f.request()
  const row = f.saved()
  db(f.store).prepare('DELETE FROM transcripts WHERE id=?').run(row.id)
  db(f.store)
    .prepare(
      'INSERT INTO transcripts(id,episode_id,audio_hash,document_json,revision,imported_at) VALUES(?,?,?,?,?,?)',
    )
    .run(
      randomUUID(),
      f.target.episodeId,
      f.target.audioHash,
      JSON.stringify(row.document),
      row.revision,
      row.importedAt,
    )
  assert.throws(() => f.store.commitSubtitleImport(replaced), { code: 'CONFLICT' })
  assert.equal(f.store.subtitleImportSource(f.target), null)
})

test('missing and stale baseline identities cannot overwrite subtitles arriving while a native picker is open', async (t) => {
  const f = await fixture(t, false),
    request = f.request()
  assert.deepEqual(request.baseline, {
    status: 'missing',
    transcriptId: null,
    revision: null,
    documentHash: null,
  })
  f.store.saveTranscript(f.target.episodeId, f.original)
  assert.throws(() => f.store.commitSubtitleImport(request), { code: 'CONFLICT' })
  const old = f.saved(),
    nextHash = 'b'.repeat(64)
  db(f.store)
    .prepare('UPDATE episodes SET content_hash=? WHERE id=?')
    .run(nextHash, f.target.episodeId)
  const target = { ...f.target, audioHash: nextHash },
    baseline = f.store.transcriptImportBaseline(target)
  assert.equal(baseline.status, 'stale')
  assert.equal(baseline.transcriptId, old.id)
  assert.equal(baseline.revision, old.revision)
  assert.equal(baseline.documentHash, sha(JSON.stringify(old.document)))
  const pending = {
    ...request,
    target,
    baseline,
    document: { ...f.converted, audioHash: nextHash },
  }
  pending.source.metadata.documentBytes = Buffer.byteLength(JSON.stringify(pending.document))
  db(f.store).prepare('UPDATE transcripts SET revision=revision+1 WHERE id=?').run(old.id)
  assert.throws(() => f.store.commitSubtitleImport(pending), { code: 'CONFLICT' })
  assert.equal(f.store.getTranscript(target.episodeId, target.audioHash).status, 'stale')
})

test('audio identity changes or removal invalidate an uncommitted import and cannot revive an episode', async (t) => {
  const f = await fixture(t),
    request = f.request()
  db(f.store)
    .prepare('UPDATE episodes SET content_hash=? WHERE id=?')
    .run('c'.repeat(64), f.target.episodeId)
  assert.throws(() => f.store.commitSubtitleImport(request), { code: 'FILE_CHANGED' })
  f.store.removeBook(f.book.id)
  assert.throws(() => f.store.commitSubtitleImport(request), { code: 'FILE_CHANGED' })
  assert.equal(db(f.store).prepare('SELECT count(*) AS n FROM subtitle_import_sources').get()!.n, 0)
  assert.equal(db(f.store).prepare('SELECT count(*) AS n FROM episodes').get()!.n, 0)
})

test('durable command and token replay returns current state after restart and never restores old text or sources', async (t) => {
  const f = await fixture(t),
    request = f.request()
  f.store.commitSubtitleImport(request)
  f.store.saveTranscript(f.target.episodeId, f.original)
  const current = f.saved()
  f.reopen()
  assert.equal(f.store.subtitleImportSource(f.target), null)
  const replay = {
    token: request.token,
    revision: request.previewRevision,
    commandId: request.commandId,
  }
  assert.equal(f.store.replaySubtitleImport(replay)!.replayed, true)
  assert.deepEqual(f.store.replaySubtitleImport(replay)!.state, {
    status: 'ready',
    transcript: current,
  })
  assert.equal(f.store.commitSubtitleImport(request).replayed, true)
  assert.deepEqual(f.saved(), current)
  assert.equal(f.store.subtitleImportSource(f.target), null)
  assert.equal(
    db(f.store).prepare('SELECT count(*) AS n FROM subtitle_import_commands').get()!.n,
    1,
  )
  for (const change of [
    { token: randomUUID() },
    { previewRevision: 2 },
    { document: f.original },
    { source: { ...request.source, offsetMs: 10 } },
  ])
    assert.throws(() => f.store.commitSubtitleImport({ ...request, ...change }), {
      code: 'CONFLICT',
    })
  assert.throws(() => f.store.replaySubtitleImport({ ...replay, revision: 2 }), {
    code: 'CONFLICT',
  })
  assert.throws(() => f.store.replaySubtitleImport({ ...replay, commandId: randomUUID() }), {
    code: 'CONFLICT',
  })
  assert.throws(() => f.store.commitSubtitleImport({ ...request, commandId: randomUUID() }), {
    code: 'CONFLICT',
  })
  assert.equal(
    f.store.replaySubtitleImport({ token: randomUUID(), revision: 1, commandId: randomUUID() }),
    null,
  )
})

test('manual corrections, split and undo retain the imported revision and raw source; a new JSON or adopted job baseline clears it', async (t) => {
  const f = await fixture(t)
  f.store.commitSubtitleImport(f.request())
  const origin = f.store.subtitleImportSource(f.target)!,
    saved = f.saved()
  f.store.performTranscriptEdit({
    ...f.target,
    revision: saved.revision,
    commandId: randomUUID(),
    operation: { kind: 'split', segmentId: 'cue-only-a', offset: 2, atMs: 1500 },
  })
  assert.deepEqual(f.store.subtitleImportSource(f.target), origin)
  const history = f.store.transcriptEditingState(f.target)
  f.store.undoTranscriptEdit({
    ...f.target,
    revision: f.saved().revision,
    commandId: randomUUID(),
    historyId: history.undo!.id,
  })
  assert.deepEqual(f.store.subtitleImportSource(f.target), origin)
  assert(f.saved().revision > origin.importRevision)
  f.store.saveTranscript(f.target.episodeId, f.original)
  assert.equal(f.store.subtitleImportSource(f.target), null)
  f.store.commitSubtitleImport(f.request())
  const job = f.store.createJob({ ...f.target, engine: 'paraformer', device: 'cpu' })
  f.store.setJobStatus(job.id, job.attempt, 'running')
  f.store.acceptJobSnapshot(
    job.id,
    job.attempt,
    {
      document: f.original,
      processedUntilMs: 20000,
      totalChunks: 1,
      cacheHits: 0,
      cacheKey: 'a'.repeat(64),
      issues: [],
    },
    1,
    true,
  )
  assert(f.store.subtitleImportSource(f.target))
  f.store.applyJob(job.id, f.saved().revision)
  assert.equal(f.store.subtitleImportSource(f.target), null)
})

test('real SQLITE_FULL rolls back source bytes, formal text, command and history; storage recovery allows the exact request', async (t) => {
  const f = await fixture(t)
  f.edit()
  const request = f.request(),
    before = f.saved(),
    history = f.store.transcriptEditingState(f.target),
    connection = db(f.store)
  request.source.bytes = Buffer.concat([raw, Buffer.alloc(1024 * 1024, 32)])
  request.source.sha256 = sha(request.source.bytes)
  const pageCount = Number(connection.prepare('PRAGMA page_count').get()!.page_count)
  connection.exec(`PRAGMA max_page_count=${pageCount}`)
  try {
    assert.throws(
      () => f.store.commitSubtitleImport(request),
      (error: unknown) => error instanceof Error && Reflect.get(error, 'errcode') === 13,
    )
    assert.equal(connection.isTransaction, false)
    assert.deepEqual(f.saved(), before)
    assert.deepEqual(f.store.transcriptEditingState(f.target), history)
    assert.equal(f.store.subtitleImportSource(f.target), null)
    assert.equal(
      f.store.replaySubtitleImport({
        token: request.token,
        revision: 1,
        commandId: request.commandId,
      }),
      null,
    )
  } finally {
    connection.exec('PRAGMA max_page_count=1073741823')
  }
  f.store.commitSubtitleImport(request)
  assert.deepEqual(f.store.subtitleImportSource(f.target)!.bytes, request.source.bytes)
})

test('raw source and converted document independently reject values over 16 MiB without disturbing the formal baseline', async (t) => {
  const f = await fixture(t),
    request = f.request(),
    before = f.saved()
  request.source.bytes = Buffer.alloc(16 * 1024 * 1024 + 1)
  request.source.sha256 = sha(request.source.bytes)
  assert.throws(() => f.store.commitSubtitleImport(request), /16 MiB/)
  const huge = f.request()
  huge.document.segments = Array.from({ length: 1900 }, (_, i) => ({
    id: `huge-${i}`,
    startMs: i * 10,
    endMs: i * 10 + 9,
    text: 'x'.repeat(9000),
  }))
  huge.document.coverage = [{ startMs: 0, endMs: 20000 }]
  assert.throws(() => f.store.commitSubtitleImport(huge), { code: 'INVALID_TRANSCRIPT' })
  assert.deepEqual(f.saved(), before)
  assert.equal(f.store.subtitleImportSource(f.target), null)
})

test('source SHA, encoding, statistics and actual-duration validation reject inconsistent provenance before any write', async (t) => {
  const f = await fixture(t),
    before = f.saved()
  for (const patch of [
    { sha256: '0'.repeat(64) },
    { encoding: 'auto' },
    { fileName: '../unsafe.vtt' },
    { offsetMs: NaN },
    { metadata: { ...f.request().source.metadata, cueCount: 0 } },
    { metadata: { ...f.request().source.metadata, outputSegments: 4 } },
    { metadata: { ...f.request().source.metadata, documentBytes: 1 } },
  ]) {
    const request = f.request()
    assert.throws(
      () =>
        f.store.commitSubtitleImport({
          ...request,
          source: { ...request.source, ...patch },
        } as CommitSubtitleImport),
      { code: 'INVALID_REQUEST' },
    )
  }
  const beyond = f.request()
  beyond.document.coverage[0]!.endMs = 20002
  beyond.source.metadata.documentBytes = Buffer.byteLength(JSON.stringify(beyond.document))
  assert.throws(() => f.store.commitSubtitleImport(beyond), { code: 'INVALID_TRANSCRIPT' })
  assert.deepEqual(f.saved(), before)
  assert.equal(
    db(f.store).prepare('SELECT count(*) AS n FROM subtitle_import_commands').get()!.n,
    0,
  )
})

test('metadata shape, aggregated warning and cue limits cannot store unbounded or contradictory provenance', async (t) => {
  const f = await fixture(t),
    before = f.saved(),
    metadata = f.request().source.metadata
  for (const patch of [
    { extra: 'unexpected payload' },
    { cueCount: 100001 },
    { outputSegments: 100001 },
    { overlappingCues: metadata.cueCount + 1 },
    { overlapSegments: metadata.outputSegments + 1 },
    { multilineCues: metadata.cueCount + 1 },
    { markupCues: metadata.cueCount + 1 },
    { settingsCues: metadata.cueCount + 1 },
    { inlineTimestamps: 16 * 1024 * 1024 + 1 },
    {
      warnings: Array.from({ length: 33 }, (_, index) => ({
        code: `bounded-${index}`,
        count: 1,
        firstLine: null,
      })),
    },
    { warnings: [metadata.warnings[0]!, metadata.warnings[0]!] },
    { warnings: [{ ...metadata.warnings[0]!, extra: 'do not retain cue payload here' }] },
    { warnings: [{ ...metadata.warnings[0]!, count: 0 }] },
    { warnings: [{ ...metadata.warnings[0]!, count: Number.MAX_SAFE_INTEGER }] },
    { warnings: [{ ...metadata.warnings[0]!, firstLine: Number.MAX_SAFE_INTEGER }] },
  ]) {
    const request = f.request()
    request.source.metadata = { ...metadata, ...patch }
    assert.throws(() => f.store.commitSubtitleImport(request), { code: 'INVALID_REQUEST' })
  }
  const wrongVttEncoding = f.request()
  wrongVttEncoding.source.encoding = 'utf-16le'
  assert.throws(() => f.store.commitSubtitleImport(wrongVttEncoding), { code: 'INVALID_REQUEST' })
  assert.deepEqual(f.saved(), before)
  assert.equal(f.store.subtitleImportSource(f.target), null)
  assert.equal(
    db(f.store).prepare('SELECT count(*) AS n FROM subtitle_import_commands').get()!.n,
    0,
  )
})

test('real parser output and exact canonical statistics persist atomically for both SRT and WebVTT', async (t) => {
  const f = await fixture(t, false)
  for (const format of ['srt', 'vtt'] as const) {
    const bytes =
        format === 'vtt'
          ? raw
          : Buffer.from(
              '1\n00:00:01,000 --> 00:00:04,000\n少年走进山谷。\n\n2\n00:00:02,000 --> 00:00:05,000\n山中响起钟声。\n',
            ),
      parsed = parseTimedSubtitles(bytes.toString('utf8'), format, f.target.audioHash, 20000),
      request = f.request()
    request.document = parsed.document
    request.source = {
      ...request.source,
      fileName: `真实解析.${format}`,
      format,
      bytes,
      sha256: sha(bytes),
      metadata: parsed.metadata,
    }
    const result = f.store.commitSubtitleImport(request)
    assert.equal(result.replayed, false)
    assert.equal(f.saved().document.kind, 'transcript')
    assert.deepEqual(f.saved().document, parsed.document)
    assert.equal(parsed.metadata.documentBytes, Buffer.byteLength(JSON.stringify(parsed.document)))
    assert.equal(parsed.metadata.cueCount, 2)
    assert.equal(parsed.metadata.outputSegments, 3)
    assert.equal(parsed.metadata.overlapSegments, 1)
    const origin = f.store.subtitleImportSource(f.target)!
    assert.deepEqual(origin.bytes, bytes)
    assert.deepEqual(origin.metadata, parsed.metadata)
    assert.equal(origin.importedDocumentHash, sha(JSON.stringify(parsed.document)))
  }
  const before = f.saved(),
    origin = f.store.subtitleImportSource(f.target)
  f.reopen()
  assert.deepEqual(f.saved(), before)
  assert.deepEqual(f.store.subtitleImportSource(f.target), origin)
})

test('book deletion cascades raw origins and import command tokens', async (t) => {
  const f = await fixture(t),
    request = f.request()
  f.store.commitSubtitleImport(request)
  f.store.removeBook(f.book.id)
  assert.equal(db(f.store).prepare('SELECT count(*) AS n FROM subtitle_import_sources').get()!.n, 0)
  assert.equal(
    db(f.store).prepare('SELECT count(*) AS n FROM subtitle_import_commands').get()!.n,
    0,
  )
  assert.equal(
    f.store.replaySubtitleImport({
      token: request.token,
      revision: 1,
      commandId: request.commandId,
    }),
    null,
  )
})

test('schema14→15 migrates history, old offline plan, originals, player and settings; a partial migration failure rolls back cleanly before reopen', async (t) => {
  const f = await fixture(t)
  f.edit()
  f.store.saveBookmark({ ...f.target, positionMs: 2500, note: '旧版本书签' })
  f.store.setSubtitlePreparation(f.book.id, {
    mode: 'manual',
    engine: 'whisperx',
    device: 'cpu',
    prepareNext: false,
  })
  const original = parseOriginal(
    Buffer.from('少年走进长长的山谷。\n远方传来了悠长的钟声。'),
    '旧版本原文.txt',
  )
  f.store.originals.import(f.target, original)
  f.store.saveProgress({
    sessionId: '',
    episodeId: f.target.episodeId,
    positionMs: 2600,
    durationMs: 20000,
    rate: 1.25,
    volume: 0.3,
  })
  const plan = f.store.createOfflinePlan({
    bookId: f.book.id,
    episodeIds: f.book.episodes.map((e) => e.id),
    scope: 'ids',
    profile: { engine: 'paraformer', device: 'cpu' },
    audioBudgetBytes: 0,
  })
  f.store.updateOfflinePlan({ id: plan.id, revision: plan.revision, action: 'pause' })
  const state = () => ({
      books: f.store.listBooks(),
      transcript: f.saved(),
      history: f.store.transcriptEditingState(f.target),
      bookmark: f.store.listBookmarks(f.book.id),
      player: f.store.getPlayerState(),
      original: f.store.originals.state(f.target),
      offline: f.store.offlinePlan(plan.id),
      items: f.store.storedOfflineItems(plan.id),
      policy: f.store.processingResources(),
    }),
    prior = state()
  f.reopen(() => {
    let connection = new DatabaseSync(f.filename)
    connection.exec(
      "DROP TABLE online_pending_progress; DROP TABLE subtitle_import_commands; DROP TABLE subtitle_import_sources; PRAGMA user_version=14; CREATE TABLE subtitle_import_commands(sentinel TEXT); INSERT INTO subtitle_import_commands VALUES('keep old data');",
    )
    connection.close()
    assert.throws(() => new LibraryStore(f.filename), /already exists/)
    connection = new DatabaseSync(f.filename)
    assert.equal(connection.prepare('PRAGMA user_version').get()!.user_version, 14)
    assert.equal(
      connection
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='subtitle_import_sources'")
        .get()!.n,
      0,
    )
    assert.equal(
      connection.prepare('SELECT sentinel FROM subtitle_import_commands').get()!.sentinel,
      'keep old data',
    )
    connection.exec('DROP TABLE subtitle_import_commands')
    connection.close()
  })
  assert.equal(db(f.store).prepare('PRAGMA user_version').get()!.user_version, 18)
  assert.deepEqual(state(), prior)
  f.reopen()
  assert.deepEqual(state(), prior)
  f.store.undoTranscriptEdit({
    ...f.target,
    revision: f.saved().revision,
    commandId: randomUUID(),
    historyId: prior.history.undo!.id,
  })
  assert.deepEqual(f.saved().document, f.original)
  f.store.commitSubtitleImport(f.request())
  assert(f.store.subtitleImportSource(f.target))
})
