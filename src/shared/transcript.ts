import { AppError } from './validation'

export interface TimeRange {
  startMs: number
  endMs: number
}
export interface TranscriptSegment extends TimeRange {
  id: string
  text: string
}
export interface TranscriptDocument {
  version: 1
  audioHash: string
  kind: 'manual' | 'transcript' | 'original'
  coverage: TimeRange[]
  segments: TranscriptSegment[]
}
export interface StoredTranscript {
  id: string
  episodeId: string
  importedAt: string
  revision: number
  document: TranscriptDocument
}
export type TranscriptState =
  { status: 'missing' | 'stale' } | { status: 'ready'; transcript: StoredTranscript }
export interface TranscriptRequest {
  episodeId: string
  audioHash: string
}
export interface TranscriptVersion {
  id: string
  revision: number
}
export type TranscriptRead = TranscriptState | { status: 'unchanged'; version: TranscriptVersion }
export type TranscriptHeaderState =
  | { status: 'missing' | 'stale' }
  | {
      status: 'ready'
      transcript: Omit<StoredTranscript, 'document'> & { coverage: TimeRange[] }
    }
export const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024
export const MAX_SEGMENTS = 100000

export function isSmallTranscriptEdit(original: string, replacement: string): boolean {
  const a = Array.from(original),
    b = Array.from(replacement)
  const limit = Math.min(64, Math.max(2, Math.ceil(a.length * 0.2)))
  if (!replacement.trim() || Math.abs(a.length - b.length) > limit) return false
  let previous = new Map<number, number>()
  for (let j = 0; j <= Math.min(b.length, limit); j++) previous.set(j, j)
  for (let i = 1; i <= a.length; i++) {
    const current = new Map<number, number>()
    if (i <= limit) current.set(0, i)
    for (let j = Math.max(1, i - limit); j <= Math.min(b.length, i + limit); j++)
      current.set(
        j,
        Math.min(
          (previous.get(j) ?? Infinity) + 1,
          (current.get(j - 1) ?? Infinity) + 1,
          (previous.get(j - 1) ?? Infinity) + (a[i - 1] === b[j - 1] ? 0 : 1),
        ),
      )
    if (Math.min(...current.values()) > limit) return false
    previous = current
  }
  return (previous.get(b.length) ?? Infinity) <= limit
}

function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}
function range(value: unknown): value is TimeRange {
  const item = value as TimeRange | null
  return (
    !!item &&
    Number.isSafeInteger(item.startMs) &&
    Number.isSafeInteger(item.endMs) &&
    item.startMs >= 0 &&
    item.endMs > item.startMs &&
    item.endMs <= 3.6e10
  )
}
function invalid(message: string): never {
  throw new AppError('INVALID_TRANSCRIPT', message)
}

export function validateTranscript(
  value: unknown,
  audioHash: string,
  durationMs: number | null = null,
): TranscriptDocument {
  if (
    !record(value, ['version', 'audioHash', 'kind', 'coverage', 'segments']) ||
    value.version !== 1 ||
    typeof value.audioHash !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(value.audioHash) ||
    !['manual', 'transcript', 'original'].includes(String(value.kind))
  )
    invalid('文稿格式无效：需要 version: 1、audioHash、kind、coverage 和 segments。')
  if (value.audioHash.toLowerCase() !== audioHash)
    throw new AppError(
      'AUDIO_VERSION_MISMATCH',
      '文稿不属于当前音频版本，请检查 audioHash 或选择对应的音频。',
    )
  if (
    !Array.isArray(value.coverage) ||
    !value.coverage.length ||
    value.coverage.length > MAX_SEGMENTS ||
    !Array.isArray(value.segments) ||
    value.segments.length > MAX_SEGMENTS
  )
    invalid('文稿需要非空的覆盖区间；句子和覆盖区间各最多 100,000 条。')
  let lastEnd = 0
  const coverage: TimeRange[] = value.coverage.map((item: unknown) => {
    if (!record(item, ['startMs', 'endMs']) || !range(item) || item.startMs < lastEnd)
      invalid('覆盖区间必须按时间排列、互不重叠，并使用非负整数毫秒。')
    if (durationMs !== null && item.endMs > durationMs + 1)
      invalid('文稿覆盖区间超出当前音频时长，请校正时间戳。')
    lastEnd = item.endMs
    return { startMs: item.startMs, endMs: item.endMs }
  })
  const ids = new Set<string>()
  lastEnd = 0
  let coverageIndex = 0
  const segments = value.segments.map((item: unknown) => {
    if (
      !record(item, ['id', 'startMs', 'endMs', 'text']) ||
      !range(item) ||
      typeof item.id !== 'string' ||
      !item.id.trim() ||
      item.id.length > 128 ||
      ids.has(item.id) ||
      typeof item.text !== 'string' ||
      !item.text.trim() ||
      item.text.length > 10000 ||
      item.startMs < lastEnd
    )
      invalid('句子需要唯一 ID、非空文字和有序且不重叠的整数毫秒时间区间。单句最多 10,000 字符。')
    while (coverage[coverageIndex] && coverage[coverageIndex]!.endMs <= item.startMs)
      coverageIndex++
    const interval = coverage[coverageIndex]
    if (!interval || item.startMs < interval.startMs || item.endMs > interval.endMs)
      invalid('每一句必须完整位于一个已声明的覆盖区间内。')
    ids.add(item.id)
    lastEnd = item.endMs
    return { id: item.id, startMs: item.startMs, endMs: item.endMs, text: item.text }
  })
  return {
    version: 1,
    audioHash,
    kind: value.kind as TranscriptDocument['kind'],
    coverage,
    segments,
  }
}

function precedingIndex(ranges: TimeRange[], positionMs: number): number {
  let low = 0
  let high = ranges.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (ranges[middle]!.startMs <= positionMs) low = middle + 1
    else high = middle
  }
  return low - 1
}

export interface TranscriptPosition {
  status: 'sentence' | 'pause' | 'uncovered' | 'ended'
  index: number
  anchor: number
}
export function locateTranscript(
  document: TranscriptDocument,
  positionMs: number,
  durationMs: number,
): TranscriptPosition {
  const index = precedingIndex(document.segments, positionMs)
  const anchor = Math.max(0, index)
  if (durationMs > 0 && positionMs >= durationMs) return { status: 'ended', index: -1, anchor }
  const segment = document.segments[index]
  if (segment && positionMs < segment.endMs) return { status: 'sentence', index, anchor }
  const interval = document.coverage[precedingIndex(document.coverage, positionMs)]
  return {
    status: interval && positionMs < interval.endMs ? 'pause' : 'uncovered',
    index: -1,
    anchor,
  }
}
