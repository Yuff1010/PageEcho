import { ORIGINAL_PAGE_SIZE, type OriginalSentence } from '../../shared/original'
import type { ReadingBook } from '../../shared/reading'

export interface ReaderAnchor {
  ordinal: number
  offset: number
}
export { readReaderSettings, storeReaderSettings, type ReaderSettings } from './reader-settings'
export function initialReaderAnchor(book: ReadingBook): ReaderAnchor {
  try {
    const value = JSON.parse(
      localStorage.getItem(`ralb:reading:anchor:${book.id}`) ?? 'null',
    ) as ReaderAnchor & { updatedAt: number }
    if (
      value &&
      Number.isSafeInteger(value.ordinal) &&
      value.ordinal >= 0 &&
      value.ordinal < book.sentenceCount &&
      Number.isSafeInteger(value.offset) &&
      value.offset >= 0 &&
      Number.isFinite(value.updatedAt) &&
      (value.ordinal === book.position ||
        value.updatedAt >= Date.parse(book.lastReadAt ?? '1970-01-01'))
    )
      return { ordinal: value.ordinal, offset: value.offset }
  } catch {
    /* Use the database position. */
  }
  return { ordinal: book.position, offset: 0 }
}
export function storeReaderAnchor(id: string, anchor: ReaderAnchor) {
  try {
    localStorage.setItem(
      `ralb:reading:anchor:${id}`,
      JSON.stringify({ ...anchor, updatedAt: Date.now() }),
    )
  } catch {
    /* The sentence position is also saved in the database. */
  }
}
export function readerChunkStarts(ordinal: number, count: number) {
  const center =
    Math.floor(Math.max(0, Math.min(ordinal, count - 1)) / ORIGINAL_PAGE_SIZE) * ORIGINAL_PAGE_SIZE
  return [center - ORIGINAL_PAGE_SIZE, center, center + ORIGINAL_PAGE_SIZE].filter(
    (start) => start >= 0 && start < count,
  )
}
export function readingParagraphs(sentences: OriginalSentence[]) {
  const groups: OriginalSentence[][] = []
  for (const sentence of sentences) {
    const previous = groups.at(-1)
    if (previous?.[0]?.paragraph === sentence.paragraph && previous[0].chapter === sentence.chapter)
      previous.push(sentence)
    else groups.push([sentence])
  }
  return groups
}
export function readingRoute(hash: string) {
  const match = /^#\/read\/([^/?#]{1,200})$/.exec(hash)
  if (!match) return null
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return null
  }
}
