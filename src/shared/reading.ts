import type { OriginalInfo } from './original'

export interface ReadingBook extends OriginalInfo {
  /** Optional bounded local artwork cache, independent from the reading document. */
  coverUrl?: string
  /** Present only for a host-managed chapter import; ordinary files remain immutable. */
  source?: { sourceId: string; workId: string }
  position: number
  lastReadAt: string | null
}

export interface ReadingLocation {
  id: string
  position: number
}

export interface ReadingFindRequest {
  id: string
  query: string
  offset: number
}
