import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Episode } from '../shared/contracts'
import { createSubtitleStatusSnapshot } from '../shared/subtitle-status'
import type { StartTranscription } from '../shared/transcription'
import { AppError } from '../shared/validation'
import {
  MAX_ACTIVE_OFFLINE_PLANS,
  MAX_OFFLINE_ITEMS,
  MAX_OFFLINE_AUDIO_BUDGET_BYTES,
  OFFLINE_ITEMS_PAGE_SIZE,
  OFFLINE_PLAN_PAGE_SIZE,
  type OfflinePlan,
  type OfflinePlanItem,
  type OfflineProfile,
  type OfflineSelection,
  type OfflinePlanStatus,
  type OfflineItemStatus,
  type UpdateOfflinePlanRequest,
} from '../shared/offline'
import type { FileMetadata, StoredAudio, StoredTranscriptionJob } from './database'

export const OFFLINE_SCHEMA = `
CREATE TABLE offline_plans (
 id TEXT PRIMARY KEY,book_id TEXT NOT NULL,book_title TEXT NOT NULL,scope TEXT NOT NULL,
 engine TEXT NOT NULL CHECK(engine IN ('paraformer','whisperx')),device TEXT NOT NULL CHECK(device IN ('cpu','cuda')),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),audio_budget_bytes INTEGER NOT NULL CHECK(audio_budget_bytes>=0),
 status TEXT NOT NULL CHECK(status IN ('queued','running','paused','blocked','completed','completed-with-issues','canceled')),
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,error_text TEXT,retention_released_at TEXT
) STRICT;
CREATE TABLE offline_plan_items (
 id TEXT PRIMARY KEY,plan_id TEXT NOT NULL REFERENCES offline_plans(id) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL,episode_id TEXT NOT NULL,episode_title TEXT NOT NULL,episode_order INTEGER NOT NULL,
 source_json TEXT,initial_hash TEXT,audio_hash TEXT,file_json TEXT,duration_ms REAL,
 audio_valid INTEGER NOT NULL DEFAULT 0 CHECK(audio_valid IN (0,1)),
 status TEXT NOT NULL CHECK(status IN ('queued','downloading','waiting-foreground','audio-ready','transcribing','ready','needs-attention','failed','canceled')),
 attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt>0),error_text TEXT,
 job_id TEXT REFERENCES transcription_jobs(id) ON DELETE SET NULL,retry_requested INTEGER NOT NULL DEFAULT 0 CHECK(retry_requested IN (0,1)),
 updated_at TEXT NOT NULL,UNIQUE(plan_id,episode_id),UNIQUE(plan_id,ordinal)
) STRICT;
CREATE INDEX offline_items_job ON offline_plan_items(job_id);
CREATE TABLE offline_media_refs (
 item_id TEXT PRIMARY KEY REFERENCES offline_plan_items(id) ON DELETE CASCADE,
 path TEXT NOT NULL,content_hash TEXT NOT NULL,size_bytes INTEGER NOT NULL CHECK(size_bytes>0),modified_at REAL NOT NULL
) STRICT;
CREATE INDEX offline_media_path ON offline_media_refs(path,content_hash,size_bytes,modified_at);
CREATE TABLE offline_job_owners (
 job_id TEXT PRIMARY KEY REFERENCES transcription_jobs(id) ON DELETE CASCADE,
 manual INTEGER NOT NULL DEFAULT 0 CHECK(manual IN (0,1)),
 planned INTEGER NOT NULL DEFAULT 0 CHECK(planned IN (0,1))
) STRICT;
`
const TERMINAL: OfflinePlanStatus[] = ['completed', 'completed-with-issues', 'canceled']
const RUNNABLE: OfflinePlanStatus[] = ['queued', 'running']
const HASH = /^[a-f0-9]{64}$/
const ITEM_STATES: OfflineItemStatus[] = [
  'queued',
  'downloading',
  'waiting-foreground',
  'audio-ready',
  'transcribing',
  'ready',
  'needs-attention',
  'failed',
  'canceled',
]
export interface OfflineFileIdentity extends FileMetadata {
  contentHash: string
}
export type OfflineMediaIdentity = Pick<
  OfflineFileIdentity,
  'path' | 'contentHash' | 'sizeBytes' | 'modifiedAt'
>
export interface StoredOfflineItem extends OfflinePlanItem {
  file: OfflineFileIdentity | null
  audioVerified: boolean
  retryRequested: boolean
}
export interface OfflineItemContext {
  planId: string
  planRevision: number
  itemId: string
  attempt: number
}
export interface CreateOfflinePlan {
  bookId: string
  episodeIds: string[]
  scope: OfflineSelection['kind']
  profile: OfflineProfile
  audioBudgetBytes: number
}
export interface UpdateOfflineItem extends OfflineItemContext {
  patch: {
    status?: OfflineItemStatus
    error?: string | null
    audioReady?: boolean
    durationMs?: number | null
  }
  /** Invalidate a preempted download before rescheduling within the same control revision. */
  advanceAttempt?: boolean
}
export interface OfflineReadiness {
  audioReady: boolean
  subtitleReady: boolean
  subtitleState: 'missing' | 'stale' | 'partial' | 'ready' | 'preview' | 'unknown-duration'
  subtitleSource: OfflinePlanItem['subtitleSource']
  subtitleRevision: number | null
  durationMs: number | null
  changed: boolean
}
/** Scheduler-only state: no items, transcript coverage, or file identities are read. */
export type OfflinePlanControl = Pick<
  OfflinePlan,
  'id' | 'revision' | 'status' | 'profile' | 'audioBudgetBytes'
