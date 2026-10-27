import { randomUUID } from 'node:crypto'
// @ts-expect-error -- The existing pinned xmldom 0.8.15 exposes its complete HTML entity data without deep-import declarations.
import { HTML_ENTITIES } from '@xmldom/xmldom/lib/entities.js'
import {
  MAX_SEGMENTS,
  MAX_TRANSCRIPT_BYTES,
  validateTranscript,
  type TranscriptDocument,
} from '../shared/transcript'
import type { TimedSubtitleMetadata, TimedSubtitleWarning } from '../shared/subtitle-import'
import { AppError } from '../shared/validation'

const entities = HTML_ENTITIES as Readonly<Record<string, string>>
const MAX_TIME = 3.6e10
interface Cue {
  ordinal: number
  line: number
  startMs: number
  endMs: number
  text: string
}
interface Block {
  text: string
  line: number
}
function invalid(line: number, message: string): never {
  throw new AppError('INVALID_TRANSCRIPT', `第 ${line} 行：${message}`)
}
function safeText(text: string, line: number): void {
  for (const character of text) {
    const point = character.codePointAt(0)!
    if ((point < 32 && ![9, 10, 13].includes(point)) || point === 127)
      invalid(line, '字幕含有不支持的控制字符。')
    if (point >= 0xd800 && point <= 0xdfff) invalid(line, '字幕含有不完整的 Unicode 字符。')
    if (point === 10) line++
  }
}

// Iterate offsets rather than split the entire file: millions of blank lines
// must not create millions of retained strings/array slots.
function* blocks(source: string): Generator<Block> {
  let position = 0,
    line = 1,
    begin = -1,
    firstLine = 1,
    end = 0
  while (position <= source.length) {
    const newline = source.indexOf('\n', position),
      next = newline < 0 ? source.length : newline,
      value = source.slice(position, next)
    if (/^[ \t]*$/.test(value)) {
      if (begin >= 0) {
        yield { text: source.slice(begin, end), line: firstLine }
        begin = -1
      }
    } else {
      if (begin < 0) {
        begin = position
        firstLine = line
      }
      end = next
    }
    if (newline < 0) break
    position = newline + 1
    line++
  }
  if (begin >= 0) yield { text: source.slice(begin, end), line: firstLine }
}
function firstLine(text: string): [string, string] {
  const end = text.indexOf('\n')
  return end < 0 ? [text, ''] : [text.slice(0, end), text.slice(end + 1)]
}
function timestamp(value: string, format: 'srt' | 'vtt', line: number): number {
  const match =
    format === 'srt'
      ? /^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})$/.exec(value)
      : /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(value)
  if (!match) invalid(line, '时间戳格式无效；请使用合法的分秒及三位毫秒。')
  const result =
    Number(match[1] ?? 0) * 3_600_000 +
    Number(match[2]) * 60_000 +
    Number(match[3]) * 1000 +
    Number(match[4])
  if (!Number.isSafeInteger(result) || result > MAX_TIME)
    invalid(line, '时间戳超过支持的媒体时间范围。')
  return result
}
function percentage(value: string): boolean {
  return /^\d+(?:\.\d+)?%$/.test(value) && Number(value.slice(0, -1)) <= 100
}
function settings(text: string, format: 'srt' | 'vtt', line: number): void {
  const keys = new Set<string>()
  for (const token of text.split(/[ \t]+/)) {
    const colon = token.indexOf(':'),
      name = token.slice(0, colon),
      value = token.slice(colon + 1)
    if (colon <= 0 || !value || keys.has(name)) invalid(line, '字幕位置设置格式无效或重复。')
    keys.add(name)
    let valid: boolean
    if (format === 'srt') valid = /^(?:X1|X2|Y1|Y2)$/.test(name) && /^\d+$/.test(value)
    else {
      const [base, alignment, extra] = value.split(',')
      switch (name) {
        case 'vertical':
          valid = /^(rl|lr)$/.test(value)
          break
        case 'line':
          valid =
            (base === 'auto' || /^-?\d+$/.test(base!) || percentage(base!)) &&
            (alignment === undefined || /^(start|center|end)$/.test(alignment)) &&
            extra === undefined
          break
        case 'position':
          valid =
            percentage(base!) &&
            (alignment === undefined || /^(line-left|center|line-right)$/.test(alignment)) &&
            extra === undefined
          break
        case 'size':
          valid = percentage(value)
          break
        case 'align':
          valid = /^(start|center|end|left|right)$/.test(value)
          break
        case 'region':
          valid = !value.includes('-->')
          break
        default:
          // Future settings remain source data. They never control our DOM/CSS.
          valid = /^[a-zA-Z][\w-]*$/.test(name) && !value.includes('-->')
      }
    }
    if (!valid) invalid(line, '字幕位置设置的值无效。')
  }
}

