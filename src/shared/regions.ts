import type { TimeRange, TranscriptRequest, TranscriptSegment } from './transcript'
import { AppError } from './validation'

export const REGION_LABELS = { advertisement: '广告', intro: '片头', recap: '前情回顾' } as const
export type RegionKind = keyof typeof REGION_LABELS
export interface TranscriptRegion extends TimeRange {
  kind: RegionKind
}
export interface TranscriptRegions {
  revision: number
  regions: TranscriptRegion[]
}
export interface RegionUpdate extends TranscriptRequest, TimeRange {
  revision: number
  kind: RegionKind | null
  previous?: TimeRange
}
export const MAX_REGIONS = 2000
export function readRegionList(value: unknown): TranscriptRegion[] {
  if (!Array.isArray(value) || value.length > MAX_REGIONS)
    throw new AppError('INTERNAL', '片段标注数据无法读取，原文稿和音频仍可使用。')
  let end = 0
  return value.map((item: unknown) => {
    const region = item as Partial<TranscriptRegion> | null
    if (
      !region ||
      typeof region.kind !== 'string' ||
      !Object.hasOwn(REGION_LABELS, region.kind) ||
      !Number.isSafeInteger(region.startMs) ||
      !Number.isSafeInteger(region.endMs) ||
      region.startMs! < end ||
      region.endMs! <= region.startMs! ||
      region.endMs! > 3.6e10
    )
      throw new AppError('INTERNAL', '片段标注数据无法读取，原文稿和音频仍可使用。')
    end = region.endMs!
    return { startMs: region.startMs!, endMs: end, kind: region.kind }
  })
}
export function regionKey(region: TranscriptRegion): string {
  return `${region.kind}:${region.startMs}:${region.endMs}`
}

/** Replace only the requested original-media range, preserving both outside tails. */
export function replaceRegion(
  regions: TranscriptRegion[],
  change: TimeRange & { kind: RegionKind | null },
): TranscriptRegion[] {
  if (
    !Number.isSafeInteger(change.startMs) ||
    !Number.isSafeInteger(change.endMs) ||
    change.startMs < 0 ||
    change.endMs <= change.startMs ||
    change.endMs > 3.6e10 ||
    (change.kind !== null &&
      (typeof change.kind !== 'string' || !Object.hasOwn(REGION_LABELS, change.kind)))
  )
    throw new AppError('INVALID_REQUEST', '标注需要有效的原始音频时间范围和片段类型。')
  const next: TranscriptRegion[] = []
  for (const region of regions) {
    if (region.endMs <= change.startMs || region.startMs >= change.endMs) next.push({ ...region })
    else {
      if (region.startMs < change.startMs) next.push({ ...region, endMs: change.startMs })
      if (region.endMs > change.endMs) next.push({ ...region, startMs: change.endMs })
    }
  }
  if (change.kind !== null)
    next.push({ startMs: change.startMs, endMs: change.endMs, kind: change.kind })
  next.sort((a, b) => a.startMs - b.startMs)
  const merged: TranscriptRegion[] = []
  for (const region of next) {
    const last = merged.at(-1)
    if (last?.kind === region.kind && last.endMs === region.startMs) last.endMs = region.endMs
    else merged.push(region)
  }
  if (merged.length > MAX_REGIONS)
    throw new AppError('INVALID_REQUEST', '每集最多保留 2,000 个标注区间，请先移除部分标注。')
  return merged
}

export function classifyRegion(
  regions: TranscriptRegion[],
  segment: TimeRange,
): {
  complete: TranscriptRegion | undefined
  kinds: RegionKind[]
} {
  let low = 0,
    high = regions.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (regions[middle]!.endMs <= segment.startMs) low = middle + 1
    else high = middle
  }
  const first = regions[low]
  const complete =
    first && first.startMs <= segment.startMs && first.endMs >= segment.endMs ? first : undefined
  const kinds = new Set<RegionKind>()
  for (let index = low; regions[index] && regions[index]!.startMs < segment.endMs; index++)
    kinds.add(regions[index]!.kind)
  return { complete, kinds: [...kinds] }
}
export type ReadingRow =
  | { type: 'sentence'; index: number }
  | { type: 'region'; index: number; lastIndex: number; region: TranscriptRegion }
export function regionReadingRows(
  segments: TranscriptSegment[],
  regions: TranscriptRegion[],
  folded: boolean,
  expanded: ReadonlySet<string>,
): ReadingRow[] {
  const rows: ReadingRow[] = []
  for (const [index, segment] of segments.entries()) {
    const { complete } = classifyRegion(regions, segment)
    if (!folded || !complete || expanded.has(regionKey(complete)))
      rows.push({ type: 'sentence', index })
    else {
      const last = rows.at(-1)
      if (
        last?.type === 'region' &&
        last.lastIndex === index - 1 &&
        regionKey(last.region) === regionKey(complete)
      )
        last.lastIndex = index
      else rows.push({ type: 'region', index, lastIndex: index, region: complete })
    }
  }
  return rows
}
