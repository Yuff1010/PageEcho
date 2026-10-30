import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { Book, Episode, ProgressUpdate, SelectedFile } from '../shared/contracts'
import type { ScannedBook } from './files'
import {
  validateTranscript,
  isSmallTranscriptEdit,
  type TranscriptDocument,
  type TranscriptState,
  type TranscriptRequest,
  type TranscriptVersion,
  type TranscriptRead,
  type TranscriptHeaderState,
  type StoredTranscript,
  type TimeRange,
} from '../shared/transcript'
import type {
  StartTranscription,
  TranscriptionJob,
  TranscriptionStatus,
  TranscriptEdit,
  SubtitlePreparation,
} from '../shared/transcription'
import type { AsrSnapshot } from './asr-process'
import { mergeJobDocument, processedPrefix } from '../shared/job-document'
import { createSubtitleStatusSnapshot, type SubtitleStatusTarget } from '../shared/subtitle-status'
import type { Bookmark, SaveBookmark, BookSkips } from '../shared/listening'
import type { TaskQuery, TaskPage, TaskSummary } from '../shared/maintenance'
import { AppError } from '../shared/validation'
import { ORIGINAL_SCHEMA, OriginalStore } from './original/store'
import { READING_SCHEMA, ReadingStore } from './reading-store'
import { BookLinkStore } from './book-links'
import {
  SUBTITLE_IMPORT_SCHEMA,
  SubtitleImportStore,
  type CommitSubtitleImport,
  type ReplaySubtitleImport,
} from './subtitle-import-store'
import {
  TRANSCRIPT_EDIT_SCHEMA,
  TranscriptEditStore,
  type PreparedTranscriptReplacement,
} from './transcript-edit-store'
import type {
  TranscriptEditRequest,
  TranscriptHistoryRequest,
  TranscriptReplacementRequest,
} from '../shared/transcript-editing'
import {
  OFFLINE_SCHEMA,
  OfflineStore,
  type CreateOfflinePlan,
  type OfflineItemContext,
  type OfflineFileIdentity,
  type OfflineMediaIdentity,
  type UpdateOfflineItem,
} from './offline-store'
import type { UpdateOfflinePlanRequest } from '../shared/offline'
import type {
  SavedProcessingResources,
  UpdateProcessingPolicy,
  PauseProcessing,
} from '../shared/processing-resources'
import {
  DEFAULT_SOURCE_PREPARATION,
  isSourceId,
  type SourcePreparation,
  type SourceBook,
  type SourceEpisode,
} from '../shared/sources'
import {
  replaceRegion,
  readRegionList,
  MAX_REGIONS,
  type RegionUpdate,
  type TranscriptRegions,
} from '../shared/regions'

export interface FileMetadata {
  path: string
  name: string
  sizeBytes: number
  modifiedAt: number
}

const SCHEMA_VERSION = 17

export interface StoredTranscriptionJob extends TranscriptionJob {
  configurationHash: string | null
  rangeEndMs: number | null
}
export type UnsavedJobTerminal = Pick<StoredTranscriptionJob, 'id' | 'attempt' | 'status' | 'error'>

const JOB_COLUMNS = `id, episode_id AS episodeId, audio_hash AS audioHash, engine, device, cpu_threads AS cpuThreads, background, status,
  attempt, stage, processed_until_ms AS processedUntilMs, total_chunks AS totalChunks,
  completed_chunks AS completedChunks, cache_hits AS cacheHits, issue_count AS issueCount,
  auto_apply AS autoApply, applied_revision AS appliedRevision, preview_revision AS previewRevision,
  typeof(document_json) <> 'null' AS hasPreview, created_at AS createdAt, updated_at AS updatedAt,
  error_text AS error, configuration_hash AS configurationHash, range_end_ms AS rangeEndMs`

export interface StoredAudio extends FileMetadata {
  id: string
  contentHash: string
}

export class LibraryStore {
  private readonly db: DatabaseSync
  readonly originals: OriginalStore
  readonly reading: ReadingStore
  readonly bookLinks: BookLinkStore
  private readonly offline: OfflineStore
  private readonly editing: TranscriptEditStore
  private readonly subtitleImports: SubtitleImportStore
  private readSnapshotDepth = 0
  private readSnapshotVersion?: number
  private readonly coverageCache = new Map<
    string,
    { revision: number; dataVersion: number; coverage: TimeRange[] }
  >()
  private acceptedSnapshot?: {
    id: string
    revision: number
    dataVersion: number
    encoded: string
    document: TranscriptDocument
  }

