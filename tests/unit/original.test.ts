import assert from 'node:assert/strict'
import { test } from 'node:test'
import { zip, epub } from '../fixtures/original-epub'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseOriginal, decodeOriginal } from '../../src/main/original/parse'
import { matchOriginal } from '../../src/main/original/match'
import { LibraryStore } from '../../src/main/database'
import { validateRequest } from '../../src/shared/validation'
import type { TranscriptDocument } from '../../src/shared/transcript'
import { normalizeOriginal } from '../../src/main/original/normalize'
import { findOriginal } from '../../src/main/original/search'

const source = `作品前言。\n第18章 起点\n这一章没有出现在声音当中。\n第19章 山路\n少年将整齐的衣服收进旅行用的布袋。\n他把旧地图折好，小心放进身后的背包。\n山谷中的钟声渐渐远去，路上只剩下清风和明月。\n第20章 清晨\n第二天清晨，他们沿着河岸走向远方的村庄。\n村口的大树下坐着一位沉默不语的老人。\n21、归程\n请记住这段重复出现但是无法唯一定位的文字。\n22、再会\n请记住这段重复出现但是无法唯一定位的文字。`
const hash = 'a'.repeat(64)
function document(texts: string[]): TranscriptDocument {
  return {
    version: 1,
    audioHash: hash,
    kind: 'transcript',
    coverage: [{ startMs: 0, endMs: 30_000 }],
    segments: texts.map((text, i) => ({
      id: `s${i}`,
      startMs: i * 3000 + 100,
      endMs: i * 3000 + 2100,
      text,
    })),
  }
}
test('TXT preserves versioned chapter/paragraph/sentence order across UTF and GB18030 encodings', () => {
  const parsed = parseOriginal(Buffer.from(source), '小说.txt')
  assert.deepEqual(
    parsed.chapters.map((chapter) => chapter.title),
    ['前言', '第18章 起点', '第19章 山路', '第20章 清晨', '21、归程', '22、再会'],
  )
  assert.equal(parsed.sentences[3]?.text, '他把旧地图折好，小心放进身后的背包。')
  assert.equal(parsed.sentences[3]?.chapter, 2)
  assert.equal(parsed.sentences[3]?.paragraph, 4)
  assert.equal(decodeOriginal(Buffer.from('d6d0cec4', 'hex')).text, '中文')
  assert.equal(
    decodeOriginal(
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('第一章 中文', 'utf16le')]),
    ).encoding,
    'utf-16le',
  )
  assert.throws(() => parseOriginal(Buffer.from([0]), 'bad.txt'), /控制字符/)
  assert.throws(() => parseOriginal(Buffer.from(''), 'empty.txt'), /非空/)
  assert.throws(() => parseOriginal(Buffer.from('正文'), 'bad.html'), /TXT/)
  const long = parseOriginal(Buffer.from('甲'.repeat(1401)), '长段.txt')
  assert.equal(long.sentences.map((sentence) => sentence.text).join('').length, 1401)
  assert.equal(long.sentences.length, 3)
  const notes = parseOriginal(
    Buffer.from(
      '第188章 回忆\n小说正文不能丢失。\n1、作者总结\n补充说明。\n189、继续\n下一章正文。',
    ),
    '附记.txt',
  )
  assert.deepEqual(
    notes.chapters.map((chapter) => chapter.title),
    ['第188章 回忆', '189、继续'],
  )
  assert.equal(
    notes.sentences.some((sentence) => sentence.text === '1、作者总结'),
    true,
  )
})

test('EPUB follows spine, reads only text and rejects corruption, paths, entities and encryption', () => {
  for (const method of [0, 8]) {
    const parsed = parseOriginal(zip(epub, method), '小说.epub')
    assert.deepEqual(
      parsed.sentences.map((sentence) => sentence.text),
      ['这是阅读顺序中的第一段正文。', '这是书中的第二段正文。'],
    )
    assert.deepEqual(
      parsed.chapters.map((chapter) => chapter.title),
      ['第1章 起点', '第2章 远方'],
    )
  }
  const corrupt = zip(epub)
  corrupt[35] = corrupt[35]! ^ 1
  assert.throws(() => parseOriginal(corrupt, 'bad.epub'), /EPUB/)
  assert.throws(() => parseOriginal(zip({ ...epub, '../escape': 'x' }), 'bad.epub'), /路径/)
  assert.throws(
    () => parseOriginal(zip({ ...epub, 'META-INF/encryption.xml': '<encryption/>' }), 'bad.epub'),
    /加密/,
  )
  assert.throws(
    () =>
      parseOriginal(
        zip({
          ...epub,
          'OPS/a.xhtml': '<!DOCTYPE html [<!ENTITY x "hello">]><html><body>&x;</body></html>',
        }),
        'bad.epub',
      ),
    /实体/,
  )
})