>
interface Host {
  getEpisode(id: string): Episode | undefined
  getAudio(id: string): StoredAudio | undefined
  latestJob(id: string, hash: string): StoredTranscriptionJob | null
  getJob(id: string): StoredTranscriptionJob | null
  createJob(request: StartTranscription, background: boolean): StoredTranscriptionJob
  retryJob(id: string): StoredTranscriptionJob
  cacheSourceEpisode(id: string, audio: OfflineFileIdentity): void
}
type Row = Record<string, unknown>
function conflict(message = '离线计划已变化，请刷新后重试。'): never {
  throw new AppError('CONFLICT', message)
}
function validBudget(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_OFFLINE_AUDIO_BUDGET_BYTES)
    throw new AppError('INVALID_REQUEST', '离线音频预算无效。')
}
function validProfile(value: OfflineProfile): void {
  if (
    !value ||
    !['paraformer', 'whisperx'].includes(value.engine) ||
    !['cpu', 'cuda'].includes(value.device)
  )
    throw new AppError('INVALID_REQUEST', '离线计划引擎或设备无效。')
}
function sameFile(
  a: OfflineMediaIdentity | null,
  b: OfflineMediaIdentity | null | undefined,
): boolean {
  return (
    !!a &&
    !!b &&
    a.path === b.path &&
    a.contentHash === b.contentHash &&
    a.sizeBytes === b.sizeBytes &&
    a.modifiedAt === b.modifiedAt
  )
}
function now(): string {
  return new Date().toISOString()
}

