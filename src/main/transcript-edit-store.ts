import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Episode } from '../shared/contracts'
import { AppError } from '../shared/validation'
import {
  validateTranscript,
  MAX_TRANSCRIPT_BYTES,
  type TranscriptDocument,
  type TranscriptRequest,
  type TranscriptSegment,
  type TranscriptState,
  type StoredTranscript,
} from '../shared/transcript'
import {
  MAX_EDIT_DELTA_BYTES,
  MAX_REPLACEMENT_EPISODES,
  MAX_REPLACEMENT_SCAN_BYTES,
  MAX_REPLACEMENT_SEGMENTS,
  TRANSCRIPT_HISTORY_LIMIT,
  isTranscriptReplacementLiteral,
  type TranscriptEditingState,
  type TranscriptEditRequest,
  type TranscriptEditResult,
  type TranscriptEditTarget,
  type TranscriptHistoryRequest,
  type TranscriptHistorySummary,
  type TranscriptReplacementRequest,
  type TranscriptReplacementChange,
} from '../shared/transcript-editing'
import { applyTranscriptEdit, replaceTranscriptText } from './transcript-edit-operations'

export const TRANSCRIPT_EDIT_SCHEMA = `
CREATE TABLE transcript_edit_heads (
 transcript_id TEXT PRIMARY KEY REFERENCES transcripts(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL,document_hash TEXT NOT NULL
) STRICT;
CREATE TABLE transcript_edit_groups (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
 label TEXT NOT NULL,created_at TEXT NOT NULL,episodes INTEGER NOT NULL,segments INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('applied','undone'))
) STRICT;
CREATE TABLE transcript_edit_members (
 group_id TEXT NOT NULL REFERENCES transcript_edit_groups(id) ON DELETE CASCADE,
 transcript_id TEXT NOT NULL,episode_id TEXT NOT NULL,audio_hash TEXT NOT NULL,
 before_hash TEXT NOT NULL,after_hash TEXT NOT NULL,delta_json TEXT NOT NULL,
 visible INTEGER NOT NULL DEFAULT 1 CHECK(visible IN (0,1)),changed INTEGER NOT NULL CHECK(changed IN (0,1)),
 PRIMARY KEY(group_id,transcript_id)
) STRICT;
CREATE INDEX transcript_edit_member_target ON transcript_edit_members(episode_id,audio_hash,visible);
CREATE TABLE transcript_edit_commands (
 id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,episode_id TEXT NOT NULL,audio_hash TEXT NOT NULL,created_at TEXT NOT NULL
) STRICT;
`
interface Splice {
  beforeIndex: number
  afterIndex: number
  before: TranscriptSegment[]
  after: TranscriptSegment[]
}
export interface TranscriptDelta {
  splices: Splice[]
}
export interface PreparedTranscriptEntry extends TranscriptEditTarget {
  transcriptId: string
  beforeHash: string
  afterHash: string
  delta: TranscriptDelta
}
export interface PreparedTranscriptReplacement {
  target: TranscriptEditTarget
  find: string
  replacement: string
  changes: TranscriptReplacementChange[]
  episodes: number
  segments: number
  occurrences: number
  skippedEpisodes: number
  entries: PreparedTranscriptEntry[]
  request: TranscriptReplacementRequest
}
interface Host {
  episode(id: string): Episode | undefined
  transcript(id: string, hash: string): TranscriptState
  /** Writes inside our transaction, preserving history and suppressing notification. */
  write(id: string, document: TranscriptDocument): StoredTranscript
  notify(target: TranscriptRequest): void
}
type Row = Record<string, unknown>
function conflict(message = '字幕或编辑历史已变化，请刷新后重试。'): never {
  throw new AppError('CONFLICT', message)
}
function invalid(message: string): never {
  throw new AppError('INVALID_TRANSCRIPT', message)
}
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
const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')
const equal = (a: TranscriptSegment | undefined, b: TranscriptSegment | undefined) =>
  !!a && !!b && a.id === b.id && a.text === b.text && a.startMs === b.startMs && a.endMs === b.endMs
