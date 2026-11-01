import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { AppError } from '../../shared/validation'
import type { ParsedOriginal } from '../../shared/original'
import type { SourceReadingImport } from '../../shared/text-sources'
import type { ParsedSourceChapter } from '../source-reading-store'
import type { LibraryStore } from '../database'
import { OriginalService } from '../original/service'

/** Source parsing has its own worker, so canceling it cannot cancel manual original matching. */
export class TextBookImporter {
  private parsers = new Set<OriginalService>()
  private closed = false
  constructor(
    private store: LibraryStore,
    private directory: string,
  ) {}

  async import(bytes: Buffer, filename: string, signal: AbortSignal) {
    signal.throwIfAborted()
    if (this.closed || this.parsers.size) throw new AppError('BUSY', '正在导入电子书，请稍后重试。')
    if (
      filename !== basename(filename) ||
      !/\.(?:txt|epub)$/i.test(filename) ||
      !bytes.length ||
      bytes.length > 32 * 1024 * 1024
    )
      throw new AppError('INVALID_ORIGINAL', '来源电子书必须是非空且不超过 32 MiB 的 TXT／EPUB。')
    const parser = new OriginalService()
    this.parsers.add(parser)
    let temporary: string | undefined
    let file: string | undefined
    const cancel = () => {
      void parser.cancel()
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      temporary = await mkdtemp(join(this.directory, 'text-import-'))
      file = join(temporary, filename)
      await writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
      signal.throwIfAborted()
      const parsed = await parser.run<ParsedOriginal>({ kind: 'parse', path: file })
      signal.throwIfAborted()
      return this.store.reading.import(parsed)
    } finally {
      signal.removeEventListener('abort', cancel)
      await parser.close()
      this.parsers.delete(parser)
      // Only our exact temporary file and empty directory are removed; no recursive cleanup.
      if (file) await unlink(file).catch(() => undefined)
      if (temporary) await rmdir(temporary).catch(() => undefined)
    }
  }

  /** Parse selected chapters off-thread, then append once in the library transaction. */
  async importChapters(input: SourceReadingImport, signal: AbortSignal) {
    signal.throwIfAborted()
    if (this.closed || this.parsers.size) throw new AppError('BUSY', '正在导入电子书，请稍后重试。')
    if (!input.chapters.length || input.chapters.length > 20)
      throw new AppError('INVALID_ORIGINAL', '请选择 1–20 个章节。')
    const parser = new OriginalService()
    this.parsers.add(parser)
    let temporary: string | undefined
    const files: string[] = []
    const cancel = () => {
      void parser.cancel()
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      temporary = await mkdtemp(join(this.directory, 'text-chapters-'))
      const chapters: ParsedSourceChapter[] = []
      let total = 0
      for (const [index, chapter] of input.chapters.entries()) {
        signal.throwIfAborted()
        if (
          typeof chapter.text !== 'string' ||
          !chapter.text.trim() ||
          typeof chapter.title !== 'string' ||
          !chapter.title.trim() ||
          chapter.title.length > 500 ||
          /[\r\n]/.test(chapter.title) ||
          chapter.title.includes('\u0000') ||
          !Number.isSafeInteger(chapter.order)
        )
          throw new AppError('INVALID_ORIGINAL', '来源章节正文或目录顺序无效。')
        const bytes = Buffer.from(`第1章 ${chapter.title}\n\n${chapter.text}`, 'utf8')
        total += bytes.length
        if (total > 32 * 1024 * 1024)
          throw new AppError('INVALID_ORIGINAL', '本次来源正文超过 32 MiB，请减少章节范围。')
        const file = join(temporary, `${index}.txt`)
        files.push(file)
        await writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
        const parsed = await parser.run<ParsedOriginal>({ kind: 'parse', path: file })
        chapters.push({ id: chapter.id, title: chapter.title, order: chapter.order!, parsed })
      }
      signal.throwIfAborted()
      return this.store.reading.appendSource(input, chapters)
    } finally {
      signal.removeEventListener('abort', cancel)
      await parser.close()
      this.parsers.delete(parser)
      for (const file of files) await unlink(file).catch(() => undefined)
      if (temporary) await rmdir(temporary).catch(() => undefined)
    }
  }

  async close() {
    this.closed = true
    await Promise.all([...this.parsers].map((parser) => parser.close()))
  }
}
