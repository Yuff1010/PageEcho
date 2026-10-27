export interface BookSkips {
  introMs: number
  outroMs: number
}

export interface Bookmark {
  id: string
  bookId: string
  episodeId: string
  audioHash: string
  episodeTitle: string
  positionMs: number
  note: string
  createdAt: string
  stale: boolean
}

export interface SaveBookmark {
  episodeId: string
  audioHash: string
  positionMs: number
  note: string
}

export type SleepTimer = { mode: 'minutes'; deadline: number } | { mode: 'chapter' } | null

export function listeningRange(durationMs: number, skips: BookSkips) {
  const valid = durationMs > 0 && skips.introMs + skips.outroMs < durationMs
  return {
    startMs: valid ? skips.introMs : 0,
    endMs: valid ? durationMs - skips.outroMs : durationMs,
    skipsDisabled: !valid && (skips.introMs > 0 || skips.outroMs > 0),
  }
}