/** Parse external timed text into our non-overlapping formal document model.
 * Original bytes/encoding/provenance are retained by the importing service.
 */
export function parseTimedSubtitles(
  text: string,
  format: 'srt' | 'vtt',
  audioHash: string,
  durationMs: number | null,
  offsetMs = 0,
): { document: TranscriptDocument; metadata: TimedSubtitleMetadata } {
  if (
    typeof text !== 'string' ||
    !text.length ||
    text.length > MAX_TRANSCRIPT_BYTES ||
    !['srt', 'vtt'].includes(format) ||
    typeof audioHash !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(audioHash) ||
    !Number.isSafeInteger(offsetMs) ||
    Math.abs(offsetMs) > MAX_TIME ||
    (durationMs !== null &&
      (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_TIME))
  )
    throw new AppError('INVALID_TRANSCRIPT', '字幕文本、媒体身份、时长或时间偏移无效或超限。')
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'),
    metadata: TimedSubtitleMetadata = {
      format,
      cueCount: 0,
      outputSegments: 0,
      overlappingCues: 0,
      overlapSegments: 0,
      multilineCues: 0,
      markupCues: 0,
      inlineTimestamps: 0,
      notes: 0,
      styles: 0,
      regions: 0,
      settingsCues: 0,
      documentBytes: 0,
      warnings: [],
    },
    warnings = new Map<string, TimedSubtitleWarning>()
  safeText(source, 1)
  if (format === 'vtt' && !source.startsWith('WEBVTT')) invalid(1, 'WebVTT 签名必须位于文件开头。')
  function warn(code: string, line: number, count = 1) {
    const previous = warnings.get(code)
    if (previous) previous.count += count
    else if (warnings.size < 32) warnings.set(code, { code, count, firstLine: line })
  }
  function decode(value: string, line: number): string {
    let position = 0
    const result = value.replace(
      /&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][\da-zA-Z]*);?/g,
      (raw, offset: number) => {
        while (position < offset) if (value[position++] === '\n') line++
        if (!raw.endsWith(';')) {
          warn('unknown-entity-literal', line)
          return raw
        }
        if (raw[1] !== '#') {
          const name = raw.slice(1, -1)
          if (Object.hasOwn(entities, name)) return entities[name]!
          warn('unknown-entity-literal', line)
          return raw
        }
        const hex = raw[2]?.toLowerCase() === 'x',
          point = Number.parseInt(raw.slice(hex ? 3 : 2, -1), hex ? 16 : 10)
        if (
          !Number.isSafeInteger(point) ||
          point < 1 ||
          point > 0x10ffff ||
          (point >= 0xd800 && point <= 0xdfff) ||
          (point < 32 && ![9, 10, 13].includes(point)) ||
          point === 127
        )
          invalid(line, '数字实体不是合法的 Unicode 字符。')
        // HTML's legacy numeric references use Windows-1252 in this range.
        const remapped: Record<number, number> = {
          128: 8364,
          130: 8218,
          131: 402,
          132: 8222,
          133: 8230,
          134: 8224,
          135: 8225,
          136: 710,
          137: 8240,
          138: 352,
          139: 8249,
          140: 338,
          142: 381,
          145: 8216,
          146: 8217,
          147: 8220,
          148: 8221,
          149: 8226,
          150: 8211,
          151: 8212,
          152: 732,
          153: 8482,
          154: 353,
          155: 8250,
          156: 339,
          158: 382,
          159: 376,
        }
        return String.fromCodePoint(remapped[point] ?? point)
      },
    )
    return result
  }
  function payload(raw: string, start: number, end: number, line: number): string {
    let result = '',
      position = 0,
      counted = 0,
      markup = false,
      lastTimestamp = start
    const currentLine = (offset: number) => {
      while (counted < offset) if (raw[counted++] === '\n') line++
      return line
    }
    const stack: string[] = []
    const append = (value: string) => {
      if (result.length + value.length > 10000) invalid(line, '转换后单条字幕超过 10,000 字符。')
      result += value
    }
    while (position < raw.length) {
      const open = raw.indexOf('<', position)
      if (open < 0) {
        append(decode(raw.slice(position), currentLine(position)))
        break
      }
      append(decode(raw.slice(position, open), currentLine(position)))
      currentLine(open)
      const close = raw.indexOf('>', open + 1)
      if (close < 0) {
        append(decode(raw.slice(open), line))
        warn('unsupported-markup-literal', line)
        break
      }
      const literal = raw.slice(open, close + 1),
        tag = raw.slice(open + 1, close)
      position = close + 1
      if (/^\d/.test(tag)) {
        const time = timestamp(tag, 'vtt', line)
        if (time <= lastTimestamp || time >= end) invalid(line, '句内时间戳必须在 cue 内严格递增。')
        lastTimestamp = time
        metadata.inlineTimestamps++
        warn('inline-timestamps-removed', line)
        markup = true
        continue
      }
      const token = /^(\/)?([a-zA-Z]+)(?:\.[^\s<>]+)?(?:[ \t]+([^<>]*))?(\/)?$/.exec(tag),
        name = format === 'srt' ? token?.[2]?.toLowerCase() : token?.[2]
      if (
        !token ||
        !name ||
        !['b', 'i', 'u', 'c', 'v', 'lang', 'ruby', 'rt', 'font', 'br'].includes(name)
      ) {
        append(literal)
        warn('unsupported-markup-literal', line)
        continue
      }
      const closing = !!token[1],
        annotation = token[3]
      if (annotation) decode(annotation, line) // Validate entities without executing attributes.
      if (name === 'br' && !closing) append('\n')
      else if (closing) {
        const index = stack.lastIndexOf(name)
        if (index < 0) {
          append(literal)
          warn('unsupported-markup-literal', line)
          continue
        }
        for (const removed of stack.splice(index)) if (removed === 'rt') append('）')
      } else {
        if (stack.length >= 1024) invalid(line, '字幕标签嵌套过深。')
        if (name === 'rt') {
          if (!stack.includes('ruby')) invalid(line, 'ruby 读音标签缺少基字容器。')
          if (stack.at(-1) === 'rt') {
            stack.pop()
            append('）')
          }
          append('（')
          warn('ruby-annotation-expanded', line)
        }
        stack.push(name)
      }
      markup = true
    }
    for (const name of stack) if (name === 'rt') append('）')
    if (markup) {
      metadata.markupCues++
      warn('markup-removed', line)
    }
    if (result.includes('\n')) {
      metadata.multilineCues++
      warn('multiline', line)
    }
    return result
  }
  const cues: Cue[] = [],
    sourceIds = new Set<string>()
  let header = false,
    seenCue = false,
    lastStart = -1,
    expectedIndex = 1
  for (const block of blocks(source)) {
    let [line, rest] = firstLine(block.text),
      timingLine = block.line,
      sourceId: string | undefined
    if (format === 'vtt' && !header) {
      if (!/^WEBVTT(?:[ \t].*)?$/.test(line) || line.includes('-->'))
        invalid(block.line, 'WebVTT 文件需要 WEBVTT 签名及分隔空行。')
      if (rest.includes('-->')) invalid(block.line, 'WEBVTT 文件头与字幕之间缺少空行。')
      if (/^X-TIMESTAMP-MAP[=:]/m.test(rest))
        invalid(block.line, '不支持外部 PTS 时间轴；请先转换为当前音频的本地时间。')
      if (/^Kind:[ \t]*(?:metadata|chapters)\b/im.test(rest))
        invalid(block.line, '此 WebVTT 声明为非字幕轨道，不能当作伴读字幕导入。')
      if (rest) warn('header-metadata-ignored', block.line)
      header = true
      continue
    }
    if (format === 'vtt' && /^NOTE(?:[ \t]|$)/.test(line)) {
      metadata.notes++
      warn('notes-ignored', block.line)
      continue
    }
    if (format === 'vtt' && /^(STYLE|REGION)[ \t]*$/.test(line)) {
      if (seenCue) invalid(block.line, 'STYLE/REGION 布局块必须位于第一个字幕 cue 之前。')
      if (!rest || rest.includes('-->')) invalid(block.line, '布局块为空或包含字幕时间箭头。')
      if (line.trim() === 'STYLE') {
        metadata.styles++
        warn('styles-ignored', block.line)
      } else {
        metadata.regions++
        warn('regions-ignored', block.line)
      }
      continue
    }
    if (/^X-TIMESTAMP-MAP[=:]/.test(line))
      invalid(block.line, '不支持外部 PTS 时间轴；请先转换字幕时间。')
    if (!line.includes('-->')) {
      sourceId = line
      ;[line, rest] = firstLine(rest)
      timingLine++
      if (!line.includes('-->')) invalid(timingLine, '字幕块缺少合法的起止时间行。')
      if (format === 'srt') {
        if (!/^\d+$/.test(sourceId) || Number(sourceId) !== expectedIndex)
          warn('srt-index-nonstandard', block.line)
      } else if (sourceIds.has(sourceId)) warn('duplicate-cue-id', block.line)
      sourceIds.add(sourceId)
    } else if (format === 'srt') warn('srt-index-missing', block.line)
    const match =
      format === 'vtt'
        ? /^(\S+)[ \t]+-->[ \t]+(\S+)(?:[ \t]+(.+?))?[ \t]*$/.exec(line)
        : /^(\S+?)[ \t]*-->[ \t]*(\S+?)(?:[ \t]+(.+?))?[ \t]*$/.exec(line)
    if (!match) invalid(timingLine, '字幕时间行格式无效。')
    const rawStart = timestamp(match[1]!, format, timingLine),
      rawEnd = timestamp(match[2]!, format, timingLine),
      startMs = rawStart + offsetMs,
      endMs = rawEnd + offsetMs
    if (rawEnd <= rawStart) invalid(timingLine, '字幕结束时间必须大于开始时间。')
    if (startMs < 0 || endMs > MAX_TIME || (durationMs !== null && endMs > durationMs + 1))
      invalid(timingLine, '偏移后的字幕时间为负数或超出当前媒体时长。')
    if (rawStart < lastStart) {
      if (format === 'vtt') invalid(timingLine, 'WebVTT cue 必须按开始时间排列。')
      warn('srt-order-normalized', timingLine)
    }
    lastStart = rawStart
    if (format === 'srt' && (match[1]!.includes('.') || match[2]!.includes('.')))
      warn('srt-dot-timestamp', timingLine)
    if (match[3]) {
      settings(match[3], format, timingLine)
      metadata.settingsCues++
      warn('settings-ignored', timingLine)
    }
    if (format === 'vtt' && rest.includes('-->'))
      invalid(timingLine + 1, 'WebVTT 正文包含未转义时间箭头或缺少 cue 分隔空行。')
    if (/^(?:\d{2,}:)?\d{2}:\d{2}[,.]\d{3}[ \t]*-->[ \t]*\S+/m.test(rest))
      invalid(timingLine + 1, '字幕块之间缺少空行，未跳过后续时间行。')
    if (++metadata.cueCount > MAX_SEGMENTS) invalid(timingLine, '源字幕最多 100,000 个 cue。')
    const plain = payload(rest, rawStart, rawEnd, timingLine + 1)
    if (plain.trim())
      cues.push({ ordinal: metadata.cueCount - 1, line: timingLine, startMs, endMs, text: plain })
    else warn('empty-cue', timingLine)
    expectedIndex++
    seenCue = true
  }
  if (!cues.length) invalid(1, '文件没有可导入的字幕正文。')
  const document: TranscriptDocument = {
      version: 1,
      audioHash: audioHash.toLowerCase(),
      kind: 'transcript',
      coverage: [],
      segments: [],
    },
    events = cues
      .flatMap((cue) => [
        { time: cue.startMs, start: true, cue },
        { time: cue.endMs, start: false, cue },
      ])
      .sort(
        (a, b) =>
          a.time - b.time || Number(a.start) - Number(b.start) || a.cue.ordinal - b.cue.ordinal,
      ),
    active = new Map<number, Cue>(),
    overlaps = new Set<number>()
  let activeLength = 0,
    bytes = Buffer.byteLength(JSON.stringify(document), 'utf8')
  for (let index = 0; index < events.length;) {
    const time = events[index]!.time
    while (events[index]?.time === time) {
      const event = events[index++]!
      if (event.start) {
        if (active.size) {
          const previous = active.values().next().value!
          overlaps.add(previous.ordinal)
          overlaps.add(event.cue.ordinal)
        }
        active.set(event.cue.ordinal, event.cue)
        activeLength += event.cue.text.length
      } else {
        active.delete(event.cue.ordinal)
        activeLength -= event.cue.text.length
      }
    }
    const endMs = events[index]?.time
    if (endMs === undefined || !active.size) continue
    if (activeLength + active.size - 1 > 10000)
      invalid(active.values().next().value!.line, '重叠字幕合并显示后超过单句 10,000 字符。')
    if (document.segments.length >= MAX_SEGMENTS)
      invalid(1, '重叠转换后的字幕超过 100,000 段，未截断源字幕。')
    const selected = [...active.values()].sort((a, b) => a.ordinal - b.ordinal),
      segment = {
        id: randomUUID(),
        startMs: time,
        endMs,
        text: selected.map((cue) => cue.text).join('\n'),
      }
    bytes += Buffer.byteLength(JSON.stringify(segment), 'utf8') + (document.segments.length ? 1 : 0)
    if (bytes > MAX_TRANSCRIPT_BYTES) invalid(selected[0]!.line, '转换后的完整字幕超过 16 MiB。')
    document.segments.push(segment)
    const range = document.coverage.at(-1)
    if (range?.endMs === time) range.endMs = endMs
    else document.coverage.push({ startMs: time, endMs })
    if (selected.length > 1) metadata.overlapSegments++
  }
  metadata.overlappingCues = overlaps.size
  if (overlaps.size)
    warn('overlap-flattened', cues.find((cue) => overlaps.has(cue.ordinal))!.line, overlaps.size)
  metadata.outputSegments = document.segments.length
  metadata.documentBytes = Buffer.byteLength(JSON.stringify(document), 'utf8')
  if (metadata.documentBytes > MAX_TRANSCRIPT_BYTES) invalid(1, '转换后的完整字幕超过 16 MiB。')
  metadata.warnings = [...warnings.values()]
  return { document: validateTranscript(document, document.audioHash, durationMs), metadata }
}
