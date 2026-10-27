import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Episode } from '../shared/contracts'
import {
  MAX_TRANSCRIPT_BYTES,
  MAX_SEGMENTS,
  validateTranscript,
  type TranscriptDocument,
  type TranscriptRequest,
  type TranscriptState,
} from '../shared/transcript'
import type {
  ResolvedSubtitleImportEncoding,
  SubtitleImportResult,
  TimedSubtitleMetadata,
  TranscriptImportBaseline,
} from '../shared/subtitle-import'
import type { SubtitleFormat } from '../shared/subtitles'
import { AppError, isId } from '../shared/validation'

export const SUBTITLE_IMPORT_SCHEMA = `
CREATE TABLE subtitle_import_sources (
 transcript_id TEXT PRIMARY KEY REFERENCES transcripts(id) ON DELETE CASCADE,
 episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,audio_hash TEXT NOT NULL,
 import_revision INTEGER NOT NULL CHECK(import_revision>0),file_name TEXT NOT NULL,
 format TEXT NOT NULL CHECK(format IN ('srt','vtt')),
 encoding TEXT NOT NULL CHECK(encoding IN ('utf-8','utf-16le','utf-16be','gb18030','big5')),
 source_bytes BLOB NOT NULL CHECK(length(source_bytes) BETWEEN 1 AND 16777216),
 source_sha256 TEXT NOT NULL,metadata_json TEXT NOT NULL,offset_ms INTEGER NOT NULL,
 document_hash TEXT NOT NULL,created_at TEXT NOT NULL,
 UNIQUE(episode_id,audio_hash)
) STRICT;
CREATE TABLE subtitle_import_commands (
 command_id TEXT PRIMARY KEY,token TEXT NOT NULL UNIQUE,preview_revision INTEGER NOT NULL,
 payload_hash TEXT NOT NULL,episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
 audio_hash TEXT NOT NULL,created_at TEXT NOT NULL
) STRICT;
`

export interface SubtitleImportSource {
  fileName: string
  format: SubtitleFormat
  encoding: ResolvedSubtitleImportEncoding
  bytes: Buffer
  sha256: string
  metadata: TimedSubtitleMetadata
  offsetMs: number
}
export interface CommitSubtitleImport {
  target: TranscriptRequest
  baseline: TranscriptImportBaseline
  document: TranscriptDocument
  token: string
  previewRevision: number
  commandId: string
  source: SubtitleImportSource
}
export interface ReplaySubtitleImport {
  token: string
  revision: number
  commandId: string
}
export interface StoredSubtitleImportSource extends SubtitleImportSource, TranscriptRequest {
  transcriptId: string
  importRevision: number
  importedDocumentHash: string
  importedAt: string
}
interface Host {
  episode(id: string): Episode | undefined
  transcript(id: string, hash: string): TranscriptState
  /** Writes inside the import transaction; clears old history and import origin. */
  write(id: string, document: TranscriptDocument): TranscriptState
  notify(target: TranscriptRequest): void
}

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value
function invalid(message: string): never {
  throw new AppError('INVALID_REQUEST', message)
}
function conflict(): never {
  throw new AppError('CONFLICT', '当前文稿或导入预览已变化，请重新预览后导入。')
}
function identity(request: ReplaySubtitleImport): void {
  if (
    !isId(request.token) ||
    !isId(request.commandId) ||
    !Number.isSafeInteger(request.revision) ||
    request.revision < 1 ||
    request.revision > 1e9
  )
    invalid('字幕导入预览身份无效。')
}
function checkedMetadata(value: TimedSubtitleMetadata, source: SubtitleImportSource): string {
  const keys = [
    'cueCount',
    'outputSegments',
    'overlappingCues',
    'overlapSegments',
    'multilineCues',
    'markupCues',
    'inlineTimestamps',
    'notes',
    'styles',
    'regions',
    'settingsCues',
    'documentBytes',
  ] as const
  const exact = (item: unknown, fields: readonly string[]): item is Record<string, unknown> =>
    !!item &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    Object.keys(item).length === fields.length &&
    fields.every((field) => Object.hasOwn(item, field))
  if (
    !exact(value, ['format', ...keys, 'warnings']) ||
    value.format !== source.format ||
    keys.some(
      (key) =>
        !Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > MAX_TRANSCRIPT_BYTES,
    ) ||
    value.cueCount < 1 ||
    value.cueCount > MAX_SEGMENTS ||
    value.outputSegments < 1 ||
    value.outputSegments > MAX_SEGMENTS ||
    value.overlappingCues > value.cueCount ||
    value.overlapSegments > value.outputSegments ||
    value.multilineCues > value.cueCount ||
    value.markupCues > value.cueCount ||
    value.settingsCues > value.cueCount ||
    !Array.isArray(value.warnings) ||
    value.warnings.length > 32 ||
    new Set(value.warnings.map((warning) => warning?.code)).size !== value.warnings.length ||
    value.warnings.some(
      (warning) =>
        !exact(warning, ['code', 'count', 'firstLine']) ||
        typeof warning.code !== 'string' ||
        !warning.code.trim() ||
        warning.code.length > 100 ||
        !Number.isSafeInteger(warning.count) ||
        warning.count < 1 ||
        warning.count > MAX_TRANSCRIPT_BYTES ||
        (warning.firstLine !== null &&
          (!Number.isSafeInteger(warning.firstLine) ||
            warning.firstLine < 1 ||
            warning.firstLine > MAX_TRANSCRIPT_BYTES + 1)),
    )
  )
    invalid('字幕导入来源统计无效。')
  const encoded = JSON.stringify(value)
  if (Buffer.byteLength(encoded) > 256 * 1024) invalid('字幕导入来源统计过大。')
  return encoded
}
function checkedDocument(
  value: TranscriptDocument,
  target: TranscriptRequest,
  duration: number | null,
) {
  const document = validateTranscript(value, target.audioHash, duration)
  let size = Buffer.byteLength(JSON.stringify({ ...document, coverage: [], segments: [] }))
  for (const entries of [document.coverage, document.segments])
    for (const [index, entry] of entries.entries()) {
      size += Buffer.byteLength(JSON.stringify(entry)) + Number(index > 0)
      if (size > MAX_TRANSCRIPT_BYTES)
        throw new AppError('INVALID_TRANSCRIPT', '转换后的整集字幕超过 16 MiB，未导入。')
    }
  return { document, encoded: JSON.stringify(document) }
}

