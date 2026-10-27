import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyTranscriptEdit,
  replaceTranscriptText,
  transcriptEditBytes,
} from '../../src/main/transcript-edit-operations'
import {
  locateTranscript,
  MAX_SEGMENTS,
  MAX_TRANSCRIPT_BYTES,
  type TranscriptDocument,
} from '../../src/shared/transcript'
import type { TranscriptEditOperation } from '../../src/shared/transcript-editing'

const hash = 'a'.repeat(64),
  ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
  ]
function source(): TranscriptDocument {
  return {
    version: 1,
    audioHash: hash,
    kind: 'transcript',
    coverage: [
      { startMs: 0, endMs: 5000 },
      { startMs: 7000, endMs: 10000 },
    ],
    segments: [
      { id: 'first', startMs: 100, endMs: 2000, text: '甲𠮷乙。' },
      { id: 'second', startMs: 2500, endMs: 4000, text: '下一句。' },
      { id: 'last', startMs: 7500, endMs: 9000, text: '末句。' },
    ],
  }
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
}
function fresh() {
  let index = 0
  return () => ids[index++]!
}
function many(count: number, text = '甲乙'): TranscriptDocument {
  return {
    version: 1,
    audioHash: hash,
    kind: 'manual',
    coverage: [{ startMs: 0, endMs: count * 10 }],
    segments: Array.from({ length: count }, (_, index) => ({
      id: `s${index}`,
      startMs: index * 10,
      endMs: index * 10 + 9,
      text,
    })),
  }
}

test('split uses code-point offsets, fresh identities and half-open times while preserving every coverage range and outside sentence', () => {
  const before = source()
  freeze(before)
  const next = applyTranscriptEdit(
    before,
    { kind: 'split', segmentId: 'first', offset: 2, atMs: 1000 },
    10000,
    fresh(),
  )
  assert.deepEqual(next.segments.slice(0, 2), [
    { id: ids[0], startMs: 100, endMs: 1000, text: '甲𠮷' },
    { id: ids[1], startMs: 1000, endMs: 2000, text: '乙。' },
  ])
  assert.equal(next.segments[0]!.text + next.segments[1]!.text, before.segments[0]!.text)
  assert.deepEqual(next.segments.slice(2), before.segments.slice(1))
  assert.deepEqual(next.coverage, before.coverage)
  assert.equal(next.kind, before.kind)
  assert.equal(next.audioHash, before.audioHash)
  assert.equal(locateTranscript(next, 999, 10000).index, 0)
  assert.equal(locateTranscript(next, 1000, 10000).index, 1)
  assert.equal(locateTranscript(next, 5000, 10000).status, 'uncovered')
  assert.deepEqual(before, source())
})

test('split rejects offsets at either edge, fractional times, zero-length audio sides and whitespace-only text sides without mutating the source', () => {
  const before = source(),
    snapshot = JSON.stringify(before)
  for (const [offset, atMs] of [
    [0, 1000],
    [4, 1000],
    [2.5, 1000],
    [2, 100],
    [2, 2000],
    [2, 1000.5],
    [2, NaN],
  ])
    assert.throws(
      () =>
        applyTranscriptEdit(
          before,
          { kind: 'split', segmentId: 'first', offset: offset!, atMs: atMs! },
          10000,
        ),
      { code: 'INVALID_TRANSCRIPT' },
    )
  before.segments[0]!.text = '   甲'
  assert.throws(
    () =>
      applyTranscriptEdit(
        before,
        { kind: 'split', segmentId: 'first', offset: 3, atMs: 1000 },
        null,
      ),
    { code: 'INVALID_TRANSCRIPT' },
  )
  before.segments[0]!.text = source().segments[0]!.text
  before.segments[0]!.endMs = 101
  assert.throws(
    () =>
      applyTranscriptEdit(
        before,
        { kind: 'split', segmentId: 'first', offset: 2, atMs: 100 },
        null,
      ),
    { code: 'INVALID_TRANSCRIPT' },
  )
  before.segments[0]!.endMs = 2000
  assert.equal(JSON.stringify(before), snapshot)
})

