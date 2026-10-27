import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import type { OriginalAcousticSnapshot } from './acoustic-snapshot'
import {
  MAX_ACOUSTIC_RANGE_MS,
  MAX_ACOUSTIC_TEXT_LENGTH,
  ORIGINAL_ACOUSTIC_CONTRACT,
  type OriginalAcousticRequest,
  type OriginalAcousticResult,
  type RestoreOriginalAcousticRequest,
} from '../../shared/original-acoustic'
import { storeOriginalDocument } from './documents'
import type { Episode } from '../../shared/contracts'
import { AppError } from '../../shared/validation'
import type { TranscriptState } from '../../shared/transcript'
import {
  createIncrementalPlan,
  matchSource,
  mergeIncrementalMatches,
  sameSource,
  sourceForMatch,
  type OriginalIncrementalPlan,
} from './incremental'
import {
  ORIGINAL_MATCHER_VERSION,
  ORIGINAL_PAGE_SIZE,
  type OriginalAlignment,
  type OriginalCandidate,
  type OriginalCorrection,
  type OriginalInfo,
  type OriginalMatch,
  type OriginalPage,
  type OriginalState,
  type OriginalTarget,
  type ParsedOriginal,
} from '../../shared/original'

export const ORIGINAL_SCHEMA = `
  CREATE TABLE original_documents (
    id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, parser_version INTEGER NOT NULL,
    info_json TEXT NOT NULL, document_json TEXT NOT NULL, UNIQUE(content_hash, parser_version)
  ) STRICT;
  CREATE TABLE book_originals (
    book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES original_documents(id)
  ) STRICT;
  CREATE TABLE original_alignments (
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    audio_hash TEXT NOT NULL, document_id TEXT NOT NULL REFERENCES original_documents(id),
    revision INTEGER NOT NULL, alignment_json TEXT NOT NULL,
    PRIMARY KEY(episode_id,audio_hash,document_id)
  ) STRICT;
`

