import snapshot from './engine-reference.json'
import type { SubtitlePreparation } from './transcription'

export interface EngineReferenceProfile {
  engine: SubtitlePreparation['engine']
  device: SubtitlePreparation['device']
  completedSamples: number
  editDistance: number
  cer: number
  report: string
  reportSha256: string
  documentsSha256: string
  checkpointsSha256: string
}

export interface EngineReferenceDataset {
  id: string
  label: string
  source: string
  samples: number
  referenceCharacters: number
  durationMs: number
  manifestSha256: string
  scope: string
  summaries: { path: string; sha256: string }[]
  profiles: EngineReferenceProfile[]
}

// Generated from frozen real-worker reports by scripts/audit-engine-reference.py.
// This reference never selects an engine or changes saved book settings.
export const engineReference = snapshot as Omit<typeof snapshot, 'datasets'> & {
  datasets: EngineReferenceDataset[]
}