test('affected sentences cannot reuse an old ID, return the same new UUID twice or accept a malformed generated ID', () => {
  const before = source()
  before.segments[0]!.id = ids[0]!
  const split = { kind: 'split', segmentId: ids[0]!, offset: 2, atMs: 1000 } as const
  for (const generate of [() => ids[0]!.toUpperCase(), () => ids[1]!, () => 'not-a-uuid'])
    assert.throws(() => applyTranscriptEdit(before, split, null, generate), {
      code: 'INVALID_TRANSCRIPT',
    })
  assert.equal(before.segments.length, 3)
})

test('merging neighboring sentences retains a covered natural pause, an explicit separator and every unaffected identity', () => {
  const before = source()
  freeze(before)
  for (const separator of ['', ' '] as const) {
    const next = applyTranscriptEdit(
      before,
      { kind: 'merge', firstId: 'first', secondId: 'second', separator },
      10000,
      fresh(),
    )
    assert.deepEqual(next.segments, [
      { id: ids[0], startMs: 100, endMs: 4000, text: `甲𠮷乙。${separator}下一句。` },
      before.segments[2],
    ])
    assert.deepEqual(next.coverage, before.coverage)
    assert.equal(locateTranscript(next, 2200, 10000).status, 'sentence')
    assert.equal(locateTranscript(before, 2200, 10000).status, 'pause')
  }
})

test('merge refuses reversed/nonadjacent sentences and both genuine holes and merely touching separate coverage intervals', () => {
  for (const [firstId, secondId] of [
    ['second', 'first'],
    ['first', 'last'],
    ['first', 'first'],
  ])
    assert.throws(
      () =>
        applyTranscriptEdit(
          source(),
          { kind: 'merge', firstId: firstId!, secondId: secondId!, separator: '' },
          null,
        ),
      { code: 'INVALID_TRANSCRIPT' },
    )
  const hole = source()
  assert.throws(
    () =>
      applyTranscriptEdit(
        hole,
        { kind: 'merge', firstId: 'second', secondId: 'last', separator: '' },
        null,
      ),
    { code: 'INVALID_TRANSCRIPT' },
  )
  const touching = many(2)
  touching.coverage = [
    { startMs: 0, endMs: 10 },
    { startMs: 10, endMs: 20 },
  ]
  assert.throws(
    () =>
      applyTranscriptEdit(
        touching,
        { kind: 'merge', firstId: 's0', secondId: 's1', separator: '' },
        20,
      ),
    { code: 'INVALID_TRANSCRIPT' },
  )
  assert.deepEqual(touching.coverage, [
    { startMs: 0, endMs: 10 },
    { startMs: 10, endMs: 20 },
  ])
})

test('manual retiming keeps stable IDs/text and a precise shared boundary but never sorts invalid edits into validity', () => {
  const before = source(),
    next = applyTranscriptEdit(
      before,
      {
        kind: 'timing',
        ranges: [
          { segmentId: 'first', startMs: 100, endMs: 2400 },
          { segmentId: 'second', startMs: 2400, endMs: 4100 },
        ],
      },
      10000,
    )
  assert.equal(locateTranscript(next, 2400, 10000).index, 1)
  assert.deepEqual(
    next.segments.map(({ id, text }) => ({ id, text })),
    before.segments.map(({ id, text }) => ({ id, text })),
  )
  assert.deepEqual(next.coverage, before.coverage)
  assert.deepEqual(before, source())
  assert.throws(
    () =>
      applyTranscriptEdit(
        before,
        {
          kind: 'timing',
          ranges: [
            { segmentId: 'first', startMs: 3000, endMs: 4000 },
            { segmentId: 'second', startMs: 100, endMs: 2000 },
          ],
        },
        null,
      ),
    { code: 'INVALID_TRANSCRIPT' },
  )
})

