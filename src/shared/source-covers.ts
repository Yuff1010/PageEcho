/** Same application origin; the renderer never receives permission to fetch arbitrary websites. */
export const SOURCE_COVER_PREFIX = 'readlisten://app/covers/'
/** Durable local images; unlike source candidates these URLs survive an app restart. */
export const BOOK_COVER_PREFIX = 'readlisten://app/book-covers/'

export function isSourceCoverUrl(value: unknown): value is string {
  return typeof value === 'string' && /^readlisten:\/\/app\/covers\/[a-f0-9-]{36}$/.test(value)
}

export function isBookCoverUrl(value: unknown): value is string {
  return typeof value === 'string' && /^readlisten:\/\/app\/book-covers\/[a-f0-9]{64}$/.test(value)
}
