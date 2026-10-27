import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LibraryStore } from '../../src/main/database'
import { parseOriginal } from '../../src/main/original/parse'
import { matchOriginal } from '../../src/main/original/match'
import type { OriginalAcousticSnapshot } from '../../src/main/original/acoustic-snapshot'
import {
  ORIGINAL_ACOUSTIC_CONTRACT,
  type OriginalAcousticResult,
} from '../../src/shared/original-acoustic'
import type { TranscriptDocument } from '../../src/shared/transcript'

// Synthetic store fixtures test revision/coordinate protection. These times and
// labels are never passed off as human review or acoustic model quality evidence.
function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'ralb-original-acoustic-store-')), 'library.sqlite3')
  let library = new LibraryStore(path)
  const hash = 'a'.repeat(64),
    episodeId = randomUUID(),
    bookId = randomUUID()
  library.importBook({
    id: bookId,
    title: '合成声学校准测试',
    sourcePath: 'D:/fixture',
    kind: 'folder',
    episodes: [
      {
        id: episodeId,
        path: 'D:/fixture/acoustic-test.mp3',
        name: 'acoustic-test.mp3',
        sizeBytes: 10,
        modifiedAt: 1,
        contentHash: hash,
      },
    ],
  })
  library.recordSourceDuration(episodeId, hash, 20000)
  const texts = [
    '少年将整齐的衣服收进旅行用的布袋。',
    '他把旧地图折好，小心放进身后的背包。',
    '山谷中的钟声渐渐远去，路上只剩下清风和明月。',
  ]
  const target = { episodeId, audioHash: hash }
  const document: TranscriptDocument = {
    version: 1,
    audioHash: hash,
    kind: 'transcript',
    coverage: [{ startMs: 0, endMs: 20000 }],
    segments: texts.map((text, index) => ({
      id: `segment-${index}`,
      startMs: [1000, 5000, 11000][index]!,
      endMs: [3000, 8000, 13000][index]!,
      text,
    })),
  }
  const saved = library.saveTranscript(episodeId, document)
  assert.equal(saved.status, 'ready')
  if (saved.status !== 'ready') throw new Error('Missing fixture transcript')
  const parsed = parseOriginal(Buffer.from('第1章\n' + texts.join('\n')), '合成测试.txt')
  const originalId = library.originals.import(target, parsed).info!.id
  library.originals.saveAlignment(
    target,
    originalId,
    saved.transcript.id,
    saved.transcript.revision,
    0,
    matchOriginal(parsed, document),
  )
  return {
    target,
    document,
    parsed,
    originalId,
    transcript: saved,
    get library() {
      return library
    },
    state() {
      return library.originals.state(target)
    },
    request() {
      return {
        ...target,
        originalId,
        revision: this.state().alignment!.revision,
        segmentId: 'segment-1',
        device: 'cpu' as const,
      }
    },
    confirm(selection: { first: number; last: number } | null = { first: 1, last: 1 }) {
      return library.originals.correct({ ...this.request(), selection, startMs: 5400, endMs: 7900 })
    },
    snapshot() {
      return library.originals.acousticSnapshot(this.request())
    },
    reopen() {
      library.close()
      library = new LibraryStore(path)
    },
    close() {
      library.close()
    },
  }
}

function accepted(
  snapshot: OriginalAcousticSnapshot,
  startMs = 5600,
  endMs = 7700,
): OriginalAcousticResult {
  return {
    status: 'accepted',
    contract: ORIGINAL_ACOUSTIC_CONTRACT,
    range: snapshot.range,
    startMs,
    endMs,
    characters: [],
    sentenceTimes: snapshot.sentences.map((sentence) => ({
      ordinal: sentence.ordinal,
      startMs,
      endMs,
    })),
    evidence: {
      lexicalCharacters: snapshot.originalText.length,
      timedCharacters: 0,
      characterCoverage: 0,
      audioRms: null,
      freePathCharacters: null,
      freePathEditDistance: null,
      minTokenPosterior: null,
      meanTokenPosterior: null,
      confidence: null,
    },
    reasons: [],
  }
}

