import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { validateRequest } from '../../src/shared/validation'
import {
  subtitleBufferState,
  subtitleLeadMs,
  SubtitleThroughput,
  subtitleCoveredUntil,
} from '../../src/shared/subtitle-preparation'
import type { TranscriptionState, TranscriptionSummaryState } from '../../src/shared/transcription'
import { subtitleStatusFromTranscription } from '../../src/shared/subtitle-status'

function state(
  coverage: { startMs: number; endMs: number }[],
  status = 'running',
  autoApply = true,
): TranscriptionState {
  return {
    configured: true,
    job: {
      id: 'fixture-job',
      episodeId: 'fixture',
      audioHash: 'a'.repeat(64),
      engine: 'whisperx',
      device: 'cpu',
      background: false,
      status: status as NonNullable<TranscriptionState['job']>['status'],
      attempt: 1,
      stage: status,
      processedUntilMs: 0,
      totalChunks: 3,
      completedChunks: 0,
      cacheHits: 0,
      issueCount: 0,
      autoApply,
      appliedRevision: 1,
      previewRevision: 0,
      hasPreview: false,
      createdAt: '',
      updatedAt: '',
      error: null,
    },
    transcript: {
      status: 'ready',
      transcript: {
        id: 'fixture',
        episodeId: 'fixture',
        importedAt: '',
        revision: 1,
        document: {
          version: 1,
          kind: 'transcript',
          audioHash: 'a'.repeat(64),
          coverage,
          segments: [],
        },
      },
    },
  }
}

function summary(value: TranscriptionState): TranscriptionSummaryState {
  const { transcript, ...rest } = value
  return {
    ...rest,
    transcriptHeader:
      transcript.status === 'ready'
        ? {
            status: 'ready',
            transcript: {
              id: transcript.transcript.id,
              episodeId: transcript.transcript.episodeId,
              importedAt: transcript.transcript.importedAt,
              revision: transcript.transcript.revision,
              coverage: transcript.transcript.document.coverage,
            },
          }
        : transcript,
  }
}

test('coverage-only playback summaries preserve gaps, speed, short tails and throughput without sentence bodies', () => {
  const coverage = [
    { startMs: 0, endMs: 10000 },
    { startMs: 20000, endMs: 25000 },
    { startMs: 40000, endMs: 70000 },
    { startMs: 80000, endMs: 95000 },
  ]
  for (const status of ['running', 'failed', 'canceled', 'completed']) {
    const full = state(coverage, status),
      compact = summary(full)
    assert.equal(JSON.stringify(compact).includes('segments'), false)
    for (const positionMs of [0, 15000, 21000, 40000, 85000, 94000]) {
      assert.equal(
        subtitleCoveredUntil(compact, positionMs),
        subtitleCoveredUntil(full, positionMs),
      )
      for (const rate of [1, 2])
        assert.deepEqual(
          subtitleBufferState(compact, positionMs, 95000, { rate }),
          subtitleBufferState(full, positionMs, 95000, { rate }),
        )
      const target = {
        episodeId: 'episode',
        audioHash: 'a'.repeat(64),
        positionMs,
        durationMs: 95000,
      }
      assert.deepEqual(
        subtitleStatusFromTranscription(compact, target),
        subtitleStatusFromTranscription(full, target),
      )
    }
  }
  const fullMetrics = new SubtitleThroughput(),
    compactMetrics = new SubtitleThroughput()
  for (const [completed, hits, endMs, at] of [
    [0, 0, 10000, 0],
    [1, 0, 30000, 1000],
    [2, 1, 40000, 1001],
    [3, 1, 50000, 2001],
  ]) {
    const full = state([{ startMs: 0, endMs: endMs! }])
    Object.assign(full.job!, { id: 'job', attempt: 1, completedChunks: completed, cacheHits: hits })
    assert.deepEqual(compactMetrics.observe(summary(full), at!), fullMetrics.observe(full, at!))
  }
})

test('subtitle buffer uses coverage at current media time, including silence and short episode tails', () => {
  assert.equal(subtitleBufferState(state([{ startMs: 0, endMs: 5000 }]), 0, 90_000).waiting, true)
  assert.equal(subtitleBufferState(state([{ startMs: 0, endMs: 30_000 }]), 0, 90_000).ready, true)
  assert.equal(
    subtitleBufferState(state([{ startMs: 0, endMs: 30_000 }]), 45_000, 90_000).waiting,
    true,
  )
  assert.equal(
    subtitleBufferState(state([{ startMs: 0, endMs: 50_000 }]), 45_000, 50_000).ready,
    true,
  )
  assert.equal(
    subtitleBufferState(
      state([
        { startMs: 0, endMs: 10_000 },
        { startMs: 20_000, endMs: 40_000 },
      ]),
      0,
      90_000,
    ).waiting,
    true,
  )
})

test('manual/imported text and failed, canceled or missing components never block ordinary playback', () => {
  for (const status of ['completed', 'failed', 'canceled', 'canceling'])
    assert.equal(subtitleBufferState(state([], status), 0, 90_000).waiting, false)
  assert.equal(subtitleBufferState(state([], 'running', false), 0, 90_000).waiting, false)
  assert.equal(
    subtitleBufferState(
      { configured: false, job: null, transcript: { status: 'missing' } },
      0,
      90_000,
    ).waiting,
    false,
  )
  assert.equal(subtitleBufferState({ ...state([]), job: null }, 0, 90_000).waiting, false)
})

