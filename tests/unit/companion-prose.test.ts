import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  companionProseBlocks,
  companionSentenceSpace,
} from '../../src/renderer/src/companion-prose'
import type { ReadingRow } from '../../src/shared/regions'
import type { TranscriptSegment } from '../../src/shared/transcript'

const sentence = (index: number, text: string, gap = 0): TranscriptSegment => ({
  id: `s${index}`,
  startMs: index * 1000 + gap,
  endMs: index * 1000 + gap + 800,
  text,
})
const rows = (count: number): ReadingRow[] =>
  Array.from({ length: count }, (_, index) => ({ type: 'sentence', index }))

test('booklike layout groups adjacent sentences without changing their source or order', () => {
  const source = [sentence(0, '山间起风。'), sentence(1, '故事继续。'), sentence(2, '明天出发。')]
  const snapshot = structuredClone(source)
  assert.deepEqual(companionProseBlocks(rows(3), source), [{ type: 'paragraph', rows: rows(3) }])
  assert.deepEqual(source, snapshot)
})

test('explicit line breaks, long pauses and folded regions delimit layout paragraphs', () => {
  const source = [
    sentence(0, '第一段。\n'),
    sentence(1, '第二段。'),
    sentence(2, '长停顿后。', 1800),
  ]
  const region: ReadingRow = {
    type: 'region',
    index: 1,
    lastIndex: 1,
    region: { startMs: 1000, endMs: 1800, kind: 'advertisement' },
  }
  assert.deepEqual(companionProseBlocks(rows(3), source), [
    { type: 'paragraph', rows: [{ type: 'sentence', index: 0 }] },
    { type: 'paragraph', rows: [{ type: 'sentence', index: 1 }] },
    { type: 'paragraph', rows: [{ type: 'sentence', index: 2 }] },
  ])
  assert.deepEqual(companionProseBlocks([rows(3)[0]!, region, rows(3)[2]!], source), [
    { type: 'paragraph', rows: [{ type: 'sentence', index: 0 }] },
    region,
    { type: 'paragraph', rows: [{ type: 'sentence', index: 2 }] },
  ])
})

test('a long run breaks after a complete sentence while preserving every index once', () => {
  const source = [sentence(0, '长句'.repeat(100)), sentence(1, '结束。'), sentence(2, '下一段。')]
  const blocks = companionProseBlocks(rows(3), source)
  assert.equal(blocks.length, 2)
  assert.deepEqual(
    blocks.flatMap((block) =>
      block.type === 'paragraph' ? block.rows.map((row) => row.index) : [],
    ),
    [0, 1, 2],
  )
})

test('layout spacing separates Latin sentence fragments and keeps Chinese text contiguous', () => {
  assert.equal(companionSentenceSpace('Hello.', 'Tomorrow'), ' ')
  assert.equal(companionSentenceSpace('a', 'book'), ' ')
  assert.equal(companionSentenceSpace('风停了。', '明天出发。'), '')
  assert.equal(companionSentenceSpace('already ', 'spaced'), '')
})
