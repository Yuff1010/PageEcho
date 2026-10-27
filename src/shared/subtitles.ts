import type { TranscriptRequest } from './transcript'

export type SubtitleFormat = 'srt' | 'vtt'
export type SubtitleSource = TranscriptRequest & {
  transcriptId: string
  transcriptRevision: number
} & (
    { source: 'transcript' } | { source: 'original'; originalId: string; alignmentRevision: number }
  )
export type SubtitleExportRequest = SubtitleSource & { format: SubtitleFormat }
export type SubtitleExportResult =
  | { canceled: true }
  | { canceled: false; fileName: string; cueCount: number; skippedSegments: number }
