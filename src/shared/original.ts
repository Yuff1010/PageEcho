import type { TranscriptRequest } from './transcript'
import type { OriginalAcousticHistory } from './original-acoustic'

export const ORIGINAL_PARSER_VERSION = 2
export const ORIGINAL_EPUB_PARSER_VERSION = 3
export const ORIGINAL_PAGE_SIZE = 60
export interface OriginalChapter {
  index: number
  title: string
  first: number
  count: number
}
export interface OriginalSentence {
  ordinal: number
  chapter: number
  paragraph: number
  text: string
}
export interface ParsedOriginal {
  hash: string
  parserVersion: number
  title: string
  sourceName: string
  format: 'txt' | 'epub'
  encoding: string
  bytes: number
  chapters: OriginalChapter[]
  sentences: OriginalSentence[]
  warnings: string[]
}
export interface OriginalInfo extends Omit<ParsedOriginal, 'sentences'> {
  id: string
  sentenceCount: number
  importedAt: string
}
export interface OriginalPage {
  info: OriginalInfo
  start: number
  sentences: OriginalSentence[]
}
export interface OriginalCandidate {
  basis?: 'context' | 'anchors'
  first: number
  last: number
  score: number
  excerpt: string
  chapter: string
}
export interface OriginalMatch {
  reviewed: boolean
  segmentId: string
  startMs: number
  endMs: number
  asrText: string
  candidates: OriginalCandidate[]
  selected: { first: number; last: number; method: 'auto' | 'manual' } | null
  // Recognition coordinates are distinct from user-corrected display coordinates.
  source?: { startMs: number; endMs: number }
  sourceState?: 'current' | 'legacy' | 'retained'
  acoustic?: OriginalAcousticHistory
}
export interface OriginalMatchSource {
  segmentId: string
  text: string
  startMs: number
  endMs: number
}
export interface OriginalAlignment {
  revision: number
  originalId: string
  transcriptId: string
  transcriptRevision: number
  matcherVersion: number
  matches: OriginalMatch[]
  sources?: OriginalMatchSource[]
  pendingSegments?: number
}
export interface OriginalState {
  info: OriginalInfo | null
  alignment: OriginalAlignment | null
  stale: boolean
}
export type OriginalTarget = TranscriptRequest
export interface OriginalFindRequest extends OriginalTarget {
  originalId: string
  query: string
  offset: number
}
export interface OriginalSearchPage {
  originalId: string
  query: string
  offset: number
  total: number
  results: OriginalCandidate[]
}
export const ORIGINAL_SEARCH_PAGE_SIZE = 20
export interface OriginalCorrection extends OriginalTarget {
  originalId: string
  revision: number
  segmentId: string
  selection: { first: number; last: number } | null
  startMs: number
  endMs: number
}

// Kept as an explicit versioned policy, separate from acoustic alignment/model confidence.
export const ORIGINAL_MATCHER_VERSION = 5
