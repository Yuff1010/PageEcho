import type { DatabaseSync } from 'node:sqlite'
import type { Episode } from '../shared/contracts'
import type {
  BookLink,
  LinkedListeningCandidate,
  LinkReadingBookRequest,
  OpenLinkedReadingRequest,
  OpenLinkedReadingResult,
  ResolveLinkedListeningRequest,
  ResolveLinkedListeningResult,
} from '../shared/book-links'
import { ORIGINAL_MATCHER_VERSION, type OriginalMatch } from '../shared/original'
import { AppError } from '../shared/validation'
import type { ReadingStore } from './reading-store'
import type { OriginalStore } from './original/store'

/** Explicit links reuse the original binding. Reads never create shelf membership. */
export class BookLinkStore {
  constructor(
    private db: DatabaseSync,
    private reading: ReadingStore,
    private originals: OriginalStore,
    private episode: (id: string) => Episode | undefined,
  ) {}

  list(): BookLink[] {
    return this.db
      .prepare(
        `SELECT b.id AS audioBookId, r.document_id AS readingBookId,
          b.title AS audioTitle, json_extract(d.info_json,'$.title') AS readingTitle
        FROM book_originals o JOIN books b ON b.id=o.book_id
        JOIN reading_books r ON r.document_id=o.document_id
        JOIN original_documents d ON d.id=o.document_id
        ORDER BY b.title COLLATE NOCASE, b.id`,
      )
      .all() as unknown as BookLink[]
  }

  link(request: LinkReadingBookRequest): BookLink {
    const audio = this.book(request.bookId)
    const book = this.reading.get(request.readingBookId)
    this.db
      .prepare(
        `INSERT INTO book_originals(book_id,document_id) VALUES (?,?)
        ON CONFLICT(book_id) DO UPDATE SET document_id=excluded.document_id`,
      )
      .run(request.bookId, book.id)
    this.notify(request.bookId)
    return {
      audioBookId: request.bookId,
      readingBookId: book.id,
      audioTitle: audio.title,
      readingTitle: book.title,
    }
  }

  unlink(bookId: string): void {
    this.book(bookId)
    // Keep both the original and its alignment revisions for a later relink.
    this.db.prepare('DELETE FROM book_originals WHERE book_id=?').run(bookId)
    this.notify(bookId)
  }

  openReading(request: OpenLinkedReadingRequest): OpenLinkedReadingResult {
    const state = this.originals.state(request)
    if (!state.info) throw new AppError('INVALID_ORIGINAL', '这本有声书尚未关联电子书或小说原文。')
    const episode = this.episode(request.episodeId)!
    if (
      !Number.isSafeInteger(request.positionMs) ||
      request.positionMs < 0 ||
      request.positionMs > 3.6e10 ||
      (episode.durationMs !== null && request.positionMs > episode.durationMs)
    )
      throw new AppError('INVALID_REQUEST', '音频位置超出本集范围。')

    const positions = new Set<number>()
    if (!state.stale && state.alignment?.matcherVersion === ORIGINAL_MATCHER_VERSION) {
      for (const match of state.alignment.matches) {
        if (!this.usable(match, state.info.sentenceCount)) continue
        if (request.positionMs < match.startMs || request.positionMs >= match.endMs) continue
        if (match.acoustic) {
          for (const time of match.acoustic.sentenceTimes)
            if (
              time.ordinal >= match.selected!.first &&
              time.ordinal <= match.selected!.last &&
              time.startMs <= request.positionMs &&
              request.positionMs < time.endMs
            )
              positions.add(time.ordinal)
        } else positions.add(match.selected!.first)
      }
    }
    // Conflicting source intervals do not justify choosing an arbitrary sentence.
    const position = positions.size === 1 ? [...positions][0]! : null
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare('INSERT OR IGNORE INTO reading_books(document_id) VALUES (?)')
        .run(state.info.id)
      if (position !== null) this.reading.savePosition(state.info.id, position)
      this.db.exec('COMMIT')
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
    return {
      book: this.reading.get(state.info.id),
      position,
      status: position === null ? 'unmapped' : 'mapped',
    }
  }

