import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  auditLongClock,
  parseJournal,
  type LongSample,
  type LongEvent,
} from '../model/long-playback-analysis'

const whole = 'a'.repeat(64),
  next = 'b'.repeat(64)
function fixture() {
  const source = (hash: string) => `readlisten://app/media/episode/${hash}`
  const samples: LongSample[] = Array.from({ length: 21 }, (_, index) => ({
    wallMs: 100000 + index * 1000,
    source: source(index <= 10 ? whole : next),
    positionMs: index <= 10 ? index * 1000 : (index - 10) * 1000,
    paused: false,
    ipcMs: 1,
    visibility: 'visible',
    jobs: [],
    rate: 1,
    savedPositionMs: index <= 10 ? Math.max(0, index * 1000 - 4000) : 0,
  }))
  const events: LongEvent[] = [
    { type: 'playing', source: source(whole), wallMs: 100000, positionMs: 0 },
    { type: 'ended', source: source(whole), wallMs: 110000, positionMs: 10000 },
    { type: 'playing', source: source(next), wallMs: 110025, positionMs: 0 },
  ]
  return { samples, events }
}
test('whole-source proof requires observed start/end, real elapsed EOF and following playback', () => {
  const { samples, events } = fixture()
  const result = auditLongClock(samples, events, 10000, whole, next)
  assert.equal(Object.values(result.checks).every(Boolean), true)
  assert.equal(result.endedToNextPlayingMs, 25)
  assert.equal(result.maximumSavedLagMs, 4000)
})
test('short interrupted observations cannot satisfy whole-source completion', () => {
  const { samples, events } = fixture()
  const result = auditLongClock(samples.slice(0, 5), events.slice(0, 1), 10000, whole, next)
  assert.equal(result.checks.observedNearWholeEnd, false)
  assert.equal(result.checks.naturalEndAtDuration, false)
  assert.equal(result.checks.automaticNextObserved, false)
})
test('synthesized early EOF and a forward clock jump are rejected separately', () => {
  const { samples, events } = fixture()
  samples[4]!.positionMs += 2000
  events[1]!.wallMs = 104000
  const result = auditLongClock(samples, events, 10000, whole, next)
  assert.equal(result.checks.noObservedTimeJump, false)
  assert.equal(result.checks.naturalWallDuration, false)
})
test('missing observations remain visible even when native end evidence exists', () => {
  const { samples, events } = fixture()
  samples.splice(3, 4)
  const result = auditLongClock(samples, events, 10000, whole, next)
  assert.equal(result.maximumSampleGapMs, 5000)
  assert.equal(result.analysis.tracks[0]!.unobservedGapMs, 5000)
})
test('rate changes, interior pause and native errors cannot be counted as smooth 1x playback', () => {
  const { samples, events } = fixture()
  samples[5]!.rate = 2
  events.push({ ...events[0]!, type: 'pause', positionMs: 5000 }, { ...events[0]!, type: 'error' })
  const result = auditLongClock(samples, events, 10000, whole, next)
  assert.equal(result.checks.nativeRateOne, false)
  assert.equal(result.checks.noInteriorPause, false)
  assert.equal(result.checks.noReportedMediaError, false)
})
test('only a running journal may ignore one incomplete final append', () => {
  assert.deepEqual(parseJournal('{"n":1}\n{"n":', true), {
    values: [{ n: 1 }],
    incompleteTail: true,
  })
  assert.throws(() => parseJournal('{"n":1}\n{"n":', false))
  assert.throws(() => parseJournal('{"n":broken}\n{"n":2}', true))
  assert.deepEqual(parseJournal('{"n":1}\n', false), { values: [{ n: 1 }], incompleteTail: false })
})

test('a sampled interior pause still fails when the final native event journal was not flushed', () => {
  const { samples, events } = fixture()
  samples[5]!.paused = true
  assert.equal(auditLongClock(samples, events, 10000, whole, next).checks.noInteriorPause, false)
})
