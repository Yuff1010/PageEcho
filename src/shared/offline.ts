import type { SourceId } from './sources'
import type { TranscriptDocument } from './transcript'

export const MAX_OFFLINE_ITEMS = 1000
export const MAX_ACTIVE_OFFLINE_PLANS = 5
export const OFFLINE_ITEMS_PAGE_SIZE = 100
export const OFFLINE_PLAN_PAGE_SIZE = 25
export const MAX_OFFLINE_AUDIO_BUDGET_BYTES = 1024 ** 4
export type OfflineSelection =
  | { kind: 'all' }
  | { kind: 'range'; from: number; to: number }
  | { kind: 'ids'; episodeIds: string[] }
export interface OfflineProfile {
  engine: 'paraformer' | 'whisperx'
  device: 'cpu' | 'cuda'
}
export type OfflinePlanStatus =
  'queued' | 'running' | 'paused' | 'blocked' | 'completed' | 'completed-with-issues' | 'canceled'
export type OfflineItemStatus =
  | 'queued'
  | 'downloading'
  | 'waiting-foreground'
  | 'audio-ready'
  | 'transcribing'
  | 'ready'
  | 'needs-attention'
  | 'failed'
  | 'canceled'
export interface OfflineSourceIdentity {
  sourceId: SourceId
  bookId: string
  episodeId: string
}
export interface OfflineCounts {
  total: number
  audioReady: number
  subtitleReady: number
  needsAttention: number
  failed: number
  canceled: number
}
export interface OfflinePlan {
  id: string
  /** User-control generation; ordinary item progress does not increment this. */
  revision: number
  bookId: string
  bookTitle: string
  scope: OfflineSelection['kind']
  profile: OfflineProfile
  audioBudgetBytes: number
  status: OfflinePlanStatus
  createdAt: string
  updatedAt: string
  error: string | null
  retentionReleasedAt: string | null
  counts: OfflineCounts
}
/** Renderer DTO. Managed audio paths and download URLs never cross IPC. */
export interface OfflinePlanItem {
  id: string
  planId: string
  ordinal: number
  episodeId: string
  episodeTitle: string
  episodeOrder: number
  source: OfflineSourceIdentity | null
  initialHash: string | null
  audioHash: string | null
  audioReady: boolean
  mediaBytes: number | null
  durationMs: number | null
  status: OfflineItemStatus
  attempt: number
  error: string | null
  jobId: string | null
  subtitleSource: TranscriptDocument['kind'] | null
  subtitleRevision: number | null
  updatedAt: string
}
export interface OfflinePlanPage {
  page: number
  total: number
  plans: OfflinePlan[]
}
export interface OfflineItemPage {
  page: number
  total: number
  items: OfflinePlanItem[]
}
export interface OfflinePlanDetail {
  plan: OfflinePlan
  items: OfflineItemPage
}
export interface OfflinePreviewItem {
  episodeId: string
  title: string
  order: number
  online: boolean
  cached: boolean
  audioHash: string | null
  mediaBytes: number | null
  subtitle: 'missing' | 'partial' | 'complete' | 'unknown-duration'
  conflict: string | null
}
export interface PreviewOfflinePlanRequest {
  requestId: string
  bookId: string
  selection: OfflineSelection
  profile: OfflineProfile
  audioBudgetBytes: number
}
export interface OfflinePlanPreview {
  token: string
  expiresAt: number
  bookId: string
  bookTitle: string
  selection: OfflineSelection
  profile: OfflineProfile
  audioBudgetBytes: number
  catalogComplete: boolean
  totalItems: number
  knownAudioBytes: number
  unknownAudioItems: number
  existingAudioItems: number
  completeSubtitleItems: number
  partialSubtitleItems: number
  freeBytes: number
  conflicts: string[]
  items: OfflinePreviewItem[]
}
export type UpdateOfflinePlanRequest = { id: string; revision: number } & (
  | { action: 'pause' | 'resume' | 'cancel' | 'retry-failed' }
  | { action: 'set-budget'; audioBudgetBytes: number }
)
export interface OfflineReleasePreview {
  token: string
  id: string
  revision: number
  files: number
  bytes: number
  sharedFiles: number
}
