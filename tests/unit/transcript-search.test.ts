import test from 'node:test'
import assert from 'node:assert/strict'
import { TranscriptSearchIndex } from '../../src/shared/transcript-search'
import type { TranscriptSegment } from '../../src/shared/transcript'

const segment = (id: number, text: string): TranscriptSegment => ({
  id: `s${id}`,
  text,
  startMs: id * 100,
  endMs: id * 100 + 80,
})

test('transcript search spans adjacent segments, ignores punctuation and preserves original ranges/times', () => {
  const source = [
    segment(0, '前言。ＡＢＣ，山'),
    segment(1, '！？'),
    segment(2, '路的故事。'),
    segment(3, '山路，山路。'),
  ]
  const before = JSON.stringify(source)
  const index = new TranscriptSearchIndex(source)
  const page = index.find('ａｂｃ 山路', 0)
  assert.equal(page.total, 1)
  assert.deepEqual(page.results[0], {
    first: 0,
    last: 2,
    startMs: 0,
    endMs: 280,
    excerpt: '前言。ＡＢＣ，山！？路的故事。',
  })
  assert.deepEqual(
    index.find('山路', 0).results.map(({ first, last }) => [first, last]),
    [
      [0, 2],
      [3, 3],
    ],
  )
  assert.equal(JSON.stringify(source), before)
})

test('transcript search paginates the whole 100,000-segment snapshot and resets its query cache', () => {
  const source = Array.from({ length: 100000 }, (_, i) => segment(i, `寻找第${i}句。`))
  const index = new TranscriptSearchIndex(source)
  assert.equal(index.find('寻找', 0).total, 100000)
  const last = index.find('寻找', 99980)
  assert.equal(last.results.length, 20)
  assert.equal(last.results.at(-1)!.first, 99999)
  assert.equal(index.find('寻找第99999句', 0).total, 1)
  assert.equal(index.find('不存在的文字', 0).total, 0)
  assert.equal(index.find('寻找', 100000).results.length, 0)
})

test('transcript search handles overlapping occurrences, Unicode and invalid requests without stale results', () => {
  const index = new TranscriptSearchIndex([
    segment(0, 'aaaa'),
    segment(1, 'a𠮷'),
    segment(2, '野家。'),
  ])
  assert.deepEqual(
    index.find('aaa', 0).results.map(({ first, last }) => [first, last]),
    [
      [0, 0],
      [0, 1],
    ],
  )
  assert.equal(index.find('𠮷野', 0).results[0]!.last, 2)
  for (const query of ['', '山', '！？', 'a'.repeat(101)]) assert.throws(() => index.find(query, 0))
  for (const offset of [-1, 1.5, Infinity, 200001]) assert.throws(() => index.find('aaaa', offset))
  assert.equal(new TranscriptSearchIndex([]).find('没有', 0).total, 0)
  assert.equal(new TranscriptSearchIndex([segment(0, '！？')]).find('没有', 0).total, 0)
})
