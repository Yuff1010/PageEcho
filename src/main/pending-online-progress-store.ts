import type { DatabaseSync } from 'node:sqlite'
import type { Episode, ProgressUpdate } from '../shared/contracts'
import type {
  PendingOnlineCommit,
  PendingOnlinePosition,
  PendingOnlineProof,
} from '../shared/pending-online-progress'
import { AppError, isId } from '../shared/validation'

const MAX_BYTES = 256 * 1024 * 1024
const MAX_TIME = 3.6e10
const SHA = /^[0-9a-f]{64}$/
const invalid = (): never => {
  throw new AppError('INVALID_REQUEST', '播放会话或暂存进度已变化，请重新选择章节。')
}
const finite = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
function validProof(proof: PendingOnlineProof): boolean {
  return (
    !!proof &&
    Number.isSafeInteger(proof.bytes) &&
    Number.isSafeInteger(proof.totalBytes) &&
    proof.bytes >= 12 &&
    proof.totalBytes >= proof.bytes &&
    proof.totalBytes <= MAX_BYTES &&
    typeof proof.sha256 === 'string' &&
    SHA.test(proof.sha256)
  )
}

export const PENDING_ONLINE_PROGRESS_SCHEMA = `
  CREATE TABLE online_pending_progress (
    episode_id TEXT PRIMARY KEY REFERENCES online_episodes(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL CHECK(length(session_id)=36),
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
    position_ms REAL NOT NULL CHECK(position_ms BETWEEN 0 AND ${MAX_TIME}),
    duration_ms REAL CHECK(duration_ms BETWEEN 1 AND ${MAX_TIME}),
    rate REAL NOT NULL CHECK(rate BETWEEN 0.5 AND 3),
    volume REAL NOT NULL CHECK(volume BETWEEN 0 AND 1),
    prefix_bytes INTEGER NOT NULL CHECK(prefix_bytes>=12),
    prefix_sha256 TEXT NOT NULL CHECK(length(prefix_sha256)=64 AND prefix_sha256 NOT GLOB '*[^0-9a-f]*'),
    total_bytes INTEGER NOT NULL CHECK(total_bytes BETWEEN prefix_bytes AND ${MAX_BYTES}),
    saved_at INTEGER NOT NULL
  ) STRICT;
`

/** Private Main ownership; durable snapshots never grant a playback lease. */
export class PendingOnlineProgressStore {
  private lease?: { episodeId: string; sessionId: string; resumeRevision: number | null }
  constructor(
    private readonly db: DatabaseSync,
    private readonly episode: (id: string) => Episode | undefined,
  ) {}

  read(id: string): PendingOnlinePosition | null {
    const row = this.db
      .prepare(
        `SELECT episode_id AS episodeId, session_id AS sessionId, revision,
      position_ms AS positionMs,duration_ms AS durationMs,rate,volume,
      prefix_bytes AS bytes,prefix_sha256 AS sha256,total_bytes AS totalBytes
      FROM online_pending_progress WHERE episode_id=?`,
      )
      .get(id)
    if (!row) return null
    const result: PendingOnlinePosition = {
      episodeId: String(row.episodeId),
      sessionId: String(row.sessionId),
      revision: Number(row.revision),
      positionMs: Number(row.positionMs),
      durationMs: row.durationMs === null ? null : Number(row.durationMs),
      rate: Number(row.rate),
      volume: Number(row.volume),
      proof: {
        bytes: Number(row.bytes),
        sha256: String(row.sha256),
        totalBytes: Number(row.totalBytes),
      },
    }
    if (
      !isId(result.episodeId) ||
      !isId(result.sessionId) ||
      !Number.isSafeInteger(result.revision) ||
      result.revision < 1 ||
      !finite(result.positionMs, 0, MAX_TIME) ||
      (result.durationMs !== null && !finite(result.durationMs, 1, MAX_TIME)) ||
      !finite(result.rate, 0.5, 3) ||
      !finite(result.volume, 0, 1) ||
      !validProof(result.proof)
    )
      invalid()
    return result
  }

  begin(id: string, sessionId: string): { resume: PendingOnlinePosition | null } {
    if (!isId(id) || !isId(sessionId)) invalid()
    const episode = this.episode(id),
      resume = this.read(id)
    if (!episode?.online || (episode.contentHash && !resume)) invalid()
    if (this.lease?.sessionId === sessionId) invalid()
    this.lease = { episodeId: id, sessionId, resumeRevision: resume?.revision ?? null }
    return { resume }
  }

