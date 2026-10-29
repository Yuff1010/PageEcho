import { randomUUID } from 'node:crypto'
import {
  SourceError,
  SOURCE_QUERY_LIMITS,
  type SourceAdapter,
  type SourceBook,
  type SourceEpisode,
  type SourcePage,
} from '../../shared/sources'

const ORIGIN = 'https://librivox.org'
const API = `${ORIGIN}/api/feed/audiobooks/`
const PAGE_SIZE = 20
const MAX_JSON_BYTES = 8 * 1024 * 1024
type Row = Record<string, unknown>
function row(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SourceError('SOURCE_CHANGED', 'LibriVox 返回了无效书目信息。')
  return value as Row
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,8}$/.test(value))
    throw new SourceError('INVALID_SOURCE_REQUEST', '无效的 LibriVox 书目或分集标识。')
  return value
}
function text(value: unknown, maximum: number, required = false): string {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > maximum)
    throw new SourceError('SOURCE_CHANGED', 'LibriVox 书目信息格式已变化。')
  return value.trim()
}
function plain(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi, (entity) => {
      const names: Record<string, string> = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&apos;': "'",
        '&nbsp;': ' ',
      }
      if (names[entity.toLowerCase()]) return names[entity.toLowerCase()]!
      const code = Number.parseInt(
        entity.slice(entity[2]?.toLowerCase() === 'x' ? 3 : 2, -1),
        entity[2]?.toLowerCase() === 'x' ? 16 : 10,
      )
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : ''
    })
    .replace(/\s+/g, ' ')
    .trim()
}
export function librivoxPageUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new SourceError('INVALID_SOURCE_REQUEST', '无效的 LibriVox 地址。')
  }
  if (url.origin !== ORIGIN || url.username || url.password || url.hash || value.length > 4000)
    throw new SourceError('INVALID_SOURCE_REQUEST', '地址不属于 LibriVox 官方站点。')
  return url
}
// Archive serves LibriVox MP3s through numbered storage nodes. A redirect must
// retain the exact collection/file identity, not merely an allowed hostname.
export function librivoxMediaUrl(value: string, original?: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new SourceError('SOURCE_MEDIA_UNAVAILABLE', 'LibriVox 音频地址无效。')
  }
  const primary = ['archive.org', 'www.archive.org'].includes(url.hostname)
  const storage = /^(?:ia|dn)\d+\.(?:us|ca|eu)\.archive\.org$/.test(url.hostname)
  const identity = primary
    ? /^\/download\/(.+\/[^/]+\.mp3)$/i.exec(url.pathname)?.[1]
    : storage
      ? /^\/\d+\/items\/(.+\/[^/]+\.mp3)$/i.exec(url.pathname)?.[1]
      : undefined
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    value.length > 16000 ||
    !identity ||
    /%2f|%5c|%00/i.test(url.pathname)
  )
    throw new SourceError('SOURCE_MEDIA_UNAVAILABLE', 'LibriVox 返回了尚未验证的归档音频地址。')
  if (original) {
    const initial = new URL(librivoxMediaUrl(original))
    const initialIdentity = /^\/(?:download|\d+\/items)\/(.+)$/i.exec(initial.pathname)?.[1]
    if (identity !== initialIdentity)
      throw new SourceError('SOURCE_MEDIA_UNAVAILABLE', '归档重定向改变了音频文件。')
  }
  return url.href
}