test('acoustic snapshots require a manually reviewed selected passage and retain original/transcript identities', () => {
  const f = fixture()
  try {
    assert.equal(f.state().alignment!.matches[1]!.selected?.method, 'auto')
    assert.throws(() => f.snapshot(), { code: 'INVALID_ORIGINAL' })
    f.confirm(null)
    assert.equal(f.state().alignment!.matches[1]!.reviewed, true)
    assert.throws(() => f.snapshot(), { code: 'INVALID_ORIGINAL' })
    f.confirm()
    const snapshot = f.snapshot()
    assert.equal(snapshot.originalText, f.parsed.sentences[1]!.text)
    assert.equal(
      snapshot.textHash,
      createHash('sha256').update(snapshot.originalText).digest('hex'),
    )
    assert.equal(snapshot.transcriptId, f.transcript.transcript.id)
    assert.equal(snapshot.transcriptRevision, 1)
    assert.deepEqual(snapshot.selection, { first: 1, last: 1 })
    assert.deepEqual(snapshot.oldRange, { startMs: 5400, endMs: 7900 })
    assert.deepEqual(snapshot.range, { startMs: 3900, endMs: 9400 })
    assert.deepEqual(snapshot.sentences, [
      { ordinal: 1, textStart: 0, textEnd: snapshot.originalText.length },
    ])
  } finally {
    f.close()
  }
})

test('applying and restoring an acoustic result use revision CAS, persist history and leave the ASR document intact', () => {
  const f = fixture()
  try {
    f.confirm()
    const snapshot = f.snapshot(),
      id = randomUUID(),
      result = accepted(snapshot)
    let state = f.library.originals.applyAcoustic(snapshot, id, result, snapshot.revision)
    const match = state.alignment!.matches[1]!
    assert.equal(state.alignment!.revision, snapshot.revision + 1)
    assert.deepEqual([match.startMs, match.endMs], [5600, 7700])
    assert.equal(match.acoustic!.id, id)
    assert.deepEqual(match.acoustic!.manualRange, snapshot.oldRange)
    assert.deepEqual(match.acoustic!.sentenceTimes, result.sentenceTimes)
    assert.deepEqual(f.library.getTranscript(f.target.episodeId, f.target.audioHash), f.transcript)
    assert.throws(
      () => f.library.originals.applyAcoustic(snapshot, randomUUID(), result, snapshot.revision),
      { code: 'CONFLICT' },
    )
    assert.throws(
      () =>
        f.library.originals.restoreAcoustic({
          ...f.request(),
          revision: snapshot.revision,
          historyId: id,
        }),
      { code: 'CONFLICT' },
    )
    f.reopen()
    assert.deepEqual(f.state(), state)
    state = f.library.originals.restoreAcoustic({ ...f.request(), historyId: id })
    assert.deepEqual(
      [state.alignment!.matches[1]!.startMs, state.alignment!.matches[1]!.endMs],
      [5400, 7900],
    )
    assert.equal(state.alignment!.matches[1]!.acoustic, undefined)
    assert.equal(state.alignment!.revision, snapshot.revision + 2)
    assert.deepEqual(f.library.getTranscript(f.target.episodeId, f.target.audioHash), f.transcript)
  } finally {
    f.close()
  }
})

test('repeated acoustic applications preserve the first manual range; manual correction clears their history', () => {
  const f = fixture()
  try {
    f.confirm()
    const first = f.snapshot(),
      firstId = randomUUID()
    f.library.originals.applyAcoustic(first, firstId, accepted(first), first.revision)
    const second = f.snapshot(),
      secondId = randomUUID()
    let state = f.library.originals.applyAcoustic(
      second,
      secondId,
      accepted(second, 5700, 7600),
      second.revision,
    )
    assert.deepEqual(state.alignment!.matches[1]!.acoustic!.manualRange, first.oldRange)
    assert.notDeepEqual(second.oldRange, first.oldRange)
    assert.throws(
      () => f.library.originals.restoreAcoustic({ ...f.request(), historyId: firstId }),
      { code: 'CONFLICT' },
    )
    state = f.library.originals.correct({
      ...f.request(),
      selection: { first: 1, last: 1 },
      startMs: 5500,
      endMs: 7800,
    })
    assert.equal(state.alignment!.matches[1]!.acoustic, undefined)
    assert.deepEqual(
      [state.alignment!.matches[1]!.startMs, state.alignment!.matches[1]!.endMs],
      [5500, 7800],
    )
    assert.throws(
      () => f.library.originals.restoreAcoustic({ ...f.request(), historyId: secondId }),
      { code: 'CONFLICT' },
    )
  } finally {
    f.close()
  }
})

