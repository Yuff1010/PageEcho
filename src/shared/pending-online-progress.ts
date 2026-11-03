/** A prefix received and written by Main. This is never a full audioHash. */
export interface PendingOnlineProof {
  bytes: number
  sha256: string
  totalBytes: number
}

export interface PendingOnlinePosition {
  episodeId: string
  sessionId: string
  revision: number
  positionMs: number
  durationMs: number | null
  rate: number
  volume: number
  proof: PendingOnlineProof
}

export type PendingOnlineCommit =
  | { kind: 'live'; sessionId: string }
  | {
      kind: 'resume'
      sessionId: string
      revision: number
      observedProof: PendingOnlineProof
    }