export class OriginalStore {
  private cached: { id: string; value: ParsedOriginal } | null = null
  private changed?: (target: OriginalTarget) => void
  constructor(
    private db: DatabaseSync,
    private episode: (id: string) => Episode | undefined,
    private transcript: (id: string, hash: string) => TranscriptState,
  ) {}
  onTranscriptChanged(listener: (target: OriginalTarget) => void): () => void {
    this.changed = listener
    return () => {
      if (this.changed === listener) this.changed = undefined
    }
  }
  transcriptChanged(target: OriginalTarget): void {
    this.changed?.(target)
  }
  automaticTargets(): OriginalTarget[] {
    return this.db
      .prepare(
        `SELECT e.id AS episodeId,e.content_hash AS audioHash
      FROM episodes e JOIN book_originals o ON o.book_id=e.book_id
      JOIN transcripts t ON t.episode_id=e.id AND t.audio_hash=e.content_hash
      ORDER BY e.rowid DESC LIMIT 8`,
      )
      .all() as unknown as OriginalTarget[]
  }
  prepareIncremental(target: OriginalTarget): OriginalIncrementalPlan | null {
    const state = this.state(target),
      transcript = this.transcript(target.episodeId, target.audioHash)
    return state.info && transcript.status === 'ready'
      ? createIncrementalPlan(target, state.info.id, transcript.transcript, state.alignment)
      : null
  }
  saveIncremental(plan: OriginalIncrementalPlan, matches: OriginalMatch[]): OriginalState {
    const state = this.state(plan.target),
      transcript = this.transcript(plan.target.episodeId, plan.target.audioHash)
    if (
      state.info?.id !== plan.originalId ||
      (state.alignment?.revision ?? 0) !== plan.alignmentRevision ||
      transcript.status !== 'ready' ||
      transcript.transcript.id !== plan.transcriptId ||
      transcript.transcript.revision !== plan.transcriptRevision
    )
      throw new AppError('CONFLICT', '原文、转写稿或人工校正已更新，增量结果已忽略。')
    const sourceIds = new Set(plan.processed.map((source) => source.segmentId))
    const alignment: OriginalAlignment = {
      revision: plan.alignmentRevision + 1,
      originalId: plan.originalId,
      transcriptId: plan.transcriptId,
      transcriptRevision: plan.transcriptRevision,
      matcherVersion: ORIGINAL_MATCHER_VERSION,
      matches: mergeIncrementalMatches(transcript.transcript.document, state.alignment, matches),
      sources: plan.processed,
      pendingSegments: transcript.transcript.document.segments.filter(
        (segment) => !sourceIds.has(segment.id),
      ).length,
    }
    if (
      state.alignment &&
      JSON.stringify({ ...alignment, revision: state.alignment.revision }) ===
        JSON.stringify(state.alignment)
    )
      return state
    this.writeAlignment(plan.target, alignment)
    return this.state(plan.target)
  }
  private writeAlignment(target: OriginalTarget, alignment: OriginalAlignment) {
    this.db
      .prepare(
        'INSERT INTO original_alignments VALUES (?,?,?,?,?) ON CONFLICT(episode_id,audio_hash,document_id) DO UPDATE SET revision=excluded.revision,alignment_json=excluded.alignment_json',
      )
      .run(
        target.episodeId,
        target.audioHash,
        alignment.originalId,
        alignment.revision,
        JSON.stringify(alignment),
      )
  }
  private asset(target: OriginalTarget): Episode {
    const episode = this.episode(target.episodeId)
    if (!episode || !episode.contentHash || episode.contentHash !== target.audioHash)
      throw new AppError('FILE_CHANGED', '音频版本已变化，请重新打开原文。')
    return episode
  }
  private infoForBook(bookId: string): OriginalInfo | null {
    const row = this.db
      .prepare(
        'SELECT d.info_json FROM original_documents d JOIN book_originals b ON b.document_id=d.id WHERE b.book_id=?',
      )
      .get(bookId)
    return row ? (JSON.parse(String(row.info_json)) as OriginalInfo) : null
  }
  state(target: OriginalTarget): OriginalState {
    const episode = this.asset(target),
      info = this.infoForBook(episode.bookId)
    if (!info) return { info: null, alignment: null, stale: false }
    const row = this.db
      .prepare(
        'SELECT alignment_json FROM original_alignments WHERE episode_id=? AND audio_hash=? AND document_id=?',
      )
      .get(target.episodeId, target.audioHash, info.id)
    const alignment = row ? (JSON.parse(String(row.alignment_json)) as OriginalAlignment) : null
    const transcript = this.transcript(target.episodeId, target.audioHash)
    return {
      info,
      alignment,
      stale:
        !!alignment &&
        (transcript.status !== 'ready' ||
          alignment.transcriptId !== transcript.transcript.id ||
          alignment.transcriptRevision !== transcript.transcript.revision ||
          alignment.matcherVersion !== ORIGINAL_MATCHER_VERSION),
    }
  }
  import(target: OriginalTarget, parsed: ParsedOriginal): OriginalState {
    const episode = this.asset(target)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const id = storeOriginalDocument(this.db, parsed)
      this.db
        .prepare(
          'INSERT INTO book_originals VALUES (?,?) ON CONFLICT(book_id) DO UPDATE SET document_id=excluded.document_id',
        )
        .run(episode.bookId, id)
      this.db.exec('COMMIT')
      this.transcriptChanged(target)
      return this.state(target)
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }
  document(target: OriginalTarget, originalId: string): ParsedOriginal {
    const info = this.infoForBook(this.asset(target).bookId)
    if (info?.id !== originalId)
      throw new AppError('CONFLICT', '本书原文版本已变化，请刷新后重试。')
    if (this.cached?.id === originalId) return this.cached.value
    const row = this.db
      .prepare('SELECT document_json FROM original_documents WHERE id=?')
      .get(originalId)!
    const value = JSON.parse(String(row.document_json)) as ParsedOriginal
    this.cached = { id: originalId, value }
    return value
  }
  page(target: OriginalTarget, originalId: string, start: number): OriginalPage {
    const document = this.document(target, originalId)
    return {
      info: this.infoForBook(this.asset(target).bookId)!,
      start,
      sentences: document.sentences.slice(start, start + ORIGINAL_PAGE_SIZE),
    }
  }
  search(target: OriginalTarget, originalId: string, query: string): OriginalCandidate[] {
    const document = this.document(target, originalId),
      result: OriginalCandidate[] = []
    for (const sentence of document.sentences)
      if (sentence.text.includes(query)) {
        result.push({
          first: sentence.ordinal,
          last: sentence.ordinal,
          score: 1,
          excerpt: sentence.text,
          chapter: document.chapters[sentence.chapter]!.title,
        })
        if (result.length === 30) break
      }
    return result
  }
  saveAlignment(
    target: OriginalTarget,
    originalId: string,
    transcriptId: string,
    transcriptRevision: number,
    expectedRevision: number,
    matches: OriginalMatch[],
  ): OriginalState {
    const state = this.state(target),
      transcript = this.transcript(target.episodeId, target.audioHash)
    if (
      state.info?.id !== originalId ||
      (state.alignment?.revision ?? 0) !== expectedRevision ||
      transcript.status !== 'ready' ||
      transcript.transcript.id !== transcriptId ||
      transcript.transcript.revision !== transcriptRevision
    )
      throw new AppError('CONFLICT', '原文、转写稿或人工校正已更新，请重新匹配。')
    const alignment: OriginalAlignment = {
      revision: expectedRevision + 1,
      originalId,
      transcriptId,
      transcriptRevision,
      matcherVersion: ORIGINAL_MATCHER_VERSION,
      matches: mergeIncrementalMatches(transcript.transcript.document, state.alignment, matches),
      sources: transcript.transcript.document.segments.map(matchSource),
      pendingSegments: 0,
    }
    this.writeAlignment(target, alignment)
    return this.state(target)
  }
  acousticSnapshot(request: OriginalAcousticRequest): OriginalAcousticSnapshot {
    const state = this.state(request),
      alignment = state.alignment
    const transcript = this.transcript(request.episodeId, request.audioHash)
    if (
      !alignment ||
      state.stale ||
      state.info?.id !== request.originalId ||
      alignment.revision !== request.revision ||
      transcript.status !== 'ready'
    )
      throw new AppError('CONFLICT', '原文或文稿已变化，请刷新后重新核对这一句。')
    const index = alignment.matches.findIndex((match) => match.segmentId === request.segmentId)
    const match = alignment.matches[index]
    if (!match?.reviewed || !match.selected || match.selected.method !== 'manual')
      throw new AppError(
        'INVALID_ORIGINAL',
        '请先人工确认这段原文，保留空缺的片段不能进行声音对齐。',
      )
    const original = this.document(request, request.originalId)
    const selected = original.sentences.slice(match.selected.first, match.selected.last + 1)
    const originalText = selected.map((sentence) => sentence.text).join('')
    if (
      !selected.length ||
      !originalText.match(/[\p{L}\p{N}]/u) ||
      originalText.length > MAX_ACOUSTIC_TEXT_LENGTH
    )
      throw new AppError(
        'INVALID_ORIGINAL',
        '声音对齐需要包含实际朗读内容的原文，每次最多 1000 字。',
      )
    const durationMs = this.asset(request).durationMs
    const span = match.endMs - match.startMs
    if (!durationMs || span <= 0 || span > MAX_ACOUSTIC_RANGE_MS)
      throw new AppError('INVALID_ORIGINAL', '请先测量音频时长，并将本段确认范围控制在 60 秒内。')
    const padding = Math.min(1500, Math.floor((MAX_ACOUSTIC_RANGE_MS - span) / 2))
    const range = {
      startMs: Math.max(0, match.startMs - padding, alignment.matches[index - 1]?.endMs ?? 0),
      endMs: Math.min(
        Math.ceil(durationMs),
        match.endMs + padding,
        alignment.matches[index + 1]?.startMs ?? Infinity,
      ),
    }
    if (range.endMs <= range.startMs)
      throw new AppError('INVALID_ORIGINAL', '当前片段没有可用的独立音频范围。')
    let offset = 0
    return {
      ...request,
      transcriptId: transcript.transcript.id,
      transcriptRevision: transcript.transcript.revision,
      originalText,
      textHash: createHash('sha256').update(originalText).digest('hex'),
      selection: { first: match.selected.first, last: match.selected.last },
      oldRange: { startMs: match.startMs, endMs: match.endMs },
      range,
      sentences: selected.map((sentence) => {
        const textStart = offset
        offset += sentence.text.length
        return { ordinal: sentence.ordinal, textStart, textEnd: offset }
      }),
    }
  }
  applyAcoustic(
    snapshot: OriginalAcousticSnapshot,
    id: string,
    result: OriginalAcousticResult,
    revision: number,
  ): OriginalState {
    if (revision !== snapshot.revision)
      throw new AppError('CONFLICT', '预览修订已变化，请重新进行声音对齐。')
    const current = this.acousticSnapshot(snapshot)
    if (
      current.transcriptId !== snapshot.transcriptId ||
      current.transcriptRevision !== snapshot.transcriptRevision ||
      current.textHash !== snapshot.textHash ||
      current.oldRange.startMs !== snapshot.oldRange.startMs ||
      current.oldRange.endMs !== snapshot.oldRange.endMs
    )
      throw new AppError('CONFLICT', '原文、文稿或人工同步点已变化，未采用旧预览。')
    const state = this.state(snapshot),
      alignment = state.alignment!
    const index = alignment.matches.findIndex((match) => match.segmentId === snapshot.segmentId)
    const match = alignment.matches[index]!
    const timedSentences = snapshot.sentences.filter((sentence) =>
      /[\p{L}\p{N}]/u.test(snapshot.originalText.slice(sentence.textStart, sentence.textEnd)),
    )
    if (
      result.status !== 'accepted' ||
      result.contract !== ORIGINAL_ACOUSTIC_CONTRACT ||
      result.startMs === null ||
      result.endMs === null ||
      !Number.isSafeInteger(result.startMs) ||
      !Number.isSafeInteger(result.endMs) ||
      result.startMs < snapshot.range.startMs ||
      result.endMs > snapshot.range.endMs + 1 ||
      result.endMs <= result.startMs ||
      result.range.startMs !== snapshot.range.startMs ||
      result.range.endMs !== snapshot.range.endMs ||
      result.sentenceTimes.length !== timedSentences.length ||
      result.sentenceTimes.some(
        (time, ordinal) =>
          time.ordinal !== timedSentences[ordinal]?.ordinal ||
          !Number.isSafeInteger(time.startMs) ||
          !Number.isSafeInteger(time.endMs) ||
          time.startMs < result.startMs! ||
          time.endMs > result.endMs! ||
          time.endMs <= time.startMs ||
          (ordinal > 0 && time.startMs < result.sentenceTimes[ordinal - 1]!.endMs),
      ) ||
      result.sentenceTimes[0]?.startMs !== result.startMs ||
      result.sentenceTimes.at(-1)?.endMs !== result.endMs ||
      (index > 0 && result.startMs < alignment.matches[index - 1]!.endMs) ||
      (index + 1 < alignment.matches.length && result.endMs > alignment.matches[index + 1]!.startMs)
    )
      throw new AppError('INVALID_ORIGINAL', '声音对齐没有可采用的独立同步范围，原人工位置保留。')
    match.acoustic = {
      id,
      contract: result.contract,
      textHash: snapshot.textHash,
      manualRange: match.acoustic?.manualRange ?? { ...snapshot.oldRange },
      sentenceTimes: result.sentenceTimes.map((time) => ({ ...time })),
      appliedAt: new Date().toISOString(),
      device: snapshot.device,
      evidence: { ...result.evidence },
      diagnostics: result.diagnostics,
    }
    match.startMs = result.startMs
    match.endMs = result.endMs
    alignment.revision++
    this.writeAlignment(snapshot, alignment)
    this.transcriptChanged(snapshot)
    return this.state(snapshot)
  }
  restoreAcoustic(request: RestoreOriginalAcousticRequest): OriginalState {
    const state = this.state(request),
      alignment = state.alignment
    if (
      !alignment ||
      state.stale ||
      state.info?.id !== request.originalId ||
      alignment.revision !== request.revision
    )
      throw new AppError('CONFLICT', '原文匹配已变化，请刷新后恢复人工同步点。')
    const index = alignment.matches.findIndex((match) => match.segmentId === request.segmentId)
    const match = alignment.matches[index]
    if (!match?.acoustic || match.acoustic.id !== request.historyId)
      throw new AppError('CONFLICT', '声音对齐记录已变化，未恢复旧的同步点。')
    const manual = match.acoustic.manualRange,
      duration = this.asset(request).durationMs
    if (
      !duration ||
      !Number.isSafeInteger(manual.startMs) ||
      !Number.isSafeInteger(manual.endMs) ||
      manual.startMs < 0 ||
      manual.endMs <= manual.startMs ||
      manual.endMs > duration + 1 ||
      (index > 0 && manual.startMs < alignment.matches[index - 1]!.endMs) ||
      (index + 1 < alignment.matches.length && manual.endMs > alignment.matches[index + 1]!.startMs)
    )
      throw new AppError('CONFLICT', '原人工范围与当前相邻片段冲突，请使用手动校正。')
    match.startMs = manual.startMs
    match.endMs = manual.endMs
    delete match.acoustic
    alignment.revision++
    this.writeAlignment(request, alignment)
    this.transcriptChanged(request)
    return this.state(request)
  }
  correct(request: OriginalCorrection): OriginalState {
    const state = this.state(request),
      alignment = state.alignment
    const transcript = this.transcript(request.episodeId, request.audioHash)
    const existing = alignment?.matches.find((match) => match.segmentId === request.segmentId)
    const segment =
      transcript.status === 'ready' &&
      transcript.transcript.document.segments.find((value) => value.id === request.segmentId)
    const stable =
      existing &&
      segment &&
      (sameSource(sourceForMatch(existing), matchSource(segment)) ||
        (existing.reviewed && !existing.source && existing.asrText === segment.text))
    if (
      !alignment ||
      (state.stale && !stable) ||
      state.info?.id !== request.originalId ||
      alignment.revision !== request.revision
    )
      throw new AppError('CONFLICT', '匹配版本已变化，请刷新或重新匹配后校正。')
    const index = alignment.matches.findIndex((match) => match.segmentId === request.segmentId),
      match = alignment.matches[index]
    const duration = this.asset(request).durationMs ?? 3.6e10
    if (
      !match ||
      !Number.isSafeInteger(request.startMs) ||
      !Number.isSafeInteger(request.endMs) ||
      request.startMs < 0 ||
      request.endMs <= request.startMs ||
      request.endMs > duration + 1 ||
      (index > 0 && request.startMs < alignment.matches[index - 1]!.endMs) ||
      (index < alignment.matches.length - 1 &&
        request.endMs > alignment.matches[index + 1]!.startMs)
    )
      throw new AppError('INVALID_ORIGINAL', '同步范围超出音频或与相邻片段重叠。')
    const parsed = this.document(request, request.originalId)
    if (
      request.selection &&
      (!Number.isSafeInteger(request.selection.first) ||
        !Number.isSafeInteger(request.selection.last) ||
        request.selection.first < 0 ||
        request.selection.last < request.selection.first ||
        request.selection.last >= parsed.sentences.length ||
        request.selection.last - request.selection.first >= 20)
    )
      throw new AppError('INVALID_ORIGINAL', '原文范围不存在或超过 20 句。')
    match.startMs = request.startMs
    match.endMs = request.endMs
    match.selected = request.selection ? { ...request.selection, method: 'manual' } : null
    match.reviewed = true
    delete match.acoustic
    if (transcript.status === 'ready' && alignment.transcriptId === transcript.transcript.id) {
      alignment.matches = mergeIncrementalMatches(transcript.transcript.document, alignment, [])
      alignment.transcriptRevision = transcript.transcript.revision
      const current = new Map(
        transcript.transcript.document.segments.map((value) => [value.id, matchSource(value)]),
      )
      const known = new Map(
        alignment.sources
          ?.filter((source) => sameSource(source, current.get(source.segmentId)!))
          .map((source) => [source.segmentId, source]),
      )
      if (segment) known.set(segment.id, matchSource(segment))
      alignment.sources = [...known.values()]
      alignment.pendingSegments = current.size - known.size
    }
    alignment.revision++
    this.db
      .prepare(
        'UPDATE original_alignments SET revision=?,alignment_json=? WHERE episode_id=? AND audio_hash=? AND document_id=?',
      )
      .run(
        alignment.revision,
        JSON.stringify(alignment),
        request.episodeId,
        request.audioHash,
        request.originalId,
      )
    this.transcriptChanged(request)
    return this.state(request)
  }
}
