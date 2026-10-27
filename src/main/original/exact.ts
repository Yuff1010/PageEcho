export interface ExactOriginalRanges {
  ranges: { first: number; last: number }[]
  unique: boolean
}

// Candidate retrieval is bounded; uniqueness must still cover the complete original.
// Keep at most two distinct sentence ranges and a bounded query cache.
export function createExactOriginalLookup(sentences: string[]) {
  const starts: number[] = []
  let length = 0
  for (const sentence of sentences) {
    starts.push(length)
    length += sentence.length
  }
  const text = sentences.join('')
  const cache = new Map<string, ExactOriginalRanges>()
  function sentenceAt(position: number): number {
    let low = 0,
      high = starts.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (starts[middle]! <= position) low = middle + 1
      else high = middle
    }
    return Math.max(0, low - 1)
  }
  return (query: string): ExactOriginalRanges => {
    if (query.length < 6 || query.length > 800) return { ranges: [], unique: false }
    const cached = cache.get(query)
    if (cached) return cached
    const ranges: ExactOriginalRanges['ranges'] = []
    let occurrences = 0
    for (
      let position = text.indexOf(query);
      position >= 0;
      position = text.indexOf(query, position + 1)
    ) {
      occurrences = Math.min(2, occurrences + 1)
      const first = sentenceAt(position),
        last = sentenceAt(position + query.length - 1)
      if (!ranges.some((range) => range.first === first && range.last === last))
        ranges.push({ first, last })
      if (ranges.length === 2) break
    }
    const value = { ranges, unique: occurrences === 1 }
    if (cache.size >= 256) cache.delete(cache.keys().next().value!)
    cache.set(query, value)
    return value
  }
}