function delta(before: TranscriptDocument, after: TranscriptDocument): TranscriptDelta {
  if (before.kind !== after.kind || digest(before.coverage) !== digest(after.coverage))
    invalid('字幕编辑不能改变已声明的音频覆盖区间。')
  const positions = new Map(after.segments.map((segment, index) => [segment.id, index])),
    splices: Splice[] = []
  let i = 0,
    j = 0
  while (i < before.segments.length || j < after.segments.length) {
    if (equal(before.segments[i], after.segments[j])) {
      i++
      j++
      continue
    }
    const firstI = i,
      firstJ = j
    while (i < before.segments.length) {
      const next = positions.get(before.segments[i]!.id)
      if (next !== undefined && next >= j && equal(before.segments[i], after.segments[next])) {
        j = next
        break
      }
      i++
    }
    if (i === before.segments.length) j = after.segments.length
    splices.push({
      beforeIndex: firstI,
      afterIndex: firstJ,
      before: before.segments.slice(firstI, i),
      after: after.segments.slice(firstJ, j),
    })
  }
  return { splices }
}
function applyDelta(
  document: TranscriptDocument,
  value: TranscriptDelta,
  undo: boolean,
  duration: number | null,
): TranscriptDocument {
  const segments = [...document.segments]
  for (const splice of [...value.splices].reverse()) {
    const index = undo ? splice.afterIndex : splice.beforeIndex,
      expected = undo ? splice.after : splice.before,
      replacement = undo ? splice.before : splice.after
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index + expected.length > segments.length ||
      expected.some((segment, offset) => !equal(segment, segments[index + offset]))
    )
      conflict('编辑历史内容不再匹配当前字幕，未修改任何分集。')
    segments.splice(index, expected.length, ...replacement)
  }
  const result = validateTranscript({ ...document, segments }, document.audioHash, duration)
  if (encodedBytes(result) > MAX_TRANSCRIPT_BYTES) invalid('编辑后的字幕超过 16 MiB。')
  return result
}
const changedCount = (value: TranscriptDelta) =>
  value.splices.reduce(
    (sum, splice) => sum + Math.max(splice.before.length, splice.after.length),
    0,
  )

/** Uses LibraryStore's connection. Group commits, history and manual protection are atomic. */
export class TranscriptEditStore {
  private transactionReads?: Map<string, TranscriptState>

