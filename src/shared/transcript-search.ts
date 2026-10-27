import { MAX_SEGMENTS, type TranscriptSegment } from './transcript'

export const TRANSCRIPT_SEARCH_PAGE_SIZE = 20
export interface TranscriptSearchHit {
  first: number
  last: number
  startMs: number
  endMs: number
  excerpt: string
}
export interface TranscriptSearchPage {
  query: string
  offset: number
  total: number
  results: TranscriptSearchHit[]
}
export type TranscriptSearchInput =
  | { type: 'init'; segments: TranscriptSegment[] }
  | { type: 'find'; id: number; query: string; offset: number }
export type TranscriptSearchOutput =
  | { type: 'ready' }
  | { type: 'result'; id: number; page: TranscriptSearchPage }
  | { type: 'error'; id?: number; error: string }

function normalize(text: string) {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
}

/** An immutable document snapshot; the renderer owns a copy in a dedicated worker. */
export class TranscriptSearchIndex {
  private text: string
  private spans: { index: number; end: number }[] = []
  private cached: { query: string; ranges: { first: number; last: number }[] } | null = null
  constructor(private segments: readonly TranscriptSegment[]) {
    if (segments.length > MAX_SEGMENTS) throw new Error('文稿超过搜索片段上限。')
    const parts: string[] = []
    let length = 0
    for (const [index, segment] of segments.entries()) {
      const part = normalize(segment.text)
      if (!part) continue
      parts.push(part)
      length += part.length
      this.spans.push({ index, end: length })
    }
    this.text = parts.join('')
  }
  find(query: string, offset: number): TranscriptSearchPage {
    if (typeof query !== 'string' || query.trim().length < 2 || query.length > 100)
      throw new Error('请输入 2–100 个字符。')
    const needle = normalize(query)
    if (Array.from(needle).length < 2) throw new Error('搜索文字至少需要两个字母或数字。')
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_SEGMENTS * 2)
      throw new Error('搜索页码无效。')
    if (this.cached?.query !== needle) {
      const ranges: { first: number; last: number }[] = []
      let from = 0,
        firstSpan = 0,
        lastSpan = 0
      for (;;) {
        const at = this.text.indexOf(needle, from)
        if (at < 0) break
        while (this.spans[firstSpan]!.end <= at) firstSpan++
        lastSpan = Math.max(firstSpan, lastSpan)
        while (this.spans[lastSpan]!.end < at + needle.length) lastSpan++
        const first = this.spans[firstSpan]!.index,
          last = this.spans[lastSpan]!.index
        const previous = ranges.at(-1)
        if (!previous || previous.first !== first || previous.last !== last)
          ranges.push({ first, last })
        // Include overlapping occurrences, but count each sentence range once.
        from = at + 1
      }
      this.cached = { query: needle, ranges }
    }
    const ranges = this.cached.ranges
    return {
      query: query.trim(),
      offset,
      total: ranges.length,
      results: ranges.slice(offset, offset + TRANSCRIPT_SEARCH_PAGE_SIZE).map(({ first, last }) => {
        let excerpt = ''
        for (let index = first; index <= last && excerpt.length <= 240; index++)
          excerpt += this.segments[index]!.text
        if (excerpt.length > 240) excerpt = excerpt.slice(0, 237) + '…'
        return {
          first,
          last,
          startMs: this.segments[first]!.startMs,
          endMs: this.segments[last]!.endMs,
          excerpt,
        }
      }),
    }
  }
}