  resolveListening(request: ResolveLinkedListeningRequest): ResolveLinkedListeningResult {
    const book = this.reading.get(request.readingBookId)
    if (
      !Number.isSafeInteger(request.position) ||
      request.position < 0 ||
      request.position >= book.sentenceCount
    )
      throw new AppError('INVALID_REQUEST', '阅读位置超出本书范围。')
    if (request.bookId) this.book(request.bookId)
    const rows = this.db
      .prepare(
        `SELECT a.episode_id AS episodeId, a.audio_hash AS audioHash,
          e.book_id AS bookId, b.title AS bookTitle
        FROM original_alignments a
        JOIN episodes e ON e.id=a.episode_id AND e.content_hash=a.audio_hash
        JOIN book_originals o ON o.book_id=e.book_id AND o.document_id=a.document_id
        JOIN books b ON b.id=e.book_id
        WHERE a.document_id=? ${request.bookId ? 'AND e.book_id=?' : ''}
        ORDER BY b.id, e.sort_order, e.id LIMIT 10001`,
      )
      .all(...(request.bookId ? [book.id, request.bookId] : [book.id]))
    if (rows.length > 10000)
      throw new AppError('INVALID_ORIGINAL', '关联的音频过多，请先选择一本有声书再定位。')
    const candidates = new Map<string, LinkedListeningCandidate>()
    for (const row of rows) {
      const target = { episodeId: String(row.episodeId), audioHash: String(row.audioHash) }
      const state = this.originals.state(target)
      const episode = this.episode(target.episodeId)!
      if (
        state.info?.id !== book.id ||
        state.stale ||
        state.alignment?.matcherVersion !== ORIGINAL_MATCHER_VERSION
      )
        continue
      for (const match of state.alignment.matches) {
        if (
          !this.usable(match, book.sentenceCount) ||
          request.position < match.selected!.first ||
          request.position > match.selected!.last
        )
          continue
        const starts = match.acoustic
          ? match.acoustic.sentenceTimes
              .filter((time) => time.ordinal === request.position)
              .map((time) => time.startMs)
          : [match.startMs]
        for (const positionMs of starts) {
          if (
            !Number.isSafeInteger(positionMs) ||
            positionMs < 0 ||
            positionMs > 3.6e10 ||
            (episode.durationMs !== null && positionMs >= episode.durationMs)
          )
            continue
          const key = `${target.episodeId}:${target.audioHash}:${positionMs}`
          candidates.set(key, {
            bookId: String(row.bookId),
            ...target,
            bookTitle: String(row.bookTitle),
            episodeTitle: episode.title,
            positionMs,
            first: match.selected!.first,
            last: match.selected!.last,
          })
          if (candidates.size > 200)
            throw new AppError('INVALID_ORIGINAL', '对应的声音片段过多，请先选择一本有声书。')
        }
      }
    }
    const values = [...candidates.values()]
    return {
      status: values.length === 0 ? 'unmapped' : values.length === 1 ? 'mapped' : 'ambiguous',
      candidates: values,
    }
  }

  private book(id: string): { title: string } {
    const row = this.db.prepare('SELECT title FROM books WHERE id=?').get(id)
    if (!row) throw new AppError('FILE_UNAVAILABLE', '有声书已移除，请返回书架重新选择。')
    return { title: String(row.title) }
  }

  private notify(bookId: string) {
    for (const row of this.db
      .prepare('SELECT id,content_hash FROM episodes WHERE book_id=?')
      .all(bookId))
      if (/^[0-9a-f]{64}$/.test(String(row.content_hash)))
        this.originals.transcriptChanged({
          episodeId: String(row.id),
          audioHash: String(row.content_hash),
        })
  }

  private usable(match: OriginalMatch, sentenceCount: number): boolean {
    return (
      match.sourceState === 'current' &&
      !!match.selected &&
      Number.isSafeInteger(match.selected.first) &&
      Number.isSafeInteger(match.selected.last) &&
      match.selected.first >= 0 &&
      match.selected.last >= match.selected.first &&
      match.selected.last < sentenceCount &&
      Number.isSafeInteger(match.startMs) &&
      Number.isSafeInteger(match.endMs) &&
      match.startMs >= 0 &&
      match.endMs > match.startMs
    )
  }
}
