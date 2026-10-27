import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { SubtitleImportService } from '../../src/main/subtitle-import-service'
import type { SubtitleImportOptions, SubtitleImportPreview } from '../../src/shared/subtitle-import'
import type { TranscriptDocument } from '../../src/shared/transcript'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture(t: TestContext, saved = true) {
  const root = await mkdtemp(join(tmpdir(), 'ralb-subtitle-import-service-')),
    audioDirectory = join(root, 'audio'),
    audioPath = join(audioDirectory, '一集.mp3')
  await mkdir(audioDirectory)
  await writeFile(audioPath, 'owned audio identity, parser/service tests do not load a codec')
  const fixed = new Date('2026-01-01T00:00:00Z')
  await utimes(audioPath, fixed, fixed)
  const store = new LibraryStore(join(root, 'library.sqlite3'))
  store.importBook(await scanBook(audioDirectory, 'folder'))
  const episode = store.listBooks()[0]!.episodes[0]!,
    target = { episodeId: episode.id, audioHash: episode.contentHash },
    old: TranscriptDocument = {
      version: 1,
      kind: 'manual',
      audioHash: target.audioHash,
      coverage: [{ startMs: 0, endMs: 10000 }],
      segments: [{ id: 'old', startMs: 100, endMs: 1800, text: '原字幕需要保留。' }],
    }
  store.recordSourceDuration(episode.id, episode.contentHash, 10000)
  if (saved) store.saveTranscript(episode.id, old)
  const events: unknown[] = []
  let now = 1000
  const service = new SubtitleImportService({
    store,
    now: () => now,
    notify: (value) => events.push(value),
  })
  t.after(async () => {
    await service.close()
    store.close()
    const resolved = join(tmpdir(), root.slice(tmpdir().length))
    assert.equal(resolved, root)
    assert.ok(root.startsWith(join(tmpdir(), 'ralb-subtitle-import-service-')))
    await rm(root, { recursive: true, force: true })
  })
  const file = join(root, '字幕.srt')
  await writeFile(
    file,
    '1\n00:00:01,000 --> 00:00:03,000\n第一句。\n\n2\n00:00:02,000 --> 00:00:04,000\n第二句。\n',
  )
  const request = (options: Partial<SubtitleImportOptions> = {}) => ({
    ...target,
    requestId: randomUUID(),
    encoding: 'auto' as const,
    offsetMs: 0,
    ...options,
  })
  async function preview(options: Partial<SubtitleImportOptions> = {}) {
    const input = request(options),
      result = await service.preview(input, async () => file)
    assert.equal(result.canceled, false)
    return { input, value: (result as { canceled: false; preview: SubtitleImportPreview }).preview }
  }
  return {
    root,
    store,
    target,
    old,
    service,
    file,
    audioPath,
    events,
    request,
    preview,
    tick: (value: number) => {
      now += value
    },
    current: () => store.getTranscript(target.episodeId, target.audioHash),
  }
}

test('native selection and paged preview never write; explicit import preserves raw bytes and command replay cannot restore old text', async (t) => {
  const f = await fixture(t),
    before = f.current(),
    { value } = await f.preview()
  assert.equal(value.status, 'ready')
  assert.deepEqual(
    value.rows.map((row) => [row.startMs, row.endMs, row.text]),
    [
      [1000, 2000, '第一句。'],
      [2000, 3000, '第一句。\n第二句。'],
      [3000, 4000, '第二句。'],
    ],
  )
  assert.deepEqual(f.current(), before)
  assert.equal(f.store.subtitleImportSource(f.target), null)
  assert.deepEqual(f.events, [])
  const command = { token: value.token, revision: value.revision, commandId: randomUUID() },
    result = await f.service.apply(command)
  assert.equal(result.replayed, false)
  assert.equal(result.state.status, 'ready')
  assert.deepEqual(f.store.subtitleImportSource(f.target)!.bytes, await readFile(f.file))
  assert.equal(f.events.length, 1)
  const changed = {
    ...f.old,
    segments: f.old.segments.map((row) => ({ ...row, text: '后来的正式稿。' })),
  }
  f.store.saveTranscript(f.target.episodeId, changed)
  const replay = await f.service.apply(command)
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.state, f.current())
  assert.equal(f.store.subtitleImportSource(f.target), null)
  assert.equal(f.events.length, 1)
  await assert.rejects(async () => f.service.apply({ ...command, commandId: randomUUID() }), {
    code: 'CONFLICT',
  })
})