test('restoring manual timing refuses a new neighbor overlap instead of moving either passage', () => {
  const f = fixture()
  try {
    f.confirm()
    const snapshot = f.snapshot(),
      id = randomUUID()
    f.library.originals.applyAcoustic(snapshot, id, accepted(snapshot), snapshot.revision)
    f.library.originals.correct({
      ...f.request(),
      segmentId: 'segment-0',
      selection: { first: 0, last: 0 },
      startMs: 1000,
      endMs: 5500,
    })
    const before = f.state()
    assert.throws(() => f.library.originals.restoreAcoustic({ ...f.request(), historyId: id }), {
      code: 'CONFLICT',
    })
    assert.deepEqual(f.state(), before)
    const current = f.snapshot()
    assert.equal(current.range.startMs, 5500)
    assert.throws(
      () =>
        f.library.originals.applyAcoustic(
          current,
          randomUUID(),
          accepted(current, 5499, 7700),
          current.revision,
        ),
      { code: 'INVALID_ORIGINAL' },
    )
    assert.deepEqual(f.state(), before)
  } finally {
    f.close()
  }
})

test('a new original version or transcript revision rejects an old acoustic proposal without replacing current work', () => {
  for (const change of ['original', 'transcript', 'alignment'] as const) {
    const f = fixture()
    try {
      f.confirm()
      const snapshot = f.snapshot(),
        result = accepted(snapshot)
      if (change === 'original')
        f.library.originals.import(
          f.target,
          parseOriginal(Buffer.from('第1章\n另外一份小说正文，不能沿用旧位置。'), '新版.txt'),
        )
      if (change === 'transcript')
        f.library.saveTranscript(f.target.episodeId, {
          ...f.document,
          segments: f.document.segments.map((segment) =>
            segment.id === 'segment-1'
              ? { ...segment, text: segment.text.replace('旧地图', '新地图') }
              : segment,
          ),
        })
      if (change === 'alignment')
        f.library.originals.correct({
          ...f.request(),
          selection: { first: 1, last: 1 },
          startMs: 5450,
          endMs: 7850,
        })
      const before = f.state(),
        transcript = f.library.getTranscript(f.target.episodeId, f.target.audioHash)
      assert.throws(
        () => f.library.originals.applyAcoustic(snapshot, randomUUID(), result, snapshot.revision),
        { code: 'CONFLICT' },
      )
      assert.deepEqual(f.state(), before)
      assert.deepEqual(f.library.getTranscript(f.target.episodeId, f.target.audioHash), transcript)
    } finally {
      f.close()
    }
  }
})

test('rejected or invalid acoustic boundaries never change the manually confirmed timing', () => {
  const f = fixture()
  try {
    f.confirm()
    const snapshot = f.snapshot(),
      result = accepted(snapshot),
      before = f.state()
    for (const invalid of [
      { ...result, status: 'rejected' as const },
      { ...result, contract: 'unrecognized-contract' },
      { ...result, startMs: null },
      { ...result, endMs: null },
      { ...result, startMs: 5600.5 },
      { ...result, startMs: 2999 },
      { ...result, endMs: 11001 },
      { ...result, endMs: 5600 },
    ]) {
      assert.throws(
        () => f.library.originals.applyAcoustic(snapshot, randomUUID(), invalid, snapshot.revision),
        { code: 'INVALID_ORIGINAL' },
      )
      assert.deepEqual(f.state(), before)
    }
  } finally {
    f.close()
  }
})
