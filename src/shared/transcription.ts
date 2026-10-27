import type {
  TranscriptDocument,
  TranscriptState,
  TranscriptRead,
  TranscriptRequest,
  TranscriptVersion,
  TranscriptHeaderState,
} from './transcript'
import type { SubtitleStatusSnapshot } from './subtitle-status'

export interface SubtitlePreparation {
  mode: 'manual' | 'auto' | 'ahead'
  engine: 'whisperx' | 'paraformer'
  device: 'cpu' | 'cuda'
  prepareNext: boolean
}
export const DEFAULT_SUBTITLE_PREPARATION: SubtitlePreparation = {
  mode: 'auto',
  engine: 'whisperx',
  device: 'cpu',
  prepareNext: false,
}
// Audio time, independent of playback rate and model processing time.
export const SUBTITLE_LEAD_MS = 30_000

export type TranscriptionStatus =
  'queued' | 'running' | 'canceling' | 'completed' | 'failed' | 'canceled'
export interface TranscriptionJob {
  cpuThreads?: 1 | 2 | 4
  id: string
  episodeId: string
  audioHash: string
  engine: 'whisperx' | 'paraformer'
  device: 'cpu' | 'cuda'
  background: boolean
  status: TranscriptionStatus
  attempt: number
  stage: string
  processedUntilMs: number
  totalChunks: number
  completedChunks: number
  cacheHits: number
  issueCount: number
  autoApply: boolean
  appliedRevision: number
  previewRevision: number
  hasPreview: boolean
  createdAt: string
  updatedAt: string
  error: string | null
}
export interface StartTranscription {
  episodeId: string
  audioHash: string
  engine: TranscriptionJob['engine']
  device: TranscriptionJob['device']
}
export interface StartPreparedTranscription {
  episodeId: string
  audioHash: string
  sessionId: string
  settings: SubtitlePreparation
}
export interface CancelAutomaticSubtitles {
  episodeId: string
  audioHash: string
  sessionId: string
}
export interface StartAutomaticSubtitles extends CancelAutomaticSubtitles {
  explicit?: boolean
  positionMs?: number
}
export interface AutomaticSubtitlesResult {
  status:
    'started' | 'reused' | 'disabled' | 'stopped' | 'missing-component' | 'unavailable' | 'stale'
  settings: SubtitlePreparation | null
  message: string
  transcription: TranscriptionState | null
}
export interface TranscriptionState {
  configured: boolean
  job: TranscriptionJob | null
  transcript: TranscriptState
  subtitleStatus?: SubtitleStatusSnapshot
}
export interface TranscriptionSyncRequest extends TranscriptRequest {
  knownTranscript?: TranscriptVersion
}
export interface TranscriptionSyncState extends Omit<TranscriptionState, 'transcript'> {
  transcript: TranscriptRead
}
export interface TranscriptionSummaryState extends Omit<TranscriptionState, 'transcript'> {
  transcriptHeader: TranscriptHeaderState
}
export interface TranscriptionPreview {
  job: TranscriptionJob
  document: TranscriptDocument
}
export interface TranscriptEdit {
  episodeId: string
  audioHash: string
  revision: number
  segmentId: string
  text: string
}
export interface TranscriptionChange {
  episodeId: string
  audioHash: string
}
export const ACTIVE_JOB_STATUSES: TranscriptionStatus[] = ['queued', 'running', 'canceling']