  constructor(filename: string) {
    this.db = new DatabaseSync(filename)
    try {
      this.db.exec('PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON;')
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version as number
      if (version > SCHEMA_VERSION) {
        throw new Error('数据库来自更新版本的应用，请升级应用后再打开。')
      }
      this.db.exec('PRAGMA journal_mode = WAL;')
      if (version === 0) {
        this.db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE selected_files (
            id TEXT PRIMARY KEY,
            locator TEXT NOT NULL UNIQUE COLLATE NOCASE,
            name TEXT NOT NULL,
            size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
            modified_at REAL NOT NULL,
            selected_at TEXT NOT NULL
          ) STRICT;
          PRAGMA user_version = 1;
          COMMIT;
        `)
      }
      if (version < 2)
        this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE books (
          id TEXT PRIMARY KEY, title TEXT NOT NULL,
          source_locator TEXT NOT NULL UNIQUE COLLATE NOCASE,
          kind TEXT NOT NULL CHECK(kind IN ('file', 'folder')),
          imported_at TEXT NOT NULL, last_played_at TEXT, current_episode_id TEXT
        ) STRICT;
        CREATE TABLE episodes (
          id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
          title TEXT NOT NULL, sort_order INTEGER NOT NULL,
          locator TEXT NOT NULL COLLATE NOCASE, size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
          modified_at REAL NOT NULL, content_hash TEXT NOT NULL,
          duration_ms REAL, position_ms REAL NOT NULL DEFAULT 0 CHECK(position_ms >= 0),
          UNIQUE(book_id, locator)
        ) STRICT;
        CREATE TABLE player_settings (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          current_episode_id TEXT, rate REAL NOT NULL DEFAULT 1, volume REAL NOT NULL DEFAULT 1
        ) STRICT;
        INSERT INTO player_settings(singleton) VALUES (1);
        PRAGMA user_version = 2;
        COMMIT;
      `)
      if (version < 3)
        this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE transcripts (
          id TEXT PRIMARY KEY,
          episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
          audio_hash TEXT NOT NULL, document_json TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1, imported_at TEXT NOT NULL,
          UNIQUE(episode_id, audio_hash)
        ) STRICT;
        PRAGMA user_version = 3;
        COMMIT;
      `)
      if (version < 4)
        this.db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE transcription_jobs (
            id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
            audio_hash TEXT NOT NULL, engine TEXT NOT NULL CHECK(engine IN ('whisperx','paraformer')),
            device TEXT NOT NULL CHECK(device IN ('cpu','cuda')),
            status TEXT NOT NULL CHECK(status IN ('queued','running','canceling','completed','failed','canceled')),
            attempt INTEGER NOT NULL DEFAULT 1, stage TEXT NOT NULL DEFAULT 'queued',
            processed_until_ms INTEGER NOT NULL DEFAULT 0, total_chunks INTEGER NOT NULL DEFAULT 0,
            completed_chunks INTEGER NOT NULL DEFAULT 0, cache_hits INTEGER NOT NULL DEFAULT 0,
            issue_count INTEGER NOT NULL DEFAULT 0, auto_apply INTEGER NOT NULL,
            applied_revision INTEGER NOT NULL DEFAULT 0, preview_revision INTEGER NOT NULL DEFAULT 0,
            document_json TEXT, configuration_hash TEXT, range_end_ms INTEGER,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error_text TEXT
          ) STRICT;
          CREATE UNIQUE INDEX one_active_transcription ON transcription_jobs(episode_id, audio_hash)
            WHERE status IN ('queued','running','canceling');
          PRAGMA user_version = 4;
          COMMIT;
        `)
      if (version < 5)
        this.db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE book_listening_settings (
            book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
            intro_ms INTEGER NOT NULL DEFAULT 0 CHECK(intro_ms BETWEEN 0 AND 3600000),
            outro_ms INTEGER NOT NULL DEFAULT 0 CHECK(outro_ms BETWEEN 0 AND 3600000)
          ) STRICT;
          CREATE TABLE bookmarks (
            id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
            audio_hash TEXT NOT NULL, position_ms INTEGER NOT NULL CHECK(position_ms >= 0),
            note TEXT NOT NULL, created_at TEXT NOT NULL,
            UNIQUE(episode_id, audio_hash, position_ms)
          ) STRICT;
          PRAGMA user_version = 5;
          COMMIT;
        `)
      if (version < 6)
        this.db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE transcript_regions (
            episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
            audio_hash TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
            regions_json TEXT NOT NULL,
            PRIMARY KEY(episode_id, audio_hash)
          ) STRICT;
          PRAGMA user_version = 6;
          COMMIT;
        `)
      if (version < 7)
        this.db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE online_books (
            book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
            source_id TEXT NOT NULL CHECK(source_id='ting13'), source_book_id TEXT NOT NULL,
            metadata_json TEXT NOT NULL, catalog_complete INTEGER NOT NULL DEFAULT 0,
            UNIQUE(source_id, source_book_id)
          ) STRICT;
          CREATE TABLE online_episodes (
            id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            source_episode_id TEXT NOT NULL, title TEXT NOT NULL, sort_order INTEGER NOT NULL,
            UNIQUE(book_id, source_episode_id), UNIQUE(book_id, sort_order)
          ) STRICT;
          PRAGMA user_version = 7;
          COMMIT;
        `)
      if (version < 8)
        this.db.exec(`
          BEGIN IMMEDIATE;
          ALTER TABLE online_episodes ADD COLUMN cache_available INTEGER NOT NULL DEFAULT 0;
          UPDATE online_episodes SET cache_available=1 WHERE id IN (SELECT id FROM episodes);
          ALTER TABLE online_books ADD COLUMN preparation_json TEXT;
          ALTER TABLE transcription_jobs ADD COLUMN background INTEGER NOT NULL DEFAULT 0;
          CREATE TABLE source_media_files (
            path TEXT PRIMARY KEY, episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
            size_bytes INTEGER NOT NULL CHECK(size_bytes>0), modified_at REAL NOT NULL,
            content_hash TEXT NOT NULL, accessed_at REAL NOT NULL
          ) STRICT;
          INSERT INTO source_media_files SELECT e.locator, e.id, e.size_bytes,e.modified_at,e.content_hash,0
            FROM episodes e JOIN online_episodes o ON o.id=e.id;
          PRAGMA user_version = 8;
          COMMIT;
        `)
      if (version < 9)
        this.db.exec(`BEGIN IMMEDIATE; ${ORIGINAL_SCHEMA} PRAGMA user_version = 9; COMMIT;`)
      if (version < 10)
        this.db.exec(`BEGIN IMMEDIATE; ${READING_SCHEMA} PRAGMA user_version = 10; COMMIT;`)
      if (version < 11)
        this.db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE book_subtitle_settings (
            book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
            settings_json TEXT NOT NULL
          ) STRICT;
          PRAGMA user_version = 11;
          COMMIT;
        `)
      if (version < 12)
        this.db.exec(`
          BEGIN IMMEDIATE;
          ALTER TABLE transcription_jobs ADD COLUMN cpu_threads INTEGER NOT NULL DEFAULT 4 CHECK(cpu_threads IN (1,2,4));
          CREATE TABLE processing_resources (
            id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL,
            cpu_threads INTEGER NOT NULL CHECK(cpu_threads IN (1,2,4)),
            low_priority INTEGER NOT NULL CHECK(low_priority IN (0,1)),
            background_idle_only INTEGER NOT NULL CHECK(background_idle_only IN (0,1)),
            paused INTEGER NOT NULL CHECK(paused IN (0,1))
          ) STRICT;
          INSERT INTO processing_resources VALUES(1,1,4,0,0,0);
          PRAGMA user_version=12;
          COMMIT;
        `)
      if (version < 13)
        this.db.exec(`BEGIN IMMEDIATE; ${OFFLINE_SCHEMA} PRAGMA user_version=13; COMMIT;`)
      if (version < 14)
        this.db.exec(`BEGIN IMMEDIATE; ${TRANSCRIPT_EDIT_SCHEMA} PRAGMA user_version=14; COMMIT;`)
      if (version < 15)
        this.db.exec(`BEGIN IMMEDIATE; ${SUBTITLE_IMPORT_SCHEMA} PRAGMA user_version=15; COMMIT;`)
      if (version < 16)
        this.db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE online_books_multi (
            book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
            source_id TEXT NOT NULL CHECK(source_id IN ('ting13','librivox')),
            source_book_id TEXT NOT NULL, metadata_json TEXT NOT NULL,
            catalog_complete INTEGER NOT NULL DEFAULT 0, preparation_json TEXT,
            UNIQUE(source_id, source_book_id)
          ) STRICT;
          INSERT INTO online_books_multi SELECT book_id,source_id,source_book_id,metadata_json,
            catalog_complete,preparation_json FROM online_books;
          DROP TABLE online_books;
          ALTER TABLE online_books_multi RENAME TO online_books;
          PRAGMA user_version=16;
          COMMIT;
        `)
      if (version < 17)
        this.db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE online_books_plugins (
            book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
            source_id TEXT NOT NULL CHECK(source_id IN ('ting13','librivox') OR source_id GLOB 'plugin:*:*'),
            source_book_id TEXT NOT NULL, metadata_json TEXT NOT NULL,
            catalog_complete INTEGER NOT NULL DEFAULT 0, preparation_json TEXT,
            UNIQUE(source_id, source_book_id)
          ) STRICT;
          INSERT INTO online_books_plugins SELECT book_id,source_id,source_book_id,metadata_json,
            catalog_complete,preparation_json FROM online_books;
          DROP TABLE online_books;
          ALTER TABLE online_books_plugins RENAME TO online_books;
          PRAGMA user_version=17;
          COMMIT;
        `)
      this.offline = new OfflineStore(this.db, {
        getEpisode: (id) => this.getEpisode(id),
        getAudio: (id) => this.getAudio(id),
        latestJob: (id, hash) => this.latestJob(id, hash),
        getJob: (id) => this.getJob(id) ?? null,
        createJob: (request, background) => this.createJob(request, background),
        retryJob: (id) => this.retryJob(id),
        cacheSourceEpisode: (id, audio) => this.writeSourceEpisode(id, audio),
      })
      this.reading = new ReadingStore(this.db)
      this.originals = new OriginalStore(
        this.db,
        (id) => this.getEpisode(id),
        (id, hash) => this.getTranscript(id, hash),
      )
      this.bookLinks = new BookLinkStore(this.db, this.reading, this.originals, (id) =>
        this.getEpisode(id),
      )
      this.editing = new TranscriptEditStore(this.db, {
        episode: (id) => this.getEpisode(id),
        transcript: (id, hash) => this.getTranscript(id, hash),
        write: (id, document) => {
          const state = this.writeTranscript(id, document, true)
          if (state.status !== 'ready') throw new AppError('INTERNAL', '字幕写入后未能读取。')
          return state.transcript
        },
        notify: (target) => this.originals.transcriptChanged(target),
      })
      this.subtitleImports = new SubtitleImportStore(this.db, {
        episode: (id) => this.getEpisode(id),
        transcript: (id, hash) => this.getTranscript(id, hash),
        write: (id, document) => this.writeTranscript(id, document),
        notify: (target) => this.originals.transcriptChanged(target),
      })
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  transcriptImportBaseline(target: TranscriptRequest) {
    return this.subtitleImports.baseline(target)
  }
  commitSubtitleImport(request: CommitSubtitleImport) {
    return this.subtitleImports.commit(request)
  }
  replaySubtitleImport(request: ReplaySubtitleImport) {
    return this.subtitleImports.replay(request)
  }
  subtitleImportSource(target: TranscriptRequest) {
    return this.subtitleImports.source(target)
  }

  transcriptEditingState(target: TranscriptRequest) {
    return this.editing.state(target)
  }
  performTranscriptEdit(request: TranscriptEditRequest, label?: '采用声音重对齐') {
    return this.editing.perform(request, label)
  }
  undoTranscriptEdit(request: TranscriptHistoryRequest) {
    return this.editing.history(request, true)
  }
  redoTranscriptEdit(request: TranscriptHistoryRequest) {
    return this.editing.history(request, false)
  }
  prepareTranscriptReplacement(request: TranscriptReplacementRequest) {
    return this.editing.prepareReplacement(request)
  }
  commitTranscriptReplacement(plan: PreparedTranscriptReplacement, commandId: string) {
    return this.editing.commitReplacement(plan, commandId)
  }

  createOfflinePlan(request: CreateOfflinePlan) {
    return this.offline.create(request)
  }
  offlinePlan(id: string) {
    return this.offline.plan(id)
  }
  offlinePlanControl(id: string) {
    return this.offline.planControl(id)
  }
  offlineSchedulingPlans() {
    return this.offline.schedulingPlans()
  }
  offlinePlans(page = 0, activeOnly = false) {
    return this.offline.plans(page, activeOnly)
  }
  offlineItems(id: string, page = 0) {
    return this.offline.items(id, page)
  }
  getStoredOfflineItem(id: string) {
    return this.offline.storedItem(id)
  }
  storedOfflineItems(id: string) {
    return this.offline.storedItems(id)
  }
  updateOfflinePlan(request: UpdateOfflinePlanRequest) {
    return this.offline.update(request)
  }
  blockOfflinePlan(id: string, revision: number, error: string) {
    return this.offline.block(id, revision, error)
  }
  updateOfflineItem(request: UpdateOfflineItem) {
    return this.offline.updateItem(request)
  }
  getOfflineReadiness(id: string) {
    return this.offline.readiness(id)
  }
  retainOfflineMedia(context: OfflineItemContext, audio: OfflineFileIdentity) {
    return this.offline.retain(context, audio)
  }
  offlineMediaReferences() {
    return this.offline.references()
  }
  offlineRetainedFiles(planId?: string) {
    return this.offline.retainedFiles(planId)
  }
  invalidateOfflineMedia(file: OfflineMediaIdentity, error: string) {
    return this.offline.invalidateMedia(file, error)
  }
  releaseOfflineMedia(id: string, revision: number) {
    return this.offline.release(id, revision)
  }
  offlinePlanJobIds(id: string) {
    return this.offline.jobIds(id)
  }
  createOrAttachOfflineJob(
    itemId: string,
    request: StartTranscription,
    context?: { planRevision: number; attempt: number },
  ) {
    return this.offline.createJob(itemId, request, context)
  }
  offlineJobOwnership(jobId: string) {
    return this.offline.ownership(jobId)
  }
  claimJobForManual(jobId: string): void {
    this.offline.claimManual(jobId)
  }
  recoverOfflinePlans(): void {
    this.offline.recover()
  }

  processingResources(): SavedProcessingResources {
    const row = this.db.prepare('SELECT * FROM processing_resources WHERE id=1').get()!
    return {
      revision: Number(row.revision),
      policy: {
        cpuThreads: Number(row.cpu_threads) as 1 | 2 | 4,
        lowPriority: !!row.low_priority,
        backgroundIdleOnly: !!row.background_idle_only,
      },
      paused: !!row.paused,
    }
  }
  setProcessingPolicy(request: UpdateProcessingPolicy): SavedProcessingResources {
    const policy = request.policy
    if (
      Object.keys(policy).length !== 3 ||
      ![1, 2, 4].includes(policy.cpuThreads) ||
      typeof policy.lowPriority !== 'boolean' ||
      typeof policy.backgroundIdleOnly !== 'boolean'
    )
      throw new AppError('INVALID_REQUEST', '处理资源设置无效。')
    const changed = this.db
      .prepare(
        `UPDATE processing_resources SET revision=revision+1,
      cpu_threads=?,low_priority=?,background_idle_only=? WHERE id=1 AND revision=?`,
      )
      .run(
        policy.cpuThreads,
        Number(policy.lowPriority),
        Number(policy.backgroundIdleOnly),
        request.revision,
      )
    if (!changed.changes) throw new AppError('CONFLICT', '处理资源设置已更新，请刷新后保存。')
    return this.processingResources()
  }
  setProcessingPaused(request: PauseProcessing): SavedProcessingResources {
    if (typeof request.paused !== 'boolean') throw new AppError('INVALID_REQUEST', '暂停设置无效。')
    const changed = this.db
      .prepare(
        'UPDATE processing_resources SET revision=revision+1,paused=? WHERE id=1 AND revision=?',
      )
      .run(Number(request.paused), request.revision)
    if (!changed.changes) throw new AppError('CONFLICT', '处理资源设置已更新，请刷新后操作。')
    return this.processingResources()
  }
  listFiles(): SelectedFile[] {
    return this.db
      .prepare(
        `
      SELECT id, name, size_bytes AS sizeBytes, modified_at AS modifiedAt,
             selected_at AS selectedAt
      FROM selected_files ORDER BY selected_at DESC, rowid DESC LIMIT 20
    `,
      )
      .all() as unknown as SelectedFile[]
  }

  getTranscriptRegions(episodeId: string, audioHash: string): TranscriptRegions {
    if (this.getAudio(episodeId)?.contentHash !== audioHash)
      throw new AppError('FILE_CHANGED', '音频版本已变化或章节已移除，旧标注不会应用到新音频。')
    const row = this.db
      .prepare(
        'SELECT revision, regions_json FROM transcript_regions WHERE episode_id=? AND audio_hash=?',
      )
      .get(episodeId, audioHash)
    if (!row) return { revision: 0, regions: [] }
    if (String(row.regions_json).length > MAX_REGIONS * 256)
      throw new AppError('INTERNAL', '片段标注数据过大，原文稿和音频仍可使用。')
    return {
      revision: Number(row.revision),
      regions: readRegionList(JSON.parse(String(row.regions_json))),
    }
  }
  markTranscriptRegion(change: RegionUpdate): TranscriptRegions {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.getTranscriptRegions(change.episodeId, change.audioHash)
      if (current.revision !== change.revision)
        throw new AppError('CONFLICT', '片段标注已更新，请重新打开标注后再保存。')
      const episode = this.getEpisode(change.episodeId)!
      if (episode.durationMs !== null && change.endMs > episode.durationMs + 1)
        throw new AppError('INVALID_REQUEST', '标注范围超出当前音频时长。')
      let base = current.regions
      if (change.previous) {
        if (
          !base.some(
            (region) =>
              region.startMs === change.previous!.startMs &&
              region.endMs === change.previous!.endMs,
          )
        )
          throw new AppError('CONFLICT', '原标注范围已变化，请重新打开标注后再保存。')
        base = replaceRegion(base, { ...change.previous, kind: null })
      }
      const regions = change.previous && change.kind === null ? base : replaceRegion(base, change)
      const encoded = JSON.stringify(regions)
      if (encoded !== JSON.stringify(current.regions)) {
        this.db
          .prepare(
            `INSERT INTO transcript_regions(episode_id,audio_hash,revision,regions_json) VALUES (?,?,?,?)
          ON CONFLICT(episode_id,audio_hash) DO UPDATE SET revision=excluded.revision,regions_json=excluded.regions_json`,
          )
          .run(change.episodeId, change.audioHash, current.revision + 1, encoded)
      }
      this.db.exec('COMMIT')
      return this.getTranscriptRegions(change.episodeId, change.audioHash)
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  rememberFile(file: FileMetadata): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `
        INSERT INTO selected_files (id, locator, name, size_bytes, modified_at, selected_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(locator) DO UPDATE SET
          name = excluded.name, size_bytes = excluded.size_bytes,
          modified_at = excluded.modified_at, selected_at = excluded.selected_at
      `,
        )
        .run(
          randomUUID(),
          file.path,
          file.name,
          file.sizeBytes,
          file.modifiedAt,
          new Date().toISOString(),
        )
      this.db.exec(`
        DELETE FROM selected_files WHERE id NOT IN (
          SELECT id FROM selected_files ORDER BY selected_at DESC, rowid DESC LIMIT 20
        );
        COMMIT;
      `)
    } catch (error) {
      // SQLITE_FULL may already have rolled back the transaction.
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  forgetFile(id: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const book = this.db
        .prepare(
          "SELECT id FROM books WHERE kind='file' AND source_locator=(SELECT locator FROM selected_files WHERE id=?)",
        )
        .get(id)
      if (book) this.offline.bookRemoved(String(book.id))
      this.db
        .prepare(
          "DELETE FROM books WHERE kind = 'file' AND source_locator = (SELECT locator FROM selected_files WHERE id = ?)",
        )
        .run(id)
      this.db.prepare('DELETE FROM selected_files WHERE id = ?').run(id)
      this.editing.pruneOrphans()
      this.clearOrphanedCurrent()
      this.db.exec('COMMIT')
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  getRememberedPath(id: string): string | undefined {
    return this.db.prepare('SELECT locator FROM selected_files WHERE id = ?').get(id)?.locator as
      string | undefined
  }

  listBooks(): Book[] {
    const books = this.db
      .prepare(
        `SELECT b.id, b.title, b.imported_at AS importedAt,
      b.last_played_at AS lastPlayedAt, b.current_episode_id AS currentEpisodeId,
      coalesce(s.intro_ms,0) AS introMs, coalesce(s.outro_ms,0) AS outroMs
      FROM books b LEFT JOIN book_listening_settings s ON s.book_id=b.id
      ORDER BY b.last_played_at DESC, b.imported_at DESC, b.rowid DESC`,
      )
      .all()
    return books.map((book) => {
      const online = this.db.prepare('SELECT * FROM online_books WHERE book_id=?').get(book.id!)
      const subtitlePreparation = this.getSubtitlePreparation(String(book.id))
      return {
        ...book,
        episodes: this.episodeRows('bookId', String(book.id)),
        ...(subtitlePreparation ? { subtitlePreparation } : {}),
        ...(online
          ? {
              online: {
                sourceId: online.source_id,
                bookId: online.source_book_id,
                catalogComplete: Boolean(online.catalog_complete),
                preparation: online.preparation_json
                  ? JSON.parse(String(online.preparation_json))
                  : { ...DEFAULT_SOURCE_PREPARATION },
              },
            }
          : {}),
      }
    }) as unknown as Book[]
  }

  getEpisode(id: string): Episode | undefined {
    return this.episodeRows('id', id)[0]
  }

  private episodeRows(field: 'id' | 'bookId', value: string): Episode[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
      SELECT e.id, e.book_id AS bookId, e.title, e.sort_order AS 'order',
        e.size_bytes AS sizeBytes, e.modified_at AS modifiedAt, e.content_hash AS contentHash,
        e.duration_ms AS durationMs, e.position_ms AS positionMs,
        NULL AS sourceBookId, NULL AS sourceEpisodeId, 1 AS cacheAvailable, NULL AS sourceId
      FROM episodes e WHERE NOT EXISTS (SELECT 1 FROM online_episodes o WHERE o.id=e.id)
      UNION ALL
      SELECT o.id, o.book_id, o.title, o.sort_order, coalesce(e.size_bytes,0),
        coalesce(e.modified_at,0), coalesce(e.content_hash,''), e.duration_ms,
        coalesce(e.position_ms,0), b.source_book_id, o.source_episode_id, o.cache_available, b.source_id
      FROM online_episodes o JOIN online_books b ON b.book_id=o.book_id
        LEFT JOIN episodes e ON e.id=o.id
    ) WHERE ${field}=? ORDER BY "order"`,
      )
      .all(value)
    return rows.map(
      ({ sourceBookId, sourceEpisodeId, cacheAvailable, sourceId, ...row }) =>
        ({
          ...row,
          ...(sourceEpisodeId
            ? {
                online: {
                  sourceId,
                  bookId: String(sourceBookId),
                  episodeId: String(sourceEpisodeId),
                  cached: Boolean(cacheAvailable),
                },
              }
            : {}),
        }) as unknown as Episode,
    )
  }

  rememberSourceBook(book: SourceBook, episodes: SourceEpisode[], complete: boolean): string {
    if (
      !isSourceId(book.sourceId) ||
      !episodes.length ||
      episodes.length > 100000 ||
      episodes.some(
        (episode, index) =>
          episode.sourceId !== book.sourceId ||
          episode.bookId !== book.id ||
          episode.order !== index + 1,
      )
    )
      throw new AppError('SOURCE_CHANGED', '书源目录不完整或顺序发生变化，请重新读取。')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.db
        .prepare('SELECT book_id FROM online_books WHERE source_id=? AND source_book_id=?')
        .get(book.sourceId, book.id)
      const id = previous ? String(previous.book_id) : randomUUID()
      if (
        complete &&
        this.db
          .prepare('SELECT 1 FROM online_episodes WHERE book_id=? AND sort_order>?')
          .get(id, episodes.at(-1)!.order)
      )
        throw new AppError('SOURCE_CHANGED', '完整目录变短，已保留原有分集和进度，请稍后重试。')
      this.db
        .prepare(
          `INSERT INTO books(id,title,source_locator,kind,imported_at) VALUES (?,?,?,'folder',?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title`,
        )
        .run(id, book.title, `source:${book.sourceId}:${book.id}`, new Date().toISOString())
      this.db
        .prepare(
          `INSERT INTO online_books(book_id,source_id,source_book_id,metadata_json,catalog_complete)
        VALUES (?,?,?,?,?) ON CONFLICT(book_id) DO UPDATE SET metadata_json=excluded.metadata_json,
        catalog_complete=max(catalog_complete,excluded.catalog_complete)`,
        )
        .run(id, book.sourceId, book.id, JSON.stringify(book), Number(complete))
      for (const episode of episodes) {
        const old = this.db
          .prepare(
            'SELECT id,sort_order FROM online_episodes WHERE book_id=? AND source_episode_id=?',
          )
          .get(id, episode.id)
        const order = this.db
          .prepare('SELECT source_episode_id FROM online_episodes WHERE book_id=? AND sort_order=?')
          .get(id, episode.order)
        if (
          (old && old.sort_order !== episode.order) ||
          (order && order.source_episode_id !== episode.id)
        )
          throw new AppError(
            'SOURCE_CHANGED',
            '书源集数身份已变化，已保留原进度和缓存，请稍后重试。',
          )
        this.db
          .prepare(
            `INSERT INTO online_episodes(id,book_id,source_episode_id,title,sort_order) VALUES (?,?,?,?,?)
          ON CONFLICT(book_id,source_episode_id) DO UPDATE SET title=excluded.title`,
          )
          .run(old ? old.id! : randomUUID(), id, episode.id, episode.title, episode.order)
      }
      this.db.exec('COMMIT')
      return id
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  cacheSourceEpisode(id: string, audio: FileMetadata & { contentHash: string }): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.writeSourceEpisode(id, audio)
      this.db.exec('COMMIT')
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }
  private writeSourceEpisode(id: string, audio: FileMetadata & { contentHash: string }): void {
    const episode = this.getEpisode(id)
    if (!episode?.online) throw new AppError('FILE_UNAVAILABLE', '在线章节已移除。')
    this.db
      .prepare(
        `INSERT INTO episodes(id,book_id,title,sort_order,locator,size_bytes,modified_at,content_hash)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET locator=excluded.locator,
        size_bytes=excluded.size_bytes,modified_at=excluded.modified_at,
        position_ms=CASE WHEN content_hash=excluded.content_hash THEN position_ms ELSE 0 END,
        duration_ms=CASE WHEN content_hash=excluded.content_hash THEN duration_ms ELSE NULL END,
        content_hash=excluded.content_hash`,
      )
      .run(
        id,
        episode.bookId,
        episode.title,
        episode.order,
        audio.path,
        audio.sizeBytes,
        audio.modifiedAt,
        audio.contentHash,
      )
    this.db
      .prepare(
        `INSERT INTO source_media_files(path,episode_id,size_bytes,modified_at,content_hash,accessed_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET accessed_at=excluded.accessed_at`,
      )
      .run(audio.path, id, audio.sizeBytes, audio.modifiedAt, audio.contentHash, Date.now())
    this.db.prepare('UPDATE online_episodes SET cache_available=1 WHERE id=?').run(id)
  }

  touchSourceCache(id: string): void {
    this.db
      .prepare(
        `INSERT INTO source_media_files(path,episode_id,size_bytes,modified_at,content_hash,accessed_at)
      SELECT locator,id,size_bytes,modified_at,content_hash,? FROM episodes WHERE id=?
      ON CONFLICT(path) DO UPDATE SET accessed_at=excluded.accessed_at`,
      )
      .run(Date.now(), id)
    this.db.prepare('UPDATE online_episodes SET cache_available=1 WHERE id=?').run(id)
  }
  sourceCacheFiles(): {
    path: string
    sizeBytes: number
    modifiedAt: number
    contentHash: string
    accessedAt: number
    episodeId: string | null
    localReferences: number
  }[] {
    return this.db
      .prepare(
        `SELECT f.path,f.size_bytes AS sizeBytes,f.modified_at AS modifiedAt,
      f.content_hash AS contentHash,f.accessed_at AS accessedAt,f.episode_id AS episodeId,
      (SELECT count(*) FROM episodes e WHERE e.locator=f.path AND NOT EXISTS(SELECT 1 FROM online_episodes o WHERE o.id=e.id)) AS localReferences
      FROM source_media_files f`,
      )
      .all() as unknown as ReturnType<LibraryStore['sourceCacheFiles']>
  }
  removeSourceCacheFile(path: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          'UPDATE online_episodes SET cache_available=0 WHERE id IN (SELECT id FROM episodes WHERE locator=?)',
        )
        .run(path)
      this.db.prepare('DELETE FROM source_media_files WHERE path=?').run(path)
      this.db.exec('COMMIT')
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }
  setSourcePreparation(id: string, settings: SourcePreparation): void {
    if (!this.db.prepare('SELECT 1 FROM online_books WHERE book_id=?').get(id))
      throw new AppError('INVALID_SOURCE_REQUEST', '在线书籍已移除。')
    this.db
      .prepare('UPDATE online_books SET preparation_json=? WHERE book_id=?')
      .run(JSON.stringify(settings), id)
  }
  getSubtitlePreparation(id: string): SubtitlePreparation | undefined {
    const row = this.db
      .prepare('SELECT settings_json FROM book_subtitle_settings WHERE book_id=?')
      .get(id)
    return row ? (JSON.parse(String(row.settings_json)) as SubtitlePreparation) : undefined
  }
  setSubtitlePreparation(id: string, settings: SubtitlePreparation): void {
    if (!this.db.prepare('SELECT 1 FROM books WHERE id=?').get(id))
      throw new AppError('INVALID_REQUEST', '书籍已移除。')
    this.db
      .prepare(
        `INSERT INTO book_subtitle_settings(book_id,settings_json) VALUES(?,?)
      ON CONFLICT(book_id) DO UPDATE SET settings_json=excluded.settings_json`,
      )
      .run(id, JSON.stringify(settings))
  }
  recordSourceDuration(id: string, hash: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 3.6e10)
      throw new AppError('INVALID_REQUEST', '音频时长无效。')
    this.db
      .prepare(
        'UPDATE episodes SET duration_ms=? WHERE id=? AND content_hash=? AND duration_ms IS NULL',
      )
      .run(durationMs, id, hash)
  }

  getAudio(id: string): StoredAudio | undefined {
    return this.db
      .prepare(
        `SELECT id, locator AS path, title AS name, size_bytes AS sizeBytes,
      modified_at AS modifiedAt, content_hash AS contentHash FROM episodes WHERE id = ?`,
      )
      .get(id) as unknown as StoredAudio | undefined
  }

  getPlayerState(): {
    currentEpisodeId: string | null
    preferences: { rate: number; volume: number }
  } {
    const row = this.db
      .prepare('SELECT current_episode_id, rate, volume FROM player_settings')
      .get()!
    return {
      currentEpisodeId: row.current_episode_id as string | null,
      preferences: { rate: row.rate as number, volume: row.volume as number },
    }
  }

  importBook(book: ScannedBook): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const oldBook = this.db
        .prepare('SELECT id FROM books WHERE source_locator = ?')
        .get(book.sourcePath)
      const id = (oldBook?.id as string | undefined) ?? book.id
      this.db
        .prepare(
          `INSERT INTO books(id, title, source_locator, kind, imported_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(source_locator) DO UPDATE SET title = excluded.title, imported_at = excluded.imported_at`,
        )
        .run(id, book.title, book.sourcePath, book.kind, new Date().toISOString())
      const keep = new Set<string>()
      const upsert = this.db
        .prepare(`INSERT INTO episodes(id, book_id, title, sort_order, locator, size_bytes, modified_at, content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(book_id, locator) DO UPDATE SET
          title = excluded.title, sort_order = excluded.sort_order, size_bytes = excluded.size_bytes,
          modified_at = excluded.modified_at,
          position_ms = CASE WHEN content_hash = excluded.content_hash THEN position_ms ELSE 0 END,
          duration_ms = CASE WHEN content_hash = excluded.content_hash THEN duration_ms ELSE NULL END,
          content_hash = excluded.content_hash`)
      for (const [order, audio] of book.episodes.entries()) {
        upsert.run(
          audio.id,
          id,
          audio.name,
          order,
          audio.path,
          audio.sizeBytes,
          audio.modifiedAt,
          audio.contentHash,
        )
        keep.add(audio.path.toLowerCase())
      }
      for (const row of this.db
        .prepare('SELECT id, locator FROM episodes WHERE book_id = ?')
        .all(id)) {
        if (!keep.has((row.locator as string).toLowerCase()))
          this.db.prepare('DELETE FROM episodes WHERE id = ?').run(row.id!)
      }
      this.editing.pruneOrphans()
      this.clearOrphanedCurrent()
      this.db.exec('COMMIT')
    } catch (error) {
      // SQLITE_FULL may already have rolled back the transaction.
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  removeBook(id: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.offline.bookRemoved(id)
      this.db
        .prepare(
          'DELETE FROM selected_files WHERE locator = (SELECT source_locator FROM books WHERE id = ?)',
        )
        .run(id)
      this.db.prepare('DELETE FROM books WHERE id = ?').run(id)
      this.editing.pruneOrphans()
      this.clearOrphanedCurrent()
      this.db.exec('COMMIT')
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  private clearOrphanedCurrent(): void {
    this.db
      .exec(`UPDATE books SET current_episode_id = NULL WHERE current_episode_id NOT IN (SELECT id FROM episodes);
      UPDATE player_settings SET current_episode_id = NULL WHERE current_episode_id NOT IN (SELECT id FROM episodes);`)
  }

  saveProgress(progress: ProgressUpdate): void {
    const episode = this.getEpisode(progress.episodeId)
    if (!episode) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const duration = progress.durationMs ?? episode.durationMs
      this.db
        .prepare('UPDATE episodes SET position_ms = ?, duration_ms = ? WHERE id = ?')
        .run(
          duration ? Math.min(progress.positionMs, duration) : progress.positionMs,
          duration,
          episode.id,
        )
      this.db
        .prepare('UPDATE books SET current_episode_id = ?, last_played_at = ? WHERE id = ?')
        .run(episode.id, new Date().toISOString(), episode.bookId)
      this.db
        .prepare('UPDATE player_settings SET current_episode_id = ?, rate = ?, volume = ?')
        .run(episode.id, progress.rate, progress.volume)
      this.db.exec('COMMIT')
    } catch (error) {
      // SQLITE_FULL may already have rolled back the transaction.
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  setBookSkips(id: string, skips: BookSkips): void {
    if (!this.db.prepare('SELECT 1 FROM books WHERE id=?').get(id))
      throw new AppError('FILE_UNAVAILABLE', '书籍已移除。')
    this.db
      .prepare(
        `INSERT INTO book_listening_settings(book_id,intro_ms,outro_ms) VALUES(?,?,?)
      ON CONFLICT(book_id) DO UPDATE SET intro_ms=excluded.intro_ms,outro_ms=excluded.outro_ms`,
      )
      .run(id, skips.introMs, skips.outroMs)
  }

  listBookmarks(bookId: string): Bookmark[] {
    return this.db
      .prepare(
        `SELECT m.id,e.book_id AS bookId,m.episode_id AS episodeId,
      m.audio_hash AS audioHash,e.title AS episodeTitle,m.position_ms AS positionMs,m.note,
      m.created_at AS createdAt,m.audio_hash != e.content_hash AS stale
      FROM bookmarks m JOIN episodes e ON e.id=m.episode_id WHERE e.book_id=?
      ORDER BY e.sort_order,m.position_ms,m.created_at`,
      )
      .all(bookId)
      .map((row) => ({ ...row, stale: !!row.stale })) as unknown as Bookmark[]
  }

  saveBookmark(request: SaveBookmark): Bookmark {
    const episode = this.getEpisode(request.episodeId)
    if (!episode || episode.contentHash !== request.audioHash)
      throw new AppError('FILE_CHANGED', '音频版本已变化，请重新打开章节后添加书签。')
    if (episode.durationMs !== null && request.positionMs > episode.durationMs + 1)
      throw new AppError('INVALID_REQUEST', '书签位置超过音频时长。')
    const existing = this.db
      .prepare('SELECT id FROM bookmarks WHERE episode_id=? AND audio_hash=? AND position_ms=?')
      .get(episode.id, request.audioHash, request.positionMs)
    if (existing) return this.listBookmarks(episode.bookId).find((item) => item.id === existing.id)!
    if (this.listBookmarks(episode.bookId).length >= 2000)
      throw new AppError('INVALID_REQUEST', '每本书最多保存 2,000 个书签，请先整理已有书签。')
    const id = randomUUID()
    this.db
      .prepare(
        'INSERT INTO bookmarks(id,episode_id,audio_hash,position_ms,note,created_at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        id,
        episode.id,
        request.audioHash,
        request.positionMs,
        request.note.trim(),
        new Date().toISOString(),
      )
    return this.listBookmarks(episode.bookId).find((item) => item.id === id)!
  }

  editBookmark(id: string, note: string): void {
    if (!this.db.prepare('UPDATE bookmarks SET note=? WHERE id=?').run(note.trim(), id).changes)
      throw new AppError('INVALID_REQUEST', '书签不存在，可能已被移除。')
  }

  removeBookmark(id: string): void {
    this.db.prepare('DELETE FROM bookmarks WHERE id=?').run(id)
  }

  private readSnapshot<T>(action: () => T): T {
    if (this.db.isTransaction) return action()
    this.db.exec('BEGIN')
    this.readSnapshotDepth++
    try {
      // BEGIN is deferred. Establish the SQLite read snapshot before reading
      // data_version, otherwise an external commit between the two could make
      // a cached old coverage appear current beside new row metadata.
      this.db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()
      this.readSnapshotVersion = this.dataVersion()
      const value = action()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.readSnapshotDepth--
      this.readSnapshotVersion = undefined
    }
  }

  private dataVersion(): number {
    return Number(this.db.prepare('PRAGMA data_version').get()!.data_version)
  }

  private rememberCoverage(
    key: string,
    revision: number,
    coverage: readonly TimeRange[],
    dataVersion = this.readSnapshotVersion ?? this.dataVersion(),
  ): void {
    // Never publish values read from a write transaction that can still roll back.
    if (this.db.isTransaction && !this.readSnapshotDepth) return
    this.coverageCache.delete(key)
    this.coverageCache.set(key, {
      revision,
      dataVersion,
      coverage: coverage.map((range) => ({ ...range })),
    })
    // Bound retained coverage independently of the number of books and jobs.
    while (
      this.coverageCache.size > 8 ||
      [...this.coverageCache.values()].reduce((count, entry) => count + entry.coverage.length, 0) >
        100_000
    )
      this.coverageCache.delete(this.coverageCache.keys().next().value!)
  }

  private readCoverage(table: 'transcripts' | 'transcription_jobs', id: string, revision: number) {
    const key = `${table}:${id}`,
      cacheable = !this.db.isTransaction || this.readSnapshotDepth > 0,
      cached = cacheable ? this.coverageCache.get(key) : undefined
    if (
      cached?.revision === revision &&
      cached.dataVersion === (this.readSnapshotVersion ?? this.dataVersion())
    )
      return cached.coverage
    const column = table === 'transcripts' ? 'revision' : 'preview_revision'
    const row = this.db
      .prepare(
        `SELECT json_extract(document_json, '$.coverage') AS coverage FROM ${table} WHERE id=? AND ${column}=?`,
      )
      .get(id, revision)
    const coverage = row?.coverage ? (JSON.parse(String(row.coverage)) as TimeRange[]) : []
    this.rememberCoverage(key, revision, coverage)
    return coverage
  }

  getTranscriptHeader(episodeId: string, audioHash: string): TranscriptHeaderState {
    return this.readSnapshot(() => {
      const row = this.db
        .prepare(
          'SELECT id,episode_id AS episodeId,revision,imported_at AS importedAt FROM transcripts WHERE episode_id=? AND audio_hash=?',
        )
        .get(episodeId, audioHash)
      if (!row) return this.absentTranscript(episodeId)
      return {
        status: 'ready',
        transcript: {
          id: String(row.id),
          episodeId: String(row.episodeId),
          revision: Number(row.revision),
          importedAt: String(row.importedAt),
          coverage: this.readCoverage('transcripts', String(row.id), Number(row.revision)).map(
            (range) => ({ ...range }),
          ),
        },
      }
    })
  }

  private absentTranscript(episodeId: string): { status: 'missing' | 'stale' } {
    return {
      status: this.db.prepare('SELECT 1 FROM transcripts WHERE episode_id=? LIMIT 1').get(episodeId)
        ? 'stale'
        : 'missing',
    }
  }

  getTranscriptIfChanged(
    episodeId: string,
    audioHash: string,
    known?: TranscriptVersion,
  ): TranscriptRead {
    if (!known) return this.getTranscript(episodeId, audioHash)
    // CASE is evaluated in the same SQLite snapshot as the version check. An
    // unchanged request never materializes or parses the stored sentence body.
    const row = this.db
      .prepare(
        `SELECT id,episode_id AS episodeId,revision,imported_at AS importedAt,
         CASE WHEN id=? AND revision=? THEN NULL ELSE document_json END AS document
         FROM transcripts WHERE episode_id=? AND audio_hash=?`,
      )
      .get(known.id, known.revision, episodeId, audioHash)
    if (!row) return this.absentTranscript(episodeId)
    if (row.id === known.id && row.revision === known.revision)
      return {
        status: 'unchanged',
        version: { id: String(row.id), revision: Number(row.revision) },
      }
    return {
      status: 'ready',
      transcript: {
        id: String(row.id),
        episodeId: String(row.episodeId),
        revision: Number(row.revision),
        importedAt: String(row.importedAt),
        document: JSON.parse(String(row.document)) as TranscriptDocument,
      },
    }
  }

  subtitleStatuses(targets: SubtitleStatusTarget[], unsaved?: UnsavedJobTerminal) {
    return this.readSnapshot(() =>
      targets.map((target) => {
        const episode = this.getEpisode(target.episodeId)
        if (!episode || episode.contentHash !== target.audioHash)
          throw new AppError('FILE_CHANGED', '音频版本已变化，请重新打开目录。')
        const saved = this.getTranscriptHeader(target.episodeId, target.audioHash)
        const latest = this.latestJob(target.episodeId, target.audioHash)
        const job =
          latest && unsaved?.id === latest.id && unsaved.attempt === latest.attempt
            ? { ...latest, ...unsaved, stage: unsaved.status }
            : latest
        return createSubtitleStatusSnapshot({
          ...target,
          durationMs: episode.durationMs,
          savedStatus: saved.status,
          coverage: saved.status === 'ready' ? saved.transcript.coverage : [],
          job: job
            ? {
                id: job.id,
                status: job.status,
                stage: job.stage,
                autoApply: job.autoApply,
                hasPreview: job.hasPreview,
                processedUntilMs: job.processedUntilMs,
                completedChunks: job.completedChunks,
                totalChunks: job.totalChunks,
                cacheHits: job.cacheHits,
              }
            : null,
          jobCoverage: job?.hasPreview
            ? this.readCoverage('transcription_jobs', job.id, job.previewRevision)
            : null,
        })
      }),
    )
  }

  getTranscript(episodeId: string, audioHash: string): TranscriptState {
    const row = this.db
      .prepare(
        `SELECT id, episode_id AS episodeId, document_json, revision,
      imported_at AS importedAt FROM transcripts WHERE episode_id = ? AND audio_hash = ?`,
      )
      .get(episodeId, audioHash)
    if (row)
      return {
        status: 'ready',
        transcript: {
          id: row.id as string,
          episodeId: row.episodeId as string,
          revision: row.revision as number,
          importedAt: row.importedAt as string,
          document: JSON.parse(row.document_json as string) as TranscriptDocument,
        },
      }
    return this.absentTranscript(episodeId)
  }

  private persistTranscript(
    episodeId: string,
    document: TranscriptDocument,
    encoded: string,
    preserveHistory = false,
  ): Omit<StoredTranscript, 'document'> {
    if (this.getAudio(episodeId)?.contentHash !== document.audioHash)
      throw new AppError('FILE_CHANGED', '音频版本已变化，请重新选择章节后导入文稿。')
    this.coverageCache.clear()
    if (!preserveHistory) {
      this.editing.clear({ episodeId, audioHash: document.audioHash })
      this.subtitleImports.clear({ episodeId, audioHash: document.audioHash })
    }
    const row = this.db
      .prepare(
        `INSERT INTO transcripts(id, episode_id, audio_hash, document_json, imported_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(episode_id, audio_hash) DO UPDATE SET
        document_json = excluded.document_json, revision = revision + 1, imported_at = excluded.imported_at
      RETURNING id,episode_id AS episodeId,revision,imported_at AS importedAt`,
      )
      .get(randomUUID(), episodeId, document.audioHash, encoded, new Date().toISOString())!
    return {
      id: String(row.id),
      episodeId: String(row.episodeId),
      revision: Number(row.revision),
      importedAt: String(row.importedAt),
    }
  }

  private writeTranscript(
    episodeId: string,
    document: TranscriptDocument,
    preserveHistory = false,
  ): TranscriptState {
    const metadata = this.persistTranscript(
      episodeId,
      document,
      JSON.stringify(document),
      preserveHistory,
    )
    return { status: 'ready', transcript: { ...metadata, document: structuredClone(document) } }
  }

  saveTranscript(episodeId: string, document: TranscriptDocument): TranscriptState {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const state = this.writeTranscript(episodeId, document)
      this.db
        .prepare(
          'UPDATE transcription_jobs SET auto_apply = 0 WHERE episode_id = ? AND audio_hash = ?',
        )
        .run(episodeId, document.audioHash)
      this.db.exec('COMMIT')
      this.originals.transcriptChanged({ episodeId, audioHash: document.audioHash })
      return state
    } catch (error) {
      // SQLITE_FULL may already have rolled back the transaction.
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  editTranscript(request: TranscriptEdit): TranscriptState {
    const state = this.getTranscript(request.episodeId, request.audioHash)
    if (state.status !== 'ready' || state.transcript.revision !== request.revision)
      throw new AppError('CONFLICT', '文稿已更新，请重新打开这一句后再纠错。')
    const segment = state.transcript.document.segments.find(
      (segment) => segment.id === request.segmentId,
    )
    if (!segment || !isSmallTranscriptEdit(segment.text, request.text.trim()))
      throw new AppError(
        'INVALID_TRANSCRIPT',
        '这里只支持小范围文字纠错；断句、合并或大幅改写需要重新对齐文稿。',
      )
    return this.performTranscriptEdit({
      ...request,
      commandId: randomUUID(),
      operation: { kind: 'text', segmentId: request.segmentId, text: request.text.trim() },
    }).transcript
  }

  private jobRow(row: unknown): StoredTranscriptionJob | undefined {
    if (!row) return undefined
    const value = row as StoredTranscriptionJob
    return {
      ...value,
      background: !!value.background,
      autoApply: !!value.autoApply,
      hasPreview: !!value.hasPreview,
    }
  }
  getJob(id: string): StoredTranscriptionJob | undefined {
    return this.jobRow(
      this.db.prepare(`SELECT ${JOB_COLUMNS} FROM transcription_jobs WHERE id = ?`).get(id),
    )
  }
  latestJob(episodeId: string, audioHash: string): StoredTranscriptionJob | null {
    return (
      this.jobRow(
        this.db
          .prepare(
            `SELECT ${JOB_COLUMNS} FROM transcription_jobs WHERE episode_id = ? AND audio_hash = ? ORDER BY rowid DESC LIMIT 1`,
          )
          .get(episodeId, audioHash),
      ) ?? null
    )
  }
  activeJobs(): StoredTranscriptionJob[] {
    return this.db
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM transcription_jobs WHERE status IN ('queued','running','canceling') ORDER BY background,rowid`,
      )
      .all()
      .map((row) => this.jobRow(row)!)
  }
  listJobs(query: TaskQuery, unsaved?: UnsavedJobTerminal): TaskPage {
    const pending =
      unsaved && this.getJob(unsaved.id)?.attempt === unsaved.attempt ? unsaved : undefined
    const condition = query.activeOnly
      ? "WHERE status IN ('queued','running','canceling')" + (pending ? ' AND id<>?' : '')
      : ''
    const parameters = query.activeOnly && pending ? [pending.id] : []
    const total = this.db
      .prepare(`SELECT count(*) AS n FROM transcription_jobs ${condition}`)
      .get(...parameters)!.n as number
    const rows = this.db
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM transcription_jobs ${condition} ORDER BY rowid DESC LIMIT 25 OFFSET ?`,
      )
      .all(...parameters, query.page * 25)
    const jobs = rows.map((row) => {
      let job = this.jobRow(row)!
      if (pending?.id === job.id) job = { ...job, ...pending, stage: pending.status }
      const metadata = this.db
        .prepare(
          `SELECT e.title AS episodeTitle,b.title AS bookTitle,e.content_hash AS hash FROM episodes e JOIN books b ON b.id=e.book_id WHERE e.id=?`,
        )
        .get(job.episodeId)!
      return {
        ...job,
        episodeTitle: metadata.episodeTitle,
        bookTitle: metadata.bookTitle,
        stale: metadata.hash !== job.audioHash,
      } as TaskSummary
    })
    const active = this.activeJobs().filter((job) => job.id !== pending?.id)
    return {
      jobs,
      total,
      active: active.length,
      running: active.filter((job) => job.status !== 'queued').length,
    }
  }
  jobDocument(id: string): TranscriptDocument | null {
    const row = this.db.prepare('SELECT document_json FROM transcription_jobs WHERE id = ?').get(id)
    return row?.document_json
      ? (JSON.parse(row.document_json as string) as TranscriptDocument)
      : null
  }
  createJob(request: StartTranscription, background = false): StoredTranscriptionJob {
    const episode = this.getEpisode(request.episodeId)
    if (!episode || episode.contentHash !== request.audioHash)
      throw new AppError('FILE_CHANGED', '音频版本已变化，请重新选择章节。')
    const live = this.activeJobs().find(
      (job) => job.episodeId === request.episodeId && job.audioHash === request.audioHash,
    )
    if (live) {
      if (live.engine !== request.engine || live.device !== request.device)
        throw new AppError('BUSY', '请先取消正在运行的转写任务。')
      if (!background) this.promoteJob(live.id)
      return this.getJob(live.id)!
    }
    const revision = Number(
      this.db
        .prepare('SELECT revision FROM transcripts WHERE episode_id=? AND audio_hash=?')
        .get(request.episodeId, request.audioHash)?.revision ?? 0,
    )
    const id = randomUUID(),
      now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO transcription_jobs(id,episode_id,audio_hash,engine,device,background,cpu_threads,status,auto_apply,applied_revision,range_end_ms,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'queued',?,?,?,?,?)`,
      )
      .run(
        id,
        request.episodeId,
        request.audioHash,
        request.engine,
        request.device,
        Number(background),
        this.processingResources().policy.cpuThreads,
        revision === 0 ? 1 : 0,
        revision,
        episode.durationMs === null ? null : Math.round(episode.durationMs),
        now,
        now,
      )
    return this.getJob(id)!
  }
  promoteJob(id: string): void {
    this.db.prepare('UPDATE transcription_jobs SET background=0 WHERE id=?').run(id)
  }
  demoteJob(id: string): void {
    this.db.prepare('UPDATE transcription_jobs SET background=1 WHERE id=?').run(id)
  }
  setJobStatus(
    id: string,
    attempt: number,
    status: TranscriptionStatus,
    error: string | null = null,
  ): void {
    this.db
      .prepare(
        `UPDATE transcription_jobs SET status = ?, stage = ?, error_text = ?, updated_at = ? WHERE id = ? AND attempt = ?`,
      )
      .run(status, status, error, new Date().toISOString(), id, attempt)
  }
  jobProgress(id: string, attempt: number, stage: string): void {
    this.db
      .prepare(
        `UPDATE transcription_jobs SET stage = ?, updated_at = ? WHERE id = ? AND attempt = ? AND status = 'running'`,
      )
      .run(stage, new Date().toISOString(), id, attempt)
  }
  bindJobConfiguration(id: string, attempt: number, configurationHash: string): void {
    const job = this.getJob(id)
    if (!job || job.attempt !== attempt || job.status !== 'running')
      throw new AppError('CONFLICT', '转写任务已变化。')
    if (job.configurationHash && job.configurationHash !== configurationHash)
      throw new AppError('CONFLICT', '转写组件版本已变化，请生成新任务；已有文稿保留。')
    this.db
      .prepare('UPDATE transcription_jobs SET configuration_hash = ? WHERE id = ? AND attempt = ?')
      .run(configurationHash, id, attempt)
  }
  retryJob(id: string): StoredTranscriptionJob {
    const job = this.getJob(id)
    if (!job || !['failed', 'canceled'].includes(job.status))
      throw new AppError('INVALID_REQUEST', '这个任务当前不能重试。')
    if (this.getAudio(job.episodeId)?.contentHash !== job.audioHash)
      throw new AppError('FILE_CHANGED', '音频版本已变化，请重新生成任务。')
    if (
      this.activeJobs().some(
        (other) => other.episodeId === job.episodeId && other.audioHash === job.audioHash,
      )
    )
      throw new AppError('BUSY', '这一集已有转写任务。')
    this.db
      .prepare(
        `UPDATE transcription_jobs SET status='queued',stage='queued',attempt=attempt+1,error_text=NULL,updated_at=? WHERE id=?`,
      )
      .run(new Date().toISOString(), id)
    return this.getJob(id)!
  }
  recoverJobs(): void {
    this.db
      .prepare(
        `UPDATE transcription_jobs SET status='canceled',stage='canceled',updated_at=? WHERE status='canceling'`,
      )
      .run(new Date().toISOString())
    this.db
      .prepare(
        `UPDATE transcription_jobs SET status='queued',stage='queued',attempt=attempt+1,error_text='上次处理被中断，将复用已完成分块。',updated_at=? WHERE status='running'`,
      )
      .run(new Date().toISOString())
  }
  interruptJob(id: string, attempt: number): void {
    this.db
      .prepare(
        `UPDATE transcription_jobs SET status='queued',stage='queued',attempt=attempt+1,updated_at=? WHERE id=? AND attempt=? AND status='running'`,
      )
      .run(new Date().toISOString(), id, attempt)
  }
  acceptJobSnapshot(
    id: string,
    attempt: number,
    snapshot: AsrSnapshot,
    completedChunks: number,
    final: boolean,
    reportedDurationMs?: number,
  ): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // External writers cannot commit while this write transaction owns the
      // lock. Keep that version when publishing caches after COMMIT as well.
      const dataVersion = this.dataVersion()
      const job = this.getJob(id)
      if (
        !job ||
        job.attempt !== attempt ||
        job.status !== 'running' ||
        this.getAudio(job.episodeId)?.contentHash !== job.audioHash
      ) {
        this.db.exec('ROLLBACK')
        return false
      }
      if (final && reportedDurationMs !== undefined) {
        if (
          !Number.isFinite(reportedDurationMs) ||
          reportedDurationMs <= 0 ||
          reportedDurationMs > 3.6e10
        )
          throw new AppError('INVALID_REQUEST', '转写返回的容器音频时长无效。')
        // The worker probes the container. Preserve an independently measured
        // Chromium/decoder duration: container padding is not extra audible coverage.
        this.db
          .prepare(
            'UPDATE episodes SET duration_ms=coalesce(duration_ms,?) WHERE id=? AND content_hash=?',
          )
          .run(reportedDurationMs, job.episodeId, job.audioHash)
        const selectedDurationMs = this.getEpisode(job.episodeId)!.durationMs!
        this.db
          .prepare('UPDATE offline_plan_items SET duration_ms=? WHERE job_id=? AND audio_hash=?')
          .run(selectedDurationMs, job.id, job.audioHash)
      }
      const cached = this.acceptedSnapshot
      const reusable =
        cached?.id === id &&
        cached.revision === job.previewRevision &&
        cached.dataVersion === dataVersion
      const old = reusable
        ? cached.encoded
        : (this.db.prepare('SELECT document_json FROM transcription_jobs WHERE id=?').get(id)
            ?.document_json as string | null)
      const previous = reusable
        ? cached.document
        : old
          ? (JSON.parse(old) as TranscriptDocument)
          : null
      const document = validateTranscript(
        mergeJobDocument(previous, snapshot.document),
        job.audioHash,
        this.getEpisode(job.episodeId)!.durationMs,
      )
      const encoded = JSON.stringify(document)
      let revision = job.appliedRevision
      let autoApply = job.autoApply
      let formal: Omit<StoredTranscript, 'document'> | undefined
      if (encoded !== old && autoApply) {
        const currentRevision = Number(
          this.db
            .prepare('SELECT revision FROM transcripts WHERE episode_id=? AND audio_hash=?')
            .get(job.episodeId, job.audioHash)?.revision ?? 0,
        )
        if (currentRevision !== revision) autoApply = false
        else {
          formal = this.persistTranscript(job.episodeId, document, encoded)
          revision = formal.revision
        }
      }
      this.db
        .prepare(
          `UPDATE transcription_jobs SET status=?,stage=?,document_json=?,preview_revision=preview_revision+?,
        processed_until_ms=?,completed_chunks=?,total_chunks=?,cache_hits=?,issue_count=?,auto_apply=?,applied_revision=?,updated_at=?,error_text=NULL WHERE id=? AND attempt=?`,
        )
        .run(
          final ? 'completed' : 'running',
          final ? 'completed' : 'recognizing',
          encoded,
          encoded === old ? 0 : 1,
          processedPrefix(document.coverage),
          completedChunks,
          snapshot.totalChunks,
          snapshot.cacheHits,
          snapshot.issues.length,
          autoApply ? 1 : 0,
          revision,
          new Date().toISOString(),
          id,
          attempt,
        )
      this.db.exec('COMMIT')
      const previewRevision = job.previewRevision + Number(encoded !== old)
      this.acceptedSnapshot = {
        id,
        revision: previewRevision,
        dataVersion,
        encoded,
        document,
      }
      this.rememberCoverage(
        'transcription_jobs:' + id,
        previewRevision,
        document.coverage,
        dataVersion,
      )
      if (formal) {
        this.rememberCoverage(
          'transcripts:' + formal.id,
          formal.revision,
          document.coverage,
          dataVersion,
        )
        this.originals.transcriptChanged({ episodeId: job.episodeId, audioHash: job.audioHash })
      }
      return true
    } catch (error) {
      // SQLITE_FULL may already have rolled back the transaction.
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }
  applyJob(id: string, expectedRevision: number): TranscriptState {
    const job = this.getJob(id),
      document = this.jobDocument(id)
    if (!job || !document || !['completed', 'failed', 'canceled'].includes(job.status))
      throw new AppError('INVALID_REQUEST', '请等待任务结束或取消后再使用生成稿。')
    const current = this.getTranscript(job.episodeId, job.audioHash)
    if ((current.status === 'ready' ? current.transcript.revision : 0) !== expectedRevision)
      throw new AppError('CONFLICT', '当前文稿已更新，请先检查再使用生成稿。')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const state = this.writeTranscript(
        job.episodeId,
        validateTranscript(document, job.audioHash, this.getEpisode(job.episodeId)?.durationMs),
      )
      this.db
        .prepare('UPDATE transcription_jobs SET auto_apply=0 WHERE episode_id=? AND audio_hash=?')
        .run(job.episodeId, job.audioHash)
      if (state.status === 'ready')
        this.db
          .prepare('UPDATE transcription_jobs SET auto_apply=1,applied_revision=? WHERE id=?')
          .run(state.transcript.revision, id)
      this.db.exec('COMMIT')
      this.originals.transcriptChanged({ episodeId: job.episodeId, audioHash: job.audioHash })
      return state
    } catch (error) {
      // SQLITE_FULL may already have rolled back the transaction.
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }
}
