import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOriginal } from '../../src/main/original/parse'
import { matchOriginal } from '../../src/main/original/match'
import type { TranscriptDocument } from '../../src/shared/transcript'

const left = '少年将那封蓝色的信件小心放进身后的背包。'
const right = '远处山谷里响起了铜钟的声音，所有人停下了脚步。'
const middle = '他缓缓地点了点头。'
const heardLeft = left.replace('蓝色', '兰色')
const heardRight = right.replace('铜钟', '铜中')
function run(
  texts: string[],
  originalText = `${left}\n${middle}\n${right}\n第2章\n${middle}`,
  gap = 0,
) {
  const original = parseOriginal(Buffer.from('第1章\n' + originalText), '小说.txt')
  const document: TranscriptDocument = {
    version: 1,
    kind: 'transcript',
    audioHash: 'a'.repeat(64),
    coverage: [{ startMs: 0, endMs: 30000 }],
    segments: texts.map((text, index) => ({
      id: `s${index}`,
      text,
      startMs: index * (2000 + gap),
      endMs: index * (2000 + gap) + 1800,
    })),
  }
  return matchOriginal(original, document)
}
test('two accepted neighbours disambiguate a short exact passage repeated in a different chapter', () => {
  const result = run([heardLeft, middle, heardRight])
  assert.equal(result[0]?.selected?.first, 0)
  assert.equal(result[2]?.selected?.first, 2)
  assert.equal(result[1]?.selected?.first, 1)
  assert.equal(result[1]?.candidates[0]?.basis, 'anchors')
  assert.equal(run([middle])[0]?.selected, null)
})
test('anchors do not bridge inserted speech, repeated local text, long gaps or conflicting order', () => {
  assert.equal(
    run([heardLeft, '现在插播一条广告，请点击下方链接购买商品。', heardRight])[1]?.selected,
    null,
  )
  assert.equal(
    run([heardLeft, middle, heardRight], `${left}\n${middle}\n${middle}\n${right}`)[1]?.selected,
    null,
  )
  assert.equal(run([heardLeft, middle, heardRight], undefined, 2000)[1]?.selected, null)
  assert.equal(run([heardRight, middle, heardLeft])[1]?.selected, null)
})
