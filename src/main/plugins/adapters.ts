import type { PluginSourceInfo } from '../../shared/plugins'
import {
  SourceError,
  type ResolvedSourceAudio,
  type SourceAdapter,
  type SourceBook,
  type SourceEpisode,
  type SourceId,
  type SourcePage,
} from '../../shared/sources'
import type {
  TextBookDetail,
  TextBookSummary,
  TextBrowsePage,
  TextChapter,
} from '../../shared/text-sources'
import type { PluginMethod } from './runtime-types'
import { invalidPlugin, pluginObject, pluginResourceId, pluginString, pluginUrl } from './manifest'

export type PluginCall = (
  method: PluginMethod,
  args: unknown[],
  signal: AbortSignal,
) => Promise<unknown>

const activeSignal = (signal?: AbortSignal) => signal ?? AbortSignal.timeout(30_000)

function plain(value: unknown, maximum: number, empty = false): string {
  if (
    typeof value !== 'string' ||
    value.length > maximum ||
    (!empty && !value.trim()) ||
    /[^\P{Cc}\t\n\r]/u.test(value)
  )
    return invalidPlugin('插件文字内容无效或超过限制。')
  return value
}

function labels(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 40) return invalidPlugin('插件作者／演播者列表无效。')
  return value.map((item) => pluginString(item, 200))
}

export function pluginPageUrl(source: PluginSourceInfo, value: unknown): URL {
  const url = pluginUrl(value)
  if (!source.allowedOrigins.includes(url.origin))
    return invalidPlugin('插件页面地址超出已批准域名。')
  return url
}

export function pluginMediaUrl(source: PluginSourceInfo, value: unknown): string {
  // Temporary signed media URLs remain in memory and never become library identity.
  const url = pluginUrl(value, true)
  if (!source.mediaOrigins.includes(url.origin))
    throw new SourceError('SOURCE_MEDIA_UNAVAILABLE', '插件音频地址超出已批准媒体域名。')
  return url.href
}

export function pluginCoverUrl(source: PluginSourceInfo, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  try {
    const url = pluginUrl(value, true)
    return (source.coverOrigins ?? source.allowedOrigins).includes(url.origin) ? url.href : null
  } catch {
    return null
  }
}

export function pluginBook(
  source: PluginSourceInfo,
  value: unknown,
  expectedId?: string,
): SourceBook {
  const book = pluginObject(value)
  const id = pluginResourceId(book.id)
  if (expectedId !== undefined && id !== expectedId)
    return invalidPlugin('插件返回了不同的书籍 ID。')
  return {
    sourceId: source.id as SourceId,
    id,
    title: pluginString(book.title, 500),
    authors: labels(book.authors ?? (typeof book.author === 'string' ? [book.author] : undefined)),
    narrators: labels(book.narrators),
    description: plain(book.description ?? '', 20_000, true),
    pageUrl: pluginPageUrl(source, book.pageUrl ?? source.baseUrl).href,
    coverUrl: pluginCoverUrl(source, book.coverUrl),
  }
}

export function pluginPage<T>(value: unknown, parse: (item: unknown) => T): SourcePage<T> {
  const page = pluginObject(value)
  if (!Array.isArray(page.items) || page.items.length > 1000)
    return invalidPlugin('插件单页条目数量无效或超过 1000 项。')
  const nextCursor =
    page.nextCursor === null || page.nextCursor === undefined
      ? null
      : pluginString(page.nextCursor, 2048)
  return { items: page.items.map(parse), nextCursor }
}

function unique<T>(items: T[], key: (item: T) => string) {
  if (new Set(items.map(key)).size !== items.length) return invalidPlugin('插件目录含重复资源 ID。')
  return items
}

export function pluginEpisodes(
  source: PluginSourceInfo,
  bookId: string,
  value: unknown,
): SourcePage<SourceEpisode> {
  const result = pluginPage(value, (value) => {
    const episode = pluginObject(value)
    if (episode.bookId !== undefined && episode.bookId !== bookId)
      return invalidPlugin('插件返回了其他书籍的章节。')
    if (
      !Number.isSafeInteger(episode.order) ||
      Number(episode.order) < 0 ||
      Number(episode.order) > 100000
    )
      return invalidPlugin('插件章节序号无效。')
    return {
      sourceId: source.id as SourceId,
      bookId,
      id: pluginResourceId(episode.id),
      title: pluginString(episode.title, 500),
      order: Number(episode.order),
      pageUrl: pluginPageUrl(source, episode.pageUrl ?? source.baseUrl).href,
    }
  })
  unique(result.items, (episode) => episode.id)
  if (
    result.items.some(
      (episode, index) => index > 0 && episode.order <= result.items[index - 1]!.order,
    )
  )
    return invalidPlugin('插件章节顺序重复或倒置。')
  return result
}