/** Atomic raw-source provenance and formal baseline import on LibraryStore's connection. */
export class SubtitleImportStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly host: Host,
  ) {}

  baseline(target: TranscriptRequest): TranscriptImportBaseline {
    const episode = this.host.episode(target.episodeId)
    if (!episode || episode.contentHash !== target.audioHash)
      throw new AppError('FILE_CHANGED', '音频版本已变化或分集已移除。')
    const current = this.db
      .prepare(
        'SELECT id,revision,document_json FROM transcripts WHERE episode_id=? AND audio_hash=?',
      )
      .get(target.episodeId, target.audioHash)
    const row =
      current ??
      this.db
        .prepare(
          'SELECT id,revision,document_json FROM transcripts WHERE episode_id=? ORDER BY imported_at DESC,rowid DESC LIMIT 1',
        )
        .get(target.episodeId)
    return {
      status: current ? 'ready' : row ? 'stale' : 'missing',
      transcriptId: row ? String(row.id) : null,
      revision: row ? Number(row.revision) : null,
      documentHash: row ? hash(String(row.document_json)) : null,
    }
  }

  /** Called only from an existing baseline-write transaction, never manual history replay. */
  clear(target: TranscriptRequest): void {
    this.db
      .prepare('DELETE FROM subtitle_import_sources WHERE episode_id=? AND audio_hash=?')
      .run(target.episodeId, target.audioHash)
  }

  source(target: TranscriptRequest): StoredSubtitleImportSource | null {
    const row = this.db
      .prepare('SELECT * FROM subtitle_import_sources WHERE episode_id=? AND audio_hash=?')
      .get(target.episodeId, target.audioHash)
    return row
      ? {
          episodeId: target.episodeId,
          audioHash: target.audioHash,
          transcriptId: String(row.transcript_id),
          importRevision: Number(row.import_revision),
          fileName: String(row.file_name),
          format: row.format as SubtitleFormat,
          encoding: row.encoding as ResolvedSubtitleImportEncoding,
          bytes: Buffer.from(row.source_bytes as Uint8Array),
          sha256: String(row.source_sha256),
          metadata: JSON.parse(String(row.metadata_json)) as TimedSubtitleMetadata,
          offsetMs: Number(row.offset_ms),
          importedDocumentHash: String(row.document_hash),
          importedAt: String(row.created_at),
        }
      : null
  }

  private command(request: ReplaySubtitleImport) {
    identity(request)
    const row = this.db
      .prepare('SELECT * FROM subtitle_import_commands WHERE command_id=?')
      .get(request.commandId)
    if (row) {
      if (row.token !== request.token || row.preview_revision !== request.revision) conflict()
      return row
    }
    if (this.db.prepare('SELECT 1 FROM subtitle_import_commands WHERE token=?').get(request.token))
      conflict()
    return null
  }

  replay(request: ReplaySubtitleImport): SubtitleImportResult | null {
    const row = this.command(request)
    return row
      ? {
          state: this.host.transcript(String(row.episode_id), String(row.audio_hash)),
          replayed: true,
        }
      : null
  }

  commit(request: CommitSubtitleImport): SubtitleImportResult {
    const source = request.source
    identity({
      token: request.token,
      revision: request.previewRevision,
      commandId: request.commandId,
    })
    if (
      !source ||
      !Buffer.isBuffer(source.bytes) ||
      !source.bytes.length ||
      source.bytes.length > MAX_TRANSCRIPT_BYTES ||
      typeof source.fileName !== 'string' ||
      !source.fileName.trim() ||
      source.fileName.length > 255 ||
      /[\\/]/u.test(source.fileName) ||
      source.fileName.includes('\0') ||
      !['srt', 'vtt'].includes(source.format) ||
      !['utf-8', 'utf-16le', 'utf-16be', 'gb18030', 'big5'].includes(source.encoding) ||
      (source.format === 'vtt' && source.encoding !== 'utf-8') ||
      !Number.isSafeInteger(source.offsetMs) ||
      Math.abs(source.offsetMs) > 3.6e10
    )
      invalid('字幕导入原始来源无效或超过 16 MiB。')
    const bytes = Buffer.from(source.bytes),
      sourceHash = hash(bytes),
      metadata = checkedMetadata(source.metadata, source),
      converted = checkedDocument(request.document, request.target, null),
      documentHash = hash(converted.encoded),
      payloadHash = hash(
        JSON.stringify(
          canonical({
            target: request.target,
            baseline: request.baseline,
            documentHash,
            source: { ...source, bytes: undefined, sha256: sourceHash, sizeBytes: bytes.length },
          }),
        ),
      )
    if (source.sha256 !== sourceHash) invalid('字幕来源 SHA256 校验失败，未导入。')
    this.db.exec('BEGIN IMMEDIATE')
    let result: SubtitleImportResult
    try {
      const command = this.command({
        token: request.token,
        revision: request.previewRevision,
        commandId: request.commandId,
      })
      if (command) {
        if (command.payload_hash !== payloadHash) conflict()
        result = {
          state: this.host.transcript(String(command.episode_id), String(command.audio_hash)),
          replayed: true,
        }
      } else {
        const current = this.baseline(request.target)
        if (
          JSON.stringify(current) !==
          JSON.stringify({
            status: request.baseline.status,
            transcriptId: request.baseline.transcriptId,
            revision: request.baseline.revision,
            documentHash: request.baseline.documentHash,
          })
        )
          conflict()
        validateTranscript(
          converted.document,
          request.target.audioHash,
          this.host.episode(request.target.episodeId)!.durationMs,
        )
        if (
          source.metadata.outputSegments !== converted.document.segments.length ||
          source.metadata.documentBytes !== Buffer.byteLength(converted.encoded)
        )
          invalid('字幕转换统计与正式稿不一致，未导入。')
        const state = this.host.write(request.target.episodeId, converted.document)
        if (state.status !== 'ready') throw new AppError('INTERNAL', '字幕写入后未能读取。')
        this.db
          .prepare('UPDATE transcription_jobs SET auto_apply=0 WHERE episode_id=? AND audio_hash=?')
          .run(request.target.episodeId, request.target.audioHash)
        const now = new Date().toISOString()
        this.db
          .prepare('INSERT INTO subtitle_import_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(
            state.transcript.id,
            request.target.episodeId,
            request.target.audioHash,
            state.transcript.revision,
            source.fileName,
            source.format,
            source.encoding,
            bytes,
            sourceHash,
            metadata,
            source.offsetMs,
            documentHash,
            now,
          )
        this.db
          .prepare('INSERT INTO subtitle_import_commands VALUES(?,?,?,?,?,?,?)')
          .run(
            request.commandId,
            request.token,
            request.previewRevision,
            payloadHash,
            request.target.episodeId,
            request.target.audioHash,
            now,
          )
        result = { state, replayed: false }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
    if (!result.replayed) this.host.notify(request.target)
    return result
  }
}