test('preview DTOs cannot mutate Main documents; pages are complete and options invalidate older revisions without changing source bytes', async (t) => {
  const f = await fixture(t)
  await writeFile(
    f.file,
    Array.from(
      { length: 101 },
      (_, i) =>
        `${i + 1}\n00:00:${String(Math.floor(i / 20)).padStart(2, '0')},${String((i % 20) * 50).padStart(3, '0')} --> 00:00:${String(Math.floor(i / 20)).padStart(2, '0')},${String((i % 20) * 50 + 25).padStart(3, '0')}\n第${i}句`,
    ).join('\n\n'),
  )
  const { value } = await f.preview()
  assert.equal(value.pages, 3)
  assert.equal(value.rows.length, 50)
  value.rows[0]!.text = 'hostile renderer mutation'
  value.metadata!.warnings.push({ code: 'hostile', count: 1, firstLine: null })
  const page = f.service.page({ token: value.token, revision: value.revision, page: 2 })
  assert.equal(page.rows.length, 1)
  assert.equal(page.rows[0]!.text, '第100句')
  assert.ok(!page.metadata!.warnings.some((warning) => warning.code === 'hostile'))
  const updated = await f.service.update({
    token: value.token,
    revision: value.revision,
    encoding: 'auto',
    offsetMs: 100,
  })
  assert.equal(updated.revision, 2)
  assert.equal(updated.rows[0]!.startMs, 100)
  assert.equal(updated.rows[0]!.text, '第0句')
  assert.equal(updated.sourceSha256, value.sourceSha256)
  assert.throws(() => f.service.page({ token: value.token, revision: 1, page: 0 }), {
    code: 'CONFLICT',
  })
  assert.equal(f.store.subtitleImportSource(f.target), null)
  assert.deepEqual(f.events, [])
})

test('malformed times and explicit encoding recovery stay in preview and invalid previews cannot be adopted', async (t) => {
  const f = await fixture(t),
    before = f.current()
  await writeFile(
    f.file,
    Buffer.concat([
      Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n'),
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
    ]),
  )
  const { value } = await f.preview()
  assert.equal(value.status, 'encoding-required')
  assert.equal(value.rows.length, 0)
  await assert.rejects(
    async () => f.service.apply({ token: value.token, revision: 1, commandId: randomUUID() }),
    { code: 'INVALID_TRANSCRIPT' },
  )
  const decoded = await f.service.update({
    token: value.token,
    revision: 1,
    encoding: 'gb18030',
    offsetMs: 0,
  })
  assert.equal(decoded.status, 'ready')
  assert.equal(decoded.rows[0]!.text, '中文')
  const invalid = await f.service.update({
    token: value.token,
    revision: 2,
    encoding: 'gb18030',
    offsetMs: -2000,
  })
  assert.equal(invalid.status, 'invalid')
  assert.equal(invalid.rows.length, 0)
  assert.deepEqual(f.current(), before)
})

test('real selection, extension and file errors remain errors rather than being mislabeled as user cancellation', async (t) => {
  const f = await fixture(t)
  await assert.rejects(
    f.service.preview(f.request(), async () => join(f.root, 'missing.srt')),
    { code: 'FILE_UNAVAILABLE' },
  )
  await assert.rejects(
    f.service.preview(f.request(), async () => join(f.root, 'not-a-subtitle.json')),
    { code: 'INVALID_TRANSCRIPT' },
  )
  await assert.rejects(
    f.service.preview(f.request(), async () => {
      throw new Error('picker failed')
    }),
    /picker failed/,
  )
  assert.deepEqual(await f.service.preview(f.request(), async () => null), { canceled: true })
  assert.deepEqual(f.events, [])
})

test('picker-time and post-preview formal changes reject stale ready, missing and option updates without partial source/history writes', async (t) => {
  const f = await fixture(t, false),
    picker = deferred<string | null>(),
    selecting = f.service.preview(f.request(), () => picker.promise)
  f.store.saveTranscript(f.target.episodeId, f.old)
  picker.resolve(f.file)
  await assert.rejects(selecting, { code: 'CONFLICT' })
  const { value } = await f.preview()
  f.store.saveTranscript(f.target.episodeId, f.old)
  assert.throws(() => f.service.page({ token: value.token, revision: 1, page: 0 }), {
    code: 'CONFLICT',
  })
  await assert.rejects(
    f.service.update({ token: value.token, revision: 1, encoding: 'auto', offsetMs: 0 }),
    { code: 'CONFLICT' },
  )
  await assert.rejects(
    f.service.apply({ token: value.token, revision: 1, commandId: randomUUID() }),
    { code: 'CONFLICT' },
  )
  assert.equal(f.store.subtitleImportSource(f.target), null)
  assert.deepEqual(f.events, [])
})

test('canceling an open native selection settles immediately and a late picker path cannot create a preview', async (t) => {
  const f = await fixture(t),
    picker = deferred<string | null>(),
    input = f.request(),
    selecting = f.service.preview(input, () => picker.promise)
  await f.service.cancel(input.requestId)
  assert.deepEqual(await selecting, { canceled: true })
  picker.resolve(f.file)
  await new Promise((done) => setImmediate(done))
  assert.deepEqual(f.events, [])
  assert.equal(f.store.subtitleImportSource(f.target), null)
})

