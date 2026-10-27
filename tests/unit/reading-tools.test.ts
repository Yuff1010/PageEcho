import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseOriginal } from '../../src/main/original/parse'
import { findOriginal } from '../../src/main/original/search'
import { LibraryStore } from '../../src/main/database'
import {
  serializeSubtitles,
  subtitleSnapshot,
  writeSubtitleFile,
} from '../../src/main/subtitle-export'
import { validateRequest } from '../../src/shared/validation'
import type { SubtitleExportRequest } from '../../src/shared/subtitles'

test('whole-original search normalizes typography, spans sentences in a paragraph, and keeps boundaries', () => {
  const original = parseOriginal(
    Buffer.from(
      '第1章 起点\nＡlpha，山谷。清风月光。\n甲乙甲乙甲乙。\n山谷。\n清风。\n第2章 后续\n清风月光。',
    ),
    '全文.txt',
  )
  assert.deepEqual(
    findOriginal(original, 'version', 'alpha 山谷清风', 0).results.map((r) => [r.first, r.last]),
    [[0, 1]],
  )
  assert.equal(findOriginal(original, 'version', '山谷清风', 0).total, 1)
  assert.equal(findOriginal(original, 'version', '甲乙', 0).total, 1)
  assert.equal(findOriginal(original, 'version', '不存在', 0).total, 0)
  assert.throws(() => findOriginal(original, 'version', '……', 0), /请输入/)
  assert.throws(() => findOriginal(original, 'version', '山谷', -1), /页码/)
})

test('whole-original search paginates past the old thirty-result limit and reaches the last page', () => {
  const original = parseOriginal(
    Buffer.from(
      '第1章\n' + Array.from({ length: 137 }, (_, i) => `这是第${i}处寻找的原文。`).join('\n'),
    ),
    '全文.txt',
  )
  const first = findOriginal(original, 'version', '寻找', 0),
    last = findOriginal(original, 'version', '寻找', 120)
  assert.equal(first.total, 137)
  assert.equal(first.results.length, 20)
  assert.equal(first.results[0]?.first, 0)
  assert.equal(last.results.length, 17)
  assert.equal(last.results.at(-1)?.first, 136)
  assert.equal(findOriginal(original, 'version', '寻找', 140).results.length, 0)
})

test('SRT and WebVTT keep exact original millisecond coordinates, gaps and literal text', () => {
  const cues = [
    { startMs: 1_234, endMs: 2_345, text: '中文 <b> & 一行\n\n下一行' },
    { startMs: 7_200_007, endMs: 7_203_009, text: '两小时之后。' },
  ]
  assert.equal(
    serializeSubtitles(cues, 'srt'),
    '1\n00:00:01,234 --> 00:00:02,345\n中文 &lt;b&gt; &amp; 一行 下一行\n\n2\n02:00:00,007 --> 02:00:03,009\n两小时之后。\n\n',
  )
  assert.equal(
    serializeSubtitles(cues, 'vtt'),
    'WEBVTT\n\n1\n00:00:01.234 --> 00:00:02.345\n中文 &lt;b&gt; &amp; 一行 下一行\n\n2\n02:00:00.007 --> 02:00:03.009\n两小时之后。\n\n',
  )
  assert.throws(() => serializeSubtitles([], 'srt'), /没有/)
  assert.throws(
    () => serializeSubtitles([{ startMs: 0, endMs: 1.5, text: 'x' }], 'srt'),
    /整数|毫秒/,
  )
  assert.throws(() => serializeSubtitles([cues[1]!, cues[0]!], 'vtt'), /顺序/)
  assert.throws(() => serializeSubtitles([{ startMs: 0, endMs: 1, text: '\u0000' }], 'srt'), /文字/)
})

