import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createSubtitleStatusSnapshot,
  subtitleStatusText,
  type SubtitleStatusInput,
  type SubtitleStatusJob,
} from '../../src/shared/subtitle-status'

const job: SubtitleStatusJob = {
  id: 'job',
  status: 'running',
  stage: 'recognizing',
  autoApply: true,
  hasPreview: true,
  processedUntilMs: 90000,
  completedChunks: 2,
  totalChunks: 3,
  cacheHits: 0,
}
const base: SubtitleStatusInput = {
  episodeId: 'episode',
  audioHash: 'a'.repeat(64),
  positionMs: 45000,
  durationMs: 90000,
  savedStatus: 'ready',
  coverage: [
    { startMs: 60000, endMs: 90000 },
    { startMs: 0, endMs: 30000 },
  ],
  job,
}

test('disjoint coverage reports actual work separately from prefix and continuous lead at playback position', () => {
  const snapshot = createSubtitleStatusSnapshot({ ...base, jobCoverage: base.coverage })
  assert.equal(snapshot.savedCoverage.coveredMs, 60000)
  assert.equal(snapshot.savedCoverage.prefixMs, 30000)
  assert.equal(snapshot.savedCoverage.leadMs, 0)
  assert.equal(snapshot.savedCoverage.rangeCount, 2)
  assert.equal(snapshot.savedCoverage.complete, false)
  assert.equal(snapshot.job?.coverage?.coveredMs, 60000)
  const resumed = createSubtitleStatusSnapshot({ ...base, positionMs: 65000 })
  assert.equal(resumed.savedCoverage.leadMs, 25000)
  assert.match(subtitleStatusText(resumed, 2).lead, /25 秒音频，2×可听约 12 秒/)
  assert.match(subtitleStatusText(snapshot).jobText, /本次已处理 01:00/)
  assert.match(subtitleStatusText(resumed).jobText, /处理位置 01:30/)
})

test('an unadopted preview never supplies playback lead or replaces a complete saved document', () => {
  const previewJob = { ...job, autoApply: false, status: 'completed' as const }
  const saved = createSubtitleStatusSnapshot({
    ...base,
    positionMs: 0,
    coverage: [{ startMs: 0, endMs: 90000 }],
    job: previewJob,
    jobCoverage: [{ startMs: 0, endMs: 30000 }],
  })
  assert.equal(saved.savedCoverage.complete, true)
  assert.equal(saved.savedCoverage.leadMs, 90000)
  const text = subtitleStatusText(saved)
  assert.equal(text.title, '整集字幕已备')
  assert.match(text.jobText, /新稿已完成，待采用/)
  assert.match(text.jobText, /本次已处理 00:30/)
  const onlyPreview = createSubtitleStatusSnapshot({
    ...base,
    savedStatus: 'missing',
    coverage: [],
    job: previewJob,
    jobCoverage: [{ startMs: 0, endMs: 90000 }],
  })
  assert.equal(onlyPreview.savedCoverage.leadMs, 0)
  assert.equal(onlyPreview.savedCoverage.complete, false)
  assert.equal(subtitleStatusText(onlyPreview).title, '字幕未准备')
})

test('coverage merges overlaps without double counting, bounds range previews, and never completes an unknown or stale source', () => {
  const coverage = Array.from({ length: 8 }, (_, index) => ({
    startMs: index * 10000,
    endMs: index * 10000 + 5000,
  }))
  const snapshot = createSubtitleStatusSnapshot({
    ...base,
    durationMs: null,
    positionMs: 0,
    coverage: [...coverage, { startMs: 0, endMs: 4000 }],
    job: null,
  })
  assert.equal(snapshot.savedCoverage.coveredMs, 40000)
  assert.equal(snapshot.savedCoverage.rangeCount, 8)
  assert.equal(snapshot.savedCoverage.ranges.length, 3)
  assert.equal(snapshot.savedCoverage.complete, false)
  const stale = createSubtitleStatusSnapshot({ ...base, savedStatus: 'stale' })
  assert.equal(stale.savedCoverage.coveredMs, 0)
  assert.equal(stale.savedCoverage.leadMs, 0)
  assert.equal(subtitleStatusText(stale).title, '字幕音频版本不符')
})

test('whole-episode completion allows only the existing 1ms media-end rounding tolerance', () => {
  const coverage = [{ startMs: 0, endMs: 16360 }]
  for (const durationMs of [16359.75, 16360, 16360.25, 16361]) {
    const snapshot = createSubtitleStatusSnapshot({ ...base, durationMs, coverage })
    assert.equal(snapshot.savedCoverage.complete, true, `duration ${durationMs}`)
    assert.equal(snapshot.durationMs, durationMs)
  }
  for (const durationMs of [16361.01, null, 0])
    assert.equal(
      createSubtitleStatusSnapshot({ ...base, durationMs, coverage }).savedCoverage.complete,
      false,
      `duration ${durationMs}`,
    )
  const gap = createSubtitleStatusSnapshot({
    ...base,
    durationMs: 16360.25,
    coverage: [
      { startMs: 0, endMs: 8000 },
      { startMs: 8000.25, endMs: 16360 },
    ],
  })
  assert.equal(gap.savedCoverage.complete, false)
  assert.equal(gap.savedCoverage.prefixMs, 8000)
  assert.equal(gap.savedCoverage.rangeCount, 2)
})
