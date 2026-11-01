import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { OriginalInfo, ParsedOriginal } from '../shared/original'
import type {
  SourceReadingImport,
  SourceReadingState,
  SourceReadingContext,
} from '../shared/text-sources'
import { AppError } from '../shared/validation'

interface StoredChapter {
  id: string
  title: string
  order: number
  hash: string
}
interface SourceRow {
  document_id: string
  chapters_json: string
}
export interface ParsedSourceChapter {
  id: string
  title: string
  order: number
  parsed: ParsedOriginal
}

/** Owned extension table: local TXT/EPUB deduplication and immutable imports are unchanged. */
export class SourceReadingStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS source_reading_books (
      source_key TEXT PRIMARY KEY,
      document_id TEXT NOT NULL UNIQUE REFERENCES reading_books(document_id) ON DELETE CASCADE,
      source_id TEXT NOT NULL, work_id TEXT NOT NULL, chapters_json TEXT NOT NULL
    ) STRICT`)
  }

  state(key: string): SourceReadingState | null {
    const row = this.row(key)
    if (!row) return null
    const chapters = JSON.parse(row.chapters_json) as StoredChapter[]
    return {
      readingBookId: row.document_id,
      downloadedChapterIds: chapters.map((chapter) => chapter.id),
      chapterOrders: Object.fromEntries(chapters.map((chapter) => [chapter.id, chapter.order])),
    }
  }

  byBook(id: string): SourceReadingContext | null {
    const row = this.db
      .prepare('SELECT source_key,source_id,work_id FROM source_reading_books WHERE document_id=?')
      .get(id)
    const state = row ? this.state(String(row.source_key)) : null
    return row && state
      ? { ...state, sourceId: String(row.source_id), workId: String(row.work_id) }
      : null
  }

  private row(key: string): SourceRow | null {
    return (
      (this.db
        .prepare('SELECT document_id,chapters_json FROM source_reading_books WHERE source_key=?')
        .get(key) as unknown as SourceRow | undefined) ?? null
    )
  }

  append(input: SourceReadingImport, incoming: ParsedSourceChapter[]): string {
    if (
      !/^[a-f0-9]{64}$/.test(input.sourceKey) ||
      !input.sourceId ||
      input.sourceId.length > 200 ||
      !input.workId ||
      input.workId.length > 12000 ||
      !input.title.trim() ||
      input.title.length > 500 ||
      !incoming.length ||
      incoming.length > 20
    )
      throw new AppError('INVALID_ORIGINAL', '来源章节导入参数无效。')
    const ids = new Set<string>()
    for (const [index, chapter] of incoming.entries()) {
      if (
        !chapter.id ||
        chapter.id.length > 1000 ||
        ids.has(chapter.id) ||
        !Number.isSafeInteger(chapter.order) ||
        chapter.order < 0 ||
        chapter.order > 100000 ||
        (index > 0 && chapter.order <= incoming[index - 1]!.order) ||
        !chapter.parsed.sentences.length
      )
        throw new AppError('INVALID_ORIGINAL', '所选章节身份或目录顺序无效，请重新核对。')
      ids.add(chapter.id)
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.row(input.sourceKey)
      const old = row
        ? this.db
            .prepare('SELECT info_json,document_json FROM original_documents WHERE id=?')
            .get(row.document_id)
        : undefined
      if (row && !old) throw new AppError('INVALID_ORIGINAL', '已有来源电子书已不可读取。')
      const saved = row ? (JSON.parse(row.chapters_json) as StoredChapter[]) : []
      const existing = new Map(saved.map((chapter) => [chapter.id, chapter]))
      for (const chapter of incoming) {
        const prior = existing.get(chapter.id)
        if (
          prior &&
          (prior.order !== chapter.order ||
            prior.title !== chapter.title ||
            prior.hash !== chapter.parsed.hash)
        )
          throw new AppError(
            'CONFLICT',
            '网站已改变已下载章节的顺序或正文，原书保留，请先核对目录。',
          )
      }
      const fresh = incoming.filter((chapter) => !existing.has(chapter.id))
      if (!fresh.length) {
        this.db.exec('COMMIT')
        return row!.document_id
      }
      if (fresh[0]!.order <= (saved.at(-1)?.order ?? -1))
        throw new AppError('CONFLICT', '只能在本书末尾追加后续章节；前置或重排章节请先核对目录。')

      const previous = old ? (JSON.parse(String(old.document_json)) as ParsedOriginal) : null
      const parsed: ParsedOriginal = previous
        ? structuredClone(previous)
        : {
            hash: '',
            parserVersion: incoming[0]!.parsed.parserVersion,
            title: input.title,
            sourceName: `${input.title.replace(/[<>:"/\\|?*\p{Cc}]/gu, '_').slice(0, 100)}.txt`,
            format: 'txt',
            encoding: 'utf-8',
            bytes: 0,
            chapters: [],
            sentences: [],
            warnings: [
              '来源正文按已选章节追加；已下载部分的句子坐标保持不变。',
              `来源：${input.sourceId}${input.pageUrl ? ` · ${input.pageUrl}` : ''}。署名与权利信息请查阅来源页面。`,
            ],
          }
      for (const chapter of fresh) {
        const chapterIndex = parsed.chapters.length
        const first = parsed.sentences.length
        const paragraph = parsed.sentences.at(-1)?.paragraph ?? 0
        parsed.chapters.push({
          index: chapterIndex,
          title: chapter.title,
          first,
          count: chapter.parsed.sentences.length,
        })
        for (const sentence of chapter.parsed.sentences)
          parsed.sentences.push({
            ...sentence,
            ordinal: parsed.sentences.length,
            chapter: chapterIndex,
            paragraph: paragraph + sentence.paragraph,
          })
        parsed.bytes += chapter.parsed.bytes
        saved.push({
          id: chapter.id,
          title: chapter.title,
          order: chapter.order,
          hash: chapter.parsed.hash,
        })
      }
      if (
        parsed.bytes > 32 * 1024 * 1024 ||
        parsed.chapters.length > 10000 ||
        parsed.sentences.length > 250000 ||
        parsed.sentences.reduce((sum, sentence) => sum + sentence.text.length, 0) > 12_000_000
      )
        throw new AppError('INVALID_ORIGINAL', '本卷已达到正文容量上限，请按卷使用另一来源书目。')
      parsed.hash = createHash('sha256')
        .update(
          JSON.stringify([
            input.sourceKey,
            saved.map((chapter) => [chapter.id, chapter.order, chapter.hash]),
          ]),
        )
        .digest('hex')
      const id = row?.document_id ?? randomUUID()
      const priorInfo = old ? (JSON.parse(String(old.info_json)) as OriginalInfo) : null
      const { sentences, ...meta } = parsed
      const info: OriginalInfo = {
        ...meta,
        id,
        sentenceCount: sentences.length,
        importedAt: priorInfo?.importedAt ?? new Date().toISOString(),
        ...{ source: { sourceId: input.sourceId, workId: input.workId } },
      }
      if (row)
        this.db
          .prepare(
            'UPDATE original_documents SET content_hash=?,info_json=?,document_json=? WHERE id=?',
          )
          .run(parsed.hash, JSON.stringify(info), JSON.stringify(parsed), id)
      else {
        this.db
          .prepare('INSERT INTO original_documents VALUES (?,?,?,?,?)')
          .run(id, parsed.hash, parsed.parserVersion, JSON.stringify(info), JSON.stringify(parsed))
        this.db.prepare('INSERT INTO reading_books(document_id) VALUES (?)').run(id)
      }
      this.db
        .prepare(
          `INSERT INTO source_reading_books VALUES (?,?,?,?,?)
        ON CONFLICT(source_key) DO UPDATE SET chapters_json=excluded.chapters_json`,
        )
        .run(input.sourceKey, id, input.sourceId, input.workId, JSON.stringify(saved))
      this.db.exec('COMMIT')
      return id
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }
}