test('retiming rejects noninteger, overlapping, uncovered and out-of-duration ranges, retaining the one-millisecond container endpoint allowance', () => {
  const before = source()
  for (const [startMs, endMs] of [
    [-1, 1000],
    [100.5, 1000],
    [100, Infinity],
    [100, 100],
    [100, 2600],
    [4500, 7500],
  ])
    assert.throws(
      () =>
        applyTranscriptEdit(
          before,
          { kind: 'timing', ranges: [{ segmentId: 'first', startMs: startMs!, endMs: endMs! }] },
          10000,
        ),
      { code: 'INVALID_TRANSCRIPT' },
    )
  const fractional = many(1)
  fractional.coverage[0]!.endMs = 11
  assert.equal(
    applyTranscriptEdit(
      fractional,
      { kind: 'timing', ranges: [{ segmentId: 's0', startMs: 0, endMs: 11 }] },
      10.25,
    ).segments[0]!.endMs,
    11,
  )
  fractional.coverage[0]!.endMs = 12
  assert.throws(
    () =>
      applyTranscriptEdit(
        fractional,
        { kind: 'timing', ranges: [{ segmentId: 's0', startMs: 0, endMs: 12 }] },
        10.25,
      ),
    { code: 'INVALID_TRANSCRIPT' },
  )
  for (const duration of [0, NaN, Infinity, 3.6e10 + 1])
    assert.throws(
      () =>
        applyTranscriptEdit(before, { kind: 'text', segmentId: 'last', text: '末句。' }, duration),
      { code: 'INVALID_REQUEST' },
    )
})

test('one operation supports at most twenty distinct timing changes; empty and duplicate requests are rejected atomically', () => {
  const before = many(21),
    ranges = before.segments.map(({ id, startMs, endMs }) => ({ segmentId: id, startMs, endMs }))
  assert.deepEqual(
    applyTranscriptEdit(before, { kind: 'timing', ranges: ranges.slice(0, 20) }, null),
    before,
  )
  for (const values of [[], ranges, [ranges[0]!, ranges[0]!]])
    assert.throws(() => applyTranscriptEdit(before, { kind: 'timing', ranges: values }, null))
  assert.equal(before.segments.length, 21)
})

test('small text corrections keep timing/ID and exact no-op edits stay equivalent for the history layer', () => {
  const before = source()
  before.segments[0]!.text = '李小明走进山谷。'
  const next = applyTranscriptEdit(
    before,
    { kind: 'text', segmentId: 'first', text: '李晓明走进山谷。' },
    10000,
  )
  assert.deepEqual(next.segments[0], { ...before.segments[0], text: '李晓明走进山谷。' })
  assert.deepEqual(next.coverage, before.coverage)
  assert.deepEqual(
    applyTranscriptEdit(
      before,
      { kind: 'text', segmentId: 'first', text: '李小明走进山谷。' },
      null,
    ),
    before,
  )
  assert.deepEqual(replaceTranscriptText(before, '未出现的名字', '李明', null), {
    document: before,
    changes: [],
    occurrences: 0,
  })
  assert.throws(
    () =>
      applyTranscriptEdit(
        before,
        { kind: 'text', segmentId: 'first', text: '完全不同的大幅改写内容且长度明显增加。' },
        null,
      ),
    { code: 'INVALID_TRANSCRIPT' },
  )
})

test('literal batch replacement does not cross sentence boundaries, normalize names or interpret regex/replacement markers', () => {
  const before = source()
  before.segments[0]!.text = '李明和李明提到[x].与Ａa。'
  before.segments[1]!.text = '李'
  before.segments[2]!.text = '明'
  freeze(before)
  const names = replaceTranscriptText(before, '李明', '李萌', 10000)
  assert.equal(names.occurrences, 2)
  assert.deepEqual(names.changes, [
    {
      segmentId: 'first',
      before: before.segments[0]!.text,
      after: '李萌和李萌提到[x].与Ａa。',
      occurrences: 2,
    },
  ])
  assert.deepEqual(names.document.coverage, before.coverage)
  assert.deepEqual(
    names.document.segments.map(({ id, startMs, endMs }) => ({ id, startMs, endMs })),
    before.segments.map(({ id, startMs, endMs }) => ({ id, startMs, endMs })),
  )
  assert.equal(
    replaceTranscriptText(before, '[x].', '$&', null).document.segments[0]!.text,
    '李明和李明提到$&与Ａa。',
  )
  assert.equal(replaceTranscriptText(before, 'A', 'B', null).occurrences, 0)
  assert.equal(
    replaceTranscriptText(before, 'a', 'b', null).document.segments[0]!.text,
    '李明和李明提到[x].与Ａb。',
  )
})