export function pluginChapters(value: unknown): SourcePage<TextChapter> {
  const page = pluginPage(value, (value) => {
    const chapter = pluginObject(value)
    return { id: pluginResourceId(chapter.id), title: pluginString(chapter.title, 500) }
  })
  unique(page.items, (chapter) => chapter.id)
  return page
}

export function pluginTextSummary(
  source: PluginSourceInfo,
  value: unknown,
  expectedId?: string,
): TextBookSummary {
  const book = pluginBook(source, value, expectedId)
  return {
    sourceId: source.id,
    workId: book.id,
    title: book.title,
    author: book.authors.join('、') || null,
    description: book.description || null,
    pageUrl: book.pageUrl,
    coverUrl: book.coverUrl,
  }
}

export function pluginAudioAdapter(source: PluginSourceInfo, call: PluginCall): SourceAdapter {
  return {
    id: source.id as SourceId,
    urlPolicy: {
      mediaUrl: (value) => pluginMediaUrl(source, value),
      pageUrl: (value) => pluginPageUrl(source, value),
    },
    search: async (query, cursor, signal) => {
      if (!query.trim() || query.trim().length > 200)
        return invalidPlugin('请输入 1–200 字的搜索内容。')
      const page = pluginPage(
        await call('search', [query.trim(), cursor ?? null], activeSignal(signal)),
        (value) => pluginBook(source, value),
      )
      unique(page.items, (book) => book.id)
      return page
    },
    getBook: async (id, signal) =>
      pluginBook(source, await call('getBook', [pluginResourceId(id)], activeSignal(signal)), id),
    getEpisodes: async (bookId, cursor, signal) =>
      pluginEpisodes(
        source,
        bookId,
        await call('getEpisodes', [pluginResourceId(bookId), cursor ?? null], activeSignal(signal)),
      ),
    resolveAudio: async (bookId, episodeId, signal): Promise<ResolvedSourceAudio> => {
      const value = await call(
        'resolveAudio',
        [pluginResourceId(bookId), pluginResourceId(episodeId)],
        activeSignal(signal),
      )
      const result = typeof value === 'string' ? { url: value } : pluginObject(value)
      const url = pluginMediaUrl(source, result.url)
      const pageUrl = pluginPageUrl(source, result.pageUrl ?? source.baseUrl).href
      const headers: Record<string, string> & { Referer: string } = { Referer: pageUrl }
      if (result.headers !== undefined) {
        const extra = pluginObject(result.headers)
        if (Object.keys(extra).length > 4) return invalidPlugin('插件音频请求头过多。')
        for (const [key, raw] of Object.entries(extra)) {
          const canonical = (
            {
              referer: 'Referer',
              'user-agent': 'User-Agent',
              origin: 'Origin',
              accept: 'Accept',
            } as Record<string, string>
          )[key.toLowerCase()]
          if (!canonical) return invalidPlugin('插件音频请求头包含未允许的字段。')
          const value = pluginString(raw, 2000)
          if (canonical === 'Referer') pluginPageUrl(source, value)
          if (
            canonical === 'Origin' &&
            (!source.allowedOrigins.includes(value) || new URL(value).origin !== value)
          )
            return invalidPlugin('插件 Origin 请求头无效。')
          headers[canonical] = value
        }
      }
      if (
        result.expiresAt !== undefined &&
        result.expiresAt !== null &&
        (!Number.isSafeInteger(result.expiresAt) || Number(result.expiresAt) < Date.now())
      )
        return invalidPlugin('插件返回了无效或已过期的音频地址。')
      return {
        sourceId: source.id as SourceId,
        episodeId,
        url,
        pageUrl,
        headers,
        expiresAt:
          result.expiresAt === undefined || result.expiresAt === null
            ? null
            : Number(result.expiresAt),
      }
    },
  }
}

export function textBrowsePage(source: PluginSourceInfo, value: unknown): TextBrowsePage {
  const page = pluginPage(value, (book) => pluginTextSummary(source, book))
  unique(page.items, (book) => book.workId)
  return {
    sourceId: source.id,
    books: page.items,
    navigation: [],
    nextCursor: page.nextCursor,
    searchable: true,
  }
}

export function textBookDetail(
  source: PluginSourceInfo,
  book: unknown,
  chapters: TextChapter[],
  complete: boolean,
): TextBookDetail {
  return {
    ...pluginTextSummary(source, book),
    chapters,
    acquisitions: [],
    notice: complete
      ? null
      : '这里只显示已读取目录；插件还有后续目录页。请选择本次要导入的章节，最多 20 项。',
  }
}

export function chapterBody(value: unknown): string {
  const body = plain(value, 2 * 1024 * 1024)
  if (Buffer.byteLength(body, 'utf8') > 4 * 1024 * 1024)
    return invalidPlugin('单章正文超过 4 MiB，请缩小章节范围。')
  return body
}
