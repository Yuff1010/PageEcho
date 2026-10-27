import type { TranscriptRequest, TranscriptSegment, TranscriptState } from './transcript'
import type { OriginalAcousticResult } from './original-acoustic'

export const TRANSCRIPT_HISTORY_LIMIT = 20
export const MAX_EDIT_DELTA_BYTES = 2 * 1024 * 1024
export const MAX_REPLACEMENT_SCAN_BYTES = 64 * 1024 * 1024
export const MAX_REPLACEMENT_EPISODES = 1000
export const MAX_REPLACEMENT_SEGMENTS = 10000
export const REPLACEMENT_PAGE_SIZE = 50
export const MAX_RETIMED_SEGMENTS = 20

/** Literal names use Unicode code points consistently in IPC, storage and editing. */
export function isTranscriptReplacementLiteral(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) return false
  const characters = Array.from(value)
  return (
    characters.length <= 100 &&
    characters.every((character) => {
      const point = character.codePointAt(0)!
      return point >= 32 && point !== 127 && !(point >= 0xd800 && point <= 0xdfff)
    })
  )
}

export interface TranscriptEditTarget extends TranscriptRequest {
  revision: number
}
export type TranscriptEditOperation =
  | { kind: 'text'; segmentId: string; text: string }
  | { kind: 'split'; segmentId: string; offset: number; atMs: number }
  | { kind: 'merge'; firstId: string; secondId: string; separator: '' | ' ' }
  | { kind: 'timing'; ranges: { segmentId: string; startMs: number; endMs: number }[] }
export interface TranscriptEditRequest extends TranscriptEditTarget {
  commandId: string
  operation: TranscriptEditOperation
}
export interface TranscriptHistoryRequest extends TranscriptEditTarget {
  commandId: string
  historyId: string
}
export interface TranscriptHistorySummary {
  id: string
  label: string
  createdAt: string
  episodes: number
  segments: number
}
export interface TranscriptEditingState extends TranscriptRequest {
  transcriptId: string | null
  revision: number | null
  undo: TranscriptHistorySummary | null
  redo: TranscriptHistorySummary | null
  undoBlocked: string | null
  redoBlocked: string | null
  historyCount: number
  historyLimit: number
}
export interface TranscriptEditResult {
  transcript: TranscriptState
  history: TranscriptEditingState
  changed: TranscriptRequest[]
  replayed: boolean
}
export interface TranscriptReplacementRequest extends TranscriptEditTarget {
  requestId: string
  scope: { kind: 'episode' } | { kind: 'book'; bookId: string; episodeIds: string[] }
  find: string
  replacement: string
}
export interface TranscriptReplacementChange {
  episodeId: string
  episodeTitle: string
  segmentId: string
  before: string
  after: string
  occurrences: number
}
export interface TranscriptReplacementPreview {
  token: string
  expiresAt: number
  find: string
  replacement: string
  episodes: number
  segments: number
  occurrences: number
  skippedEpisodes: number
  page: number
  pages: number
  changes: TranscriptReplacementChange[]
}
export interface ApplyTranscriptReplacement {
  token: string
  commandId: string
}
export interface TranscriptAlignmentRequest extends TranscriptEditTarget {
  requestId: string
  segmentIds: string[]
  device: 'cpu' | 'cuda'
}
export interface TranscriptAlignmentJob extends TranscriptEditTarget {
  id: string
  transcriptId: string
  device: 'cpu' | 'cuda'
  segments: TranscriptSegment[]
  status: 'running' | 'ready' | 'rejected' | 'failed' | 'canceled' | 'applied'
  stage: 'checking-components' | 'aligning' | 'done'
  createdAt: string
  result: OriginalAcousticResult | null
  ranges: { segmentId: string; startMs: number; endMs: number }[]
  error: string | null
}
export interface TranscriptAlignmentState {
  configured: boolean
  job: TranscriptAlignmentJob | null
}
export interface ApplyTranscriptAlignment {
  id: string
  revision: number
  commandId: string
}