test('image-only EPUB cover sections are omitted while TXT and EPUB retain independent parser versions', () => {
  const covered = {
    ...epub,
    'OPS/book.opf': epub['OPS/book.opf']
      .replace(
        '<manifest>',
        '<manifest><item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>',
      )
      .replace('<spine>', '<spine><itemref idref="cover"/>'),
    'OPS/cover.xhtml':
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="cover.jpg" alt="封面"/></body></html>',
  }
  const parsed = parseOriginal(zip(covered), '含封面.epub')
  assert.equal(parsed.parserVersion, 3)
  assert.equal(parseOriginal(Buffer.from(source), '原文.txt').parserVersion, 2)
  assert.deepEqual(
    parsed.sentences.map((sentence) => sentence.text),
    ['这是阅读顺序中的第一段正文。', '这是书中的第二段正文。'],
  )
  assert.equal(parsed.chapters.length, 2)
  assert.ok(parsed.chapters.every((chapter) => chapter.count > 0))
  const onlyCover = {
    ...covered,
    'OPS/book.opf': covered['OPS/book.opf'].replace('<itemref idref="b"/><itemref idref="a"/>', ''),
  }
  assert.throws(() => parseOriginal(zip(onlyCover), '只有图片.epub'), /为空/)
})

test('Traditional Chinese retrieval preserves source spelling, ASR text and name-aware conversion', () => {
  const text = '醫生推了推鼻樑上的眼鏡，點頭答應明天繼續。'
  const original = parseOriginal(Buffer.from('第1章\n' + text), '繁體.txt')
  const input = document(['医生推了推鼻梁上的眼镜，点头答应明天继续。'])
  const matches = matchOriginal(original, input)
  assert.deepEqual(matches[0]?.selected, { first: 0, last: 0, method: 'auto' })
  assert.equal(matches[0]?.asrText, input.segments[0]?.text)
  assert.equal(original.sentences[0]?.text, text)
  assert.equal(matches[0]?.candidates[0]?.excerpt, text)
  assert.equal(normalizeOriginal('ＡQ 頭髮，乾隆年間。'), 'aq头发乾隆年间')
  assert.equal(findOriginal(original, 'version', '鼻梁上的眼镜', 0).results[0]?.first, 0)
  assert.equal(findOriginal(original, 'version', '鼻樑上的眼鏡', 0).results[0]?.excerpt, text)
})

test('script folding cannot turn two original passages into a falsely unique automatic mapping', () => {
  const original = parseOriginal(
    Buffer.from(
      '第1章\n他的頭髮被清風輕輕吹起，他決定明天繼續趕路。\n第2章\n他的头发被清风轻轻吹起，他决定明天继续赶路。',
    ),
    '兩處.txt',
  )
  const matches = matchOriginal(
    original,
    document(['他的头发被清风轻轻吹起，他决定明天继续赶路。']),
  )
  assert.equal(matches[0]?.selected, null)
  assert.equal(matches[0]?.candidates.filter((candidate) => candidate.score === 1).length, 2)
  assert.equal(findOriginal(original, 'version', '头发被清风', 0).total, 2)
})

test('retrieval maps episode 32 into chapter 19, crosses chapters, leaves insertions and repeats unmatched', () => {
  const parsed = parseOriginal(Buffer.from(source), '小说.txt')
  const result = matchOriginal(
    parsed,
    document([
      '他把旧地图折好，小心放进身后的背包。',
      '欢迎关注订阅本节目，下面插播一条完全无关的广告。',
      '山谷中的钟声渐渐远去，路上只剩下清风和明月。第二天清晨，他们沿着河岸走向远方的村庄。',
      '请记住这段重复出现但是无法唯一定位的文字。',
    ]),
  )
  assert.deepEqual(result[0]?.selected, { first: 3, last: 3, method: 'auto' })
  assert.equal(result[1]?.selected, null)
  assert.deepEqual(result[2]?.selected, { first: 4, last: 5, method: 'auto' })
  assert.equal(result[3]?.selected, null)
  assert.equal(result[3]?.candidates[0]?.score, 1)
  const secondEpisode = matchOriginal(parsed, document(['村口的大树下坐着一位沉默不语的老人。']))
  assert.deepEqual(secondEpisode[0]?.selected, { first: 6, last: 6, method: 'auto' })
  assert.equal(matchOriginal(parsed, document(['你好']))[0]?.selected, null)
})