  end(sessionId: string): void {
    if (this.lease?.sessionId === sessionId) this.lease = undefined
  }

  private owned(id: string, sessionId: string): void {
    if (this.lease?.episodeId !== id || this.lease.sessionId !== sessionId) invalid()
  }

  save(update: ProgressUpdate, proof: PendingOnlineProof): void {
    this.owned(update.episodeId, update.sessionId)
    const episode = this.episode(update.episodeId)
    if (!episode?.online) return invalid()
    if (
      episode.contentHash ||
      !validProof(proof) ||
      !finite(update.positionMs, 0, MAX_TIME) ||
      (update.durationMs !== null && !finite(update.durationMs, 1, MAX_TIME)) ||
      !finite(update.rate, 0.5, 3) ||
      !finite(update.volume, 0, 1)
    )
      invalid()
    const previous = this.read(update.episodeId)
    if (previous && previous.revision === Number.MAX_SAFE_INTEGER) invalid()
    if (
      previous?.sessionId === update.sessionId &&
      (proof.totalBytes !== previous.proof.totalBytes ||
        proof.bytes < previous.proof.bytes ||
        (proof.bytes === previous.proof.bytes && proof.sha256 !== previous.proof.sha256))
    )
      invalid()
    const position = update.durationMs
      ? Math.min(update.positionMs, update.durationMs)
      : update.positionMs
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `INSERT INTO online_pending_progress
        (episode_id,session_id,revision,position_ms,duration_ms,rate,volume,prefix_bytes,prefix_sha256,total_bytes,saved_at)
        VALUES (?,?,1,?,?,?,?,?,?,?,?) ON CONFLICT(episode_id) DO UPDATE SET
          session_id=excluded.session_id,revision=online_pending_progress.revision+1,
          position_ms=excluded.position_ms,duration_ms=excluded.duration_ms,rate=excluded.rate,
          volume=excluded.volume,prefix_bytes=excluded.prefix_bytes,prefix_sha256=excluded.prefix_sha256,
          total_bytes=excluded.total_bytes,saved_at=excluded.saved_at`,
        )
        .run(
          update.episodeId,
          update.sessionId,
          position,
          update.durationMs,
          update.rate,
          update.volume,
          proof.bytes,
          proof.sha256,
          proof.totalBytes,
          Date.now(),
        )
      this.db
        .prepare('UPDATE books SET current_episode_id=?,last_played_at=? WHERE id=?')
        .run(update.episodeId, new Date().toISOString(), episode.bookId)
      this.db
        .prepare('UPDATE player_settings SET current_episode_id=?,rate=?,volume=?')
        .run(update.episodeId, update.rate, update.volume)
      this.db.exec('COMMIT')
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Called inside the complete-file registration transaction; no global selection writes. */
  transfer(
    id: string,
    audio: { sizeBytes: number; contentHash: string },
    commit: PendingOnlineCommit,
  ): void {
    if (!this.db.isTransaction || !SHA.test(audio.contentHash)) invalid()
    this.owned(id, commit.sessionId)
    const row = this.read(id)
    if (commit.kind === 'live') {
      if (row && row.sessionId !== commit.sessionId) invalid()
    } else if (commit.kind === 'resume') {
      if (
        !Number.isSafeInteger(commit.revision) ||
        this.lease?.resumeRevision !== commit.revision ||
        row?.revision !== commit.revision ||
        !validProof(commit.observedProof)
      )
        invalid()
    } else invalid()
    if (!row) return
    const matches =
      row.proof.totalBytes === audio.sizeBytes &&
      (commit.kind === 'live' ||
        (commit.observedProof.bytes === row.proof.bytes &&
          commit.observedProof.totalBytes === row.proof.totalBytes &&
          commit.observedProof.sha256 === row.proof.sha256))
    const current = this.db
      .prepare(
        'SELECT position_ms AS positionMs,duration_ms AS durationMs FROM episodes WHERE id=?',
      )
      .get(id)
    if (!current) return invalid()
    // A verified position saved meanwhile is newer evidence than a pending snapshot.
    if (matches && current.positionMs === 0) {
      const duration = current.durationMs === null ? row.durationMs : Number(current.durationMs)
      this.db
        .prepare('UPDATE episodes SET position_ms=?,duration_ms=? WHERE id=?')
        .run(duration ? Math.min(row.positionMs, duration) : row.positionMs, duration, id)
    }
    this.db
      .prepare('DELETE FROM online_pending_progress WHERE episode_id=? AND revision=?')
      .run(id, row.revision)
  }
}
