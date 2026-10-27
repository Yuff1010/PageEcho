import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { LibraryStore } from './database'
import { checkAudio, MEDIA_PREFIX } from './media'
import { AppError, isId, validateRequest } from '../shared/validation'
import type { TranscriptRequest, StoredTranscript, TranscriptSegment } from '../shared/transcript'
import { ACTIVE_JOB_STATUSES } from '../shared/transcription'
import {
  emptyListeningReviewEntry,
  hasSpokenReference,
  LISTENING_REVIEW_TEXT_LIMITS,
  listeningReviewSummary,
  MAX_LISTENING_REVIEW_SAMPLES,
  type ListeningReview,
  type ListeningReviewEntry,
  type ListeningReviewGet,
  type ListeningReviewHeader,
  type ListeningReviewPrepare,
  type ListeningReviewSample,
  type ListeningReviewSave,
  type ListeningReviewState,
} from '../shared/listening-review'

const FRACTIONS = [0.15, 0.5, 0.85]
const MAX_RECORD_BYTES = 3 * 1024 * 1024

function reject(message: string): never {
  throw new AppError('INVALID_REQUEST', message)
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}
function target(value: TranscriptRequest) {
  if (!isId(value.episodeId) || !/^[0-9a-f]{64}$/.test(value.audioHash))
    reject('试听校对的音频身份无效。')
}
function boundedText(value: unknown, length: number) {
  return (
    value === null || (typeof value === 'string' && value.length <= length && !value.includes('\0'))
  )
}
function validateEntry(entry: ListeningReviewEntry, sample: ListeningReviewSample) {
  if (
    !exact(entry, [
      'listened',
      'speech',
      'spokenText',
      'namesChecked',
      'properNames',
      'sync',
      'humanStartMs',
      'humanEndMs',
      'notes',
    ]) ||
    typeof entry.listened !== 'boolean' ||
    typeof entry.namesChecked !== 'boolean' ||
    !['unknown', 'speech', 'silence'].includes(entry.speech) ||
    !['unknown', 'aligned', 'early', 'late', 'mixed', 'not-applicable'].includes(entry.sync) ||
    !boundedText(entry.spokenText, LISTENING_REVIEW_TEXT_LIMITS.spokenText) ||
    !boundedText(entry.properNames, LISTENING_REVIEW_TEXT_LIMITS.properNames) ||
    !boundedText(entry.notes, LISTENING_REVIEW_TEXT_LIMITS.notes)
  )
    reject('校对字段无效或内容过长。')
  if (
    !entry.listened &&
    (entry.speech !== 'unknown' ||
      entry.spokenText !== null ||
      entry.namesChecked ||
      entry.properNames !== null ||
      entry.sync !== 'unknown' ||
      entry.humanStartMs !== null ||
      entry.humanEndMs !== null)
  )
    reject('请实际试听后再填写人工判断，未知内容保持未填写。')
  if (entry.speech === 'speech' && !hasSpokenReference(entry.spokenText))
    reject('有语音时请填写实际听到的目标范围文字；无法确定请选择未知。')
  if (entry.speech === 'unknown' && entry.spokenText !== null) reject('未知语音不能填写参考文字。')
  if (
    entry.speech === 'silence' &&
    (entry.spokenText !== '' ||
      entry.sync !== 'not-applicable' ||
      entry.humanStartMs !== null ||
      entry.humanEndMs !== null)
  )
    reject('确认无语音时不填写声音起止边界，同步选择不适用。')
  if (entry.speech !== 'silence' && entry.sync === 'not-applicable')
    reject('仅确认无语音的片段可将同步标为不适用。')
  if (!entry.namesChecked && entry.properNames !== null) reject('请先确认专名已核对，或保留未知。')
  if (entry.namesChecked && entry.properNames === null)
    reject('专名已核对时请明确记录专名，或用空文字表示没有专名。')
  for (const boundary of [entry.humanStartMs, entry.humanEndMs])
    if (
      boundary !== null &&
      (!Number.isSafeInteger(boundary) ||
        boundary < sample.clipStartMs ||
        boundary > sample.clipEndMs)
    )
      reject('人工声音边界应位于试听上下文范围内，并使用整数毫秒。')
  if (
    entry.humanStartMs !== null &&
    entry.humanEndMs !== null &&
    entry.humanStartMs >= entry.humanEndMs
  )
    reject('人工声音终点必须晚于起点。')
}

