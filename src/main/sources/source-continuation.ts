import type { LibraryStore } from '../database'
import { SourceError, type SourceAdapter, type SourceEpisode } from '../../shared/sources'

// Cursors belong to one adapter instance. After restart, traverse fresh source pages.
export async function continueSourceCatalog(
  store: LibraryStore,
  adapter: SourceAdapter,
  id: string,
  signal: AbortSignal,
) {
  const current = store.getEpisode(id)
  if (!current?.online) throw new SourceError('INVALID_SOURCE_REQUEST', '这不是已保存的在线章节。')
  const known = store.getBookMetadata(current.bookId)
  if (!known?.online) throw new SourceError('SOURCE_CHANGED', '在线书籍已移除。')
  if (store.hasBookEpisodeAfter(current.bookId, current.order) || known.online.catalogComplete)
    return
  const book = await adapter.getBook(current.online.bookId, signal)
  if (book.sourceId !== current.online.sourceId || book.id !== current.online.bookId)
    throw new SourceError('SOURCE_CHANGED', '书源书籍身份变化，已保留原目录和进度。')
  const all: SourceEpisode[] = []
  let cursor: string | undefined
  for (let pages = 0; pages < 100; pages++) {
    signal.throwIfAborted()
    const page = await adapter.getEpisodes(book.id, cursor, signal)
    if (!page.items.length) throw new SourceError('SOURCE_CHANGED', '书源返回了空目录页。')
    all.push(...page.items)
    if (all.length > 100000) throw new SourceError('SOURCE_CHANGED', '书源目录过大，已保留原目录。')
    if (all.at(-1)!.order > current.order || !page.nextCursor) {
      if (all[current.order - 1]?.id !== current.online.episodeId)
        throw new SourceError('SOURCE_CHANGED', '书源当前集身份变化，已保留原目录和进度。')
      signal.throwIfAborted()
      store.rememberSourceBook(book, all, page.nextCursor === null)
      return
    }
    cursor = page.nextCursor
  }
  throw new SourceError('SOURCE_CHANGED', '书源目录分页异常，已保留原目录。')
}