  constructor(
    private readonly db: DatabaseSync,
    private readonly host: Host,
  ) {}
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    this.transactionReads = new Map()
    try {
      const result = action()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.transactionReads = undefined
    }
  }
  private transcript(target: TranscriptRequest): TranscriptState {
    const key = `${target.episodeId}:${target.audioHash}`,
      cached = this.transactionReads?.get(key)
    if (cached) return cached
    const state = this.host.transcript(target.episodeId, target.audioHash)
    // BEGIN IMMEDIATE excludes other writers. Reuse only within this synchronous
    // transaction; replacement previews and later commits must read independently.
    this.transactionReads?.set(key, state)
    return state
  }
  private write(target: TranscriptRequest, document: TranscriptDocument): StoredTranscript {
    // Do not retain a pre-write snapshot, including a readonly batch initiator.
    // A result after any write must read the actual persisted document again.
    this.transactionReads?.clear()
    try {
      return this.host.write(target.episodeId, document)
    } finally {
      this.transactionReads?.clear()
    }
  }
  private asset(target: TranscriptRequest): Episode {
    const episode = this.host.episode(target.episodeId)
    if (!episode || episode.contentHash !== target.audioHash)
      throw new AppError('FILE_CHANGED', '音频版本已变化或分集已移除。')
    return episode
  }
  private current(target: TranscriptEditTarget): StoredTranscript {
    this.asset(target)
    const state = this.transcript(target)
    if (state.status !== 'ready' || state.transcript.revision !== target.revision) conflict()
    return state.transcript
  }
  private metadata(target: TranscriptRequest): Row | undefined {
    return this.db
      .prepare('SELECT id,revision FROM transcripts WHERE episode_id=? AND audio_hash=?')
      .get(target.episodeId, target.audioHash) as Row | undefined
  }
  private summary(row: Row): TranscriptHistorySummary {
    return {
      id: String(row.id),
      label: String(row.label),
      createdAt: String(row.created_at),
      episodes: Number(row.episodes),
      segments: Number(row.segments),
    }
  }
  private members(id: string, withDelta = false): Row[] {
    return this.db
      .prepare(
        `SELECT group_id,transcript_id,episode_id,audio_hash,before_hash,after_hash,visible,changed${withDelta ? ',delta_json' : ''} FROM transcript_edit_members WHERE group_id=?`,
      )
      .all(id) as Row[]
  }
  private top(transcriptId: string, undo: boolean, changedOnly = false): Row | undefined {
    return this.db
      .prepare(
        `SELECT g.* FROM transcript_edit_groups g JOIN transcript_edit_members m ON m.group_id=g.id WHERE m.transcript_id=? AND m.visible=1 ${changedOnly ? 'AND m.changed=1' : ''} AND g.status=? ORDER BY g.sequence ${undo ? 'DESC' : 'ASC'} LIMIT 1`,
      )
      .get(transcriptId, undo ? 'applied' : 'undone') as Row | undefined
  }
  private blocked(group: Row, undo: boolean): string | null {
    for (const member of this.members(String(group.id))) {
      if (!member.changed) continue
      const row = this.db
        .prepare(
          'SELECT t.id,t.revision,h.revision AS head_revision,h.document_hash,e.content_hash FROM transcripts t JOIN episodes e ON e.id=t.episode_id LEFT JOIN transcript_edit_heads h ON h.transcript_id=t.id WHERE t.id=? AND t.episode_id=? AND t.audio_hash=?',
        )
        .get(String(member.transcript_id), String(member.episode_id), String(member.audio_hash))
      if (!member.visible || !row || row.content_hash !== member.audio_hash)
        return '该批次有分集已移除、音频改变或采用新稿，不能只撤销部分分集。'
      if (
        row.head_revision !== row.revision ||
        row.document_hash !== (undo ? member.after_hash : member.before_hash)
      )
        return '该批次有分集存在后续修改，请先撤销后续操作。'
      if (this.top(String(member.transcript_id), undo, true)?.id !== group.id)
        return '该批次有分集存在后续编辑或不同的重做顺序。'
    }
    return null
  }
  state(target: TranscriptRequest): TranscriptEditingState {
    const row = this.metadata(target),
      undo = row && this.top(String(row.id), true),
      redo = row && this.top(String(row.id), false)
    return {
      episodeId: target.episodeId,
      audioHash: target.audioHash,
      transcriptId: row ? String(row.id) : null,
      revision: row ? Number(row.revision) : null,
      undo: undo ? this.summary(undo) : null,
      redo: redo ? this.summary(redo) : null,
      undoBlocked: undo ? this.blocked(undo, true) : null,
      redoBlocked: redo ? this.blocked(redo, false) : null,
      historyCount: row
        ? Number(
            this.db
              .prepare(
                'SELECT count(*) AS n FROM transcript_edit_members WHERE transcript_id=? AND visible=1',
              )
              .get(String(row.id))!.n,
          )
        : 0,
      historyLimit: TRANSCRIPT_HISTORY_LIMIT,
    }
  }
  /** Called within an external baseline write transaction, not for history replay. */
  clear(target: TranscriptRequest): void {
    this.db
      .prepare('UPDATE transcript_edit_members SET visible=0 WHERE episode_id=? AND audio_hash=?')
      .run(target.episodeId, target.audioHash)
    this.db
      .prepare(
        'DELETE FROM transcript_edit_heads WHERE transcript_id IN (SELECT id FROM transcripts WHERE episode_id=? AND audio_hash=?)',
      )
      .run(target.episodeId, target.audioHash)
    this.pruneOrphans()
  }
  /** Snapshot members deliberately do not cascade: surviving members must show a blocked batch. */
  pruneOrphans(): void {
    this.db.exec(
      'UPDATE transcript_edit_members SET visible=0 WHERE NOT EXISTS(SELECT 1 FROM transcripts t WHERE t.id=transcript_edit_members.transcript_id); DELETE FROM transcript_edit_groups WHERE NOT EXISTS(SELECT 1 FROM transcript_edit_members m WHERE m.group_id=transcript_edit_groups.id AND m.visible=1);',
    )
  }
  private replay(
    commandId: string,
    payload: unknown,
    target: TranscriptRequest,
  ): TranscriptEditResult | null {
    const row = this.db
      .prepare('SELECT payload_hash FROM transcript_edit_commands WHERE id=?')
      .get(commandId)
    if (!row) return null
    if (row.payload_hash !== digest(payload)) conflict('同一编辑命令已用于不同内容，请刷新后重试。')
    return this.result(target, [], true)
  }
  private remember(commandId: string, payload: unknown, target: TranscriptRequest): void {
    this.db
      .prepare('INSERT INTO transcript_edit_commands VALUES(?,?,?,?,?)')
      .run(commandId, digest(payload), target.episodeId, target.audioHash, new Date().toISOString())
  }
  private result(
    target: TranscriptRequest,
    changed: TranscriptRequest[],
    replayed = false,
  ): TranscriptEditResult {
    return {
      transcript: this.transcript(target),
      history: this.state(target),
      changed,
      replayed,
    }
  }
  private entry(
    target: TranscriptEditTarget,
    before: StoredTranscript,
    after: TranscriptDocument,
  ): PreparedTranscriptEntry {
    return {
      episodeId: target.episodeId,
      audioHash: target.audioHash,
      revision: target.revision,
      transcriptId: before.id,
      beforeHash: digest(before.document),
      afterHash: digest(after),
      delta: delta(before.document, after),
    }
  }
  private protect(target: TranscriptRequest): void {
    this.db
      .prepare('UPDATE transcription_jobs SET auto_apply=0 WHERE episode_id=? AND audio_hash=?')
      .run(target.episodeId, target.audioHash)
  }
  private head(saved: StoredTranscript): void {
    this.db
      .prepare(
        'INSERT INTO transcript_edit_heads VALUES(?,?,?) ON CONFLICT(transcript_id) DO UPDATE SET revision=excluded.revision,document_hash=excluded.document_hash',
      )
      .run(saved.id, saved.revision, digest(saved.document))
  }
  private checkEntries(entries: PreparedTranscriptEntry[]): Map<string, StoredTranscript> {
    const current = new Map<string, StoredTranscript>()
    for (const entry of entries) {
      const saved = this.current(entry)
      if (saved.id !== entry.transcriptId || digest(saved.document) !== entry.beforeHash)
        conflict('预览后的字幕内容已变化，请重新预览。')
      current.set(saved.id, saved)
    }
    return current
  }
  private commit(
    entries: PreparedTranscriptEntry[],
    target: TranscriptEditTarget,
    label: string,
  ): TranscriptRequest[] {
    const current = this.checkEntries(entries),
      changed = entries.filter((entry) => entry.beforeHash !== entry.afterHash)
    if (!changed.length) return []
    const tracked = entries.filter(
      (entry) =>
        entry.beforeHash !== entry.afterHash ||
        (entry.episodeId === target.episodeId && entry.audioHash === target.audioHash),
    )
    if (encodedBytes(tracked) > MAX_EDIT_DELTA_BYTES)
      invalid('本次编辑差量超过 2 MiB，请缩小范围或分批操作。')
    const id = randomUUID(),
      segments = changed.reduce((sum, entry) => sum + changedCount(entry.delta), 0)
    if (segments > MAX_REPLACEMENT_SEGMENTS) invalid('一次最多修改 10,000 句，请分批操作。')
    // An edit after undo invalidates the entire affected redo group, never just one member.
    for (const entry of changed) {
      this.db
        .prepare(
          "DELETE FROM transcript_edit_groups WHERE status='undone' AND id IN (SELECT group_id FROM transcript_edit_members WHERE transcript_id=? AND visible=1 AND changed=1)",
        )
        .run(entry.transcriptId)
      this.db
        .prepare(
          "UPDATE transcript_edit_members SET visible=0 WHERE transcript_id=? AND changed=0 AND group_id IN (SELECT id FROM transcript_edit_groups WHERE status='undone')",
        )
        .run(entry.transcriptId)
    }
    this.db
      .prepare(
        "INSERT INTO transcript_edit_groups(id,label,created_at,episodes,segments,status) VALUES(?,?,?,?,?,'applied')",
      )
      .run(id, label, new Date().toISOString(), changed.length, segments)
    for (const entry of tracked) {
      const before = current.get(entry.transcriptId)!
      let saved = before
      if (entry.beforeHash !== entry.afterHash) {
        const after = applyDelta(before.document, entry.delta, false, this.asset(entry).durationMs)
        if (digest(after) !== entry.afterHash) conflict('预览编辑差量校验失败，未修改字幕。')
        saved = this.write(entry, after)
        this.protect(entry)
      }
      this.head(saved)
      this.db
        .prepare(
          'INSERT INTO transcript_edit_members(group_id,transcript_id,episode_id,audio_hash,before_hash,after_hash,delta_json,changed) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          entry.transcriptId,
          entry.episodeId,
          entry.audioHash,
          entry.beforeHash,
          entry.afterHash,
          JSON.stringify(entry.delta),
          Number(entry.beforeHash !== entry.afterHash),
        )
    }
    for (const entry of tracked) {
      const old = this.db
        .prepare(
          'SELECT group_id,m.changed FROM transcript_edit_members m JOIN transcript_edit_groups g ON g.id=m.group_id WHERE m.transcript_id=? AND m.visible=1 ORDER BY g.sequence DESC LIMIT -1 OFFSET ?',
        )
        .all(entry.transcriptId, TRANSCRIPT_HISTORY_LIMIT)
      for (const row of old) {
        if (row.changed)
          this.db.prepare('DELETE FROM transcript_edit_groups WHERE id=?').run(String(row.group_id))
        else
          this.db
            .prepare(
              'UPDATE transcript_edit_members SET visible=0 WHERE group_id=? AND transcript_id=?',
            )
            .run(String(row.group_id), entry.transcriptId)
      }
    }
    this.pruneOrphans()
    return changed.map(({ episodeId, audioHash }) => ({ episodeId, audioHash }))
  }
  perform(request: TranscriptEditRequest, label?: '采用声音重对齐'): TranscriptEditResult {
    const payload = { action: 'edit', request, label: label ?? null }
    const result = this.transaction(() => {
      const replay = this.replay(request.commandId, payload, request)
      if (replay) return replay
      const before = this.current(request),
        after = applyTranscriptEdit(
          before.document,
          request.operation,
          this.asset(request).durationMs,
        )
      const labels = { text: '纠正文字', split: '拆分句子', merge: '合并句子', timing: '调整时间' }
      const changed = this.commit(
        [this.entry(request, before, after)],
        request,
        label ?? labels[request.operation.kind],
      )
      this.remember(request.commandId, payload, request)
      return this.result(request, changed)
    })
    for (const target of result.changed) this.host.notify(target)
    return result
  }
  history(request: TranscriptHistoryRequest, undo: boolean): TranscriptEditResult {
    const payload = { action: undo ? 'undo' : 'redo', request }
    const result = this.transaction(() => {
      const replay = this.replay(request.commandId, payload, request)
      if (replay) return replay
      const current = this.current(request),
        group = this.top(current.id, undo)
      if (!group || group.id !== request.historyId) conflict()
      const blocked = this.blocked(group, undo)
      if (blocked) conflict(blocked)
      const changed: TranscriptRequest[] = []
      for (const member of this.members(String(group.id), true)) {
        if (!member.changed) continue
        const target = {
            episodeId: String(member.episode_id),
            audioHash: String(member.audio_hash),
          },
          state = this.transcript(target)
        if (
          state.status !== 'ready' ||
          state.transcript.id !== member.transcript_id ||
          digest(state.transcript.document) !== (undo ? member.after_hash : member.before_hash)
        )
          conflict('编辑历史的精确内容校验失败，未修改任何分集。')
        const patch = JSON.parse(String(member.delta_json)) as TranscriptDelta
        if (member.before_hash !== member.after_hash) {
          const after = applyDelta(
            state.transcript.document,
            patch,
            undo,
            this.asset(target).durationMs,
          )
          if (digest(after) !== (undo ? member.before_hash : member.after_hash))
            conflict('编辑历史重放校验失败，未修改任何分集。')
          this.head(this.write(target, after))
          this.protect(target)
          changed.push(target)
        }
      }
      this.db
        .prepare('UPDATE transcript_edit_groups SET status=? WHERE id=?')
        .run(undo ? 'undone' : 'applied', String(group.id))
      this.remember(request.commandId, payload, request)
      return this.result(request, changed)
    })
    for (const target of result.changed) this.host.notify(target)
    return result
  }
  prepareReplacement(request: TranscriptReplacementRequest): PreparedTranscriptReplacement {
    const episode = this.asset(request),
      initiatingMeta = this.metadata(request)
    if (!initiatingMeta || initiatingMeta.revision !== request.revision) conflict()
    if (
      !isTranscriptReplacementLiteral(request.find) ||
      !isTranscriptReplacementLiteral(request.replacement) ||
      request.find === request.replacement
    )
      throw new AppError('INVALID_REQUEST', '请填写有效的原样查找与替换文字。')
    const ids = request.scope.kind === 'episode' ? [request.episodeId] : request.scope.episodeIds
    if (!ids.length || ids.length > MAX_REPLACEMENT_EPISODES || new Set(ids).size !== ids.length)
      throw new AppError('INVALID_REQUEST', '批量替换需要 1–1,000 个不同分集。')
    if (request.scope.kind === 'book' && request.scope.bookId !== episode.bookId)
      throw new AppError('INVALID_REQUEST', '批量替换范围必须属于当前书籍。')
    const selected: { episode: Episode; revision: number; transcriptId: string }[] = [],
      seen = new Set<string>()
    let scanBytes = 0,
      skippedEpisodes = 0
    for (const id of ids) {
      const value = this.host.episode(id)
      if (!value || value.bookId !== episode.bookId)
        throw new AppError('FILE_CHANGED', '选中分集已移除或不再属于当前书籍。')
      const meta = this.db
        .prepare(
          'SELECT id,revision,length(CAST(document_json AS BLOB)) AS bytes FROM transcripts WHERE episode_id=? AND audio_hash=?',
        )
        .get(id, value.contentHash)
      if (!meta) {
        skippedEpisodes++
        continue
      }
      scanBytes += Number(meta.bytes)
      if (scanBytes > MAX_REPLACEMENT_SCAN_BYTES) invalid('选中文稿合计超过 64 MiB，请缩小范围。')
      selected.push({
        episode: value,
        revision: Number(meta.revision),
        transcriptId: String(meta.id),
      })
      seen.add(id)
    }
    if (!seen.has(request.episodeId)) {
      scanBytes += Number(
        this.db
          .prepare(
            'SELECT length(CAST(document_json AS BLOB)) AS bytes FROM transcripts WHERE id=?',
          )
          .get(String(initiatingMeta.id))!.bytes,
      )
      if (scanBytes > MAX_REPLACEMENT_SCAN_BYTES) invalid('选中文稿合计超过 64 MiB，请缩小范围。')
    }
    const initiating = this.current(request)
    const entries: PreparedTranscriptEntry[] = [],
      changes: TranscriptReplacementChange[] = []
    let occurrences = 0,
      episodes = 0
    for (const value of selected) {
      const target = {
          episodeId: value.episode.id,
          audioHash: value.episode.contentHash,
          revision: value.revision,
        },
        before = this.current(target)
      const result = replaceTranscriptText(
        before.document,
        request.find,
        request.replacement,
        value.episode.durationMs,
      )
      const entry = this.entry(target, before, result.document)
      entries.push(entry)
      if (entry.beforeHash !== entry.afterHash) episodes++
      occurrences += result.occurrences
      changes.push(
        ...result.changes.map((change) => ({
          ...change,
          episodeId: target.episodeId,
          episodeTitle: value.episode.title,
        })),
      )
      if (changes.length > MAX_REPLACEMENT_SEGMENTS)
        invalid('本次替换影响超过 10,000 句，请缩小范围。')
    }
    if (!seen.has(request.episodeId))
      entries.push(this.entry(request, initiating, initiating.document))
    if (
      encodedBytes(
        entries.filter(
          (entry) => entry.beforeHash !== entry.afterHash || entry.episodeId === request.episodeId,
        ),
      ) > MAX_EDIT_DELTA_BYTES
    )
      invalid('本次编辑差量超过 2 MiB，请缩小范围或分批操作。')
    return structuredClone({
      target: {
        episodeId: request.episodeId,
        audioHash: request.audioHash,
        revision: request.revision,
      },
      find: request.find,
      replacement: request.replacement,
      changes,
      episodes,
      segments: changes.length,
      occurrences,
      skippedEpisodes,
      entries,
      request,
    })
  }
  commitReplacement(plan: PreparedTranscriptReplacement, commandId: string): TranscriptEditResult {
    const payload = { action: 'replace', request: plan.request, entries: plan.entries }
    const result = this.transaction(() => {
      const replay = this.replay(commandId, payload, plan.target)
      if (replay) return replay
      this.current(plan.target)
      const changed = this.commit(plan.entries, plan.target, '批量替换')
      this.remember(commandId, payload, plan.target)
      return this.result(plan.target, changed)
    })
    for (const target of result.changed) this.host.notify(target)
    return result
  }
}
