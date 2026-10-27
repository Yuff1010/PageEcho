import type { OriginalInfo } from './original'

export interface ReadingBook extends OriginalInfo {
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
