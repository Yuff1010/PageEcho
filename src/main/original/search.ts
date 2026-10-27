import {
  ORIGINAL_SEARCH_PAGE_SIZE,
  type OriginalSearchPage,
  type ParsedOriginal,
} from '../../shared/original'
import { AppError } from '../../shared/validation'
import { normalizeOriginal } from './normalize'

// Search the whole version, including phrases split into adjacent sentences in one paragraph.
// Chapter/paragraph boundaries stay explicit so unrelated passages cannot form a false hit.
export function findOriginal(
  original: ParsedOriginal,
  originalId: string,
  query: string,
  offset: number,
): OriginalSearchPage {
  const needle = normalizeOriginal(query)
  if (needle.length < 2 || query.length > 100 || !Number.isSafeInteger(offset) || offset < 0)
    throw new AppError('INVALID_REQUEST', '请输入 2–100 个字符的文字，搜索页码必须有效。')
  const starts: number[] = [],
    parts: string[] = []
  let length = 0
  for (let i = 0; i < original.sentences.length; i++) {
    const sentence = original.sentences[i]!,
      previous = original.sentences[i - 1]
    if (
      previous &&
      (previous.chapter !== sentence.chapter || previous.paragraph !== sentence.paragraph)
    ) {
      parts.push('\0')
      length++
    }
    starts.push(length)
    const normalized = normalizeOriginal(sentence.text)
    parts.push(normalized)
    length += normalized.length
  }
  const text = parts.join('')
  const sentenceAt = (position: number) => {
    let low = 0,
      high = starts.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (starts[mid]! <= position) low = mid + 1
      else high = mid
    }
    return Math.max(0, low - 1)
  }
  const page: OriginalSearchPage = {
    originalId,
    query: query.trim(),
    offset,
    total: 0,
    results: [],
  }
  let position = text.indexOf(needle),
    previousFirst = -1,
    previousLast = -1
  while (position >= 0) {
    const first = sentenceAt(position),
      last = sentenceAt(position + needle.length - 1)
    if (first !== previousFirst || last !== previousLast) {
      if (page.total >= offset && page.results.length < ORIGINAL_SEARCH_PAGE_SIZE) {
        page.results.push({
          first,
          last,
          score: 1,
          chapter: original.chapters[original.sentences[first]!.chapter]!.title,
          excerpt: original.sentences
            .slice(first, last + 1)
            .map((sentence) => sentence.text)
            .join('')
            .slice(0, 600),
        })
      }
      page.total++
      previousFirst = first
      previousLast = last
    }
    position = text.indexOf(needle, position + 1)
  }
  return page
}