test('cancel after preview releases its source and tokens; expiry and two-preview capacity remain bounded', async (t) => {
  const f = await fixture(t),
    first = await f.preview(),
    second = await f.preview()
  await assert.rejects(
    f.service.preview(f.request(), async () => f.file),
    { code: 'BUSY' },
  )
  await f.service.cancel(first.input.requestId)
  assert.throws(() => f.service.page({ token: first.value.token, revision: 1, page: 0 }), {
    code: 'CONFLICT',
  })
  const next = await f.preview()
  f.tick(300001)
  assert.throws(() => f.service.page({ token: second.value.token, revision: 1, page: 0 }), {
    code: 'CONFLICT',
  })
  assert.throws(() => f.service.page({ token: next.value.token, revision: 1, page: 0 }), {
    code: 'CONFLICT',
  })
  assert.equal((await f.preview()).value.status, 'ready')
})

test('cancel wins an in-flight audio hash and update without late adoption or notification', async (t) => {
  const f = await fixture(t),
    before = f.current(),
    { input, value } = await f.preview(),
    applying = f.service.apply({ token: value.token, revision: 1, commandId: randomUUID() })
  const rejection = assert.rejects(applying, { code: 'CONFLICT' })
  await f.service.cancel(input.requestId)
  await rejection
  const next = await f.preview(),
    updating = f.service.update({
      token: next.value.token,
      revision: 1,
      encoding: 'auto',
      offsetMs: 25,
    }),
    updateRejection = assert.rejects(updating)
  await f.service.cancel(next.input.requestId)
  await updateRejection
  assert.deepEqual(f.current(), before)
  assert.equal(f.store.subtitleImportSource(f.target), null)
  assert.deepEqual(f.events, [])
})

test('same-size same-timestamp audio corruption is rejected by a full content hash before adoption', async (t) => {
  const f = await fixture(t),
    { value } = await f.preview(),
    before = await stat(f.audioPath),
    bytes = await readFile(f.audioPath)
  bytes[0] = bytes[0]! ^ 1
  await writeFile(f.audioPath, bytes)
  await utimes(f.audioPath, before.atime, before.mtime)
  await assert.rejects(
    f.service.apply({ token: value.token, revision: 1, commandId: randomUUID() }),
    { code: 'FILE_CHANGED' },
  )
  assert.equal(f.store.subtitleImportSource(f.target), null)
})

test('close drains preview and legacy JSON selection; late picker responses cannot write', async (t) => {
  const f = await fixture(t),
    picker = deferred<string | null>(),
    jsonPicker = deferred<string | null>(),
    selecting = f.service.preview(f.request(), () => picker.promise),
    importing = f.service.importJson(f.target, () => jsonPicker.promise)
  await f.service.close()
  assert.deepEqual(await selecting, { canceled: true })
  assert.deepEqual(await importing, { canceled: true })
  picker.resolve(f.file)
  jsonPicker.resolve(join(f.root, 'missing.json'))
  await new Promise((done) => setImmediate(done))
  assert.throws(() => f.service.page({ token: randomUUID(), revision: 1, page: 0 }), {
    code: 'BUSY',
  })
  assert.deepEqual(f.events, [])
})

test('close aborts an in-flight update and audio-hash adoption, then permits the database to close without late notifications', async (t) => {
  const f = await fixture(t),
    first = await f.preview(),
    second = await f.preview(),
    before = f.current(),
    updating = f.service.update({
      token: first.value.token,
      revision: 1,
      encoding: 'auto',
      offsetMs: 10,
    }),
    applying = f.service.apply({ token: second.value.token, revision: 1, commandId: randomUUID() }),
    updateRejection = assert.rejects(updating),
    applyRejection = assert.rejects(applying, { code: 'CONFLICT' })
  await f.service.close()
  await Promise.all([updateRejection, applyRejection])
  assert.deepEqual(f.current(), before)
  assert.equal(f.store.subtitleImportSource(f.target), null)
  assert.deepEqual(f.events, [])
})

test('the selected source is an immutable byte snapshot even when the original file is edited or deleted after preview', async (t) => {
  const f = await fixture(t),
    original = await readFile(f.file),
    { value } = await f.preview()
  await writeFile(f.file, 'invalid replacement made after selecting the file')
  await rm(f.file)
  const result = await f.service.apply({ token: value.token, revision: 1, commandId: randomUUID() })
  assert.equal(result.state.status, 'ready')
  assert.deepEqual(f.store.subtitleImportSource(f.target)!.bytes, original)
})

test('legacy JSON import retains its format and rejects a revision created while its picker waits', async (t) => {
  const f = await fixture(t),
    json = join(f.root, 'manual.json'),
    picker = deferred<string | null>(),
    importing = f.service.importJson(f.target, () => picker.promise)
  await writeFile(json, JSON.stringify(f.old))
  f.store.saveTranscript(f.target.episodeId, f.old)
  picker.resolve(json)
  await assert.rejects(importing, { code: 'CONFLICT' })
  const result = await f.service.importJson(f.target, async () => json)
  assert.equal(result.canceled, false)
  assert.equal(f.events.length, 1)
  assert.equal(f.store.subtitleImportSource(f.target), null)
})
