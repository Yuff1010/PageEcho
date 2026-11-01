import type { DatabaseSync } from 'node:sqlite'
import { ORIGINAL_PAGE_SIZE, type OriginalPage, type ParsedOriginal } from '../shared/original'
import type { ReadingBook } from '../shared/reading'
import { AppError } from '../shared/validation'
import { storeOriginalDocument } from './original/documents'
import { SourceReadingStore, type ParsedSourceChapter } from './source-reading-store'
import type { SourceReadingImport } from '../shared/text-sources'

export const READING_SCHEMA = `
  CREATE TABLE reading_books (
    document_id TEXT PRIMARY KEY REFERENCES original_documents(id),
    position INTEGER NOT NULL DEFAULT 0 CHECK(position >= 0), last_read_at TEXT
  ) STRICT;
`

export class ReadingStore {
  private cached: { id: string; value: ParsedOriginal } | null = null
  private sources: SourceReadingStore
  constructor(private db: DatabaseSync) {
    this.sources = new SourceReadingStore(db)
  }

  sourceState(key: string) {
    return this.sources.state(key)
  }
  sourceByBook(id: string) {
    this.get(id)
    return this.sources.byBook(id)
  }
  appendSource(input: SourceReadingImport, chapters: ParsedSourceChapter[]): ReadingBook {
    const id = this.sources.append(input, chapters)
    if (this.cached?.id === id) this.cached = null
    return this.get(id)
  }

  list(): ReadingBook[] {
    return this.db
      .prepare(
        `SELECT d.info_json, r.position, r.last_read_at FROM reading_books r
        JOIN original_documents d ON d.id=r.document_id
        ORDER BY r.last_read_at DESC, r.rowid DESC`,
      )
      .all()
      .map((row) => this.fromRow(row))
  }
  private fromRow(row: Record<string, unknown>): ReadingBook {
    return {
      ...JSON.parse(String(row.info_json)),
      position: Number(row.position),
      lastReadAt: row.last_read_at === null ? null : String(row.last_read_at),
    } as ReadingBook
  }
  get(id: string): ReadingBook {
    const row = this.db
      .prepare(
        `SELECT d.info_json, r.position, r.last_read_at FROM reading_books r
        JOIN original_documents d ON d.id=r.document_id WHERE r.document_id=?`,
      )
      .get(id)
    if (!row) throw new AppError('FILE_UNAVAILABLE', '电子书已移除，请返回阅读书架。')
    return this.fromRow(row)
  }
  import(parsed: ParsedOriginal): ReadingBook {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const id = storeOriginalDocument(this.db, parsed)
      this.db.prepare('INSERT OR IGNORE INTO reading_books(document_id) VALUES (?)').run(id)
      this.db.exec('COMMIT')
      return this.get(id)
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }
  document(id: string): ParsedOriginal {
    const info = this.get(id) // Membership and source append revision are checked on every read.
    if (this.cached?.id === id && this.cached.value.hash === info.hash) return this.cached.value
    const row = this.db.prepare('SELECT document_json FROM original_documents WHERE id=?').get(id)!
    const value = JSON.parse(String(row.document_json)) as ParsedOriginal
    this.cached = { id, value }
    return value
  }
  page(id: string, start: number): OriginalPage {
    const info = this.get(id)
    this.checkPosition(info, start)
    return {
      info,
      start,
      sentences: this.document(id).sentences.slice(start, start + ORIGINAL_PAGE_SIZE),
    }
  }
  savePosition(id: string, position: number): void {
    this.checkPosition(this.get(id), position)
    this.db
      .prepare('UPDATE reading_books SET position=?, last_read_at=? WHERE document_id=?')
      .run(position, new Date().toISOString(), id)
  }
  private checkPosition(book: ReadingBook, position: number): void {
    if (!Number.isSafeInteger(position) || position < 0 || position >= book.sentenceCount)
      throw new AppError('INVALID_REQUEST', '阅读位置超出本书范围。')
  }
  remove(id: string): void {
    this.get(id)
    this.db.prepare('DELETE FROM reading_books WHERE document_id=?').run(id)
    if (this.cached?.id === id) this.cached = null
    // Other audio books may still use this document for companion reading.
    this.db
      .prepare(
        `DELETE FROM original_documents WHERE id=?
      AND NOT EXISTS (SELECT 1 FROM book_originals WHERE document_id=?)
      AND NOT EXISTS (SELECT 1 FROM original_alignments WHERE document_id=?)`,
      )
      .run(id, id, id)
  }
}
