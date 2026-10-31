/** Same application origin; the renderer never receives permission to fetch arbitrary websites. */
export const SOURCE_COVER_PREFIX = 'readlisten://app/covers/'

export function isSourceCoverUrl(value: unknown): value is string {
  return typeof value === 'string' && /^readlisten:\/\/app\/covers\/[a-f0-9-]{36}$/.test(value)
}