function sample(
  segment: TranscriptSegment,
  durationMs: number,
  fractions: number[] = [],
): ListeningReviewSample {
  const clipStartMs = Math.max(0, segment.startMs - 1500),
    // Media container durations may contain fractional milliseconds; transcript
    // coordinates are integers and permit at most 1 ms of endpoint tolerance.
    clipEndMs = Math.max(segment.endMs, Math.min(Math.ceil(durationMs), segment.endMs + 1500))
  if (clipEndMs <= clipStartMs || clipEndMs - clipStartMs > 60000 || segment.text.length > 10000)
    reject('固定试听句超出一分钟或文字过长，无法建立完整校对样本；请先整理句级文稿。')
  return {
    id: randomUUID(),
    segmentId: segment.id,
    kind: fractions.length ? 'fixed' : 'additional',
    fixedFractions: fractions,
    targetStartMs: segment.startMs,
    targetEndMs: segment.endMs,
    clipStartMs,
    clipEndMs,
    machineText: segment.text,
    entry: emptyListeningReviewEntry(),
  }
}

export class ListeningReviewStore {
  private readonly db: DatabaseSync
  constructor(
    filename: string,
    private readonly library: LibraryStore,
  ) {
    this.db = new DatabaseSync(filename)
    try {
      this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;`)
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version)
      if (version > 1) throw new AppError('CONFLICT', '试听校对数据来自更新版本，请升级应用。')
      this.db.exec(`CREATE TABLE IF NOT EXISTS listening_reviews (
        id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL,
        audio_hash TEXT NOT NULL,
        transcript_id TEXT NOT NULL,
        transcript_revision INTEGER NOT NULL CHECK(transcript_revision > 0),
        revision INTEGER NOT NULL CHECK(revision > 0),
        updated_at TEXT NOT NULL,
        document_json TEXT NOT NULL CHECK(json_valid(document_json)),
        UNIQUE(episode_id,audio_hash,transcript_id,transcript_revision)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS listening_review_episode ON listening_reviews(episode_id,updated_at);
      PRAGMA user_version=1;`)
    } catch (error) {
      this.db.close()
      throw error
    }
  }
  close() {
    this.db.close()
  }
  private read(id: string) {
    const row = this.db.prepare('SELECT * FROM listening_reviews WHERE id=?').get(id)
    if (!row) return null
    const source = String(row.document_json)
    if (Buffer.byteLength(source) > MAX_RECORD_BYTES)
      throw new AppError('CONFLICT', '试听校对记录过大，无法安全读取。')
    const review = JSON.parse(source) as ListeningReview
    if (
      review.version !== 1 ||
      !Array.isArray(review.samples) ||
      !review.samples.length ||
      review.samples.length > MAX_LISTENING_REVIEW_SAMPLES ||
      review.sampleCount !== review.samples.length
    )
      throw new AppError('CONFLICT', '试听校对记录格式无效，未计算质量状态。')
    const fractions = new Set<number>(),
      segmentIds = new Set<string>(),
      sampleIds = new Set<string>()
    try {
      if (
        review.id !== id ||
        review.episodeId !== row.episode_id ||
        review.audioHash !== row.audio_hash ||
        review.transcriptId !== row.transcript_id ||
        review.transcriptRevision !== row.transcript_revision ||
        review.revision !== row.revision ||
        !isId(review.id) ||
        !isId(review.episodeId) ||
        !isId(review.transcriptId) ||
        !/^[0-9a-f]{64}$/.test(review.audioHash) ||
        !Number.isFinite(review.durationMs) ||
        review.durationMs <= 0 ||
        review.durationMs > 3.6e10 ||
        review.selectionPolicy !== 'segment-index-15-50-85-v1' ||
        review.mediaUrl !== `${MEDIA_PREFIX}${review.episodeId}/${review.audioHash}`
      )
        reject('冻结来源无效。')
      for (const selected of review.samples) {
        if (
          !isId(selected.id) ||
          sampleIds.has(selected.id) ||
          typeof selected.segmentId !== 'string' ||
          !selected.segmentId.trim() ||
          selected.segmentId.length > 128 ||
          segmentIds.has(selected.segmentId) ||
          !['fixed', 'additional'].includes(selected.kind) ||
          !Array.isArray(selected.fixedFractions) ||
          (selected.kind === 'fixed') !== selected.fixedFractions.length > 0 ||
          typeof selected.machineText !== 'string' ||
          !selected.machineText.trim() ||
          selected.machineText.length > 10000
        )
          reject('冻结样本无效。')
        sampleIds.add(selected.id)
        segmentIds.add(selected.segmentId)
        for (const fraction of selected.fixedFractions) {
          if (!FRACTIONS.includes(fraction) || fractions.has(fraction))
            reject('固定抽样点重复或丢失。')
          fractions.add(fraction)
        }
        if (
          ![
            selected.clipStartMs,
            selected.clipEndMs,
            selected.targetStartMs,
            selected.targetEndMs,
          ].every(Number.isSafeInteger) ||
          selected.clipStartMs < 0 ||
          selected.clipEndMs > review.durationMs + 1 ||
          selected.clipEndMs - selected.clipStartMs > 60000 ||
          selected.targetStartMs < selected.clipStartMs ||
          selected.targetEndMs > selected.clipEndMs ||
          selected.targetStartMs >= selected.targetEndMs
        )
          reject('冻结时间范围无效。')
        validateEntry(selected.entry, selected)
      }
      if (fractions.size !== FRACTIONS.length) reject('固定抽样点丢失。')
    } catch {
      throw new AppError('CONFLICT', '试听校对记录不完整或已损坏，未计算质量状态。')
    }
    return review
  }
  private current(request: TranscriptRequest) {
    target(request)
    const episode = this.library.getEpisode(request.episodeId),
      audio = this.library.getAudio(request.episodeId)
    if (!episode || !audio) throw new AppError('FILE_UNAVAILABLE', '请先缓存或重新导入这一集音频。')
    if (audio.contentHash !== request.audioHash || episode.contentHash !== request.audioHash)
      throw new AppError('AUDIO_VERSION_MISMATCH', '音频版本已变化，请重新打开这一集。')
    return {
      episode,
      audio,
      transcript: this.library.getTranscript(request.episodeId, request.audioHash),
    }
  }
  private history(episodeId: string) {
    return this.db
      .prepare(
        `SELECT id,episode_id,audio_hash,transcript_id,transcript_revision,revision,updated_at,
        json_extract(document_json,'$.createdAt') AS created_at,
        json_extract(document_json,'$.sampleCount') AS sample_count
        FROM listening_reviews WHERE episode_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 100`,
      )
      .all(episodeId)
      .map((row): ListeningReviewHeader => ({
        id: String(row.id),
        episodeId: String(row.episode_id),
        audioHash: String(row.audio_hash),
        transcriptId: String(row.transcript_id),
        transcriptRevision: Number(row.transcript_revision),
        revision: Number(row.revision),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        sampleCount: Number(row.sample_count),
      }))
  }
  private state(
    request: ListeningReviewGet,
    audioIssue: string | null = null,
  ): ListeningReviewState {
    const current = this.current(request),
      history = this.history(request.episodeId)
    const transcript = current.transcript.status === 'ready' ? current.transcript.transcript : null
    let selected = request.reviewId
    if (!selected && transcript)
      selected = history.find(
        (entry) =>
          entry.audioHash === request.audioHash &&
          entry.transcriptId === transcript.id &&
          entry.transcriptRevision === transcript.revision,
      )?.id
    selected ??= history[0]?.id
    const review = selected ? this.read(selected) : null
    if (review && review.episodeId !== request.episodeId) reject('校对记录不属于这一集。')
    if (!review) return { status: 'missing', reason: null, review: null, summary: null, history }
    const reason =
      audioIssue ||
      (review.audioHash !== request.audioHash
        ? '音频版本已变化，这份历史校对只读。'
        : !transcript ||
            transcript.id !== review.transcriptId ||
            transcript.revision !== review.transcriptRevision
          ? '文稿修订已变化，这份历史校对只读；可为当前文稿建立新的试听样本。'
          : null)
    return {
      status: reason ? 'stale' : 'ready',
      reason,
      review,
      summary: listeningReviewSummary(review),
      history,
    }
  }
  async get(request: ListeningReviewGet): Promise<ListeningReviewState> {
    validateRequest('listening:review-get', [request])
    if (
      !exact(
        request,
        request.reviewId === undefined
          ? ['episodeId', 'audioHash']
          : ['episodeId', 'audioHash', 'reviewId'],
      ) ||
      (request.reviewId !== undefined && !isId(request.reviewId))
    )
      reject('读取试听校对的参数无效。')
    const current = this.current(request)
    let issue: string | null = null
    try {
      await checkAudio(current.audio)
    } catch (error) {
      issue = error instanceof Error ? error.message : '音频无法读取。'
    }
    return this.state(request, issue)
  }
  private frozenCurrent(request: TranscriptRequest, review?: ListeningReview) {
    const current = this.current(request)
    if (current.transcript.status !== 'ready')
      throw new AppError('CONFLICT', '请先生成或导入完整的本集字幕。')
    const transcript = current.transcript.transcript
    if (
      review &&
      (review.audioHash !== request.audioHash ||
        review.transcriptId !== transcript.id ||
        review.transcriptRevision !== transcript.revision)
    )
      throw new AppError('CONFLICT', '音频或文稿版本已变化，历史校对保持只读。')
    return { ...current, transcript }
  }
  private createSamples(transcript: StoredTranscript, durationMs: number) {
    const selected = new Map<number, number[]>()
    for (const fraction of FRACTIONS) {
      const index = Math.min(
        transcript.document.segments.length - 1,
        Math.floor(transcript.document.segments.length * fraction),
      )
      selected.set(index, [...(selected.get(index) ?? []), fraction])
    }
    return [...selected].map(([index, fractions]) =>
      sample(transcript.document.segments[index]!, durationMs, fractions),
    )
  }
  async prepare(request: ListeningReviewPrepare): Promise<ListeningReviewState> {
    validateRequest('listening:review-prepare', [request])
    if (
      !exact(request, ['episodeId', 'audioHash', 'transcriptRevision']) ||
      !Number.isSafeInteger(request.transcriptRevision) ||
      request.transcriptRevision < 1
    )
      reject('建立试听样本的参数无效。')
    await checkAudio(this.current(request).audio)
    const current = this.frozenCurrent(request),
      durationMs = current.episode.durationMs
    if (current.transcript.revision !== request.transcriptRevision)
      throw new AppError('CONFLICT', '文稿修订已变化，请刷新后建立试听样本。')
    const job = this.library.latestJob(request.episodeId, request.audioHash)
    if (job?.autoApply && ACTIVE_JOB_STATUSES.includes(job.status))
      throw new AppError('BUSY', '字幕仍在更新，请等待整集完成或取消生成后再冻结听审。')
    let covered = 0
    for (const range of current.transcript.document.coverage) {
      if (range.startMs > covered + 1) break
      covered = Math.max(covered, range.endMs)
    }
    if (!durationMs || covered < durationMs - 1 || !current.transcript.document.segments.length)
      throw new AppError(
        'CONFLICT',
        '本集字幕尚未完整覆盖音频或没有可试听的句子，缺失样本不会计为通过。',
      )
    const existing = this.state(request)
    if (existing.status === 'ready') return existing
    const samples = this.createSamples(current.transcript, durationMs),
      now = new Date().toISOString()
    const review: ListeningReview = {
      version: 1,
      id: randomUUID(),
      episodeId: request.episodeId,
      audioHash: request.audioHash,
      transcriptId: current.transcript.id,
      transcriptRevision: current.transcript.revision,
      transcriptKind: current.transcript.document.kind,
      episodeTitle: current.episode.title,
      durationMs,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      sampleCount: samples.length,
      sourceProfile:
        job?.appliedRevision === current.transcript.revision
          ? { engine: job.engine, device: job.device, jobId: job.id, attempt: job.attempt }
          : null,
      selectionPolicy: 'segment-index-15-50-85-v1',
      mediaUrl: `${MEDIA_PREFIX}${request.episodeId}/${request.audioHash}`,
      samples,
    }
    this.db
      .prepare(
        'INSERT INTO listening_reviews(id,episode_id,audio_hash,transcript_id,transcript_revision,revision,updated_at,document_json) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        review.id,
        review.episodeId,
        review.audioHash,
        review.transcriptId,
        review.transcriptRevision,
        review.revision,
        now,
        JSON.stringify(review),
      )
    return this.state(request)
  }
  async save(request: ListeningReviewSave): Promise<ListeningReviewState> {
    validateRequest('listening:review-save', [request])
    const keys = [
      'episodeId',
      'audioHash',
      'reviewId',
      'revision',
      'action',
      ...(request.action === 'feedback' ? ['sampleId', 'entry'] : ['segmentId']),
    ]
    if (
      !exact(request, keys) ||
      !isId(request.reviewId) ||
      !Number.isSafeInteger(request.revision) ||
      request.revision < 1 ||
      !['feedback', 'add-sample'].includes(request.action)
    )
      reject('保存试听校对的参数无效。')
    await checkAudio(this.current(request).audio)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const review = this.read(request.reviewId)
      if (!review || review.episodeId !== request.episodeId)
        reject('校对记录不存在或不属于这一集。')
      const current = this.frozenCurrent(request, review)
      if (review.revision !== request.revision)
        throw new AppError('CONFLICT', '校对记录已在其他窗口更新，请重新读取后保存。')
      if (request.action === 'feedback') {
        const selected = review.samples.find((item) => item.id === request.sampleId)
        if (!selected) reject('试听样本不存在，固定样本不能移除。')
        validateEntry(request.entry, selected)
        selected.entry = { ...request.entry }
      } else {
        if (
          typeof request.segmentId !== 'string' ||
          !request.segmentId.trim() ||
          request.segmentId.length > 128
        )
          reject('追加试听句无效。')
        const selected = current.transcript.document.segments.find(
          (item) => item.id === request.segmentId,
        )
        if (!selected) reject('当前句不属于冻结文稿，请重新选择。')
        if (!review.samples.some((item) => item.segmentId === selected.id)) {
          if (review.samples.length >= MAX_LISTENING_REVIEW_SAMPLES)
            reject('本次听审最多保留 100 个样本，固定样本及已有样本均不会删除。')
          review.samples.push(sample(selected, review.durationMs))
        }
      }
      review.revision++
      review.updatedAt = new Date().toISOString()
      review.sampleCount = review.samples.length
      const source = JSON.stringify(review)
      if (Buffer.byteLength(source) > MAX_RECORD_BYTES) reject('校对记录过大，请缩短备注。')
      const changed = this.db
        .prepare(
          'UPDATE listening_reviews SET revision=?,updated_at=?,document_json=? WHERE id=? AND revision=?',
        )
        .run(review.revision, review.updatedAt, source, review.id, request.revision)
      if (Number(changed.changes) !== 1)
        throw new AppError('CONFLICT', '校对记录已变化，保存未覆盖其他修改。')
      this.db.exec('COMMIT')
      return this.state(request)
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }
}