test('batch replacement counts nonoverlapping occurrences and preserves supplementary Unicode characters literally', () => {
  const before = source()
  before.segments[0]!.text = 'aaaa𠮷𠮷'
  const next = replaceTranscriptText(before, 'aa', 'x', null)
  assert.equal(next.document.segments[0]!.text, 'xx𠮷𠮷')
  assert.equal(next.occurrences, 2)
  assert.equal(replaceTranscriptText(next.document, '𠮷', '吉', null).occurrences, 2)
  assert.equal(before.segments[0]!.text, 'aaaa𠮷𠮷')
})

test('replacement literals accept exactly one hundred Unicode code points including supplementary characters', () => {
  const before = many(1, '𠮷'.repeat(100)),
    replacement = '😀'.repeat(100),
    next = replaceTranscriptText(before, before.segments[0]!.text, replacement, null)
  assert.equal(next.occurrences, 1)
  assert.equal(next.document.segments[0]!.text, replacement)
  assert.equal(before.segments[0]!.text, '𠮷'.repeat(100))
  for (const [find, value] of [
    ['𠮷'.repeat(101), '甲'],
    ['甲', '😀'.repeat(101)],
    ['𠮷'.repeat(100) + '甲', '乙'],
    ['甲', '😀'.repeat(100) + '乙'],
  ])
    assert.throws(() => replaceTranscriptText(before, find!, value!, null), {
      code: 'INVALID_REQUEST',
    })
})

test('replacement rejects C0, DEL and unpaired surrogates in either literal without changing a document', () => {
  const before = many(1, '甲😀乙'),
    snapshot = JSON.stringify(before)
  for (const value of [
    ...Array.from({ length: 32 }, (_, point) => `甲${String.fromCharCode(point)}乙`),
    '甲\u007f乙',
    '甲\ud800乙',
    '甲\udfff乙',
    '\ud800😀',
    '😀\udfff',
  ])
    for (const [find, replacement] of [
      [value, '丙'],
      ['甲', value],
    ])
      assert.throws(() => replaceTranscriptText(before, find!, replacement!, null), {
        code: 'INVALID_REQUEST',
      })
  assert.equal(JSON.stringify(before), snapshot)
})

test('invalid replacement requests or sentence growth never publish partially changed documents', () => {
  const before = source(),
    snapshot = JSON.stringify(before)
  for (const [find, replacement] of [
    ['', '名'],
    ['名', ''],
    [' ', '名'],
    ['名', ' '],
    ['名', '名'],
    ['名'.repeat(101), '字'],
    ['名', '字'.repeat(101)],
  ])
    assert.throws(() => replaceTranscriptText(before, find!, replacement!, null), {
      code: 'INVALID_REQUEST',
    })
  assert.equal(JSON.stringify(before), snapshot)
  const hugeSentence = many(1, 'a'.repeat(9999) + '名')
  assert.throws(() => replaceTranscriptText(hugeSentence, '名', '李明', null), {
    code: 'INVALID_TRANSCRIPT',
  })
  const merge = many(2, 'a'.repeat(5000))
  assert.throws(
    () =>
      applyTranscriptEdit(
        merge,
        { kind: 'merge', firstId: 's0', secondId: 's1', separator: ' ' },
        null,
      ),
    { code: 'INVALID_TRANSCRIPT' },
  )
  assert.equal(merge.segments.length, 2)
})

