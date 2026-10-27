import type { TranscriptRequest, TranscriptSegment, TranscriptState } from './transcript'
import type { SubtitleFormat } from './subtitles'

export const SUBTITLE_IMPORT_PAGE_SIZE = 50
export const MAX_SUBTITLE_IMPORT_PREVIEWS = 2
export const SUBTITLE_IMPORT_PREVIEW_TTL_MS = 5 * 60_000

export type SubtitleImportEncoding = 'auto' | 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030' | 'big5'
export type ResolvedSubtitleImportEncoding = Exclude<SubtitleImportEncoding, 'auto'>
export interface SubtitleImportOptions {
  encoding: SubtitleImportEncoding
  offsetMs: number
}
export interface SubtitleImportRequest extends TranscriptRequest, SubtitleImportOptions {
  requestId: string
}
export interface SubtitleImportPreviewRequest extends SubtitleImportOptions {
  token: string
  revision: number
}
export interface SubtitleImportPageRequest {
  token: string
  revision: number
  page: number
}
export interface ApplySubtitleImport {
  token: string
  revision: number
  commandId: string
}
export interface TimedSubtitleWarning {
  code: string
  count: number
  firstLine: number | null
}
export interface TimedSubtitleMetadata {
  format: SubtitleFormat
  cueCount: number
  outputSegments: number
  overlappingCues: number
  overlapSegments: number
  multilineCues: number
  markupCues: number
  inlineTimestamps: number
  notes: number
  styles: number
  regions: number
  settingsCues: number
  documentBytes: number
  warnings: TimedSubtitleWarning[]
}
export interface TranscriptImportBaseline {
  status: 'missing' | 'stale' | 'ready'
  transcriptId: string | null
  revision: number | null
  documentHash: string | null
}
export interface SubtitleImportPreview extends TranscriptRequest {
  token: string
  revision: number
  expiresAt: number
  episodeTitle: string
  previousRevision: number | null
  fileName: string
  format: SubtitleFormat
  sourceBytes: number
  sourceSha256: string
  options: SubtitleImportOptions
  encoding: ResolvedSubtitleImportEncoding | null
  status: 'ready' | 'encoding-required' | 'invalid'
  errors: string[]
  metadata: TimedSubtitleMetadata | null
  durationMs: number | null
  coverage: { ranges: number; coveredMs: number; firstMs: number; lastMs: number } | null
  page: number
  pages: number
  rows: TranscriptSegment[]
}
export type SubtitleImportSelection =
  { canceled: true } | { canceled: false; preview: SubtitleImportPreview }
export interface SubtitleImportResult {
  state: TranscriptState
  replayed: boolean
}
