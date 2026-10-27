import {
  type OriginalCandidate,
  type OriginalMatch,
  type ParsedOriginal,
} from '../../shared/original'
import type { TranscriptDocument } from '../../shared/transcript'
import { AppError } from '../../shared/validation'
import { createExactOriginalLookup } from './exact'
import { normalizeOriginal } from './normalize'

function grams(text: string): number[] {
  const result: number[] = []
  for (let i = 0; i + 2 < text.length; i++)
    result.push(
      ((text.charCodeAt(i) * 65599 + text.charCodeAt(i + 1)) * 65599 + text.charCodeAt(i + 2)) >>>
        0,
    )
  return result
}
function distance(a: string, b: string): number {
  let previous = Uint16Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = new Uint16Array(b.length + 1)
    current[0] = i
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    previous = current
  }
  return previous[b.length]!
}

export function matchOriginal(
  original: ParsedOriginal,
  transcript: TranscriptDocument,
  options: OriginalMatchOptions = {},
): OriginalMatch[] {
  return createOriginalMatcher(original)(transcript, options)
}
export interface OriginalMatchOptions {
  anchors?: OriginalMatch[]
  left?: OriginalMatch['selected']
  right?: OriginalMatch['selected']
}
export function createOriginalMatcher(original: ParsedOriginal) {
  const normalized = original.sentences.map((sentence) => normalizeOriginal(sentence.text))
  const lookupExact = createExactOriginalLookup(normalized)
  function candidateForRange(first: number, last: number, score: number): OriginalCandidate {
    const chapterA = original.chapters[original.sentences[first]!.chapter]!.title,
      chapterB = original.chapters[original.sentences[last]!.chapter]!.title
    return {
      first,
      last,
      score: Math.round(score * 10000) / 10000,
      excerpt: original.sentences
        .slice(first, last + 1)
        .map((sentence) => sentence.text)
        .join('')
        .slice(0, 2400),
      chapter: chapterA === chapterB ? chapterA : `${chapterA} → ${chapterB}`,
    }
  }
  const index = new Map<number, number[] | null>()
  normalized.forEach((text, ordinal) => {
    // Include sentence seams so a query crossing punctuation can retrieve both chapters.
    for (const gram of new Set(grams(text + (normalized[ordinal + 1]?.slice(0, 2) ?? '')))) {
      const previous = index.get(gram)
      if (previous === null) continue
      if (previous && previous.length >= 500) index.set(gram, null)
      else if (previous) previous.push(ordinal)
      else index.set(gram, [ordinal])
    }
  })
  function retrieve(query: string, exactOnly = false): OriginalCandidate[] {
    const counts = new Map<number, number>()
    const queryGrams = [...new Set(grams(query))]
    // Evenly sample long queries rather than favoring their opening words.
    for (let i = 0; i < Math.min(40, queryGrams.length); i++) {
      const gram =
        queryGrams[Math.floor((i * queryGrams.length) / Math.min(40, queryGrams.length))]!
      for (const ordinal of index.get(gram) ?? [])
        counts.set(ordinal, (counts.get(ordinal) ?? 0) + 1)
    }
    const starts = new Set<number>()
    for (const [ordinal] of [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 20))
      for (let delta = 0; delta < 4; delta++) if (ordinal - delta >= 0) starts.add(ordinal - delta)
    const found = new Map<string, OriginalCandidate>()
    for (const range of lookupExact(query).ranges) {
      if (
        range.last - range.first < 4 &&
        normalized.slice(range.first, range.last + 1).join('').length <= 1800
      )
        found.set(`${range.first}:${range.last}`, candidateForRange(range.first, range.last, 1))
    }
    if (query.length >= 6 && query.length <= 800)
      for (const first of starts) {
        let text = ''
        for (let last = first; last < Math.min(first + 4, normalized.length); last++) {
          const before = text.length
          text += normalized[last]!
          if (text.length > 1800) break
          let from = first,
            to = last,
            score = 0
          const exact = text.indexOf(query)
          if (exact >= 0) {
            let offset = 0
            for (let k = first; k <= last; k++) {
              const end = offset + normalized[k]!.length
              if (end <= exact) from = k + 1
              if (offset < exact + query.length) to = k
              offset = end
            }
            score = 1
          } else if (
            !exactOnly &&
            text.length >= query.length * 0.65 &&
            text.length <= query.length * 1.5 &&
            query.length <= 400
          ) {
            score = 1 - distance(query, text) / Math.max(query.length, text.length)
          }
          if (from > to || score < 0.55) continue
          const candidate = candidateForRange(from, to, score)
          const key = `${from}:${to}`
          if ((found.get(key)?.score ?? -1) < score) found.set(key, candidate)
          if (before > query.length * 1.5 && exact < 0) break
        }
      }
    return [...found.values()].sort(
      (a, b) => b.score - a.score || a.last - a.first - (b.last - b.first) || a.first - b.first,
    )
  }
  return (transcript: TranscriptDocument, options: OriginalMatchOptions = {}): OriginalMatch[] => {
    if (transcript.segments.length > 20_000)
      throw new AppError('INVALID_ORIGINAL', '单次匹配最多 20,000 个转写片段，请先按集处理。')
    const anchors = new Map(options.anchors?.map((match) => [match.segmentId, match]))
    const rightBounds = new Map<string, OriginalMatch['selected']>()
    let rightBound = options.right ?? null
    for (const segment of [...transcript.segments].reverse()) {
      rightBounds.set(segment.id, rightBound)
      const anchor = anchors.get(segment.id)
      if (anchor?.selected) rightBound = anchor.selected
    }
    const matches: OriginalMatch[] = []
    let previousAccepted = options.left?.first ?? -1
    for (const segment of transcript.segments) {
      const anchor = anchors.get(segment.id)
      if (anchor && anchor.asrText === segment.text) {
        matches.push({ ...anchor, startMs: segment.startMs, endMs: segment.endMs })
        if (anchor.selected) previousAccepted = anchor.selected.first
        continue
      }
      const query = normalizeOriginal(segment.text)
      const exact = lookupExact(query)
      const ranked = retrieve(query)
      const best = ranked[0]
      const distinct = ranked.find(
        (candidate) => best && (candidate.last < best.first || candidate.first > best.last),
      )
      const candidates = [best, distinct, ...ranked]
        .filter((value, i, values) => value && values.indexOf(value) === i)
        .slice(0, 3) as OriginalCandidate[]
      const accepted =
        !!best &&
        query.length >= 12 &&
        best.score >= 0.92 &&
        (!distinct || best.score - distinct.score >= 0.08) &&
        (!exact.ranges.length ||
          (best.score === 1 &&
            exact.ranges.every(
              (range) => range.first === best.first && range.last === best.last,
            ))) &&
        best.first >= previousAccepted &&
        (!rightBounds.get(segment.id) || best.last <= rightBounds.get(segment.id)!.last)
      if (accepted) previousAccepted = best.first
      matches.push({
        reviewed: false,
        segmentId: segment.id,
        startMs: segment.startMs,
        endMs: segment.endMs,
        asrText: segment.text,
        candidates,
        selected: accepted ? { first: best.first, last: best.last, method: 'auto' } : null,
      })
    }
    // Require a unique exact multi-segment context, then recover each short part's
    // sentence range from its own character span. Insertions cannot be bridged.
    const proposals = matches.map(() => new Map<string, OriginalCandidate>())
    for (let begin = 0; begin < matches.length; begin++) {
      let query = ''
      const parts: string[] = []
      for (let end = begin; end < Math.min(begin + 4, matches.length); end++) {
        if (end > begin && matches[end]!.startMs - matches[end - 1]!.endMs > 1500) break
        const part = normalizeOriginal(matches[end]!.asrText)
        if (matches[end]!.reviewed && !matches[end]!.selected) break
        if (part.length < 3) break
        parts.push(part)
        query += part
        if (query.length > 240) break
        if (
          end === begin ||
          query.length < 18 ||
          matches.slice(begin, end + 1).every((match) => match.selected)
        )
          continue
        const ranked = retrieve(query, true),
          best = ranked[0]
        if (
          !best ||
          !lookupExact(query).unique ||
          ranked.some((candidate) => candidate.last < best.first || candidate.first > best.last)
        )
          continue
        const text = normalized.slice(best.first, best.last + 1).join('')
        const offset = text.indexOf(query)
        if (offset < 0 || text.indexOf(query, offset + 1) >= 0) continue
        let consumed = 0
        for (let i = begin; i <= end; i++) {
          const start = offset + consumed,
            finish = start + parts[i - begin]!.length
          consumed += parts[i - begin]!.length
          let running = 0,
            first = best.first,
            last = best.last
          for (let j = best.first; j <= best.last; j++) {
            const until = running + normalized[j]!.length
            if (until <= start) first = j + 1
            if (running < finish) last = j
            running = until
          }
          const candidate: OriginalCandidate = {
            ...candidateForRange(first, last, 1),
            basis: 'context',
          }
          proposals[i]!.set(`${first}:${last}`, candidate)
        }
      }
    }
    const rightAnchors: OriginalMatch['selected'][] = []
    let nextAnchor: OriginalMatch['selected'] = options.right ?? null
    for (let i = matches.length - 1; i >= 0; i--) {
      rightAnchors[i] = nextAnchor
      if (matches[i]!.selected) nextAnchor = matches[i]!.selected
    }
    let left: OriginalMatch['selected'] = options.left ?? null
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i]!,
        choices = proposals[i]!
      if (match.selected) {
        left = match.selected
        continue
      }
      if (match.reviewed) continue
      if (choices.size !== 1) continue
      const candidate = [...choices.values()][0]!
      const right = rightAnchors[i]
      if ((left && candidate.first < left.first) || (right && candidate.last > right.last)) continue
      match.candidates = [
        candidate,
        ...match.candidates.filter(
          (value) => value.first !== candidate.first || value.last !== candidate.last,
        ),
      ].slice(0, 3)
      match.selected = { first: candidate.first, last: candidate.last, method: 'auto' }
      left = match.selected
    }
    // Whole-book uniqueness is intentionally strict. A passage repeated elsewhere
    // can still be unambiguous inside two independently accepted neighbours. Only
    // recover a complete, short, continuous run; never jump over an insertion or
    // a user's explicit gap, infer an episode's chapter, or use a distant anchor.
    for (let begin = 0; begin < matches.length;) {
      if (matches[begin]!.selected) {
        begin++
        continue
      }
      let end = begin
      while (end < matches.length && !matches[end]!.selected) end++
      const count = end - begin,
        before = matches[begin - 1],
        after = matches[end]
      if (
        !before?.selected ||
        !after?.selected ||
        count > 6 ||
        before.selected.last >= after.selected.first ||
        after.selected.first - before.selected.last > 13 ||
        matches.slice(begin, end).some((match) => match.reviewed) ||
        after.endMs - before.startMs > 30_000 ||
        !transcript.coverage.some(
          (range) => before.startMs >= range.startMs && after.endMs <= range.endMs,
        )
      ) {
        begin = end
        continue
      }
      const continuous = matches.slice(begin, end + 1).every((match, offset) => {
        const preceding = matches[begin + offset - 1]!
        const gap = match.startMs - preceding.endMs
        return gap >= 0 && gap <= 1500
      })
      const parts = matches.slice(begin, end).map((match) => normalizeOriginal(match.asrText))
      const query = parts.join(''),
        firstBound = before.selected.last + 1,
        lastBound = after.selected.first - 1,
        text = normalized.slice(firstBound, lastBound + 1).join('')
      if (
        !continuous ||
        parts.some((part) => part.length < 3) ||
        query.length < (count === 1 ? 6 : 18) ||
        query.length > 800 ||
        text.length > 1800
      ) {
        begin = end
        continue
      }
      let offset = text.indexOf(query),
        score = 1
      if (offset >= 0) {
        if (text.indexOf(query, offset + 1) >= 0) offset = -1
      } else if (
        query.length >= 24 &&
        text.length === query.length &&
        text.startsWith(query.slice(0, 6)) &&
        text.endsWith(query.slice(-6))
      ) {
        // A same-length, almost identical complete interval permits at most two
        // interior substitutions. Insertions, omissions and boundary shifts are
        // not repaired here: their sentence coordinates would be speculative.
        let substitutions = 0
        for (let i = 0; i < query.length && substitutions <= 2; i++)
          if (query[i] !== text[i]) substitutions++
        score = 1 - substitutions / query.length
        if (substitutions <= 2 && score >= 0.96) offset = 0
      }
      if (offset >= 0) {
        let consumed = 0
        for (let i = begin; i < end; i++) {
          const start = offset + consumed,
            finish = start + parts[i - begin]!.length
          consumed += parts[i - begin]!.length
          let running = 0,
            first = firstBound,
            last = lastBound
          for (let j = firstBound; j <= lastBound; j++) {
            const until = running + normalized[j]!.length
            if (until <= start) first = j + 1
            if (running < finish) last = j
            running = until
          }
          const candidate: OriginalCandidate = {
            ...candidateForRange(first, last, score),
            basis: 'anchors',
          }
          const match = matches[i]!
          match.candidates = [
            candidate,
            ...match.candidates.filter((value) => value.first !== first || value.last !== last),
          ].slice(0, 3)
          match.selected = { first, last, method: 'auto' }
        }
      }
      begin = end
    }
    return matches
  }
}
