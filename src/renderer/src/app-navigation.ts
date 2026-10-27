export type AppRoute =
  | { view: 'library' | 'ebook' | 'reading' | 'source' }
  | { view: 'chapters' | 'reader'; bookId: string }

function validBookId(id: string) {
  return (
    id.length <= 200 &&
    id.trim().length > 0 &&
    !/[/?#]/.test(id) &&
    !Array.from(id).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || (code >= 127 && code <= 159)
    })
  )
}

export function parseAppRoute(hash: string): AppRoute {
  switch (hash) {
    case '#/library/ebooks':
      return { view: 'ebook' }
    case '#/listening':
      return { view: 'reading' }
    case '#/sources':
      return { view: 'source' }
  }
  const match = /^#\/(audiobooks|read)\/([^/?#]{1,1800})$/.exec(hash)
  if (match) {
    try {
      const bookId = decodeURIComponent(match[2]!)
      if (validBookId(bookId)) return { view: match[1] === 'read' ? 'reader' : 'chapters', bookId }
    } catch {
      // Invalid percent encoding is an unknown route, so the library stays reachable.
    }
  }
  return { view: 'library' }
}

export function appRouteHash(route: AppRoute): string {
  switch (route.view) {
    case 'library':
      return '#/library/audiobooks'
    case 'ebook':
      return '#/library/ebooks'
    case 'reading':
      return '#/listening'
    case 'source':
      return '#/sources'
    case 'chapters':
    case 'reader':
      if (!validBookId(route.bookId)) throw new RangeError('Invalid book route ID')
      return `#/${route.view === 'reader' ? 'read' : 'audiobooks'}/${encodeURIComponent(route.bookId)}`
  }
}
