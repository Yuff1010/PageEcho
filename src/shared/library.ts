import type { AppState, Book, Episode } from './contracts'
import type { ReadingBook } from './reading'

export interface ReadingBookSummary extends Omit<ReadingBook, 'chapters'> {
  chapterCount: number
}

/** A shelf entry never claims to contain a complete or partial chapter array. */
export interface BookSummary extends Omit<Book, 'episodes'> {
  episodeCount: number
  firstEpisodeId: string | null
  resumeEpisode: Pick<Episode, 'id' | 'title' | 'positionMs' | 'durationMs'> | null
}

export interface LibraryOverview extends Omit<AppState, 'books'> {
  books: BookSummary[]
}

export interface BookEpisodePage {
  book: BookSummary
  episodes: Episode[]
  offset: number
  total: number
}

export interface PlaybackContext {
  book: Omit<Book, 'episodes'>
  episode: Episode
  previousEpisodeId: string | null
  nextEpisodeId: string | null
  /** Zero-based position in the complete canonical catalogue, independent of order values. */
  episodeIndex?: number
}

export interface LibraryMutation {
  changedBookIds: string[]
  removedBookIds: string[]
  filesChanged: boolean
  bookId?: string
  episodeId?: string
}