interface Catalog {
  book: SourceBook
  episodes: SourceEpisode[]
  audio: Map<string, string>
  at: number
}
export class LibriVoxAdapter implements SourceAdapter {
  readonly id = 'librivox' as const
  private readonly catalogs = new Map<string, Catalog>()
  private readonly cursors = new Map<string, { query: string; offset: number; at: number }>()
  constructor(
    private readonly request: typeof fetch = (input, init) => globalThis.fetch(input, init),
    private readonly now = Date.now,
  ) {}
  private async read(
    parameters: Record<string, string>,
    signal?: AbortSignal,
    emptySearch = false,
  ): Promise<Row[]> {
    const deadline = AbortSignal.timeout(30000)
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
    const url = new URL(API)
    for (const [key, value] of Object.entries({ ...parameters, format: 'json' }))
      url.searchParams.set(key, value)
    try {
      const response = await this.request(url.href, {
        signal: combined,
        redirect: 'manual',
        headers: { Accept: 'application/json' },
      })
      if (combined.aborted) {
        await response.body?.cancel()
        combined.throwIfAborted()
      }
      if (![200, 404].includes(response.status) || !response.body) {
        await response.body?.cancel()
        throw new SourceError(
          'SOURCE_UNAVAILABLE',
          response.status === 429
            ? 'LibriVox 请求过于频繁，请稍后重试。'
            : 'LibriVox 暂不可用，请稍后重试。',
        )
      }
      const declared = Number(response.headers.get('content-length') ?? 0)
      if (declared > MAX_JSON_BYTES) {
        await response.body.cancel()
        throw new SourceError('SOURCE_CHANGED', 'LibriVox 目录超过读取上限。')
      }
      const chunks: Uint8Array[] = []
      let bytes = 0
      for await (const chunk of response.body) {
        bytes += chunk.byteLength
        if (bytes > MAX_JSON_BYTES)
          throw new SourceError('SOURCE_CHANGED', 'LibriVox 目录超过读取上限。')
        chunks.push(chunk)
      }
      const body = row(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      combined.throwIfAborted()
      if (response.status === 404 && body.error === 'Audiobooks could not be found') {
        if (emptySearch) return []
        throw new SourceError('SOURCE_UNAVAILABLE', 'LibriVox 未找到此书，可能已经移除。')
      }
      if (response.status !== 200 || !Array.isArray(body.books) || body.books.length > 500)
        throw new SourceError('SOURCE_CHANGED', 'LibriVox 返回的目录格式已变化。')
      return body.books.map(row)
    } catch (error) {
      if (signal?.aborted) throw new SourceError('SOURCE_CANCELED', 'LibriVox 请求已取消。')
      if (deadline.aborted) throw new SourceError('SOURCE_TIMEOUT', 'LibriVox 请求超时，请重试。')
      if (error instanceof SourceError) throw error
      throw new SourceError('SOURCE_UNAVAILABLE', '无法读取 LibriVox，请检查网络后重试。')
    }
  }
  private book(value: Row): SourceBook {
    const authors = value.authors
    if (!Array.isArray(authors) || authors.length > 100)
      throw new SourceError('SOURCE_CHANGED', 'LibriVox 作者信息无效。')
    return {
      sourceId: this.id,
      id: identifier(value.id),
      title: plain(text(value.title, 2000, true)).slice(0, 300),
      authors: authors
        .map((author) => {
          const a = row(author)
          return `${text(a.first_name ?? '', 200)} ${text(a.last_name ?? '', 200)}`.trim()
        })
        .filter(Boolean),
      narrators: [],
      description: plain(text(value.description ?? '', 100000)).slice(0, 2000),
      pageUrl: librivoxPageUrl(text(value.url_librivox, 4000, true)).href,
    }
  }
  async search(
    query: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<SourcePage<SourceBook>> {
    if (
      typeof query !== 'string' ||
      !query.trim() ||
      query.trim().length > SOURCE_QUERY_LIMITS.librivox
    )
      throw new SourceError('INVALID_SOURCE_REQUEST', '请输入 1–200 字的书名或关键词。')
    query = query.trim()
    let offset = 0
    if (cursor) {
      const remembered = this.cursors.get(cursor)
      if (!remembered || remembered.query !== query || this.now() - remembered.at > 300000)
        throw new SourceError('INVALID_SOURCE_REQUEST', '搜索分页已失效，请重新搜索。')
      offset = remembered.offset
    }
    const books = await this.read(
      { title: query, limit: String(PAGE_SIZE), offset: String(offset), sort_order: 'asc' },
      signal,
      true,
    )
    const items = books.map((book) => this.book(book))
    let nextCursor: string | null = null
    if (items.length === PAGE_SIZE && offset < 100000) {
      while (this.cursors.size >= 100) this.cursors.delete(this.cursors.keys().next().value!)
      nextCursor = randomUUID()
      this.cursors.set(nextCursor, { query, offset: offset + PAGE_SIZE, at: this.now() })
    }
    return { items, nextCursor }
  }
  private async catalog(id: string, signal?: AbortSignal, fresh = false): Promise<Catalog> {
    identifier(id)
    const cached = this.catalogs.get(id)
    if (!fresh && cached && this.now() - cached.at < 300000) {
      signal?.throwIfAborted()
      return cached
    }
    const records = await this.read({ id, extended: '1', limit: '1' }, signal)
    if (records.length !== 1 || records[0]!.id !== id)
      throw new SourceError('SOURCE_CHANGED', 'LibriVox 书籍身份已变化。')
    const value = records[0]!,
      book = this.book(value)
    if (
      !Array.isArray(value.sections) ||
      value.sections.length === 0 ||
      value.sections.length > 100000 ||
      Number(value.num_sections) !== value.sections.length
    )
      throw new SourceError('SOURCE_CHANGED', 'LibriVox 目录不完整，已保留原目录。')
    const sections = value.sections
      .map(row)
      .sort((a, b) => Number(a.section_number) - Number(b.section_number))
    const identities = new Set<string>(),
      orders = new Set<number>(),
      audio = new Map<string, string>(),
      narrators = new Set<string>()
    const episodes = sections.map((section, index): SourceEpisode => {
      const episodeId = identifier(section.id),
        order = Number(section.section_number)
      if (
        !Number.isSafeInteger(order) ||
        order < 0 ||
        identities.has(episodeId) ||
        orders.has(order)
      )
        throw new SourceError('SOURCE_CHANGED', 'LibriVox 目录顺序或分集身份异常。')
      identities.add(episodeId)
      orders.add(order)
      audio.set(episodeId, librivoxMediaUrl(text(section.listen_url, 16000, true)))
      if (!Array.isArray(section.readers) || section.readers.length > 100)
        throw new SourceError('SOURCE_CHANGED', 'LibriVox 朗读者信息无效。')
      for (const reader of section.readers) narrators.add(text(row(reader).display_name, 300, true))
      return {
        sourceId: this.id,
        bookId: id,
        id: episodeId,
        title: plain(text(section.title, 2000, true)).slice(0, 300),
        order: index + 1,
        pageUrl: book.pageUrl,
      }
    })
    // Numbering may start at zero (an introduction); a missing section must not become a complete catalog.
    const first = Number(sections[0]!.section_number)
    if (
      ![0, 1].includes(first) ||
      sections.some((section, index) => Number(section.section_number) !== first + index)
    )
      throw new SourceError('SOURCE_CHANGED', 'LibriVox 目录缺少分集，已保留原目录。')
    book.narrators = [...narrators].slice(0, 100)
    const result = { book, episodes, audio, at: this.now() }
    while (this.catalogs.size >= 10) this.catalogs.delete(this.catalogs.keys().next().value!)
    this.catalogs.set(id, result)
    return result
  }
  async getBook(id: string, signal?: AbortSignal) {
    return (await this.catalog(id, signal)).book
  }
  async getEpisodes(
    id: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<SourcePage<SourceEpisode>> {
    if (cursor) throw new SourceError('INVALID_SOURCE_REQUEST', 'LibriVox 完整目录无需分页。')
    return { items: (await this.catalog(id, signal)).episodes, nextCursor: null }
  }
  async resolveAudio(bookId: string, episodeId: string, signal?: AbortSignal) {
    identifier(episodeId)
    const catalog = await this.catalog(bookId, signal, true),
      url = catalog.audio.get(episodeId)
    if (!url) throw new SourceError('SOURCE_MEDIA_UNAVAILABLE', '此分集不属于所选 LibriVox 书籍。')
    return {
      sourceId: this.id,
      episodeId,
      url,
      pageUrl: catalog.book.pageUrl,
      headers: { Referer: catalog.book.pageUrl },
      expiresAt: null,
    }
  }
}
