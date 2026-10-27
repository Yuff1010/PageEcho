import type { TranscriptRequest } from './transcript'

export interface ListeningReviewEntry {
  listened: boolean
  speech: 'unknown' | 'speech' | 'silence'
  spokenText: string | null
  namesChecked: boolean
  properNames: string | null
  sync: 'unknown' | 'aligned' | 'early' | 'late' | 'mixed' | 'not-applicable'
  humanStartMs: number | null
  humanEndMs: number | null
  notes: string | null
}

export interface ListeningReviewSample {
  id: string
  segmentId: string
  kind: 'fixed' | 'additional'
  fixedFractions: number[]
  targetStartMs: number
  targetEndMs: number
  clipStartMs: number
  clipEndMs: number
  machineText: string
  entry: ListeningReviewEntry
}

export interface ListeningReviewHeader {
  id: string
  episodeId: string
  audioHash: string
  transcriptId: string
  transcriptRevision: number
  createdAt: string
  updatedAt: string
  revision: number
  sampleCount: number
}

export interface ListeningReview extends ListeningReviewHeader {
  version: 1
  episodeTitle: string
  durationMs: number
  transcriptKind: 'manual' | 'transcript' | 'original'
  sourceProfile: {
    engine: 'whisperx' | 'paraformer'
    device: 'cpu' | 'cuda'
    jobId: string
    attempt: number
  } | null
  selectionPolicy: 'segment-index-15-50-85-v1'
  mediaUrl: string
  samples: ListeningReviewSample[]
}

export interface ListeningReviewSummary {
  totalSamples: number
  fixedSamples: number
  additionalSamples: number
  listenedSamples: number
  referenceSamples: number
  unknownReferenceSamples: number
  namesCheckedSamples: number
  syncJudgedSamples: number
  pairedBoundaries: number
  completeSamples: number
  reviewStatus: 'unreviewed' | 'partial-review' | 'review-data-complete'
  acceptance: 'not-evaluated'
}

export interface ListeningReviewState {
  status: 'missing' | 'ready' | 'stale'
  reason: string | null
  review: ListeningReview | null
  summary: ListeningReviewSummary | null
  history: ListeningReviewHeader[]
}

export interface ListeningReviewGet extends TranscriptRequest {
  reviewId?: string
}

export interface ListeningReviewPrepare extends TranscriptRequest {
  transcriptRevision: number
}

interface ListeningReviewSaveBase extends TranscriptRequest {
  reviewId: string
  revision: number
}

export type ListeningReviewSave = ListeningReviewSaveBase &
  (
    | { action: 'feedback'; sampleId: string; entry: ListeningReviewEntry }
    | { action: 'add-sample'; segmentId: string }
  )

export const MAX_LISTENING_REVIEW_SAMPLES = 100
export const LISTENING_REVIEW_TEXT_LIMITS = {
  spokenText: 2000,
  properNames: 1000,
  notes: 2000,
} as const

export function hasSpokenReference(value: string | null): boolean {
  return value !== null && /[\p{L}\p{N}]/u.test(value.normalize('NFKC'))
}

export function emptyListeningReviewEntry(): ListeningReviewEntry {
  return {
    listened: false,
    speech: 'unknown',
    spokenText: null,
    namesChecked: false,
    properNames: null,
    sync: 'unknown',
    humanStartMs: null,
    humanEndMs: null,
    notes: null,
  }
}

export function listeningReviewSummary(review: ListeningReview): ListeningReviewSummary {
  const samples = review.samples
  const reference = (entry: ListeningReviewEntry) =>
    entry.listened &&
    (entry.speech === 'silence' ||
      (entry.speech === 'speech' && hasSpokenReference(entry.spokenText)))
  const complete = (entry: ListeningReviewEntry) =>
    reference(entry) && entry.namesChecked && entry.sync !== 'unknown'
  const listenedSamples = samples.filter((sample) => sample.entry.listened).length
  const referenceSamples = samples.filter((sample) => reference(sample.entry)).length
  const completeSamples = samples.filter((sample) => complete(sample.entry)).length
  return {
    totalSamples: samples.length,
    fixedSamples: samples.filter((sample) => sample.kind === 'fixed').length,
    additionalSamples: samples.filter((sample) => sample.kind === 'additional').length,
    listenedSamples,
    referenceSamples,
    unknownReferenceSamples: samples.length - referenceSamples,
    namesCheckedSamples: samples.filter(
      (sample) => sample.entry.listened && sample.entry.namesChecked,
    ).length,
    syncJudgedSamples: samples.filter(
      (sample) => sample.entry.listened && sample.entry.sync !== 'unknown',
    ).length,
    pairedBoundaries: samples.filter(
      (sample) =>
        sample.entry.listened &&
        sample.entry.humanStartMs !== null &&
        sample.entry.humanEndMs !== null,
    ).length,
    completeSamples,
    reviewStatus: !listenedSamples
      ? 'unreviewed'
      : completeSamples === samples.length && samples.length > 0
        ? 'review-data-complete'
        : 'partial-review',
    acceptance: 'not-evaluated',
  }
}
