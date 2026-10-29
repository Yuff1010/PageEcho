import { SourceError } from '../../shared/sources'
import type {
  TextBookDetail,
  TextBrowseRequest,
  TextImportRequest,
} from '../../shared/text-sources'
import { MAX_TEXT_DOWNLOAD_BYTES } from './text-http'
import type { TextLibraryConnector, TextLibraryContext } from './text-provider'
import {
  checkEbookResponse,
  decodeLibraryCursor,
  ebookFilename,
  ebookFormat,
  encodeLibraryCursor,
  remoteJson,
  remoteRecord,
  remoteText,
} from './remote-library-utils'

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w-]{1,160}$/.test(value))
    throw new SourceError('INVALID_SOURCE_REQUEST', 'Audiobookshelf 资源编号无效。')
  return value
}

function apiUrl(context: TextLibraryContext, path: string): string {
  const base = new URL(context.connection.baseUrl)
  base.pathname = base.pathname.replace(/\/?$/, '/')
  base.search = ''
  return context.http.resolve(`api/${path}`, base.href)
}

async function json(context: TextLibraryContext, path: string) {
  return remoteJson(
    await context.http.get(apiUrl(context, path), context.signal, { accept: 'application/json' }),
  )
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 5000)
    throw new SourceError('SOURCE_CHANGED', 'Audiobookshelf 返回的列表无效或过长。')
  return value
}

function summary(context: TextLibraryContext, value: unknown) {
  const item = remoteRecord(value)
  const media = remoteRecord(item.media)
  const metadata = remoteRecord(media.metadata)
  return {
    sourceId: context.connection.id,
    workId: identifier(item.id),
    title: remoteText(metadata.title, '未命名电子书'),
    author:
      remoteText(metadata.authorName) ||
      (Array.isArray(metadata.authors)
        ? metadata.authors
            .map((entry) => remoteText(remoteRecord(entry).name))
            .filter(Boolean)
            .join('、')
        : '') ||
      null,
    description: remoteText(metadata.description).replace(/<[^>]*>/g, '') || null,
    pageUrl: null,
  }
}

/** Reads ebook files only. It does not create or modify Audiobookshelf playback sessions. */
export class AudiobookshelfLibraryConnector implements TextLibraryConnector {
  async browse(context: TextLibraryContext, request: TextBrowseRequest) {
    const cursor = request.cursor ? decodeLibraryCursor(request.cursor) : {}
    if (cursor.libraryId === undefined) {
      const data = await json(context, 'libraries')
      const libraries = array(data.libraries)
        .map(remoteRecord)
        .filter((library) => library.mediaType === 'book')
      return {
        sourceId: request.sourceId,
        books: [],
        navigation: libraries.map((library) => ({
          title: remoteText(library.name, '书库'),
          cursor: encodeLibraryCursor({ libraryId: identifier(library.id), page: 0 }),
        })),
        nextCursor: null,
        searchable: false,
      }
    }
    const libraryId = identifier(cursor.libraryId)
    const page = cursor.page ?? 0
    if (!Number.isSafeInteger(page) || Number(page) < 0 || Number(page) > 100000)
      throw new SourceError('INVALID_SOURCE_REQUEST', 'Audiobookshelf 分页位置无效。')
    const query = request.query?.trim() ?? ''
    const data = await json(
      context,
      query
        ? `libraries/${libraryId}/search?${new URLSearchParams({ q: query, limit: '50' })}`
        : `libraries/${libraryId}/items?${new URLSearchParams({ limit: '50', page: String(page), minified: '0', sort: 'media.metadata.title' })}`,
    )
    const items = query
      ? array(data.book).map((value) => remoteRecord(value).libraryItem)
      : array(data.results)
    const books = items
      .filter((value) => {
        const item = remoteRecord(value)
        const media = remoteRecord(item.media)
        const file =
          media.ebookFile && typeof media.ebookFile === 'object'
            ? remoteRecord(media.ebookFile)
            : null
        const format = remoteText(file?.ebookFormat || media.ebookFileFormat).toLowerCase()
        // Unsupported formats and audio-only results remain on their server.
        return ['txt', 'epub'].includes(format)
      })
      .map((item) => summary(context, item))
    const total = Number(data.total)
    return {
      sourceId: request.sourceId,
      books,
      navigation: [{ title: '全部书库', cursor: encodeLibraryCursor({}) }],
      nextCursor:
        !query && Number.isSafeInteger(total) && (Number(page) + 1) * 50 < total
          ? encodeLibraryCursor({ libraryId, page: Number(page) + 1 })
          : null,
      searchable: true,
    }
  }

  async detail(context: TextLibraryContext, workId: string): Promise<TextBookDetail> {
    const id = identifier(workId)
    const data = await json(context, `items/${id}?expanded=1`)
    if (data.id !== id) throw new SourceError('SOURCE_CHANGED', 'Audiobookshelf 返回了不同的书籍。')
    const media = remoteRecord(data.media)
    const file =
      media.ebookFile && typeof media.ebookFile === 'object' ? remoteRecord(media.ebookFile) : null
    const metadata =
      file?.metadata && typeof file.metadata === 'object' ? remoteRecord(file.metadata) : null
    const formatName = remoteText(file?.ebookFormat).toLowerCase()
    const format =
      formatName === 'epub' || formatName === 'txt'
        ? formatName
        : ebookFormat(remoteText(metadata?.filename))
    return {
      ...summary(context, data),
      chapters: [],
      acquisitions:
        file && format ? [{ id: `primary:${format}`, format, label: format.toUpperCase() }] : [],
      notice: file && format ? null : '此书没有可导入的 TXT／EPUB 主电子书。',
    }
  }

  async download(context: TextLibraryContext, request: TextImportRequest) {
    const detail = await this.detail(context, request.workId)
    const acquisition = detail.acquisitions.find((item) => item.id === request.acquisitionId)
    if (!acquisition)
      throw new SourceError('INVALID_SOURCE_REQUEST', '请选择此书的可用电子书格式。')
    const response = await context.http.get(
      apiUrl(context, `items/${identifier(request.workId)}/ebook`),
      context.signal,
      {
        maxBytes: MAX_TEXT_DOWNLOAD_BYTES,
        accept: acquisition.format === 'epub' ? 'application/epub+zip' : 'text/plain',
      },
    )
    checkEbookResponse(response, acquisition.format)
    return { bytes: response.bytes, filename: ebookFilename(detail.title, acquisition.format) }
  }
}
