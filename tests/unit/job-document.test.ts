import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { mergeJobDocument, processedPrefix } from '../../src/shared/job-document'
import type { TranscriptDocument } from '../../src/shared/transcript'
import type { AsrSnapshot } from '../../src/main/asr-process'

function document(hash: string, startMs: number, endMs: number, text: string): TranscriptDocument {
  return {
    version: 1,
    audioHash: hash,
    kind: 'transcript',
    coverage: [{ startMs, endMs }],
    segments: [{ id: `segment-${startMs}`, startMs: startMs + 100, endMs: endMs - 100, text }],
  }
}
function snapshot(document: TranscriptDocument): AsrSnapshot {
  return {
    document,
    processedUntilMs: processedPrefix(document.coverage),
    cacheKey: 'a'.repeat(64),
    totalChunks: 3,
    cacheHits: 0,
    issues: [],
  }
}
test('priority coverage retains generated earlier regions and replaces only reprocessed ranges', () => {
  const earlier = document('a'.repeat(64), 0, 30_000, '前段已经生成。')
  const distant = document(earlier.audioHash, 60_000, 90_000, '优先生成的后段。')
  const merged = mergeJobDocument(earlier, distant)
  assert.deepEqual(merged.coverage, [
    { startMs: 0, endMs: 30_000 },
    { startMs: 60_000, endMs: 90_000 },
  ])
  assert.equal(processedPrefix(merged.coverage), 30_000)
  assert.equal(merged.segments.length, 2)
  const replacement = document(earlier.audioHash, 0, 30_000, '重新识别后的前段。')
  const replaced = mergeJobDocument(merged, replacement)
  assert.deepEqual(
    replaced.segments.map((segment) => segment.text),
    ['重新识别后的前段。', '优先生成的后段。'],
  )
  const filled = mergeJobDocument(
    replaced,
    document(earlier.audioHash, 30_000, 60_000, '中段补齐。'),
  )
  assert.deepEqual(filled.coverage, [{ startMs: 0, endMs: 90_000 }])
  assert.equal(processedPrefix(filled.coverage), 90_000)
})
test('retry after checkpoint loss publishes distant subtitles while preserving prior generated text and edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ralb-priority-merge-'))
  const path = join(root, 'episode.mp3')
  await writeFile(path, 'fixture audio')
  const store = new LibraryStore(join(root, 'library.sqlite3'))
  try {
    store.importBook(await scanBook(path, 'file'))
    const episode = store.listBooks()[0]!.episodes[0]!
    store.recordSourceDuration(episode.id, episode.contentHash, 90_000)
    const job = store.createJob({
      episodeId: episode.id,
      audioHash: episode.contentHash,
      engine: 'whisperx',
      device: 'cpu',
    })
    store.setJobStatus(job.id, job.attempt, 'running')
    store.acceptJobSnapshot(
      job.id,
      job.attempt,
      snapshot(document(job.audioHash, 0, 30_000, '前段已经生成。')),
      1,
      false,
    )
    store.setJobStatus(job.id, job.attempt, 'canceled')
    const retried = store.retryJob(job.id)
    store.setJobStatus(job.id, retried.attempt, 'running')
    assert.equal(
      store.acceptJobSnapshot(
        job.id,
        retried.attempt,
        snapshot(document(job.audioHash, 60_000, 90_000, '后段优先生成。')),
        1,
        false,
      ),
      true,
    )
    assert.equal(store.getJob(job.id)!.processedUntilMs, 30_000)
    const text = store.getTranscript(episode.id, episode.contentHash)
    assert.ok(text.status === 'ready')
    assert.equal(text.transcript.document.segments.length, 2)
    store.editTranscript({
      episodeId: episode.id,
      audioHash: episode.contentHash,
      revision: text.transcript.revision,
      segmentId: text.transcript.document.segments[0]!.id,
      text: '前段已经修改。',
    })
    store.acceptJobSnapshot(
      job.id,
      retried.attempt,
      snapshot(document(job.audioHash, 30_000, 60_000, '中段生成。')),
      2,
      false,
    )
    const edited = store.getTranscript(episode.id, episode.contentHash)
    assert.ok(edited.status === 'ready')
    assert.equal(edited.transcript.document.segments[0]!.text, '前段已经修改。')
    assert.equal(store.getJob(job.id)!.autoApply, false)
    assert.equal(store.jobDocument(job.id)!.segments.length, 3)
  } finally {
    store.close()
  }
})