test('batch replacement allows ten thousand changed sentences but rejects the next one before returning a preview', () => {
  const before = many(10000, '甲'),
    result = replaceTranscriptText(before, '甲', '乙', null)
  assert.equal(result.changes.length, 10000)
  assert.equal(result.occurrences, 10000)
  assert.equal(result.document.segments.at(-1)!.text, '乙')
  assert.throws(() => replaceTranscriptText(many(10001, '甲'), '甲', '乙', null), {
    code: 'INVALID_TRANSCRIPT',
  })
  assert.equal(before.segments.at(-1)!.text, '甲')
})

test('the batch changes JSON is bounded to two MiB measured in UTF-8, independently of the larger valid full document', () => {
  const below = replaceTranscriptText(many(100, 'a'.repeat(9000)), 'a', 'b', null)
  assert.ok(Buffer.byteLength(JSON.stringify(below.changes), 'utf8') < 2 * 1024 ** 2)
  assert.throws(() => replaceTranscriptText(many(120, 'a'.repeat(9000)), 'a', 'b', null), {
    code: 'INVALID_TRANSCRIPT',
  })
  const value = { text: '𠮷名\n"\\', before: '李明' }
  assert.equal(transcriptEditBytes(value), Buffer.byteLength(JSON.stringify(value), 'utf8'))
  assert.ok(transcriptEditBytes(value) > JSON.stringify(value).length)
  assert.throws(() => transcriptEditBytes(undefined), { code: 'INVALID_REQUEST' })
})

test('a valid document at the sixteen-MiB boundary accepts a no-op but rejects extra split metadata without changing coverage', () => {
  const before = many(1700, 'a')
  let extra = MAX_TRANSCRIPT_BYTES - Buffer.byteLength(JSON.stringify(before), 'utf8')
  for (const segment of before.segments) {
    const add = Math.min(extra, 9999)
    segment.text += 'a'.repeat(add)
    extra -= add
  }
  assert.equal(extra, 0)
  assert.equal(Buffer.byteLength(JSON.stringify(before), 'utf8'), MAX_TRANSCRIPT_BYTES)
  assert.deepEqual(
    applyTranscriptEdit(
      before,
      { kind: 'timing', ranges: [{ segmentId: 's0', startMs: 0, endMs: 9 }] },
      null,
    ),
    before,
  )
  assert.throws(
    () =>
      applyTranscriptEdit(
        before,
        { kind: 'split', segmentId: 's0', offset: 2, atMs: 5 },
        null,
        fresh(),
      ),
    { code: 'INVALID_TRANSCRIPT' },
  )
  assert.deepEqual(before.coverage, [{ startMs: 0, endMs: 17000 }])
  assert.equal(before.segments.length, 1700)
})

test('splitting a hundred-thousand-sentence document cannot exceed the existing sentence ceiling', () => {
  const before = many(MAX_SEGMENTS)
  assert.throws(
    () =>
      applyTranscriptEdit(
        before,
        { kind: 'split', segmentId: 's0', offset: 1, atMs: 5 },
        null,
        fresh(),
      ),
    { code: 'INVALID_TRANSCRIPT' },
  )
  assert.equal(before.segments.length, MAX_SEGMENTS)
})

test('standalone operation validation rejects missing IDs, forged extra fields and malformed source documents', () => {
  for (const operation of [
    { kind: 'text', segmentId: 'missing', text: '字' },
    { kind: 'split', segmentId: 'first', offset: 2, atMs: 1000, path: 'C:/secret' },
    { kind: 'merge', firstId: 'first', secondId: 'second', separator: '\n' },
    {
      kind: 'timing',
      ranges: [{ segmentId: 'first', startMs: 100, endMs: 1500, path: 'C:/secret' }],
    },
    { kind: 'unknown' },
  ])
    assert.throws(() => applyTranscriptEdit(source(), operation as TranscriptEditOperation, null))
  const malformed = source()
  malformed.segments[1]!.id = 'first'
  assert.throws(
    () =>
      applyTranscriptEdit(malformed, { kind: 'text', segmentId: 'first', text: '甲𠮷乙。' }, null),
    { code: 'INVALID_TRANSCRIPT' },
  )
})
