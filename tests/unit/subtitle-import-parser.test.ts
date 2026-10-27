import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTimedSubtitles } from '../../src/main/subtitle-import-parser'
import { serializeSubtitles } from '../../src/main/subtitle-export'
import { locateTranscript, MAX_TRANSCRIPT_BYTES } from '../../src/shared/transcript'

const hash = 'ab'.repeat(32)
interface SourceCue {
  startMs: number
  endMs: number
  text: string
  id?: string
}
function time(ms: number, format: 'srt' | 'vtt' = 'vtt') {
  const hours = Math.floor(ms / 3600000),
    minutes = Math.floor(ms / 60000) % 60,
    seconds = Math.floor(ms / 1000) % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${format === 'srt' ? ',' : '.'}${String(ms % 1000).padStart(3, '0')}`
}
function file(cues: SourceCue[], format: 'srt' | 'vtt' = 'vtt') {
  return (
    (format === 'vtt' ? 'WEBVTT\n\n' : '') +
    cues
      .map(
        (cue, index) =>
          `${cue.id ?? (format === 'srt' ? String(index + 1) : `cue-${index}`)}\n${time(cue.startMs, format)} --> ${time(cue.endMs, format)}\n${cue.text}`,
      )
      .join('\n\n')
  )
}
function parsed(cues: SourceCue[], format: 'srt' | 'vtt' = 'vtt') {
  return parseTimedSubtitles(file(cues, format), format, hash, null)
}
function rows(result: ReturnType<typeof parseTimedSubtitles>) {
  return result.document.segments.map(({ startMs, endMs, text }) => ({ startMs, endMs, text }))
}
function warning(result: ReturnType<typeof parseTimedSubtitles>, code: string) {
  return result.metadata.warnings.find((value) => value.code === code)
}
function rejects(text: string, format: 'srt' | 'vtt' = 'vtt') {
  assert.throws(() => parseTimedSubtitles(text, format, hash, null), { code: 'INVALID_TRANSCRIPT' })
}

test('standard SRT keeps multiline Chinese, numeric payload, exact timestamps and fresh independent IDs with every common line ending', () => {
  const cues = [
    { startMs: 10, endMs: 1000, text: '  第一行\n2026\n第二行  ' },
    { startMs: 1500, endMs: 3000, text: '甲-->乙' },
  ]
  const ids = new Set<string>()
  for (const ending of ['\n', '\r\n', '\r']) {
    const result = parseTimedSubtitles(
      file(cues, 'srt').replaceAll('\n', ending),
      'srt',
      hash,
      3000,
    )
    assert.deepEqual(rows(result), cues)
    assert.deepEqual(result.document.coverage, [
      { startMs: 10, endMs: 1000 },
      { startMs: 1500, endMs: 3000 },
    ])
    assert.equal(result.document.kind, 'transcript')
    assert.equal(result.document.audioHash, hash)
    assert.equal(result.metadata.multilineCues, 1)
    assert.equal(result.metadata.cueCount, 2)
    for (const segment of result.document.segments) {
      assert.match(segment.id, /^[a-f\d-]{36}$/)
      assert.equal(ids.has(segment.id), false)
      ids.add(segment.id)
    }
  }
})

test('SRT missing, duplicate, skipped and textual source indices remain labels rather than colliding internal identities', () => {
  const text =
      '00:00:00,001 --> 00:00:00,010\n甲\n\n3\n00:00:00,010 --> 00:00:00,100\n乙\n\n3\n00:00:00,100 --> 00:00:01,000\n丙\n\nchapter-four\n00:00:01,000 --> 00:00:02,000\n丁',
    result = parseTimedSubtitles(text, 'srt', hash, null)
  assert.equal(result.metadata.cueCount, 4)
  assert.deepEqual(
    result.document.segments.map((value) => value.text),
    ['甲', '乙', '丙', '丁'],
  )
  assert.equal(new Set(result.document.segments.map((value) => value.id)).size, 4)
  assert.equal(warning(result, 'srt-index-missing')?.count, 1)
  assert.equal(warning(result, 'srt-index-nonstandard')?.count, 2)
})

test('SRT decimal-point compatibility and stable time ordering preserve the original millisecond values and report normalization', () => {
  const result = parseTimedSubtitles(
    '1\n00:00:00.100 --> 00:00:01.000\n后\n\n2\n00:00:00.001 --> 00:00:00.010\n先',
    'srt',
    hash,
    null,
  )
  assert.deepEqual(rows(result), [
    { startMs: 1, endMs: 10, text: '先' },
    { startMs: 100, endMs: 1000, text: '后' },
  ])
  assert.equal(warning(result, 'srt-dot-timestamp')?.count, 2)
  assert.equal(warning(result, 'srt-order-normalized')?.count, 1)
})

test('WebVTT signature, BOM, header metadata, optional identifiers, short times and long hours parse without leaking labels into text', () => {
  const result = parseTimedSubtitles(
    '\uFEFFWEBVTT 中文字幕\nLanguage: zh\n\n字幕一\n00:01.010\t-->\t00:02.100\n甲\n\n00:02.100 --> 00:03.000\n乙\n\n字幕一\n100:00:00.000 --> 100:00:01.000\n丙',
    'vtt',
    hash.toUpperCase(),
    null,
  )
  assert.deepEqual(rows(result), [
    { startMs: 1010, endMs: 2100, text: '甲' },
    { startMs: 2100, endMs: 3000, text: '乙' },
    { startMs: 360000000, endMs: 360001000, text: '丙' },
  ])
  assert.equal(result.document.audioHash, hash)
  assert.equal(warning(result, 'duplicate-cue-id')?.count, 1)
  assert.equal(warning(result, 'header-metadata-ignored')?.count, 1)
})

test('NOTE, STYLE, REGION and all ordinary cue settings are recognized but cannot become text, CSS, resources or false cues', () => {
  const result = parseTimedSubtitles(
    'WEBVTT\n\nNOTE fake timing\n00:00.000 --> 00:40.000\nignored\n\nSTYLE\n::cue { background: url(https://invalid.example/payload); }\n\nREGION\nid:dialog\nwidth:50%\nlines:3\n\n00:01.000 --> 00:02.000 vertical:rl line:-1,start position:20%,line-left size:80% align:left region:dialog\n真正正文\n\nNOTE after cue\n另一个注释',
    'vtt',
    hash,
    2000,
  )
  assert.deepEqual(rows(result), [{ startMs: 1000, endMs: 2000, text: '真正正文' }])
  assert.equal(result.metadata.notes, 2)
  assert.equal(result.metadata.styles, 1)
  assert.equal(result.metadata.regions, 1)
  assert.equal(result.metadata.settingsCues, 1)
  assert.equal(warning(result, 'notes-ignored')?.firstLine, 3)
  assert.equal(
    result.metadata.documentBytes,
    Buffer.byteLength(JSON.stringify(result.document), 'utf8'),
  )
})

test('common cue markup, omitted voice end, ruby readings and SRT font/br retain all plain text without HTML interpretation', () => {
  const result = parsed([
    {
      startMs: 0,
      endMs: 3000,
      text: '<v 张三><lang zh><c.green><b>甲</b><i>乙</i><u>丙</u></c></lang>\n<ruby>汉<rt>hàn</rt>字<rt>zì</ruby>',
    },
  ])
  assert.equal(result.document.segments[0]!.text, '甲乙丙\n汉（hàn）字（zì）')
  assert.equal(result.metadata.markupCues, 1)
  assert.equal(warning(result, 'ruby-annotation-expanded')?.count, 2)
  assert.equal(
    parsed(
      [{ startMs: 0, endMs: 1000, text: '<FONT color="red" onclick="ignored">甲<BR/>乙</FONT>' }],
      'srt',
    ).document.segments[0]!.text,
    '甲\n乙',
  )
})

test('inline WebVTT timestamps are checked against raw cue times and removed without making up word-level timing even after an offset', () => {
  const input = file([{ startMs: 1000, endMs: 3000, text: '甲<00:01.500>乙<00:02.000>丙' }]),
    result = parseTimedSubtitles(input, 'vtt', hash, 5000, 2000)
  assert.deepEqual(rows(result), [{ startMs: 3000, endMs: 5000, text: '甲乙丙' }])
  assert.equal(result.metadata.inlineTimestamps, 2)
  assert.equal(warning(result, 'inline-timestamps-removed')?.count, 2)
  for (const text of ['甲<00:01.000>乙', '甲<00:03.000>乙', '甲<00:02.000>乙<00:01.500>丙'])
    rejects(file([{ startMs: 1000, endMs: 3000, text }]))
})

test('the full named entity table, two-scalar references, numeric supplementary characters and escaped tags decode exactly once', () => {
  const result = parsed([
    {
      startMs: 0,
      endMs: 1000,
      text: '&CounterClockwiseContourIntegral; &NotEqualTilde; &Afr; &#128512; &#x20BB7; &#128; &lt;b&gt;正文&lt;/b&gt; &amp;lt; &nbsp;',
    },
  ])
  assert.equal(result.document.segments[0]!.text, '∳ ≂̸ 𝔄 😀 𠮷 € <b>正文</b> &lt; \u00a0')
  assert.equal(result.metadata.markupCues, 0)
})

test('unknown and unterminated entities or markup stay literal and warnings remain aggregated instead of deleting content', () => {
  const body =
      Array.from({ length: 50 }, () => '&missing; &amp <script onload="x">正文</script>').join(
        ' ',
      ) + ' <未闭合',
    result = parsed([{ startMs: 0, endMs: 1000, text: body }])
  assert.equal(result.document.segments[0]!.text, body)
  assert.equal(warning(result, 'unknown-entity-literal')?.count, 100)
  assert.ok(warning(result, 'unsupported-markup-literal'))
  assert.ok(result.metadata.warnings.length <= 32)
  assert.equal(result.document.segments[0]!.text.includes('onload="x"'), true)
})

test('overlap flattening retains every original active cue at exact boundaries, including duplicates and embedded newlines', () => {
  const cues = [
      { startMs: 0, endMs: 2000, text: '甲\n甲续' },
      { startMs: 1000, endMs: 3000, text: '乙' },
      { startMs: 1000, endMs: 1500, text: '乙' },
      { startMs: 3000, endMs: 3001, text: '一毫秒' },
      { startMs: 4000, endMs: 5000, text: '末句' },
    ],
    result = parsed(cues)
  assert.deepEqual(rows(result), [
    { startMs: 0, endMs: 1000, text: '甲\n甲续' },
    { startMs: 1000, endMs: 1500, text: '甲\n甲续\n乙\n乙' },
    { startMs: 1500, endMs: 2000, text: '甲\n甲续\n乙' },
    { startMs: 2000, endMs: 3000, text: '乙' },
    { startMs: 3000, endMs: 3001, text: '一毫秒' },
    { startMs: 4000, endMs: 5000, text: '末句' },
  ])
  assert.equal(result.metadata.overlappingCues, 3)
  assert.equal(result.metadata.overlapSegments, 2)
  assert.deepEqual(result.document.coverage, [
    { startMs: 0, endMs: 3001 },
    { startMs: 4000, endMs: 5000 },
  ])
  assert.equal(locateTranscript(result.document, 3001, 5000).status, 'uncovered')
  assert.equal(locateTranscript(result.document, 3000, 5000).index, 4)
})

test('an independent active-cue oracle matches nested and crossing intervals without deduplication or retiming', () => {
  const cues = Array.from({ length: 40 }, (_, index) => ({
      startMs: index * 7,
      endMs: index * 7 + 10 + (index % 9) * 5,
      text: `第${index % 3}行`,
    })),
    result = parsed(cues)
  for (let position = 0; position < 400; position++) {
    const expected = cues
        .filter((cue) => cue.startMs <= position && position < cue.endMs)
        .map((cue) => cue.text)
        .join('\n'),
      matches = result.document.segments.filter(
        (segment) => segment.startMs <= position && position < segment.endMs,
      )
    assert.ok(matches.length <= 1)
    assert.equal(matches[0]?.text ?? '', expected, `media clock ${position}ms`)
  }
  assert.ok(
    result.document.segments.every((segment) =>
      cues.some((cue) => cue.startMs === segment.startMs || cue.endMs === segment.startMs),
    ),
  )
})

test('time offsets use exact integer milliseconds and reject negative or oversized results rather than clipping', () => {
  const input = file([{ startMs: 1000, endMs: 2000, text: '正文' }])
  assert.deepEqual(rows(parseTimedSubtitles(input, 'vtt', hash, 2000, -1000)), [
    { startMs: 0, endMs: 1000, text: '正文' },
  ])
  assert.deepEqual(rows(parseTimedSubtitles(input, 'vtt', hash, 3000, 1000)), [
    { startMs: 2000, endMs: 3000, text: '正文' },
  ])
  for (const offset of [-1001, 1002, 0.5, NaN, Infinity, 3.6e10 + 1])
    assert.throws(() => parseTimedSubtitles(input, 'vtt', hash, 3000, offset), {
      code: 'INVALID_TRANSCRIPT',
    })
})

test('fractional media duration keeps the existing one-millisecond tolerance without rounding timestamps or widening it', () => {
  const input = file([{ startMs: 0, endMs: 2781, text: '正文' }])
  assert.equal(parseTimedSubtitles(input, 'vtt', hash, 2780.25).document.segments[0]!.endMs, 2781)
  assert.throws(() => parseTimedSubtitles(input, 'vtt', hash, 2779.999), {
    code: 'INVALID_TRANSCRIPT',
  })
})

test('empty source cues are counted and retained by provenance but cannot fabricate a sentence, gap coverage or an empty replacement document', () => {
  const result = parsed([
    { startMs: 0, endMs: 1000, text: '<i></i>' },
    { startMs: 2000, endMs: 3000, text: '正文' },
  ])
  assert.equal(result.metadata.cueCount, 2)
  assert.equal(result.metadata.outputSegments, 1)
  assert.equal(warning(result, 'empty-cue')?.count, 1)
  assert.deepEqual(result.document.coverage, [{ startMs: 2000, endMs: 3000 }])
  rejects('WEBVTT\n\nNOTE no actual text')
  rejects(file([{ startMs: 0, endMs: 1000, text: '<i></i>' }]))
})

test('strict timestamp and block validation rejects the entire file rather than skipping a bad trailing cue', () => {
  const valid = file([{ startMs: 0, endMs: 1000, text: '之前正文' }])
  for (const timing of [
    '00:60.000 --> 00:61.000',
    '00:00.000 --> 00:00.000',
    '00:01.000 --> 00:00.000',
    '-00:01.000 --> 00:02.000',
    '00:00.01 --> 00:02.000',
    '00:00.0000 --> 00:02.000',
    '00:00,000 --> 00:02,000',
    '0x01 --> Infinity',
    '00:00.000 --> 00:02.000 junk',
    '00:00.000 --> 00:02.000 size:101%',
    '00:00.000 --> 00:02.000 align:left align:right',
    '00:00.000 --> 00:02.000 position:50%,invalid',
    '999999999999999999999:00:00.000 --> 999999999999999999999:00:01.000',
  ])
    rejects(`${valid}\n\n${timing}\n不能部分写入`)
  rejects(`${valid}\n00:02.000 --> 00:03.000\n缺少空行`)
  rejects('WEBVTT\n00:00.000 --> 00:01.000\n缺少文件头分隔')
  rejects(`\n${valid}`)
  rejects(`${valid}\n\nSTYLE\n::cue { color:red }`)
  rejects(
    file([
      { startMs: 1000, endMs: 2000, text: '先' },
      { startMs: 0, endMs: 1000, text: '后' },
    ]),
  )
  rejects(
    'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000\n\n00:00.000 --> 00:01.000\n不能假设本地时间',
  )
  rejects('WEBVTT\nKind: metadata\n\n00:00.000 --> 00:01.000\n{}')
})

test('controls, unpaired surrogates and invalid numeric entities fail safely while valid supplementary text remains intact', () => {
  for (const text of [
    '甲\0乙',
    '甲\u0001乙',
    '甲\u007f乙',
    '甲\ud800乙',
    '甲\udfff乙',
    '&#0;',
    '&#xD800;',
    '&#x110000;',
    '&#1;',
    '&#127;',
  ])
    rejects(file([{ startMs: 0, endMs: 1000, text }]))
  assert.equal(
    parsed([{ startMs: 0, endMs: 1000, text: '𠮷😀\uFFFD\t正文' }]).document.segments[0]!.text,
    '𠮷😀\uFFFD\t正文',
  )
  rejects(file([{ startMs: 0, endMs: 1000, text: '<b>'.repeat(1025) + '深度' }]))
})

test('invalid source and decoded characters report their actual source line after multiline text and tags', () => {
  for (const ending of ['\n', '\r\n', '\r']) {
    for (const bad of ['\u0001', '\ud800']) {
      const input =
        `WEBVTT\n\n00:00.000 --> 00:01.000\n第一行\n<b>第二行</b>\n第三行${bad}`.replaceAll(
          '\n',
          ending,
        )
      assert.throws(() => parseTimedSubtitles(input, 'vtt', hash, null), /第 6 行/)
    }
  }
  for (const bad of ['&#1;', '&#127;', '&#xD800;', '&#x110000;'])
    assert.throws(
      () =>
        parseTimedSubtitles(
          `WEBVTT\n\n00:00.000 --> 00:01.000\n第一行\n<b>第二行</b>\n第三行${bad}`,
          'vtt',
          hash,
          null,
        ),
      /第 6 行/,
    )
})

test('out-of-order SRT retains source-order simultaneous text across all nested and touching media boundaries', () => {
  const cues = Array.from({ length: 90 }, (_, index) => ({
      startMs: ((index * 23) % 90) * 7,
      endMs: ((index * 23) % 90) * 7 + 1 + (index % 11) * 9,
      text: `来源${index % 7}\n第${index}段`,
    })),
    result = parsed(cues, 'srt'),
    boundaries = [...new Set(cues.flatMap((cue) => [cue.startMs, cue.endMs]))].sort((a, b) => a - b)
  for (const position of [
    ...boundaries,
    ...boundaries.slice(1).map((end, index) => (boundaries[index]! + end) / 2),
  ]) {
    const expected = cues
        .filter((cue) => cue.startMs <= position && position < cue.endMs)
        .map((cue) => cue.text)
        .join('\n'),
      located = locateTranscript(result.document, position, 1000)
    assert.equal(
      located.status === 'sentence' ? result.document.segments[located.index]!.text : '',
      expected,
      `original media ${position}ms`,
    )
  }
  assert.ok(warning(result, 'srt-order-normalized'))
  assert.ok(result.document.segments.every((segment) => boundaries.includes(segment.startMs)))
  assert.ok(result.document.segments.every((segment) => boundaries.includes(segment.endMs)))
})

test('ordinary flat subtitle exports round trip exact source text and original times without recursively interpreting escaped markup', () => {
  const cues = [
    { startMs: 1, endMs: 1000, text: '甲 & 乙 <b>正文</b> 😀𠮷 &amp;lt;' },
    { startMs: 1200, endMs: 3000, text: 'A --> B &CounterClockwiseContourIntegral;' },
  ]
  for (const format of ['srt', 'vtt'] as const) {
    const exported = serializeSubtitles(cues, format),
      result = parseTimedSubtitles(exported, format, hash, 3000)
    assert.deepEqual(rows(result), cues)
    assert.deepEqual(result.document.coverage, [
      { startMs: 1, endMs: 1000 },
      { startMs: 1200, endMs: 3000 },
    ])
    assert.equal(result.metadata.markupCues, 0)
  }
})

test('the per-segment bound is ten thousand UTF-16 units including joined overlaps, with no cue truncation', () => {
  assert.equal(
    parsed([{ startMs: 0, endMs: 1000, text: '😀'.repeat(5000) }]).document.segments[0]!.text
      .length,
    10000,
  )
  rejects(file([{ startMs: 0, endMs: 1000, text: '😀'.repeat(5001) }]))
  rejects(
    file([
      { startMs: 0, endMs: 2000, text: '甲'.repeat(5000) },
      { startMs: 1000, endMs: 3000, text: '乙'.repeat(5000) },
    ]),
  )
})

test('one hundred thousand ordinary cues remain supported while the next source cue or overlap-expanded output is rejected', () => {
  const cues = Array.from({ length: 100000 }, (_, index) => ({
      startMs: index * 2,
      endMs: index * 2 + 2,
      text: 'a',
    })),
    result = parsed(cues)
  assert.equal(result.document.segments.length, 100000)
  assert.equal(result.metadata.cueCount, 100000)
  assert.equal(result.document.coverage.length, 1)
  assert.equal(new Set(result.document.segments.map((segment) => segment.id)).size, 100000)
  rejects(file([...cues, { startMs: 200000, endMs: 200001, text: '最后' }]))
  rejects(
    file(
      Array.from({ length: 65000 }, (_, index) => ({
        startMs: index * 2,
        endMs: index * 2 + 3,
        text: 'a',
      })),
    ),
  )
})

test('canonical UTF-8 JSON accepts exactly sixteen MiB and rejects the next byte even when the source file is smaller', () => {
  const cues = Array.from({ length: 2000 }, (_, index) => ({
      startMs: index * 2,
      endMs: index * 2 + 2,
      text: 'a',
    })),
    initial = parsed(cues)
  let remaining = MAX_TRANSCRIPT_BYTES - initial.metadata.documentBytes
  for (const cue of cues) {
    const add = Math.min(remaining, 9999)
    cue.text += 'a'.repeat(add)
    remaining -= add
  }
  assert.equal(remaining, 0)
  const source = file(cues),
    result = parseTimedSubtitles(source, 'vtt', hash, null)
  assert.ok(Buffer.byteLength(source, 'utf8') < MAX_TRANSCRIPT_BYTES)
  assert.equal(result.metadata.documentBytes, MAX_TRANSCRIPT_BYTES)
  cues.at(-1)!.text += 'a'
  rejects(file(cues))
  assert.throws(
    () => parseTimedSubtitles('a'.repeat(MAX_TRANSCRIPT_BYTES + 1), 'srt', hash, null),
    { code: 'INVALID_TRANSCRIPT' },
  )
})
