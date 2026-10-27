import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { validateRequest } from '../../src/shared/validation'
import type { TranscriptDocument } from '../../src/shared/transcript'

test('batch status reads saved and preview coverage separately without exposing sentence bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ralb-subtitle-summary-'))
  const path = join(root, 'episode.mp3')
  await writeFile(path, 'isolated summary test audio')
  const store = new LibraryStore(join(root, 'library.sqlite3'))
  try {
    store.importBook(await scanBook(path, 'file'))
    const episode = store.listBooks()[0]!.episodes[0]!
    store.recordSourceDuration(episode.id, episode.contentHash, 90_000)
    const target = { episodeId: episode.id, audioHash: episode.contentHash, positionMs: 65_000 }
    const partial: TranscriptDocument = {
      version: 1,
      audioHash: episode.contentHash,
      kind: 'manual',
      coverage: [
        { startMs: 0, endMs: 30_000 },
        { startMs: 60_000, endMs: 90_000 },
      ],
      segments: [
        { id: 'saved', startMs: 0, endMs: 2000, text: '人工保留的机密正文不能进入目录状态。' },
      ],
    }
    store.saveTranscript(episode.id, partial)
    const job = store.createJob({ ...target, engine: 'paraformer', device: 'cpu' })
    store.setJobStatus(job.id, job.attempt, 'running')
    store.acceptJobSnapshot(
      job.id,
      job.attempt,
      {
        document: {
          ...partial,
          kind: 'transcript',
          coverage: [{ startMs: 60_000, endMs: 90_000 }],
          segments: [
            {
              id: 'preview',
              startMs: 60_100,
              endMs: 62_000,
              text: '新稿预览正文也不能进入目录状态。',
            },
          ],
        },
        processedUntilMs: 0,
        cacheKey: 'b'.repeat(64),
        totalChunks: 3,
        cacheHits: 0,
        issues: [],
      },
      1,
      false,
    )
    const [snapshot] = store.subtitleStatuses([target])
    assert.equal(snapshot!.savedCoverage.coveredMs, 60_000)
    assert.equal(snapshot!.savedCoverage.prefixMs, 30_000)
    assert.equal(snapshot!.savedCoverage.leadMs, 25_000)
    assert.equal(snapshot!.savedCoverage.complete, false)
    assert.equal(snapshot!.job!.autoApply, false)
    assert.equal(snapshot!.job!.coverage!.coveredMs, 30_000)
    assert.equal(snapshot!.job!.coverage!.prefixMs, 0)
    assert.equal(snapshot!.job!.hasPreview, true)
    assert.ok(!JSON.stringify(snapshot).includes('正文'))
    assert.ok(!JSON.stringify(snapshot).includes('segments'))
    assert.ok(!JSON.stringify(snapshot).includes('configurationHash'))
    const [failed] = store.subtitleStatuses([target], {
      id: job.id,
      attempt: job.attempt,
      status: 'failed',
      error: 'cannot persist',
    })
    assert.equal(failed!.job!.status, 'failed')
    assert.equal(failed!.job!.stage, 'failed')
    assert.throws(() => store.subtitleStatuses([{ ...target, audioHash: 'c'.repeat(64) }]), {
      code: 'FILE_CHANGED',
    })
  } finally {
    store.close()
  }
})

test('batch status IPC bounds the visible page and rejects paths, duplicates and invalid positions', () => {
  const target = {
    episodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    audioHash: 'a'.repeat(64),
    positionMs: 0,
  }
  validateRequest('transcription:statuses', [{ episodes: [target] }])
  for (const request of [
    { episodes: [] },
    { episodes: [target, target] },
    { episodes: [{ ...target, positionMs: -1 }] },
    { episodes: [{ ...target, positionMs: 0.5 }] },
    { episodes: [{ ...target, path: 'C:\\private.mp3' }] },
    { episodes: [target], includeText: true },
    { episodes: Array.from({ length: 101 }, () => target) },
  ])
    assert.throws(() => validateRequest('transcription:statuses', [request]), {
      code: 'INVALID_REQUEST',
    })
})
