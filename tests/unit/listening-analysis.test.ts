import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeListening, type ListeningSample } from '../model/listening-analysis'

function sample(wallMs: number, positionMs: number, prefix = 0, source = 'a'): ListeningSample {
  return {
    wallMs,
    positionMs,
    source: `readlisten://app/media/${source}/hash`,
    paused: false,
    ipcMs: 2,
    visibility: 'visible',
    jobs: [
      {
        episodeId: 'a',
        processedUntilMs: prefix,
        completedChunks: prefix ? 1 : 0,
        autoApply: true,
      },
    ],
  }
}
test('processing faster than real time still records the initial uncovered playback interval', () => {
  const result = analyzeListening([
    sample(0, 0),
    sample(500, 500),
    sample(1000, 1000, 30000),
    sample(1500, 1500, 30000),
    sample(1600, 0, 0, 'b'),
    sample(2100, 500, 0, 'b'),
  ])
  const first = result.tracks[0]!
  assert.equal(first.processedCoverageBehindMs, 500)
  assert.equal(first.processedCoverageAheadMs, 500)
  assert.equal(first.coverageTransitionMs, 500)
  assert.equal(first.maximumUnprocessedLeadMs, 500)
  assert.equal(first.firstCoveredMediaPositionMs, 1000)
  assert.equal(
    result.tracks[1]!.processedCoverageBehindMs,
    0,
    'a different chapter is not attributed to the old job',
  )
})
test('an observed clock stop excludes a long observation gap and does not cross automatic chapter boundaries', () => {
  const values = [
    sample(0, 1000),
    sample(500, 1000),
    sample(1000, 1000),
    sample(5000, 1000),
    sample(5500, 1500),
    sample(6000, 0, 0, 'b'),
  ]
  values[2]!.visibility = 'hidden'
  values[0]!.jobs[0]!.status = 'running'
  const result = analyzeListening(values)
  assert.equal(result.longestObservedClockStopMs, 1000)
  assert.equal(result.tracks[0]!.unobservedGapMs, 4000)
  assert.equal(result.discontinuities, 0)
  assert.equal(result.ipc.find((group) => group.visibility === 'hidden')!.samples, 1)
  assert.equal(result.ipc.find((group) => group.activity === 'inference-active')!.samples, 1)
  assert.throws(() => analyzeListening([{ ...values[0]!, positionMs: Number.NaN }]), /Invalid/)
})
