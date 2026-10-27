import assert from 'node:assert/strict'
import test from 'node:test'
import type { TranscriptionState } from '../../src/shared/transcription'
import { transcriptionActivityModel } from '../../src/renderer/src/transcription-activity'

const state = (
  status = 'running',
  stage = 'recognizing',
  completedChunks = 1,
  totalChunks = 4,
): TranscriptionState =>
  ({
    configured: true,
    transcript: { status: 'missing' },
    job: {
      id: 'job',
      episodeId: 'episode',
      audioHash: 'a'.repeat(64),
      engine: 'paraformer',
      device: 'cpu',
      background: false,
      status,
      stage,
      completedChunks,
      totalChunks,
      processedUntilMs: 300000,
      cacheHits: 0,
      autoApply: true,
      attempt: 1,
      issueCount: 0,
      appliedRevision: 0,
      previewRevision: 0,
      hasPreview: false,
      createdAt: '',
      updatedAt: '',
      error: null,
    },
  }) as TranscriptionState

test('automatic checks without a job expose cancellable indeterminate work instead of a generate action', () => {
  const model = transcriptionActivityModel(null, 'checking')!
  assert.equal(model.active, true)
  assert.equal(model.title, '正在自动准备字幕')
  assert.equal(model.stage, '检查字幕组件')
  assert.equal(model.total, null)
  assert.equal(model.completedChunks, 0)
})
test('queue and model loading stay indeterminate even when a future chunk count is known', () => {
  for (const [status, stage] of [
    ['queued', 'queued'],
    ['running', 'loading'],
    ['running', 'checking-components'],
  ]) {
    const model = transcriptionActivityModel(state(status, stage))!
    assert.equal(model.active, true)
    assert.equal(model.total, null)
  }
})
test('recognition progress uses completed chunks and never turns the farthest media offset into a percentage', () => {
  const model = transcriptionActivityModel(state())!
  assert.equal(model.total, 4)
  assert.equal(model.completedChunks, 1)
  assert.equal(model.stage, '识别语音')
  assert.equal(transcriptionActivityModel(state('running', 'recognizing', 0, 0))!.total, null)
})
test('canceling remains active and terminal cancellation keeps a retry and preservation message', () => {
  const stopping = transcriptionActivityModel(state('canceling'))!
  assert.equal(stopping.active, true)
  assert.equal(stopping.canceling, true)
  const canceled = transcriptionActivityModel(state('canceled'), 'stopped')!
  assert.equal(canceled.active, false)
  assert.equal(canceled.retryable, true)
  assert.match(canceled.note, /字幕会保留/)
})
test('a stopped check remains visible without a task and an unavailable check gives a setup explanation', () => {
  const stopped = transcriptionActivityModel(null, 'stopped')!
  assert.equal(stopped.retryable, true)
  assert.equal(stopped.active, false)
  const unavailable = transcriptionActivityModel(null, 'missing-component', '请选择字幕组件')!
  assert.equal(unavailable.unavailable, true)
  assert.equal(unavailable.note, '请选择字幕组件')
})
test('ordinary reading does not manufacture progress and generated previews explain adoption separately', () => {
  assert.equal(transcriptionActivityModel(null), null)
  const preview = state()
  preview.job!.autoApply = false
  preview.job!.hasPreview = true
  assert.match(transcriptionActivityModel(preview)!.note, /当前文稿会保留/)
})
