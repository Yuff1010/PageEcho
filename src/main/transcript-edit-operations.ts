import { randomUUID } from 'node:crypto'
import {
  isSmallTranscriptEdit,
  MAX_TRANSCRIPT_BYTES,
  validateTranscript,
  type TranscriptDocument,
} from '../shared/transcript'
import {
  isTranscriptReplacementLiteral,
  MAX_EDIT_DELTA_BYTES,
  MAX_REPLACEMENT_SEGMENTS,
  MAX_RETIMED_SEGMENTS,
  type TranscriptEditOperation,
} from '../shared/transcript-editing'
import { AppError, isId } from '../shared/validation'

export interface TranscriptTextChange {
  segmentId: string
  before: string
  after: string
  occurrences: number
}
export interface TranscriptTextReplacement {
  document: TranscriptDocument
  changes: TranscriptTextChange[]
  occurrences: number
}

function invalid(message: string): never {
  throw new AppError('INVALID_TRANSCRIPT', message)
}

/** The caller must still bound the complete persisted history/group envelope. */
export function transcriptEditBytes(value: unknown): number {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new AppError('INVALID_REQUEST', '编辑记录不是有效的 JSON。')
  return Buffer.byteLength(encoded, 'utf8')
}

function checked(document: TranscriptDocument, durationMs: number | null): TranscriptDocument {
  if (
    durationMs !== null &&
    (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 3.6e10)
  )
    throw new AppError('INVALID_REQUEST', '音频时长无效，请重新打开这一集。')
  if (typeof document?.audioHash !== 'string') invalid('文稿缺少有效的音频版本。')
  const value = validateTranscript(document, document.audioHash.toLowerCase(), durationMs)
  // Count independently serialized entries so an oversized in-memory document
  // cannot force one giant JSON allocation before its size is rejected.
  let bytes = transcriptEditBytes({ ...value, coverage: [], segments: [] })
  for (const entries of [value.coverage, value.segments])
    for (const [index, entry] of entries.entries()) {
      bytes += transcriptEditBytes(entry) + (index > 0 ? 1 : 0)
      if (bytes > MAX_TRANSCRIPT_BYTES) invalid('编辑后的整集文稿超过 16 MiB，请缩小编辑范围。')
    }
  return value
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

function indexOf(document: TranscriptDocument, id: unknown): number {
  if (typeof id !== 'string' || !id.trim() || id.length > 128)
    throw new AppError('INVALID_REQUEST', '请选择有效的字幕句子。')
  const index = document.segments.findIndex((segment) => segment.id === id)
  if (index < 0) throw new AppError('CONFLICT', '所选句子已变化，请刷新后重新选择。')
  return index
}

/** Pure formal-document edit. Coverage and unaffected sentence identities stay fixed. */
export function applyTranscriptEdit(
  document: TranscriptDocument,
  operation: TranscriptEditOperation,
  durationMs: number | null,
  newId: () => string = () => randomUUID(),
): TranscriptDocument {
  const value = checked(document, durationMs)
  if (!operation || typeof operation !== 'object')
    throw new AppError('INVALID_REQUEST', '字幕编辑操作无效。')
  const ids = new Set(value.segments.map((segment) => segment.id.toLowerCase()))
  const fresh = () => {
    const id = newId()
    if (!isId(id) || ids.has(id.toLowerCase())) invalid('新字幕句子 ID 无效或重复，请重试。')
    ids.add(id.toLowerCase())
    return id
  }
  const malformed = () => {
    throw new AppError('INVALID_REQUEST', '字幕编辑操作参数无效。')
  }
  switch (operation.kind) {
    case 'text': {
      if (!exact(operation, ['kind', 'segmentId', 'text']) || typeof operation.text !== 'string')
        return malformed()
      const index = indexOf(value, operation.segmentId),
        segment = value.segments[index]!,
        text = operation.text.trim()
      if (!isSmallTranscriptEdit(segment.text, text))
        invalid('单句纠错只支持小范围文字修改；大幅改写请拆句或使用批量替换后重新对齐。')
      value.segments[index] = { ...segment, text }
      break
    }
    case 'split': {
      if (!exact(operation, ['kind', 'segmentId', 'offset', 'atMs'])) return malformed()
      const index = indexOf(value, operation.segmentId),
        segment = value.segments[index]!,
        characters = Array.from(segment.text)
      if (
        !Number.isSafeInteger(operation.offset) ||
        operation.offset <= 0 ||
        operation.offset >= characters.length ||
        !Number.isSafeInteger(operation.atMs) ||
        operation.atMs <= segment.startMs ||
        operation.atMs >= segment.endMs
      )
        invalid('拆句需要位于句子内部的文字位置和整数毫秒时间。')
      const left = characters.slice(0, operation.offset).join(''),
        right = characters.slice(operation.offset).join('')
      if (!left.trim() || !right.trim()) invalid('拆句后的两句都需要非空文字。')
      value.segments.splice(
        index,
        1,
        { ...segment, id: fresh(), endMs: operation.atMs, text: left },
        { ...segment, id: fresh(), startMs: operation.atMs, text: right },
      )
      break
    }
    case 'merge': {
      if (
        !exact(operation, ['kind', 'firstId', 'secondId', 'separator']) ||
        !['', ' '].includes(operation.separator)
      )
        return malformed()
      const first = indexOf(value, operation.firstId),
        second = indexOf(value, operation.secondId)
      if (second !== first + 1) invalid('只能按原顺序合并相邻的两句。')
      const left = value.segments[first]!,
        right = value.segments[second]!
      if (
        !value.coverage.some((range) => range.startMs <= left.startMs && range.endMs >= right.endMs)
      )
        invalid('合句必须完整位于同一个现有覆盖区间，不能跨越未覆盖区域或拼接覆盖区间。')
      value.segments.splice(first, 2, {
        id: fresh(),
        startMs: left.startMs,
        endMs: right.endMs,
        text: left.text + operation.separator + right.text,
      })
      break
    }
    case 'timing': {
      if (
        !exact(operation, ['kind', 'ranges']) ||
        !Array.isArray(operation.ranges) ||
        operation.ranges.length < 1 ||
        operation.ranges.length > MAX_RETIMED_SEGMENTS
      )
        return malformed()
      const changed = new Set<string>()
      for (const range of operation.ranges) {
        if (!exact(range, ['segmentId', 'startMs', 'endMs'])) return malformed()
        const index = indexOf(value, range.segmentId)
        if (changed.has(range.segmentId)) invalid('同一次时间校正不能重复指定同一句。')
        changed.add(range.segmentId)
        value.segments[index] = {
          ...value.segments[index]!,
          startMs: range.startMs,
          endMs: range.endMs,
        }
      }
      break
    }
    default:
      return malformed()
  }
  return checked(value, durationMs)
}

/** Literal, non-overlapping replacement within each sentence; no regex or normalization. */
export function replaceTranscriptText(
  document: TranscriptDocument,
  find: string,
  replacement: string,
  durationMs: number | null,
): TranscriptTextReplacement {
  if (
    !isTranscriptReplacementLiteral(find) ||
    !isTranscriptReplacementLiteral(replacement) ||
    find === replacement
  )
    throw new AppError('INVALID_REQUEST', '查找与替换分别需要 1–100 个字符，且内容不能相同或为空。')
  const value = checked(document, durationMs),
    changes: TranscriptTextChange[] = []
  let occurrences = 0,
    deltaBytes = 2 // The changes array's surrounding brackets.
  value.segments = value.segments.map((segment) => {
    const parts = segment.text.split(find),
      count = parts.length - 1
    if (!count) return segment
    const after = parts.join(replacement),
      change = { segmentId: segment.id, before: segment.text, after, occurrences: count }
    if (after.length > 10000 || !after.trim())
      invalid('替换后单句必须包含文字且不超过 10,000 字符。')
    deltaBytes += transcriptEditBytes(change) + (changes.length ? 1 : 0)
    if (changes.length >= MAX_REPLACEMENT_SEGMENTS || deltaBytes > MAX_EDIT_DELTA_BYTES)
      invalid('批量替换最多影响 10,000 句，且修改记录不能超过 2 MiB；请缩小范围。')
    changes.push(change)
    occurrences += count
    return { ...segment, text: after }
  })
  return { document: checked(value, durationMs), changes, occurrences }
}
