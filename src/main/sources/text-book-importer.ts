import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { AppError } from '../../shared/validation'
import type { ParsedOriginal } from '../../shared/original'
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

  async close() {
    this.closed = true
    await Promise.all([...this.parsers].map((parser) => parser.close()))
  }
}