/** Shares LibraryStore's single connection; all public multi-write operations are atomic. */
export class OfflineStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly host: Host,
  ) {}
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }
  private planRow(id: string): Row | null {
    return (
      (this.db.prepare('SELECT * FROM offline_plans WHERE id=?').get(id) as unknown as Row) ?? null
    )
  }
  private itemRow(id: string): Row | null {
    return (
      (this.db.prepare('SELECT * FROM offline_plan_items WHERE id=?').get(id) as unknown as Row) ??
      null
    )
  }
  private controlDto(row: Row): OfflinePlanControl {
    return {
      id: String(row.id),
      revision: Number(row.revision),
      status: row.status as OfflinePlanStatus,
      profile: {
        engine: row.engine as OfflineProfile['engine'],
        device: row.device as OfflineProfile['device'],
      },
      audioBudgetBytes: Number(row.audio_budget_bytes),
    }
  }
  planControl(id: string): OfflinePlanControl | null {
    const row = this.db
      .prepare(
        'SELECT id,revision,status,engine,device,audio_budget_bytes FROM offline_plans WHERE id=?',
      )
      .get(id) as Row | undefined
    return row ? this.controlDto(row) : null
  }
  schedulingPlans(): OfflinePlanControl[] {
    const rows = this.db
      .prepare(
        "SELECT id,revision,status,engine,device,audio_budget_bytes FROM offline_plans WHERE status IN ('queued','running') ORDER BY rowid DESC LIMIT ?",
      )
      .all(MAX_ACTIVE_OFFLINE_PLANS) as Row[]
    return rows.map((row) => this.controlDto(row))
  }
  private rawItem(row: Row): StoredOfflineItem {
    return {
      id: String(row.id),
      planId: String(row.plan_id),
      ordinal: Number(row.ordinal),
      episodeId: String(row.episode_id),
      episodeTitle: String(row.episode_title),
      episodeOrder: Number(row.episode_order),
      source: row.source_json ? JSON.parse(String(row.source_json)) : null,
      initialHash: row.initial_hash as string | null,
      audioHash: row.audio_hash as string | null,
      file: row.file_json ? JSON.parse(String(row.file_json)) : null,
      audioReady: false,
      audioVerified: !!row.audio_valid,
      mediaBytes: null,
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      status: row.status as OfflineItemStatus,
      attempt: Number(row.attempt),
      error: row.error_text as string | null,
      jobId: row.job_id as string | null,
      retryRequested: !!row.retry_requested,
      subtitleSource: null,
      subtitleRevision: null,
      updatedAt: String(row.updated_at),
    }
  }
  storedItem(id: string): StoredOfflineItem | null {
    const row = this.itemRow(id)
    if (!row) return null
    const item = this.rawItem(row),
      ready = this.readiness(item)
    return {
      ...item,
      audioReady: ready.audioReady,
      mediaBytes: item.file?.sizeBytes ?? null,
      durationMs: ready.durationMs,
      subtitleSource: ready.subtitleSource,
      subtitleRevision: ready.subtitleRevision,
    }
  }
  storedItems(id: string): StoredOfflineItem[] {
    return (
      this.db
        .prepare('SELECT id FROM offline_plan_items WHERE plan_id=? ORDER BY ordinal')
        .all(id) as { id: string }[]
    ).map((row) => this.storedItem(row.id)!)
  }
  private dto(item: StoredOfflineItem): OfflinePlanItem {
    return {
      id: item.id,
      planId: item.planId,
      ordinal: item.ordinal,
      episodeId: item.episodeId,
      episodeTitle: item.episodeTitle,
      episodeOrder: item.episodeOrder,
      source: item.source,
      initialHash: item.initialHash,
      audioHash: item.audioHash,
      audioReady: item.audioReady,
      mediaBytes: item.mediaBytes,
      durationMs: item.durationMs,
      status: item.status,
      attempt: item.attempt,
      error: item.error,
      jobId: item.jobId,
      subtitleSource: item.subtitleSource,
      subtitleRevision: item.subtitleRevision,
      updatedAt: item.updatedAt,
    }
  }
  readiness(value: StoredOfflineItem | string): OfflineReadiness {
    const item =
      typeof value === 'string'
        ? this.itemRow(value)
          ? this.rawItem(this.itemRow(value)!)
          : null
        : value
    if (!item) throw new AppError('INVALID_REQUEST', '离线分集不存在。')
    const episode = this.host.getEpisode(item.episodeId),
      audio = this.host.getAudio(item.episodeId)
    const sourceMatches =
      !!episode &&
      (item.source
        ? episode.online?.sourceId === item.source.sourceId &&
          episode.online.bookId === item.source.bookId &&
          episode.online.episodeId === item.source.episodeId
        : !episode.online)
    const changed = !sourceMatches || (!!item.audioHash && audio?.contentHash !== item.audioHash)
    const durationMs = !changed ? (episode?.durationMs ?? item.durationMs) : item.durationMs
    const retained =
      !item.source ||
      !!this.db
        .prepare(
          'SELECT 1 FROM offline_media_refs WHERE item_id=? AND path=? AND content_hash=? AND size_bytes=? AND modified_at=?',
        )
        .get(
          item.id,
          item.file?.path ?? '',
          item.audioHash ?? '',
          item.file?.sizeBytes ?? -1,
          item.file?.modifiedAt ?? -1,
        )
    const audioReady = !changed && item.audioVerified && sameFile(item.file, audio) && retained
    // Read only the small coverage field; listing a long plan must not parse every full text.
    const saved =
      item.audioHash && !changed
        ? this.db
            .prepare(
              "SELECT revision,json_extract(document_json,'$.kind') AS kind,json_extract(document_json,'$.coverage') AS coverage FROM transcripts WHERE episode_id=? AND audio_hash=?",
            )
            .get(item.episodeId, item.audioHash)
        : undefined
    const savedStatus = saved
      ? ('ready' as const)
      : this.db.prepare('SELECT 1 FROM transcripts WHERE episode_id=? LIMIT 1').get(item.episodeId)
        ? ('stale' as const)
        : ('missing' as const)
    const status =
      item.audioHash && !changed
        ? createSubtitleStatusSnapshot({
            episodeId: item.episodeId,
            audioHash: item.audioHash,
            positionMs: 0,
            durationMs: durationMs ?? null,
            savedStatus,
            coverage: saved ? JSON.parse(String(saved.coverage ?? '[]')) : [],
            job: null,
          })
        : null
    const latest =
      item.audioHash && !changed ? this.host.latestJob(item.episodeId, item.audioHash) : null
    return {
      audioReady,
      changed,
      durationMs: durationMs ?? null,
      subtitleReady: !!status?.savedCoverage.complete,
      subtitleState: changed
        ? 'stale'
        : saved
          ? durationMs === null
            ? 'unknown-duration'
            : status!.savedCoverage.complete
              ? 'ready'
              : 'partial'
          : latest?.hasPreview && !latest.autoApply
            ? 'preview'
            : savedStatus,
      subtitleSource: saved ? (saved.kind as OfflinePlanItem['subtitleSource']) : null,
      subtitleRevision: saved ? Number(saved.revision) : null,
    }
  }
  plan(id: string): OfflinePlan | null {
    const row = this.planRow(id)
    if (!row) return null
    const items = (
        this.db
          .prepare('SELECT * FROM offline_plan_items WHERE plan_id=? ORDER BY ordinal')
          .all(id) as unknown as Row[]
      ).map((row) => this.rawItem(row)),
      readiness = items.map((item) => this.readiness(item))
    const counts = {
      total: items.length,
      audioReady: readiness.filter((item) => item.audioReady).length,
      subtitleReady: readiness.filter((item) => item.subtitleReady).length,
      needsAttention: items.filter(
        (item, i) => item.status === 'needs-attention' || readiness[i]!.changed,
      ).length,
      failed: items.filter((item) => item.status === 'failed').length,
      canceled: items.filter((item) => item.status === 'canceled').length,
    }
    const allReady =
      counts.total > 0 &&
      counts.audioReady === counts.total &&
      counts.subtitleReady === counts.total
    const status =
      row.status === 'completed' && !allReady && !row.retention_released_at
        ? 'completed-with-issues'
        : (row.status as OfflinePlanStatus)
    return {
      id,
      revision: Number(row.revision),
      bookId: String(row.book_id),
      bookTitle: String(row.book_title),
      scope: row.scope as OfflineSelection['kind'],
      profile: {
        engine: row.engine as OfflineProfile['engine'],
        device: row.device as OfflineProfile['device'],
      },
      audioBudgetBytes: Number(row.audio_budget_bytes),
      status,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      error: row.error_text as string | null,
      retentionReleasedAt: row.retention_released_at as string | null,
      counts,
    }
  }
  plans(page = 0, activeOnly = false) {
    if (!Number.isSafeInteger(page) || page < 0)
      throw new AppError('INVALID_REQUEST', '计划页码无效。')
    const filter = activeOnly
      ? "WHERE status NOT IN ('completed','completed-with-issues','canceled')"
      : ''
    const total = Number(
      this.db.prepare(`SELECT count(*) AS n FROM offline_plans ${filter}`).get()!.n,
    )
    const ids = this.db
      .prepare(`SELECT id FROM offline_plans ${filter} ORDER BY rowid DESC LIMIT ? OFFSET ?`)
      .all(OFFLINE_PLAN_PAGE_SIZE, page * OFFLINE_PLAN_PAGE_SIZE) as { id: string }[]
    return { page, total, plans: ids.map((row) => this.plan(row.id)!) }
  }
  items(id: string, page = 0) {
    if (!Number.isSafeInteger(page) || page < 0)
      throw new AppError('INVALID_REQUEST', '分集页码无效。')
    const ids = this.db
      .prepare(
        'SELECT id FROM offline_plan_items WHERE plan_id=? ORDER BY ordinal LIMIT ? OFFSET ?',
      )
      .all(id, OFFLINE_ITEMS_PAGE_SIZE, page * OFFLINE_ITEMS_PAGE_SIZE) as { id: string }[]
    return {
      page,
      total: Number(
        this.db.prepare('SELECT count(*) AS n FROM offline_plan_items WHERE plan_id=?').get(id)!.n,
      ),
      items: ids.map((row) => this.dto(this.storedItem(row.id)!)),
    }
  }
  create(request: CreateOfflinePlan): OfflinePlan {
    validProfile(request.profile)
    validBudget(request.audioBudgetBytes)
    if (
      !Array.isArray(request.episodeIds) ||
      !request.episodeIds.length ||
      request.episodeIds.length > MAX_OFFLINE_ITEMS ||
      new Set(request.episodeIds).size !== request.episodeIds.length ||
      !['all', 'range', 'ids'].includes(request.scope)
    )
      throw new AppError('INVALID_REQUEST', '离线计划集数或选择范围无效。')
    return this.transaction(() => {
      if (
        Number(
          this.db
            .prepare(
              "SELECT count(*) AS n FROM offline_plans WHERE status NOT IN ('completed','completed-with-issues','canceled')",
            )
            .get()!.n,
        ) >= MAX_ACTIVE_OFFLINE_PLANS
      )
        throw new AppError('BUSY', '最多同时保留 5 个未结束离线计划。')
      const book = this.db.prepare('SELECT title FROM books WHERE id=?').get(request.bookId)
      if (!book) throw new AppError('FILE_UNAVAILABLE', '书籍已移除。')
      const episodes = request.episodeIds.map((id) => this.host.getEpisode(id))
      if (episodes.some((episode) => !episode || episode.bookId !== request.bookId))
        throw new AppError('FILE_CHANGED', '离线章节不再属于同一本书，请重新预览。')
      const selected = (episodes as Episode[]).sort((a, b) => a.order - b.order)
      if (
        request.scope === 'range' &&
        selected.some((episode, i) => i > 0 && episode.order !== selected[i - 1]!.order + 1)
      )
        throw new AppError('INVALID_REQUEST', '连续范围不能跳过章节。')
      if (request.scope === 'all') {
        const online = this.db
          .prepare('SELECT catalog_complete FROM online_books WHERE book_id=?')
          .get(request.bookId)
        const count = online
          ? Number(
              this.db
                .prepare('SELECT count(*) AS n FROM online_episodes WHERE book_id=?')
                .get(request.bookId)!.n,
            )
          : Number(
              this.db
                .prepare('SELECT count(*) AS n FROM episodes WHERE book_id=?')
                .get(request.bookId)!.n,
            )
        if ((online && !online.catalog_complete) || count !== selected.length)
          throw new AppError('SOURCE_CHANGED', '整书目录尚未完整或已经变化，请重新预览。')
      }
      const id = randomUUID(),
        stamp = now()
      this.db
        .prepare(
          "INSERT INTO offline_plans(id,book_id,book_title,scope,engine,device,audio_budget_bytes,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'queued',?,?)",
        )
        .run(
          id,
          request.bookId,
          String(book.title),
          request.scope,
          request.profile.engine,
          request.profile.device,
          request.audioBudgetBytes,
          stamp,
          stamp,
        )
      const insert = this.db.prepare(
        "INSERT INTO offline_plan_items(id,plan_id,ordinal,episode_id,episode_title,episode_order,source_json,initial_hash,audio_hash,file_json,duration_ms,status,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued',?)",
      )
      selected.forEach((episode, i) => {
        const audio = this.host.getAudio(episode.id),
          hash = episode.contentHash || null
        insert.run(
          randomUUID(),
          id,
          i + 1,
          episode.id,
          episode.title,
          episode.order,
          episode.online
            ? JSON.stringify({
                sourceId: episode.online.sourceId,
                bookId: episode.online.bookId,
                episodeId: episode.online.episodeId,
              })
            : null,
          hash,
          hash,
          audio
            ? JSON.stringify({
                path: audio.path,
                name: audio.name,
                sizeBytes: audio.sizeBytes,
                modifiedAt: audio.modifiedAt,
                contentHash: audio.contentHash,
              })
            : null,
          episode.durationMs,
          stamp,
        )
      })
      return this.plan(id)!
    })
  }
  private control(id: string, revision: number): Row {
    const plan = this.planRow(id)
    if (!plan || plan.revision !== revision) conflict()
    return plan
  }
  private context(request: OfflineItemContext, failureOnly = false): StoredOfflineItem {
    const plan = this.control(request.planId, request.planRevision),
      item = this.storedItem(request.itemId)
    if (
      !RUNNABLE.includes(plan.status as OfflinePlanStatus) ||
      !item ||
      item.planId !== request.planId ||
      item.attempt !== request.attempt ||
      item.status === 'canceled'
    )
      conflict()
    const episode = this.host.getEpisode(item.episodeId)
    if (
      !failureOnly &&
      (!episode ||
        episode.bookId !== plan.book_id ||
        (item.source
          ? episode.online?.sourceId !== item.source.sourceId ||
            episode.online.bookId !== item.source.bookId ||
            episode.online.episodeId !== item.source.episodeId
          : !!episode.online))
    )
      throw new AppError('SOURCE_CHANGED', '计划中冻结的章节身份已变化。')
    if (
      !failureOnly &&
      item.audioHash &&
      this.host.getAudio(item.episodeId)?.contentHash !== item.audioHash
    )
      throw new AppError('FILE_CHANGED', '计划音频版本已变化，旧计划不会自动改用新音频。')
    return item
  }
  update(request: UpdateOfflinePlanRequest): OfflinePlan {
    return this.transaction(() => {
      const plan = this.control(request.id, request.revision),
        status = plan.status as OfflinePlanStatus
      let next = status
      if (request.action === 'set-budget') validBudget(request.audioBudgetBytes)
      else if (request.action === 'cancel') next = 'canceled'
      else if (request.action === 'pause') {
        if (TERMINAL.includes(status)) conflict('已结束的离线计划不能暂停。')
        next = 'paused'
      } else if (request.action === 'resume') {
        if (!['paused', 'blocked'].includes(status)) conflict('只有暂停或受阻计划可恢复。')
        next = 'queued'
      } else if (request.action === 'retry-failed') {
        if (status === 'canceled') conflict('已取消计划不会自动恢复，请建立新计划。')
        const retried = this.db
          .prepare(
            "UPDATE offline_plan_items SET status=CASE WHEN audio_valid=1 THEN 'audio-ready' ELSE 'queued' END,attempt=attempt+1,retry_requested=1,error_text=NULL,updated_at=? WHERE plan_id=? AND status IN ('failed','needs-attention')",
          )
          .run(now(), request.id)
        if (!retried.changes) conflict('没有可重试的失败或需处理分集。')
        next = status === 'paused' ? 'paused' : 'queued'
      } else throw new AppError('INVALID_REQUEST', '离线计划操作无效。')
      if (
        request.action === 'pause' ||
        request.action === 'resume' ||
        request.action === 'set-budget'
      )
        this.db
          .prepare(
            "UPDATE offline_plan_items SET attempt=attempt+1,status=CASE WHEN audio_valid=1 THEN 'audio-ready' ELSE 'queued' END,updated_at=? WHERE plan_id=? AND status IN ('downloading','transcribing','waiting-foreground')",
          )
          .run(now(), request.id)
      if (request.action === 'cancel')
        this.db
          .prepare(
            "UPDATE offline_plan_items SET status='canceled',attempt=attempt+1,updated_at=? WHERE plan_id=? AND status NOT IN ('ready','canceled')",
          )
          .run(now(), request.id)
      this.db
        .prepare(
          'UPDATE offline_plans SET revision=revision+1,status=?,audio_budget_bytes=?,updated_at=?,error_text=NULL WHERE id=?',
        )
        .run(
          next,
          request.action === 'set-budget'
            ? request.audioBudgetBytes
            : Number(plan.audio_budget_bytes),
          now(),
          request.id,
        )
      return this.plan(request.id)!
    })
  }
  updateItem(request: UpdateOfflineItem): StoredOfflineItem {
    return this.transaction(() => {
      const failureOnly =
        ['failed', 'needs-attention'].includes(request.patch.status ?? '') &&
        request.patch.audioReady !== true &&
        request.patch.durationMs === undefined
      const item = this.context(request, failureOnly),
        patch = request.patch
      if (
        Object.keys(patch).some(
          (key) => !['status', 'error', 'audioReady', 'durationMs'].includes(key),
        ) ||
        (patch.status !== undefined && !ITEM_STATES.includes(patch.status)) ||
        (patch.error !== undefined &&
          patch.error !== null &&
          (typeof patch.error !== 'string' || patch.error.length > 2000))
      )
        throw new AppError('INVALID_REQUEST', '离线分集更新无效。')
      if (patch.durationMs !== undefined && patch.durationMs !== null) {
        if (
          !Number.isFinite(patch.durationMs) ||
          patch.durationMs <= 0 ||
          patch.durationMs > 3.6e10
        )
          throw new AppError('INVALID_REQUEST', '实际音频时长无效。')
        this.db
          .prepare('UPDATE episodes SET duration_ms=? WHERE id=? AND content_hash=?')
          .run(patch.durationMs, item.episodeId, item.audioHash)
      }
      if (
        patch.audioReady === true &&
        (!sameFile(item.file, this.host.getAudio(item.episodeId)) ||
          (item.source &&
            !this.db.prepare('SELECT 1 FROM offline_media_refs WHERE item_id=?').get(item.id)))
      )
        conflict('音频尚未验证或离线保留引用缺失。')
      this.db
        .prepare(
          'UPDATE offline_plan_items SET status=?,error_text=?,audio_valid=?,duration_ms=?,attempt=attempt+?,updated_at=? WHERE id=?',
        )
        .run(
          patch.status ?? item.status,
          patch.error === undefined ? item.error : patch.error,
          Number(patch.audioReady ?? item.audioVerified),
          patch.durationMs === undefined ? item.durationMs : patch.durationMs,
          request.advanceAttempt ? 1 : 0,
          now(),
          item.id,
        )
      if (patch.status === 'ready') {
        const ready = this.readiness(item.id)
        if (!ready.audioReady || !ready.subtitleReady)
          conflict('正式字幕尚未整集覆盖或音频尚未保留，不能标记已备。')
      }
      this.rollup(item.planId)
      return this.storedItem(item.id)!
    })
  }
  block(id: string, revision: number, error: string): OfflinePlan {
    if (typeof error !== 'string' || !error.trim() || error.length > 2000)
      throw new AppError('INVALID_REQUEST', '离线计划受阻原因无效。')
    return this.transaction(() => {
      const plan = this.control(id, revision)
      if (!RUNNABLE.includes(plan.status as OfflinePlanStatus)) conflict()
      this.db
        .prepare(
          "UPDATE offline_plan_items SET attempt=attempt+1,status=CASE WHEN audio_valid=1 THEN 'audio-ready' ELSE 'queued' END,updated_at=? WHERE plan_id=? AND status IN ('downloading','transcribing','waiting-foreground')",
        )
        .run(now(), id)
      this.db
        .prepare("UPDATE offline_plans SET status='blocked',error_text=?,updated_at=? WHERE id=?")
        .run(error, now(), id)
      return this.plan(id)!
    })
  }
  private rollup(id: string): void {
    const plan = this.planRow(id)!
    if (!RUNNABLE.includes(plan.status as OfflinePlanStatus)) return
    // Stage updates are frequent. Only scan formal coverage when every item is terminal.
    const counts = this.db
      .prepare(
        "SELECT count(*) AS total,sum(status IN ('downloading','transcribing')) AS active,sum(status IN ('ready','needs-attention','failed','canceled')) AS terminal,sum(status='ready') AS ready FROM offline_plan_items WHERE plan_id=?",
      )
      .get(id)!
    let status: OfflinePlanStatus =
      Number(counts.active) > 0 ? 'running' : (plan.status as OfflinePlanStatus)
    if (Number(counts.total) > 0 && counts.terminal === counts.total) {
      const verified = counts.ready === counts.total ? this.plan(id)!.counts : null
      status =
        verified !== null &&
        verified.audioReady === counts.total &&
        verified.subtitleReady === counts.total
          ? 'completed'
          : 'completed-with-issues'
    }
    this.db
      .prepare('UPDATE offline_plans SET status=?,updated_at=? WHERE id=?')
      .run(status, now(), id)
  }
  retain(request: OfflineItemContext, audio: OfflineFileIdentity): StoredOfflineItem {
    if (
      !audio.path ||
      audio.path.includes('\0') ||
      !HASH.test(audio.contentHash) ||
      !Number.isSafeInteger(audio.sizeBytes) ||
      audio.sizeBytes <= 0 ||
      !Number.isFinite(audio.modifiedAt)
    )
      throw new AppError('INVALID_REQUEST', '离线媒体身份无效。')
    return this.transaction(() => {
      const item = this.context(request)
      if (item.audioHash && item.audioHash !== audio.contentHash)
        throw new AppError('SOURCE_CHANGED', '下载音频与计划冻结版本不符，需要重新预览。')
      if (item.source) {
        const plan = this.planRow(item.planId)!,
          retained = this.references()
            .filter((file) => file.planId === item.planId && file.itemId !== item.id)
            .filter(
              (file, index, files) => files.findIndex((other) => sameFile(file, other)) === index,
            ),
          reused = retained.some((file) => sameFile(file, audio))
        if (
          retained.reduce((sum, file) => sum + file.sizeBytes, 0) + (reused ? 0 : audio.sizeBytes) >
          Number(plan.audio_budget_bytes)
        )
          throw new AppError('BUSY', '本计划离线音频预算不足，请调整预算后重试。')
        const registered = this.db
          .prepare('SELECT * FROM source_media_files WHERE path=?')
          .get(audio.path)
        if (
          registered &&
          (registered.content_hash !== audio.contentHash ||
            registered.size_bytes !== audio.sizeBytes ||
            registered.modified_at !== audio.modifiedAt)
        )
          conflict('同一缓存路径的媒体身份已经变化。')
        this.host.cacheSourceEpisode(item.episodeId, audio)
        this.db
          .prepare(
            'INSERT INTO offline_media_refs VALUES(?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET path=excluded.path,content_hash=excluded.content_hash,size_bytes=excluded.size_bytes,modified_at=excluded.modified_at',
          )
          .run(item.id, audio.path, audio.contentHash, audio.sizeBytes, audio.modifiedAt)
      } else if (!sameFile(audio, this.host.getAudio(item.episodeId)))
        throw new AppError('FILE_CHANGED', '本地原文件版本已变化。')
      this.db
        .prepare(
          "UPDATE offline_plan_items SET audio_hash=?,file_json=?,audio_valid=1,status='audio-ready',error_text=NULL,updated_at=? WHERE id=?",
        )
        .run(audio.contentHash, JSON.stringify(audio), now(), item.id)
      return this.storedItem(item.id)!
    })
  }
  references() {
    return this.db
      .prepare(
        'SELECT r.item_id AS itemId,i.plan_id AS planId,r.path,r.content_hash AS contentHash,r.size_bytes AS sizeBytes,r.modified_at AS modifiedAt FROM offline_media_refs r JOIN offline_plan_items i ON i.id=r.item_id',
      )
      .all() as unknown as (OfflineMediaIdentity & { itemId: string; planId: string })[]
  }
  retainedFiles(planId?: string): OfflineMediaIdentity[] {
    return this.db
      .prepare(
        `SELECT DISTINCT r.path,r.content_hash AS contentHash,r.size_bytes AS sizeBytes,r.modified_at AS modifiedAt FROM offline_media_refs r JOIN offline_plan_items i ON i.id=r.item_id ${planId ? 'WHERE i.plan_id=?' : ''}`,
      )
      .all(...(planId ? [planId] : [])) as unknown as OfflineMediaIdentity[]
  }
  invalidateMedia(file: OfflineMediaIdentity, error: string) {
    if (typeof error !== 'string' || !error.trim() || error.length > 2000)
      throw new AppError('INVALID_REQUEST', '离线媒体校验原因无效。')
    return this.transaction(() => {
      const targets = this.db
        .prepare(
          "SELECT id,plan_id FROM offline_plan_items WHERE json_extract(file_json,'$.path')=? AND json_extract(file_json,'$.contentHash')=? AND json_extract(file_json,'$.sizeBytes')=? AND json_extract(file_json,'$.modifiedAt')=? AND (audio_valid=1 OR status NOT IN ('canceled','needs-attention'))",
        )
        .all(file.path, file.contentHash, file.sizeBytes, file.modifiedAt) as {
        id: string
        plan_id: string
      }[]
      const update = this.db.prepare(
        "UPDATE offline_plan_items SET audio_valid=0,status=CASE WHEN status='canceled' THEN status ELSE 'needs-attention' END,error_text=?,attempt=attempt+1,updated_at=? WHERE id=?",
      )
      for (const item of targets) update.run(error, now(), item.id)
      const planIds = [...new Set(targets.map((item) => item.plan_id))]
      for (const id of planIds) {
        this.db
          .prepare(
            "UPDATE offline_plans SET status=CASE WHEN status='completed' THEN 'completed-with-issues' ELSE status END,updated_at=? WHERE id=?",
          )
          .run(now(), id)
        this.rollup(id)
      }
      return { items: targets.length, planIds }
    })
  }
  release(id: string, revision: number): OfflinePlan {
    return this.transaction(() => {
      const plan = this.control(id, revision)
      if (!TERMINAL.includes(plan.status as OfflinePlanStatus))
        conflict('请先结束或取消计划，再移除离线保留。')
      this.db
        .prepare(
          'DELETE FROM offline_media_refs WHERE item_id IN (SELECT id FROM offline_plan_items WHERE plan_id=?)',
        )
        .run(id)
      this.db
        .prepare(
          'UPDATE offline_plans SET revision=revision+1,retention_released_at=?,updated_at=? WHERE id=?',
        )
        .run(now(), now(), id)
      return this.plan(id)!
    })
  }
  createJob(
    itemId: string,
    request: StartTranscription,
    context?: { planRevision: number; attempt: number },
  ) {
    return this.transaction(() => {
      const original = this.storedItem(itemId)
      if (!original) conflict('离线分集已移除。')
      const plan = this.planControl(original.planId)!,
        item = this.context({
          planId: original.planId,
          planRevision: context?.planRevision ?? plan.revision,
          itemId,
          attempt: context?.attempt ?? original.attempt,
        })
      if (
        !item.audioHash ||
        item.audioHash !== request.audioHash ||
        item.episodeId !== request.episodeId ||
        plan.profile.engine !== request.engine ||
        plan.profile.device !== request.device
      )
        conflict('计划转写参数与冻结的音频或引擎配置不符。')
      const latest = this.host.latestJob(request.episodeId, request.audioHash)
      let job: StoredTranscriptionJob,
        attached = false
      if (latest && ['queued', 'running', 'canceling'].includes(latest.status)) {
        if (
          latest.engine !== request.engine ||
          latest.device !== request.device ||
          latest.status === 'canceling'
        )
          throw new AppError('BUSY', '已有不同配置或正在取消的转写任务，请先处理。')
        job = latest
        attached = true
      } else if (latest?.status === 'failed' && item.retryRequested) {
        if (latest.engine !== request.engine || latest.device !== request.device)
          conflict('失败任务使用不同配置，不能自动重试。')
        job = this.host.retryJob(latest.id)
        attached = true
      } else if (latest)
        conflict(
          latest.status === 'canceled'
            ? '已有用户取消的转写任务，请在任务页明确重试。'
            : latest.status === 'failed'
              ? '已有失败任务，请明确重试失败项。'
              : '已有生成稿或文稿，请先核对完整覆盖并采用。',
        )
      else job = this.host.createJob(request, true)
      const owner = this.db
        .prepare('SELECT manual FROM offline_job_owners WHERE job_id=?')
        .get(job.id)
      this.db
        .prepare(
          'INSERT INTO offline_job_owners(job_id,manual,planned) VALUES(?,?,1) ON CONFLICT(job_id) DO UPDATE SET planned=1',
        )
        .run(job.id, Number(!owner && attached && !job.background))
      this.db
        .prepare(
          "UPDATE offline_plan_items SET job_id=?,retry_requested=0,status='transcribing',updated_at=? WHERE id=?",
        )
        .run(job.id, now(), item.id)
      this.rollup(item.planId)
      return { job, attached }
    })
  }
  ownership(jobId: string) {
    const owner = this.db
      .prepare('SELECT manual,planned FROM offline_job_owners WHERE job_id=?')
      .get(jobId)
    const runnable = !!this.db
      .prepare(
        "SELECT 1 FROM offline_plan_items i JOIN offline_plans p ON p.id=i.plan_id WHERE i.job_id=? AND p.status IN ('queued','running') AND i.status NOT IN ('failed','canceled','needs-attention','ready') LIMIT 1",
      )
      .get(jobId)
    return { planned: !!owner?.planned, runnable, manual: !!owner?.manual }
  }
  claimManual(jobId: string): void {
    if (!this.host.getJob(jobId)) throw new AppError('INVALID_REQUEST', '转写任务不存在。')
    this.db
      .prepare(
        'INSERT INTO offline_job_owners(job_id,manual,planned) VALUES(?,1,0) ON CONFLICT(job_id) DO UPDATE SET manual=1',
      )
      .run(jobId)
  }
  jobIds(planId: string): string[] {
    return (
      this.db
        .prepare(
          'SELECT DISTINCT job_id FROM offline_plan_items WHERE plan_id=? AND job_id IS NOT NULL',
        )
        .all(planId) as { job_id: string }[]
    ).map((row) => row.job_id)
  }
  recover(): void {
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE offline_plan_items SET status=CASE WHEN audio_valid=1 THEN 'audio-ready' ELSE 'queued' END,attempt=attempt+1,updated_at=? WHERE status IN ('downloading','waiting-foreground','transcribing') AND plan_id IN (SELECT id FROM offline_plans WHERE status IN ('queued','running','paused','blocked'))",
        )
        .run(now())
      this.db
        .prepare("UPDATE offline_plans SET status='queued',updated_at=? WHERE status='running'")
        .run(now())
    })
  }
  bookRemoved(id: string): void {
    // Called inside the book-removal transaction. Pins survive until explicit release.
    this.db
      .prepare(
        "UPDATE offline_plan_items SET status='canceled',attempt=attempt+1,updated_at=? WHERE plan_id IN (SELECT id FROM offline_plans WHERE book_id=?) AND status NOT IN ('ready','canceled')",
      )
      .run(now(), id)
    this.db
      .prepare(
        "UPDATE offline_plans SET status='canceled',revision=revision+1,updated_at=?,error_text='书籍已移除，已停止准备；已保留音频仍可单独移除保留。' WHERE book_id=? AND status NOT IN ('completed','completed-with-issues','canceled')",
      )
      .run(now(), id)
  }
}
