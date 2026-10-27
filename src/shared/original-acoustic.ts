import type { OriginalTarget } from './original'

export const ORIGINAL_ACOUSTIC_PROTOCOL = 1
export const ORIGINAL_ACOUSTIC_CONTRACT = 'original-ctc-support-v1'
export const MAX_ACOUSTIC_TEXT_LENGTH = 1000
export const MAX_ACOUSTIC_RANGE_MS = 60_000

export interface OriginalAcousticRequest extends OriginalTarget {
  originalId: string
  revision: number
  segmentId: string
  device: 'cpu' | 'cuda'
}
export interface AcousticRange {
  startMs: number
  endMs: number
}
export interface AcousticCharacter extends AcousticRange {
  text: string
  textStart: number
  textEnd: number
  score: number
}
export interface AcousticSentenceTime extends AcousticRange {
  ordinal: number
}
export interface AcousticReason {
  code: string
  message: string
}
export interface AcousticEvidence {
  lexicalCharacters: number
  timedCharacters: number
  characterCoverage: number
  audioRms: number | null
  freePathCharacters: number | null
  freePathEditDistance: number | null
  minTokenPosterior: number | null
  meanTokenPosterior: number | null
  // Model diagnostic, never a probability of human correctness.
  confidence: number | null
}
export interface OriginalAcousticResult {
  status: 'accepted' | 'rejected'
  contract: string
  range: AcousticRange
  startMs: number | null
  endMs: number | null
  characters: AcousticCharacter[]
  sentenceTimes: AcousticSentenceTime[]
  evidence: AcousticEvidence
  reasons: AcousticReason[]
  diagnostics?: {
    ctcContract: string
    qualityPolicy: string
    thresholds: Record<string, number>
    elapsedMs: number
    freePathErrorRate: number | null
    maxUnexplainedPosterior: number | null
  }
}
export interface OriginalAcousticHistory {
  id: string
  contract: string
  textHash: string
  // First manually confirmed coordinates survive repeated acoustic proposals.
  manualRange: AcousticRange
  sentenceTimes: AcousticSentenceTime[]
  appliedAt: string
  device: 'cpu' | 'cuda'
  evidence?: AcousticEvidence
  diagnostics?: OriginalAcousticResult['diagnostics']
}
export interface OriginalAcousticJob extends OriginalTarget {
  id: string
  originalId: string
  alignmentRevision: number
  transcriptId: string
  transcriptRevision: number
  segmentId: string
  device: 'cpu' | 'cuda'
  originalText: string
  selection: { first: number; last: number }
  oldRange: AcousticRange
  status: 'running' | 'ready' | 'rejected' | 'failed' | 'canceled' | 'applied'
  stage: 'checking-components' | 'loading' | 'aligning' | 'done'
  createdAt: string
  result: OriginalAcousticResult | null
  error: string | null
}
export interface OriginalAcousticState {
  configured: boolean
  job: OriginalAcousticJob | null
}
export interface ApplyOriginalAcousticRequest {
  id: string
  revision: number
}
export interface RestoreOriginalAcousticRequest extends OriginalTarget {
  originalId: string
  revision: number
  segmentId: string
  historyId: string
}
