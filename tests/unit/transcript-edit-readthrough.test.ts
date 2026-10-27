import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import type { TranscriptDocument } from '../../src/shared/transcript'

async function fixture(t: TestContext, count = 1) {
  const root = await mkdtemp(join(tmpdir(), 'ralb-edit-readthrough-')),
    filename = join(root, 'library.sqlite3')
  for (let index = 0; index < count; index++)
    await writeFile(join(root, `${index}.mp3`), `transaction read-through audio ${index}`)
  const store = new LibraryStore(filename)
  store.importBook(await scanBook(root, 'folder'))
  const book = store.listBooks()[0]!,
    episodes = book.episodes
  for (const episode of episodes) {
    store.recordSourceDuration(episode.id, episode.contentHash, 20_000)
    store.saveTranscript(episode.id, {
      version: 1,
      kind: 'transcript',
      audioHash: episode.contentHash,
      coverage: [{ startMs: 0, endMs: 20_000 }],
      segments: [
        { id: 's1', startMs: 1000, endMs: 4000, text: '张三走向山谷。' },
        { id: 's2', startMs: 5000, endMs: 8000, text: '远方传来了钟声。' },
      ],
    })
  }
  const saved = (index = 0) => {
    const episode = episodes[index]!,
      state = store.getTranscript(episode.id, episode.contentHash)
    assert.equal(state.status, 'ready')
    if (state.status !== 'ready') throw new Error('Expected formal document')
    return state.transcript
  }
  const target = (index = 0) => ({
    episodeId: episodes[index]!.id,
    audioHash: episodes[index]!.contentHash,
    revision: saved(index).revision,
  })
  const prepare = () =>
    store.prepareTranscriptReplacement({
      ...target(),
      requestId: randomUUID(),
      scope: { kind: 'book', bookId: book.id, episodeIds: episodes.map((episode) => episode.id) },
      find: '张三',
      replacement: '李四',
    })
  t.after(async () => {
    store.close()
    assert.equal(resolve(dirname(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('ralb-edit-readthrough-'))
    await rm(root, { recursive: true, force: true })
  })
  return { store, filename, book, episodes, saved, target, prepare }
}

test('one edit reuses its before snapshot but reads the persisted post-write result independently', async (t) => {
  const f = await fixture(t),
    target = f.target(),
    original = f.store.getTranscript.bind(f.store),
    reads: { revision: number; text: string }[] = []
  f.store.getTranscript = (episodeId, audioHash) => {
    const state = original(episodeId, audioHash)
    if (state.status === 'ready')
      reads.push({
        revision: state.transcript.revision,
        text: state.transcript.document.segments[0]!.text,
      })
    return state
  }
  try {
    const result = f.store.performTranscriptEdit({
      ...target,
      commandId: randomUUID(),
      operation: { kind: 'text', segmentId: 's1', text: '李四走向山谷。' },
    })
    assert.deepEqual(reads, [
      { revision: 1, text: '张三走向山谷。' },
      { revision: 2, text: '李四走向山谷。' },
    ])
    assert.equal(result.transcript.status, 'ready')
    if (result.transcript.status !== 'ready') throw new Error('Expected post-write result')
    assert.equal(result.transcript.transcript.revision, 2)
    assert.equal(result.transcript.transcript.document.segments[0]!.text, '李四走向山谷。')
    result.transcript.transcript.document.segments[0]!.text = '调用方改动返回对象。'
    const reread = original(target.episodeId, target.audioHash)
    assert.equal(reread.status, 'ready')
    if (reread.status !== 'ready') throw new Error('Expected independent reread')
    assert.equal(reread.transcript.document.segments[0]!.text, '李四走向山谷。')
  } finally {
    f.store.getTranscript = original
  }
})

test('replacement adoption rereads after preview and retains exact content and transcript identity guards', async (t) => {
  const f = await fixture(t),
    plan = f.prepare(),
    original = f.saved(),
    external = new DatabaseSync(f.filename),
    altered: TranscriptDocument = structuredClone(original.document),
    commandId = randomUUID()
  try {
    altered.segments[1]!.text = '外部已保存不同的钟声。'
    external
      .prepare('UPDATE transcripts SET document_json=? WHERE episode_id=?')
      .run(JSON.stringify(altered), f.episodes[0]!.id)
    assert.throws(() => f.store.commitTranscriptReplacement(plan, commandId), { code: 'CONFLICT' })
    assert.deepEqual(f.saved().document, altered)
    external
      .prepare('UPDATE transcripts SET document_json=?,id=? WHERE episode_id=?')
      .run(JSON.stringify(original.document), randomUUID(), f.episodes[0]!.id)
    assert.throws(() => f.store.commitTranscriptReplacement(plan, commandId), { code: 'CONFLICT' })
    external
      .prepare('UPDATE transcripts SET id=? WHERE episode_id=?')
      .run(original.id, f.episodes[0]!.id)
    const result = f.store.commitTranscriptReplacement(plan, commandId)
    assert.equal(result.replayed, false)
    assert.equal(result.transcript.status, 'ready')
    if (result.transcript.status !== 'ready') throw new Error('Expected replacement')
    assert.equal(result.transcript.transcript.revision, original.revision + 1)
    assert.equal(result.transcript.transcript.document.segments[0]!.text, '李四走向山谷。')
    assert.equal(result.history.historyCount, 1)
  } finally {
    external.close()
  }
})

test('a failed multi-member transaction discards every cached draft before the exact command is retried', async (t) => {
  const f = await fixture(t, 2),
    plan = f.prepare(),
    before = f.episodes.map((_, index) => f.saved(index)),
    external = new DatabaseSync(f.filename),
    commandId = randomUUID()
  try {
    external.exec(`CREATE TRIGGER fail_readthrough_member BEFORE UPDATE OF document_json ON transcripts
      WHEN OLD.episode_id='${f.episodes[1]!.id}' BEGIN SELECT RAISE(ABORT,'owned second member failure'); END`)
    assert.throws(
      () => f.store.commitTranscriptReplacement(plan, commandId),
      /owned second member failure/u,
    )
    assert.deepEqual(
      f.episodes.map((_, index) => f.saved(index)),
      before,
    )
    assert.equal(f.store.transcriptEditingState(f.target()).historyCount, 0)
    external.exec('DROP TRIGGER fail_readthrough_member')
    const applied = f.store.commitTranscriptReplacement(plan, commandId)
    assert.equal(applied.changed.length, 2)
    assert.equal(applied.history.historyCount, 1)
    assert.equal(applied.transcript.status, 'ready')
    if (applied.transcript.status !== 'ready') throw new Error('Expected committed result')
    assert.equal(applied.transcript.transcript.document.segments[0]!.text, '李四走向山谷。')
    const undone = f.store.undoTranscriptEdit({
      ...f.target(),
      commandId: randomUUID(),
      historyId: applied.history.undo!.id,
    })
    assert.equal(undone.changed.length, 2)
    assert.deepEqual(
      f.episodes.map((_, index) => f.saved(index).document),
      before.map((v) => v.document),
    )
  } finally {
    external.close()
  }
})

test('no-op and command replay return fresh transaction state without retaining a prior result', async (t) => {
  const f = await fixture(t),
    noOp = {
      ...f.target(),
      commandId: randomUUID(),
      operation: { kind: 'text' as const, segmentId: 's1', text: '张三走向山谷。' },
    },
    initial = f.store.performTranscriptEdit(noOp)
  assert.equal(initial.changed.length, 0)
  assert.equal(initial.history.historyCount, 0)
  f.store.performTranscriptEdit({
    ...f.target(),
    commandId: randomUUID(),
    operation: { kind: 'text', segmentId: 's1', text: '李四走向山谷。' },
  })
  const replay = f.store.performTranscriptEdit(noOp)
  assert.equal(replay.replayed, true)
  assert.equal(replay.transcript.status, 'ready')
  if (replay.transcript.status !== 'ready') throw new Error('Expected replay of current state')
  assert.equal(replay.transcript.transcript.revision, 2)
  assert.equal(replay.transcript.transcript.document.segments[0]!.text, '李四走向山谷。')
  assert.equal(replay.history.historyCount, 1)
})
