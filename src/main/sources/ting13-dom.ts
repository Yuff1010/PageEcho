// Executed in a separate Chromium isolated world. Returns DOM data, never page globals/code.
export interface SourceLink {
  url: string
  text: string
  title: string
}
export interface Ting13Document {
  url: string
  title: string
  ready: boolean
  challenge: boolean
  searchForm: boolean
  searchResults: {
    url: string
    title: string
    authors: string[]
    narrators: string[]
    description: string
    coverUrl?: string | null
  }[]
  book: {
    title: string
    authors: string[]
    narrators: string[]
    description: string
    directory: string
    coverUrl?: string | null
  }
  episodes: SourceLink[]
  pages: SourceLink[]
  media: string[]
}

export function readTing13Document(): Ting13Document {
  const text = (element: Element | null, max = 2000) =>
    (element?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
  const link = (element: Element): SourceLink => ({
    url: element.getAttribute('href') ?? '',
    text: text(element, 300),
    title: (element.getAttribute('title') ?? '').slice(0, 500),
  })
  const names = (root: ParentNode, selector: string) =>
    Array.from(root.querySelectorAll(selector), (element) => text(element, 200)).slice(0, 100)
  const imageUrl = (image: Element | null) => {
    for (const attribute of ['data-original', 'data-src', 'data-lazy-src', 'src']) {
      const value = image?.getAttribute(attribute)?.trim()
      if (!value || value.length > 4000) continue
      try {
        const url = new URL(value, location.href)
        if (url.protocol === 'https:' && !url.username && !url.password && !url.hash) return value
      } catch {
        /* Try another image attribute; the adapter still validates source origins. */
      }
    }
    return null
  }
  const searchCover = (card: Element, bookUrl: string) => {
    const inline = imageUrl(card.querySelector('img'))
    if (inline) return inline
    // The site's result image is a sibling of the metadata <dl>, inside the
    // same <li>. Match the book link rather than borrowing an unrelated image.
    const row = card.closest('li')
    if (!row) return null
    let target: string
    try {
      target = new URL(bookUrl, location.href).href
    } catch {
      return null
    }
    for (const anchor of Array.from(row.querySelectorAll('a[href]')).slice(0, 30)) {
      try {
        if (new URL(anchor.getAttribute('href') ?? '', location.href).href !== target) continue
        const image = imageUrl(anchor.querySelector('img'))
        if (image) return image
      } catch {
        /* A malformed or unrelated link does not identify this book's cover. */
      }
    }
    return null
  }
  const info = document.querySelector('.book-info')
  return {
    url: location.href,
    title: document.title.slice(0, 500),
    ready: document.readyState === 'complete',
    challenge:
      /^(Loading\.\.\.|Just a moment\.\.\.)$/i.test(document.title.trim()) ||
      !!document.querySelector('iframe[src*="captcha"], .cf-turnstile, #challenge-form'),
    searchForm: !!document.querySelector(
      'form[action="/novelsearch/search/result.html"] input[name="searchword"]',
    ),
    searchResults: Array.from(document.querySelectorAll('.list-works-dl'))
      .slice(0, 100)
      .map((card) => ({
        url: card.querySelector('.list-book-dt > a')?.getAttribute('href') ?? '',
        title: text(card.querySelector('.list-book-dt > a'), 300),
        authors: names(card, '.book-author a'),
        narrators: names(card, '.book-boyin a'),
        description: text(card.querySelector('.list-book-des')),
        coverUrl: searchCover(
          card,
          card.querySelector('.list-book-dt > a')?.getAttribute('href') ?? '',
        ),
      })),
    book: {
      title: text(info?.querySelector('.book-title') ?? null, 300).replace(/有声小说$/, ''),
      authors: info ? names(info, 'a[href^="/author/"]') : [],
      narrators: info ? names(info, 'a[href^="/boyin/"]') : [],
      description:
        document
          .querySelector('meta[name="description"]')
          ?.getAttribute('content')
          ?.slice(0, 2000) ?? '',
      directory: document.querySelector('a.dirurl')?.getAttribute('href') ?? '',
      coverUrl:
        imageUrl(document.querySelector('.book-img img, .book-cover img, .book-pic img')) ||
        imageUrl(document.querySelector('a.thumb img')) ||
        document.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
        null,
    },
    episodes: Array.from(document.querySelectorAll('#playlist a[href^="/play/"]'), link).slice(
      0,
      10000,
    ),
    pages: Array.from(
      document.querySelectorAll('a[href^="/search/"], a[href^="/tingdirs/"]'),
      link,
    ).slice(0, 1000),
    media: Array.from(
      document.querySelectorAll('audio[src],video[src],source[src]'),
      (element) => element.getAttribute('src') ?? '',
    ).slice(0, 20),
  }
}