test('subtitle lead follows playback speed and measured processing delay, with bounded media coverage', () => {
  assert.equal(subtitleLeadMs(), 30000)
  assert.equal(subtitleLeadMs({ rate: 2 }), 60000)
  assert.equal(subtitleLeadMs({ rate: 0.75 }), 30000)
  assert.equal(subtitleLeadMs({ rate: 1.5, chunkTurnaroundMs: 30000 }), 90000)
  assert.equal(subtitleLeadMs({ rate: 4, chunkTurnaroundMs: 999999 }), 180000)
  assert.equal(subtitleLeadMs({ rate: Number.NaN, chunkTurnaroundMs: Number.NaN }), 30000)
  const coverage = state([{ startMs: 150000, endMs: 180000 }])
  assert.equal(subtitleBufferState(coverage, 150000, 240000, { rate: 1 }).ready, true)
  assert.equal(subtitleBufferState(coverage, 150000, 240000, { rate: 2 }).waiting, true)
  assert.equal(subtitleBufferState(coverage, 170000, 180000, { rate: 2 }).ready, true)
  assert.match(
    subtitleBufferState(coverage, 175000, 240000, { rate: 2, audioMsPerWallMs: 0.5 }).message,
    /可能落后/,
  )
})

test('throughput observations exclude cache replay, repeated progress and older attempts', () => {
  const metrics = new SubtitleThroughput()
  const observation = (completed: number, hits: number, covered: number, attempt = 1) => {
    const result = state(covered ? [{ startMs: 0, endMs: covered }] : [])
    Object.assign(result.job!, { id: 'job', attempt, completedChunks: completed, cacheHits: hits })
    return result
  }
  assert.deepEqual(metrics.observe(observation(0, 0, 0), 0), {})
  assert.deepEqual(metrics.observe(observation(0, 0, 0), 1000), {})
  assert.deepEqual(metrics.observe(observation(1, 0, 30000), 10000), {
    chunkTurnaroundMs: 10000,
    audioMsPerWallMs: 3,
  })
  assert.deepEqual(metrics.observe(observation(2, 1, 60000), 10010), {
    chunkTurnaroundMs: 10000,
    audioMsPerWallMs: 3,
  })
  assert.deepEqual(metrics.observe(observation(3, 1, 90000), 20010), {
    chunkTurnaroundMs: 10000,
    audioMsPerWallMs: 3,
  })
  assert.deepEqual(metrics.observe(observation(0, 0, 0, 2), 21000), {})
  assert.deepEqual(metrics.observe(observation(4, 0, 120000, 1), 21010), {})
  assert.deepEqual(metrics.observe(observation(1, 0, 30000, 2), 31000), {
    chunkTurnaroundMs: 10000,
    audioMsPerWallMs: 3,
  })
  metrics.reset()
  assert.deepEqual(metrics.observe(observation(1, 1, 30000), 22000), {})
})

test('schema 10 migration preserves books and per-book subtitle strategies survive restart and reimport', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ralb-subtitle-settings-'))
  const audio = join(root, 'chapter.mp3')
  const filename = join(root, 'library.sqlite3')
  writeFileSync(audio, 'fixture audio')
  let store = new LibraryStore(filename)
  store.importBook(await scanBook(audio, 'file'))
  const id = store.listBooks()[0]!.id
  assert.equal(store.listBooks()[0]!.subtitlePreparation, undefined)
  store.close()
  const old = new DatabaseSync(filename)
  old.exec(
    'DROP TABLE online_pending_progress; DROP TABLE subtitle_import_commands; DROP TABLE subtitle_import_sources; DROP TABLE transcript_edit_commands; DROP TABLE transcript_edit_members; DROP TABLE transcript_edit_heads; DROP TABLE transcript_edit_groups; DROP TABLE offline_media_refs; DROP TABLE offline_plan_items; DROP TABLE offline_job_owners; DROP TABLE offline_plans; DROP TABLE processing_resources; ALTER TABLE transcription_jobs DROP COLUMN cpu_threads; DROP TABLE book_subtitle_settings; PRAGMA user_version=10;',
  )
  old.close()
  store = new LibraryStore(filename)
  try {
    assert.equal(store.listBooks()[0]!.id, id)
    const settings = {
      mode: 'ahead',
      engine: 'paraformer',
      device: 'cuda',
      prepareNext: true,
    } as const
    store.setSubtitlePreparation(id, settings)
    store.close()
    store = new LibraryStore(filename)
    assert.deepEqual(store.listBooks()[0]!.subtitlePreparation, settings)
    store.importBook(await scanBook(audio, 'file'))
    assert.deepEqual(store.getSubtitlePreparation(id), settings)
    store.removeBook(id)
    assert.equal(store.getSubtitlePreparation(id), undefined)
    assert.throws(() => store.setSubtitlePreparation(id, settings), { code: 'INVALID_REQUEST' })
  } finally {
    store.close()
  }
})

test('subtitle preparation IPC rejects planned modes, extra fields and malformed options', () => {
  const id = '49dc6bfa-b6fa-4e64-9e01-bf6b3040f007'
  const settings = { mode: 'ahead', engine: 'whisperx', device: 'cpu', prepareNext: true }
  validateRequest('transcription:preparation', [{ id, settings }])
  validateRequest('transcription:preparation', [{ id, settings: { ...settings, mode: 'manual' } }])
  for (const invalid of [
    { ...settings, mode: 'realtime' },
    { ...settings, mode: 'whole' },
    { ...settings, prepareNext: 1 },
    { ...settings, engine: 'unknown' },
    { ...settings, device: 'unknown' },
    { ...settings, path: 'arbitrary' },
  ])
    assert.throws(() => validateRequest('transcription:preparation', [{ id, settings: invalid }]), {
      code: 'INVALID_REQUEST',
    })
})