test('subtitle snapshots bind exact versions, honor manual gaps/timing and leave saved transcripts intact', () => {
  const root = mkdtempSync(join(tmpdir(), '听读导出 ')),
    store = new LibraryStore(join(root, 'db.sqlite3'))
  const hash = 'a'.repeat(64)
  try {
    store.importBook({
      id: 'book',
      title: '测试书',
      sourcePath: root,
      kind: 'folder',
      episodes: [
        {
          id: 'episode',
          path: join(root, '第32集.wav'),
          name: '第32集.wav',
          sizeBytes: 10,
          modifiedAt: 1,
          contentHash: hash,
        },
      ],
    })
    const document = {
      version: 1 as const,
      kind: 'transcript' as const,
      audioHash: hash,
      coverage: [{ startMs: 0, endMs: 10_000 }],
      segments: [
        { id: 's1', startMs: 100, endMs: 1000, text: '模型识别文字。' },
        { id: 's2', startMs: 2000, endMs: 3000, text: '插入的广告。' },
      ],
    }
    const saved = store.saveTranscript('episode', document)
    if (saved.status !== 'ready') throw new Error('Transcript not saved')
    const target = { episodeId: 'episode', audioHash: hash }
    const source = {
      ...target,
      transcriptId: saved.transcript.id,
      transcriptRevision: saved.transcript.revision,
    }
    const request: SubtitleExportRequest = { ...source, source: 'transcript', format: 'srt' }
    const plain = subtitleSnapshot(store, request)
    assert.equal(plain.cueCount, 2)
    const original = store.originals.import(
      target,
      parseOriginal(Buffer.from('第19章\n出版原文的完整句子。'), '原文.txt'),
    )
    store.originals.saveAlignment(
      target,
      original.info!.id,
      source.transcriptId,
      source.transcriptRevision,
      0,
      document.segments.map((s) => ({
        ...s,
        segmentId: s.id,
        asrText: s.text,
        candidates: [],
        selected: null,
        reviewed: false,
      })),
    )
    store.originals.correct({
      ...target,
      originalId: original.info!.id,
      revision: 1,
      segmentId: 's1',
      selection: { first: 0, last: 0 },
      startMs: 250,
      endMs: 1200,
    })
    const mappedRequest: SubtitleExportRequest = {
      ...source,
      source: 'original',
      format: 'vtt',
      originalId: original.info!.id,
      alignmentRevision: 2,
    }
    const mapped = subtitleSnapshot(store, mappedRequest)
    assert.equal(mapped.cueCount, 1)
    assert.equal(mapped.skippedSegments, 1)
    assert.match(mapped.contents, /00:00:00\.250 --> 00:00:01\.200\n出版原文的完整句子。/)
    assert.doesNotMatch(mapped.contents, /广告|模型识别/)
    assert.deepEqual(store.getTranscript('episode', hash), saved)
    assert.throws(() => subtitleSnapshot(store, { ...mappedRequest, alignmentRevision: 1 }), /版本/)
    store.saveTranscript('episode', document)
    assert.throws(() => subtitleSnapshot(store, request), /版本/)
    assert.throws(() => subtitleSnapshot(store, mappedRequest), /版本/)
    assert.throws(
      () => subtitleSnapshot(store, { ...request, audioHash: 'b'.repeat(64) }),
      /音频版本/,
    )
  } finally {
    store.close()
  }
})

test('subtitle writes replace only the selected file; failed replacement preserves its directory and removes temporary files', async () => {
  const root = mkdtempSync(join(tmpdir(), '听读字幕 空格 ')),
    path = join(root, '第32集.srt')
  writeFileSync(path, '已有字幕')
  await writeSubtitleFile(path, '新字幕\n')
  assert.equal(readFileSync(path, 'utf8'), '新字幕\n')
  const directory = join(root, '目录.srt')
  mkdirSync(directory)
  writeFileSync(join(directory, '保留.txt'), '原始内容')
  await assert.rejects(writeSubtitleFile(directory, '不能保存'), /未保存/)
  assert.equal(readFileSync(join(directory, '保留.txt'), 'utf8'), '原始内容')
  assert.deepEqual(readdirSync(root).sort(), ['第32集.srt', '目录.srt'].sort())
})

test('search and export IPC reject paths, extra arguments, wrong source versions and arbitrary formats', () => {
  const id = '12345678-1234-4234-8234-123456789abc',
    target = { episodeId: id, audioHash: 'a'.repeat(64) }
  const search = { ...target, originalId: id, query: '山谷', offset: 20 }
  validateRequest('original:find', [search])
  for (const invalid of [
    { ...search, path: 'C:/private.txt' },
    { ...search, offset: -1 },
    { ...search, offset: 0.5 },
    { ...search, query: 'x'.repeat(101) },
  ])
    assert.throws(() => validateRequest('original:find', [invalid]))
  const request: SubtitleExportRequest = {
    ...target,
    source: 'transcript',
    transcriptId: id,
    transcriptRevision: 1,
    format: 'srt',
  }
  validateRequest('transcript:export-subtitles', [request])
  validateRequest('transcript:export-subtitles', [
    { ...request, source: 'original', originalId: id, alignmentRevision: 1 },
  ])
  for (const invalid of [
    { ...request, path: 'C:/private.srt' },
    { ...request, format: 'html' },
    { ...request, transcriptRevision: 0 },
    { ...request, source: 'original' },
    { ...request, originalId: id },
  ])
    assert.throws(() => validateRequest('transcript:export-subtitles', [invalid]))
  assert.throws(() => validateRequest('transcript:export-subtitles', [request, 'C:/private.srt']))
})
