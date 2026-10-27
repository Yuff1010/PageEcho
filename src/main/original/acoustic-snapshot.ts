import type { OriginalAcousticRequest, AcousticRange } from '../../shared/original-acoustic'

/** Input to the fixed text/audio CTC validator, independent of a book mapping. */
export interface AcousticTextSnapshot {
  audioHash: string
  device: 'cpu' | 'cuda'
  originalText: string
  textHash: string
  range: AcousticRange
  sentences: { ordinal: number; textStart: number; textEnd: number }[]
}
export interface OriginalAcousticSnapshot extends OriginalAcousticRequest, AcousticTextSnapshot {
  transcriptId: string
  transcriptRevision: number
  selection: { first: number; last: number }
  oldRange: AcousticRange
}
