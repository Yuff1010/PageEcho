import {
  ORIGINAL_MATCHER_VERSION,
  type OriginalAlignment,
  type OriginalMatch,
  type OriginalMatchSource,
  type OriginalTarget,
} from '../../shared/original'
import type {
  StoredTranscript,
  TranscriptDocument,
  TranscriptSegment,
} from '../../shared/transcript'
import type { OriginalMatchOptions } from './match'

export interface OriginalIncrementalBatch {
  transcript: TranscriptDocument
  options: OriginalMatchOptions
  targetIds: string[]
}
export interface OriginalIncrementalPlan {
  target: OriginalTarget
  originalId: string
  originalHash: string
  transcriptId: string
  transcriptRevision: number
  alignmentRevision: number
  batches: OriginalIncrementalBatch[]
  processed: OriginalMatchSource[]
}
export const matchSource = (segment: TranscriptSegment): OriginalMatchSource => ({
  segmentId: segment.id,
  text: segment.text,
  startMs: segment.startMs,
  endMs: segment.endMs,
})
export function sameSource(
  a: OriginalMatchSource | undefined,
  b: OriginalMatchSource | undefined,
): boolean {
  return (
    !!a &&
    !!b &&
    a.segmentId === b.segmentId &&
    a.text === b.text &&
    a.startMs === b.startMs &&
    a.endMs === b.endMs
  )
}
export function sourceForMatch(match: OriginalMatch): OriginalMatchSource | undefined {
  return match.source || !match.reviewed
    ? {
        segmentId: match.segmentId,
        text: match.asrText,
        ...(match.source ?? { startMs: match.startMs, endMs: match.endMs }),
      }
    : undefined
}
export function createIncrementalPlan(
  target: OriginalTarget,
  originalId: string,
  originalHash: string,
  transcript: StoredTranscript,
  previous: OriginalAlignment | null,
  limit = 128,
): OriginalIncrementalPlan | null {
  const document = transcript.document
  const known = new Map(previous?.sources?.map((source) => [source.segmentId, source]))
  const old = new Map(previous?.matches.map((match) => [match.segmentId, match]))
  const reviewed = new Map(
    previous?.matches.filter((match) => match.reviewed).map((match) => [match.segmentId, match]),
  )
  const preserved: OriginalMatchSource[] = []
  const dirty: number[] = []
  const currentVersion =
    previous?.matcherVersion === ORIGINAL_MATCHER_VERSION && previous.transcriptId === transcript.id
  document.segments.forEach((segment, index) => {
    const source = matchSource(segment),
      match = old.get(segment.id)
    if (
      reviewed.get(segment.id)?.asrText === segment.text ||
      (currentVersion &&
        sameSource(known.get(segment.id) ?? (match && sourceForMatch(match)), source))
    )
      preserved.push(source)
    else dirty.push(index)
  })
  if (
    !dirty.length &&
    previous?.transcriptRevision === transcript.revision &&
    previous.sources &&
    !previous.pendingSegments
  )
    return null
  const chosen = dirty.slice(0, limit),
    chosenSet = new Set(chosen)
  const coverage = (segment: TranscriptSegment) =>
    document.coverage.findIndex(
      (range) => segment.startMs >= range.startMs && segment.endMs <= range.endMs,
    )
  const ranges: { first: number; last: number }[] = []
  for (const index of chosen) {
    let first = index,
      last = index
    for (
      let n = 0;
      n < 3 &&
      first > 0 &&
      coverage(document.segments[first - 1]!) === coverage(document.segments[index]!);
      n++
    )
      first--
    for (
      let n = 0;
      n < 3 &&
      last + 1 < document.segments.length &&
      coverage(document.segments[last + 1]!) === coverage(document.segments[index]!);
      n++
    )
      last++
    const prior = ranges.at(-1)
    if (
      prior &&
      first <= prior.last + 1 &&
      coverage(document.segments[prior.first]!) === coverage(document.segments[first]!)
    )
      prior.last = Math.max(prior.last, last)
    else ranges.push({ first, last })
  }
  const anchors = (segment: TranscriptSegment) => {
    const match = old.get(segment.id)
    return match &&
      (match.reviewed
        ? match.asrText === segment.text
        : currentVersion && sameSource(sourceForMatch(match), matchSource(segment)))
      ? match
      : undefined
  }
  const batches = ranges.map(({ first, last }): OriginalIncrementalBatch => {
    const segments = document.segments.slice(first, last + 1)
    let left: OriginalMatch['selected'] = null,
      right: OriginalMatch['selected'] = null
    for (let i = first - 1; i >= 0; i--) {
      const match = anchors(document.segments[i]!)
      if (match?.selected) {
        left = match.selected
        break
      }
    }
    for (let i = last + 1; i < document.segments.length; i++) {
      const match = anchors(document.segments[i]!)
      if (match?.selected) {
        right = match.selected
        break
      }
    }
    return {
      transcript: { ...document, segments, coverage: [document.coverage[coverage(segments[0]!)]!] },
      options: {
        anchors: segments.map(anchors).filter((match): match is OriginalMatch => !!match),
        left,
        right,
      },
      targetIds: document.segments
        .slice(first, last + 1)
        .filter((_segment, offset) => chosenSet.has(first + offset))
        .map((segment) => segment.id),
    }
  })
  return {
    target,
    originalId,
    originalHash,
    transcriptId: transcript.id,
    transcriptRevision: transcript.revision,
    alignmentRevision: previous?.revision ?? 0,
    batches,
    processed: [...preserved, ...chosen.map((index) => matchSource(document.segments[index]!))],
  }
}

export function mergeIncrementalMatches(
  document: TranscriptDocument,
  previous: OriginalAlignment | null,
  generated: OriginalMatch[],
): OriginalMatch[] {
  const segments = new Map(document.segments.map((segment) => [segment.id, segment]))
  const reviewed: OriginalMatch[] = [],
    automatic = new Map<string, OriginalMatch>()
  for (const match of previous?.matches ?? []) {
    const segment = segments.get(match.segmentId)
    if (match.reviewed) {
      reviewed.push({
        ...match,
        sourceState: !match.source
          ? 'legacy'
          : segment && sameSource(sourceForMatch(match), matchSource(segment))
            ? 'current'
            : 'retained',
      })
    } else if (
      previous?.matcherVersion === ORIGINAL_MATCHER_VERSION &&
      segment &&
      sameSource(sourceForMatch(match), matchSource(segment))
    ) {
      automatic.set(match.segmentId, {
        ...match,
        source: { startMs: segment.startMs, endMs: segment.endMs },
        sourceState: 'current',
      })
    }
  }
  for (const match of generated) {
    const segment = segments.get(match.segmentId)
    if (
      segment &&
      match.asrText === segment.text &&
      match.startMs === segment.startMs &&
      match.endMs === segment.endMs
    )
      automatic.set(match.segmentId, {
        ...match,
        reviewed: false,
        source: { startMs: segment.startMs, endMs: segment.endMs },
        sourceState: 'current',
      })
  }
  // A reviewed manual gap is also an authoritative time anchor. Recognition
  // regrouping may remove its old segment ID; retain that user decision.
  return [
    ...reviewed,
    ...[...automatic.values()].filter(
      (match) =>
        !reviewed.some(
          (anchor) =>
            anchor.segmentId === match.segmentId ||
            Math.max(anchor.startMs, match.startMs) < Math.min(anchor.endMs, match.endMs),
        ),
    ),
  ].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
}
