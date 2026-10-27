import type { ReadingBook } from '../../shared/reading'
import type { ReaderAnchor } from './reader-layout'
import { writeReaderPreference } from './reader-settings'

export interface ReadingBookmark {
  id: string
  anchor: ReaderAnchor
  chapter: string
  excerpt: string
  createdAt: string
}
const key = (id: string) => `ralb:reading:bookmarks:${id}:v1`
export function readReadingBookmarks(book: ReadingBook): ReadingBookmark[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(book.id)) ?? '[]')
    return Array.isArray(value)
      ? value
          .filter(
            (item): item is ReadingBookmark =>
              item &&
              typeof item.id === 'string' &&
              item.id.length < 100 &&
              typeof item.chapter === 'string' &&
              item.chapter.length < 2000 &&
              typeof item.excerpt === 'string' &&
              item.excerpt.length <= 160 &&
              typeof item.createdAt === 'string' &&
              Number.isFinite(Date.parse(item.createdAt)) &&
              Number.isSafeInteger(item.anchor?.ordinal) &&
              item.anchor.ordinal >= 0 &&
              item.anchor.ordinal < book.sentenceCount &&
              Number.isSafeInteger(item.anchor?.offset) &&
              item.anchor.offset >= 0,
          )
          .slice(0, 500)
      : []
  } catch {
    return []
  }
}
export function storeReadingBookmarks(id: string, bookmarks: ReadingBookmark[]) {
  return writeReaderPreference(key(id), bookmarks)
}
