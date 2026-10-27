export type ShelfLayout = 'grid' | 'list'
export type ShelfSort = 'added' | 'recent' | 'title'

export function visibleShelfBooks<T extends { title: string; importedAt: string }>(
  books: readonly T[],
  query: string,
  sort: string,
  recentOnly: boolean,
  lastUsed: (book: T) => string | null,
): T[] {
  const needle = query.trim().toLocaleLowerCase()
  return books
    .filter(
      (book) => (!recentOnly || lastUsed(book)) && book.title.toLocaleLowerCase().includes(needle),
    )
    .sort((a, b) =>
      sort === 'title'
        ? a.title.localeCompare(b.title, 'zh-CN', { numeric: true })
        : sort === 'added'
          ? b.importedAt.localeCompare(a.importedAt)
          : (lastUsed(b) ?? b.importedAt).localeCompare(lastUsed(a) ?? a.importedAt),
    )
}

export function readingShelfPosition(book: {
  position: number
  sentenceCount: number
  lastReadAt: string | null
}): string {
  if (!book.lastReadAt) return '尚未开始阅读'
  const progress =
    book.sentenceCount > 0 ? Math.floor(((book.position + 1) / book.sentenceCount) * 100) : 0
  return `已读至 ${Math.max(0, Math.min(100, progress))}%`
}
