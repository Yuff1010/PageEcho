import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { lexicalCharacters, parseAcousticResult } from '../../src/main/original/acoustic-process'
import type { OriginalAcousticSnapshot } from '../../src/main/original/acoustic-snapshot'

function fixture() {
  const text = '春𠀀。风2！'
  const snapshot: OriginalAcousticSnapshot = {
    episodeId: 'episode',
    audioHash: 'a'.repeat(64),
    originalId: 'original',
    revision: 2,
    segmentId: 'segment',
    device: 'cpu',
    transcriptId: 'transcript',
    transcriptRevision: 1,
    originalText: text,
    textHash: createHash('sha256').update(text).digest('hex'),
    selection: { first: 2, last: 3 },
    oldRange: { startMs: 1000, endMs: 5500 },
    range: { startMs: 0, endMs: 7000 },
    sentences: [
      { ordinal: 2, textStart: 0, textEnd: 4 },
      { ordinal: 3, textStart: 4, textEnd: 7 },
    ],
  }
  const value = {
    protocolVersion: 1,
    type: 'result',
    requestId: 'request',
    status: 'accepted',
    audioHash: snapshot.audioHash,
    textSha256: snapshot.textHash,
    device: 'cpu',
    range: { ...snapshot.range },
    contract: 'original-ctc-support-v1',
    ctcContract: 'ctc-complete-waveform-logodds-v1',
    qualityPolicy: 'confirmed-original-acoustic-gate-v1',
    thresholds: { minTokenPosterior: 0.02 },
    elapsedMs: 200,
    startMs: 1100,
    endMs: 5300,
    characters: lexicalCharacters(text).map((char, index) => ({
      ...char,
      startMs: [1100, 1300, 4900, 5100][index]!,
      endMs: [1300, 1500, 5100, 5300][index]!,
      score: 0.9,
    })),
    evidence: {
      lexicalCharacters: 4,
      timedCharacters: 4,
      characterCoverage: 1,
      audioRms: 0.02,
      minTokenPosterior: 0.8,
      meanTokenPosterior: 0.9,
      freePathCharacters: 4,
      freePathEditDistance: 0,
      freePathErrorRate: 0,
      maxUnexplainedPosterior: 0,
    },
    reasons: [] as { code: string; message: string }[],
  }
  return { snapshot, value, parse: () => parseAcousticResult(value, snapshot, 'request') }
}

test('acoustic parser preserves UTF16 characters and real sentence gaps without stretching punctuation', () => {
  const f = fixture(),
    result = f.parse()
  assert.deepEqual(result.characters[1], {
    text: '𠀀',
    textStart: 1,
    textEnd: 3,
    startMs: 1300,
    endMs: 1500,
    score: 0.9,
  })
  assert.deepEqual(result.sentenceTimes, [
    { ordinal: 2, startMs: 1100, endMs: 1500 },
    { ordinal: 3, startMs: 4900, endMs: 5300 },
  ])
  assert.equal(result.diagnostics?.qualityPolicy, 'confirmed-original-acoustic-gate-v1')
})

test('acoustic parser rejects forged source, request, device, contract and range identities', () => {
  for (const patch of [
    { protocolVersion: 2 },
    { requestId: 'other' },
    { audioHash: 'b'.repeat(64) },
    { textSha256: 'b'.repeat(64) },
    { device: 'cuda' },
    { contract: 'invented' },
    { range: { startMs: 0, endMs: 8000 } },
    { ctcContract: 'legacy-interpolation' },
  ]) {
    const f = fixture()
    assert.throws(() => parseAcousticResult({ ...f.value, ...patch }, f.snapshot, 'request'), {
      code: 'INTERNAL',
    })
  }
})

test('acoustic parser rejects missing, substituted, duplicated and nonmonotonic native characters', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => f.value.characters.pop(),
    (f: ReturnType<typeof fixture>) => {
      f.value.characters[1]!.text = '错'
    },
    (f: ReturnType<typeof fixture>) => {
      f.value.characters[1]!.textEnd = 2
    },
    (f: ReturnType<typeof fixture>) => {
      f.value.characters[1]!.startMs = 1200
    },
    (f: ReturnType<typeof fixture>) => {
      f.value.characters[1]!.endMs = 1300
    },
    (f: ReturnType<typeof fixture>) => {
      f.value.characters[1]!.startMs = 1300.1
    },
    (f: ReturnType<typeof fixture>) => {
      f.value.characters[1]!.score = NaN
    },
    (f: ReturnType<typeof fixture>) => {
      f.value.characters[3]!.endMs = 7002
    },
    (f: ReturnType<typeof fixture>) => {
      f.value.startMs = 1000
    },
    (f: ReturnType<typeof fixture>) => {
      f.value.evidence.characterCoverage = 0.9
    },
  ]) {
    const f = fixture()
    mutate(f)
    assert.throws(f.parse, { code: 'INTERNAL' })
  }
})

test('rejected acoustic output keeps nullable diagnostics and never supplies adoptable times', () => {
  const f = fixture()
  const value = {
    ...f.value,
    status: 'rejected',
    characters: [],
    startMs: undefined,
    endMs: undefined,
    reasons: [{ code: 'UNSUPPORTED_CHARACTERS', message: '模型词表不支持字符。' }],
    evidence: { lexicalCharacters: 4, timedCharacters: 0, characterCoverage: 0, audioRms: null },
  }
  const result = parseAcousticResult(value, f.snapshot, 'request')
  assert.deepEqual(result.sentenceTimes, [])
  assert.equal(result.startMs, null)
  assert.equal(result.evidence.minTokenPosterior, null)
  assert.throws(() => parseAcousticResult({ ...value, startMs: 1000 }, f.snapshot, 'request'))
  assert.throws(() => parseAcousticResult({ ...value, reasons: [] }, f.snapshot, 'request'))
})
