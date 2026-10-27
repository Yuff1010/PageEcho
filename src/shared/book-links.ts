import type { ReadingBook } from './reading'
import type { OriginalTarget } from './original'

/** The same immutable text is both a shelf ebook and an audiobook's original. */
export interface BookLink {
  audioBookId: string
  readingBookId: string
  audioTitle: string
  readingTitle: string
}

export interface LinkReadingBookRequest {
  bookId: string
  readingBookId: string
}

export interface OpenLinkedReadingRequest extends OriginalTarget {
  positionMs: number
}

export interface OpenLinkedReadingResult {
  book: ReadingBook
  position: number | null
  status: 'mapped' | 'unmapped'
}

export interface ResolveLinkedListeningRequest {
  readingBookId: string
  position: number
  bookId?: string
}

export interface LinkedListeningCandidate {
  bookId: string
  episodeId: string
  audioHash: string
  bookTitle: string
  episodeTitle: string
  positionMs: number
  first: number
  last: number
}

export interface ResolveLinkedListeningResult {
  status: 'mapped' | 'unmapped' | 'ambiguous'
  candidates: LinkedListeningCandidate[]
}