test('neighboring short phrases require unique exact context; unrelated insertions cannot be bridged', () => {
  const parsed = parseOriginal(Buffer.from(source), '小说.txt')
  const joined = matchOriginal(parsed, document(['山谷中的钟声渐渐远去', '路上只剩下清风和明月']))
  assert.equal(joined[0]?.selected?.first, 4)
  assert.equal(joined[1]?.selected?.first, 4)
  assert.equal(joined[0]?.candidates[0]?.basis, 'context')
  const insertion = matchOriginal(
    parsed,
    document(['山谷中的钟声渐渐远去', '突然插入完全无关广告', '路上只剩下清风和明月']),
  )
  assert.equal(
    insertion.every((match) => match.selected === null),
    true,
  )
  const repeated = parseOriginal(
    Buffer.from(
      '第1章\n山谷中的钟声渐渐远去，路上只剩下清风和明月。\n第2章\n山谷中的钟声渐渐远去，路上只剩下清风和明月。',
    ),
    '重复.txt',
  )
  assert.equal(
    matchOriginal(repeated, document(['山谷中的钟声渐渐远去', '路上只剩下清风和明月'])).every(
      (match) => match.selected === null,
    ),
    true,
  )
})

test('exact duplicates outside the bounded retrieval shortlist stay ambiguous across sentence boundaries', () => {
  const query = '晨曦映照苍翠山谷少年背起行囊沿着石阶走向远处古老的城堡'
  const noise = Array.from({ length: query.length - 2 }, (_, i) => query.slice(i, i + 3))
    .reverse()
    .join('甲')
  const split = Array.from({ length: 4 }, (_, i) =>
    query.slice(Math.floor((i * query.length) / 4), Math.floor(((i + 1) * query.length) / 4)),
  )
  const original = parseOriginal(
    Buffer.from(
      '第1章\n' +
        query +
        '。\n' +
        Array.from({ length: 25 }, (_, i) => `第${i}处干扰${noise}。`).join('\n') +
        '\n第2章\n' +
        split.join('。') +
        '。',
    ),
    '重复.txt',
  )
  for (const texts of [[query], [query.slice(0, 16), query.slice(16)]]) {
    const result = matchOriginal(original, document(texts))
    assert.ok(result.every((match) => match.selected === null))
    assert.ok(result[0]!.candidates.some((candidate) => candidate.first === 0))
    assert.ok(result[0]!.candidates.some((candidate) => candidate.first >= 26))
  }
})

test('a unique exact passage split over four sentences is found beyond retrieval shortlist limits', () => {
  const query = '晨曦映照苍翠山谷少年背起行囊沿着石阶走向远处古老的城堡'
  const noise = Array.from({ length: query.length - 2 }, (_, i) => query.slice(i, i + 3))
    .reverse()
    .join('甲')
  const split = Array.from({ length: 4 }, (_, i) =>
    query.slice(Math.floor((i * query.length) / 4), Math.floor(((i + 1) * query.length) / 4)),
  )
  const original = parseOriginal(
    Buffer.from(
      '第1章\n' +
        Array.from({ length: 25 }, (_, i) => `第${i}处干扰${noise}。`).join('\n') +
        '\n第2章\n' +
        split.join('。') +
        '。',
    ),
    '唯一.txt',
  )
  const result = matchOriginal(original, document([query]))
  assert.deepEqual(result[0]?.selected, { first: 25, last: 28, method: 'auto' })
})

