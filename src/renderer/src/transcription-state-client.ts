import type { Result } from '../../shared/contracts'
import type { TranscriptRequest, TranscriptState } from '../../shared/transcript'
import type {
  TranscriptionState,
  TranscriptionSyncRequest,
  TranscriptionSyncState,
} from '../../shared/transcription'

interface Entry {
  epoch: number
  state?: TranscriptionState
  pending?: Promise<Result<TranscriptionState>>
}

// Keep at most two idle full documents. Concurrent subscribers share one read;
// an invalidation during that read must be followed by a fresh version check.
export class TranscriptionStateClient {
  private readonly entries = new Map<string, Entry>()
  constructor(
    private readonly sync: (
      request: TranscriptionSyncRequest,
    ) => Promise<Result<TranscriptionSyncState>>,
    private readonly capacity = 2,
  ) {}

  private key(target: TranscriptRequest) {
    return `${target.episodeId}:${target.audioHash}`
  }
  invalidate(target: TranscriptRequest) {
    const entry = this.entries.get(this.key(target))
    if (entry) entry.epoch++
  }
  read(target: TranscriptRequest): Promise<Result<TranscriptionState>> {
    const key = this.key(target)
    const entry = this.entries.get(key) ?? { epoch: 0 }
    this.entries.delete(key)
    this.entries.set(key, entry)
    if (entry.pending) return entry.pending
    const pending = this.load(target, entry).finally(() => {
      entry.pending = undefined
      for (const [candidate, value] of this.entries) {
        if (this.entries.size <= this.capacity) break
        if (!value.pending) this.entries.delete(candidate)
      }
    })
    entry.pending = pending
    return pending
  }
  private async load(target: TranscriptRequest, entry: Entry): Promise<Result<TranscriptionState>> {
    let retriedFailure = false
    while (true) {
      const epoch = entry.epoch
      const previous = entry.state?.transcript
      const known =
        previous?.status === 'ready'
          ? { id: previous.transcript.id, revision: previous.transcript.revision }
          : undefined
      let response: Result<TranscriptionSyncState>
      try {
        response = await this.sync({ ...target, ...(known ? { knownTranscript: known } : {}) })
      } catch (error) {
        if (epoch !== entry.epoch && !retriedFailure) {
          retriedFailure = true
          continue
        }
        throw error
      }
      if (!response.ok) {
        // A newer notification may have arrived while this failed request was
        // in flight. Give that change one fresh read, without retrying a stable
        // failure forever while progress notifications continue to arrive.
        if (epoch !== entry.epoch && !retriedFailure) {
          retriedFailure = true
          continue
        }
        return response
      }
      let transcript: TranscriptState
      if (response.value.transcript.status === 'unchanged') {
        const version = response.value.transcript.version
        if (
          previous?.status === 'ready' &&
          previous.transcript.id === version.id &&
          previous.transcript.revision === version.revision
        ) {
          transcript = previous
        } else {
          // A lost/evicted local document cannot be reconstructed from a version.
          response = await this.sync(target)
          if (!response.ok) return response
          if (response.value.transcript.status === 'unchanged')
            throw new Error('An unconditional transcript read returned no document')
          transcript = response.value.transcript
        }
      } else {
        transcript = response.value.transcript
        if (
          previous?.status === 'ready' &&
          transcript.status === 'ready' &&
          previous.transcript.id === transcript.transcript.id &&
          previous.transcript.revision === transcript.transcript.revision
        )
          transcript = previous
      }
      const next = { ...response.value, transcript }
      const old = entry.state
      // Compare only small metadata; never serialize the document to detect equality.
      entry.state =
        old &&
        old.transcript === transcript &&
        old.configured === next.configured &&
        JSON.stringify(old.job) === JSON.stringify(next.job) &&
        JSON.stringify(old.subtitleStatus) === JSON.stringify(next.subtitleStatus)
          ? old
          : next
      if (epoch === entry.epoch) return { ok: true, value: entry.state }
    }
  }
}

export const transcriptionStateClient = new TranscriptionStateClient((request) =>
  window.desktop.syncTranscription(request),
)
