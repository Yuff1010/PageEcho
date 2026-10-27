import type { TranscriptDocument, TimeRange } from './transcript'

/** Reprocessed coverage replaces that region; saved generated regions survive lost checkpoints. */
export function mergeJobDocument(
  previous: TranscriptDocument | null,
  incoming: TranscriptDocument,
): TranscriptDocument {
  if (!previous) return incoming
  const coverage: TimeRange[] = []
  for (const range of [...previous.coverage, ...incoming.coverage].sort(
    (a, b) => a.startMs - b.startMs,
  )) {
    const last = coverage.at(-1)
    if (last && range.startMs <= last.endMs) last.endMs = Math.max(last.endMs, range.endMs)
    else coverage.push({ ...range })
  }
  const retained = previous.segments.filter(
    (segment) =>
      !incoming.coverage.some(
        (range) => segment.startMs < range.endMs && segment.endMs > range.startMs,
      ),
  )
  return {
    ...incoming,
    coverage,
    segments: [...retained, ...incoming.segments].sort(
      (a, b) => a.startMs - b.startMs || a.endMs - b.endMs,
    ),
  }
}
export function processedPrefix(coverage: TimeRange[]): number {
  let end = 0
  for (const range of coverage) {
    if (range.startMs > end) break
    end = Math.max(end, range.endMs)
  }
  return end
}