test('original versions and manual gaps/timing persist without overwriting transcripts; stale writes fail', () => {
  const file = join(mkdtempSync(join(tmpdir(), '听读原文 ')), 'library.sqlite3')
  let store = new LibraryStore(file)
  store.importBook({
    id: 'book',
    title: '音频书',
    sourcePath: 'D:/fixture',
    kind: 'folder',
    episodes: [
      {
        id: 'episode',
        path: 'D:/fixture/第32集.mp3',
        name: '第32集.mp3',
        sizeBytes: 10,
        modifiedAt: 1,
        contentHash: hash,
      },
    ],
  })
  const target = { episodeId: 'episode', audioHash: hash }
  const transcript = document(['他把旧地图折好，小心放进身后的背包。'])
  const saved = store.saveTranscript(target.episodeId, transcript)
  assert.equal(saved.status, 'ready')
  if (saved.status !== 'ready') return
  store.close()
  const v8 = new DatabaseSync(file)
  v8.exec(
    'DROP TABLE subtitle_import_commands; DROP TABLE subtitle_import_sources; DROP TABLE transcript_edit_commands; DROP TABLE transcript_edit_members; DROP TABLE transcript_edit_heads; DROP TABLE transcript_edit_groups; DROP TABLE offline_media_refs; DROP TABLE offline_plan_items; DROP TABLE offline_job_owners; DROP TABLE offline_plans; DROP TABLE processing_resources; ALTER TABLE transcription_jobs DROP COLUMN cpu_threads; DROP TABLE book_subtitle_settings; DROP TABLE reading_books; DROP TABLE original_alignments; DROP TABLE book_originals; DROP TABLE original_documents; PRAGMA user_version=8;',
  )
  v8.close()
  store = new LibraryStore(file)
  assert.deepEqual(store.getTranscript(target.episodeId, hash), saved)
  const parsed = parseOriginal(Buffer.from(source), '小说.txt'),
    initial = store.originals.import(target, parsed)
  const id = initial.info!.id
  assert.equal(store.originals.import(target, parsed).info?.id, id)
  store.originals.saveAlignment(
    target,
    id,
    saved.transcript.id,
    saved.transcript.revision,
    0,
    matchOriginal(parsed, transcript),
  )
  store.originals.correct({
    ...target,
    originalId: id,
    revision: 1,
    segmentId: 's0',
    selection: null,
    startMs: 200,
    endMs: 2200,
  })
  store.originals.saveAlignment(
    target,
    id,
    saved.transcript.id,
    saved.transcript.revision,
    2,
    matchOriginal(parsed, transcript),
  )
  assert.equal(store.originals.state(target).alignment?.matches[0]?.selected, null)
  assert.equal(store.originals.state(target).alignment?.matches[0]?.startMs, 200)
  assert.deepEqual(store.getTranscript(target.episodeId, hash), saved)
  assert.throws(
    () =>
      store.originals.correct({
        ...target,
        originalId: id,
        revision: 1,
        segmentId: 's0',
        selection: { first: 3, last: 3 },
        startMs: 200,
        endMs: 2200,
      }),
    /版本/,
  )
  const changed = store.originals.import(
    target,
    parseOriginal(Buffer.from(source + '\n不同版本补记。'), '新版.txt'),
  )
  assert.notEqual(changed.info?.id, id)
  assert.equal(changed.alignment, null)
  store.originals.import(target, parsed)
  store.close()
  store = new LibraryStore(file)
  assert.equal(store.originals.state(target).alignment?.revision, 3)
  assert.equal(store.originals.page(target, id, 3).sentences[0]?.ordinal, 3)
  assert.equal(store.originals.search(target, id, '旧地图')[0]?.first, 3)
  store.close()
  const previousMatcher = new DatabaseSync(file)
  const oldAlignment = JSON.parse(
    String(
      previousMatcher.prepare('SELECT alignment_json FROM original_alignments').get()!
        .alignment_json,
    ),
  )
  oldAlignment.matcherVersion = 1
  previousMatcher
    .prepare('UPDATE original_alignments SET alignment_json=?')
    .run(JSON.stringify(oldAlignment))
  previousMatcher.close()
  store = new LibraryStore(file)
  assert.equal(store.originals.state(target).stale, true)
  store.originals.saveAlignment(
    target,
    id,
    saved.transcript.id,
    saved.transcript.revision,
    3,
    matchOriginal(parsed, transcript),
  )
  assert.equal(store.originals.state(target).alignment?.matches[0]?.selected, null)
  assert.equal(store.originals.state(target).alignment?.matches[0]?.startMs, 200)
  store.saveTranscript(target.episodeId, transcript)
  assert.equal(store.originals.state(target).stale, true)
  assert.throws(
    () =>
      store.originals.correct({
        ...target,
        originalId: id,
        revision: 3,
        segmentId: 's0',
        selection: null,
        startMs: 200,
        endMs: 2200,
      }),
    /版本/,
  )
  store.close()
  const db = new DatabaseSync(file)
  assert.equal(db.prepare('SELECT count(*) AS n FROM original_documents').get()?.n, 2)
  db.close()
})

test('original IPC rejects paths, unknown keys, oversized queries and invalid synchronization ranges', () => {
  const target = { episodeId: '12345678-1234-4234-8234-123456789abc', audioHash: hash },
    id = target.episodeId
  for (const channel of ['original:state', 'original:import', 'original:match']) {
    validateRequest(channel, [target])
    assert.throws(() => validateRequest(channel, [{ ...target, path: 'C:/private.txt' }]))
  }
  validateRequest('original:page', [{ ...target, originalId: id, start: 60 }])
  assert.throws(() => validateRequest('original:page', [{ ...target, originalId: id, start: -1 }]))
  assert.throws(() =>
    validateRequest('original:search', [{ ...target, originalId: id, query: 'a'.repeat(101) }]),
  )
  assert.throws(() =>
    validateRequest('original:correct', [
      {
        ...target,
        originalId: id,
        revision: 1,
        segmentId: 's0',
        selection: { first: -1, last: 2 },
        startMs: 0,
        endMs: 10,
      },
    ]),
  )
})
