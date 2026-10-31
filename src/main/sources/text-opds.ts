import { createHash } from 'node:crypto'
import { SourceError } from '../../shared/sources'
import type {
  TextBookDetail,
  TextBrowsePage,
  TextBrowseRequest,
  TextImportRequest,
} from '../../shared/text-sources'
import { MAX_TEXT_DOWNLOAD_BYTES } from './text-http'
import type { TextLibraryConnector, TextLibraryContext } from './text-provider'
import { childElements, childText, cleanText, textXml } from './text-xml'

const ACQUIRE = 'http://opds-spec.org/acquisition'
const OPDS_TYPES = ['application/atom+xml', 'application/opds+json']
const FORMATS: Record<string, 'epub' | 'txt'> = {
  'application/epub+zip': 'epub',
  'text/plain': 'txt',
}
interface InternalBook {
  detail: TextBookDetail
  urls: Map<string, string>
  detailUrl?: string
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const mime = (value: string) => value.split(';')[0]!.trim().toLowerCase()
const cursorFor = (url: string) => Buffer.from(url).toString('base64url')

function cursorUrl(cursor: string): string {
  if (cursor.length > 12_000 || !/^[\w-]+$/.test(cursor))
    throw new SourceError('INVALID_SOURCE_REQUEST', '书库分页标识无效。')
  return Buffer.from(cursor, 'base64url').toString('utf8')
}

function resolveOptional(context: TextLibraryContext, value: string, base: string): string | null {
  try {
    return context.http.resolve(value, base)
  } catch {
    return null
  }
}

export class OpdsTextConnector implements TextLibraryConnector {
  private books = new Map<string, InternalBook>()
  private searches = new Map<string, { href: string; type: string; base: string }>()

  private sourceKey(context: TextLibraryContext) {
    return `${context.connection.id}\0${context.connection.baseUrl}`
  }
  private key(source: string, work: string) {
    return `${source}\0${work}`
  }

  private remember(sourceId: string, book: InternalBook) {
    if (this.books.size >= 3000) this.books.delete(this.books.keys().next().value!)
    this.books.set(this.key(sourceId, book.detail.workId), book)
  }

  private parseAtom(context: TextLibraryContext, text: string, base: string): TextBrowsePage {
    const root = textXml(text).documentElement
    if (
      !['feed', 'entry'].includes(root.localName) ||
      root.namespaceURI !== 'http://www.w3.org/2005/Atom'
    )
      throw new SourceError('SOURCE_CHANGED', '该地址未返回 OPDS / Atom 书库。')
    const sourceId = context.connection.id
    const page: TextBrowsePage = {
      sourceId,
      books: [],
      navigation: [],
      nextCursor: null,
      searchable: false,
    }
    for (const link of childElements(root, 'link')) {
      const rel = link.getAttribute('rel') ?? ''
      const href = link.getAttribute('href') ?? ''
      const type = mime(link.getAttribute('type') ?? '')
      const url = resolveOptional(context, href, base)
      if (!url) continue
      if (rel === 'next') page.nextCursor = cursorFor(url)
      if (rel === 'search') this.searches.set(this.sourceKey(context), { href, type, base })
      if (
        [
          'subsection',
          'http://opds-spec.org/sort/new',
          'http://opds-spec.org/sort/popular',
        ].includes(rel)
      )
        page.navigation.push({
          title: cleanText(link.getAttribute('title') ?? '浏览分类'),
          cursor: cursorFor(url),
        })
    }
    const entries = root.localName === 'entry' ? [root] : childElements(root, 'entry')
    if (entries.length > 1000)
      throw new SourceError('SOURCE_CHANGED', '书库单页条目过多，请使用分页目录。')
    for (const entry of entries) {
      const title = childText(entry, 'title') || '未命名电子书'
      const entryId = childText(entry, 'id')
      const urls = new Map<string, string>()
      const acquisitions: TextBookDetail['acquisitions'] = []
      let navigation: string | null = null
      let detailUrl: string | undefined
      let pageUrl: string | null = null
      let coverUrl: string | null = null
      let restricted = false
      for (const link of childElements(entry, 'link')) {
        const rel = link.getAttribute('rel') ?? 'alternate'
        const rawType = link.getAttribute('type') ?? ''
        const type = mime(rawType)
        const href = resolveOptional(context, link.getAttribute('href') ?? '', base)
        if (!href) continue
        if (
          [
            'http://opds-spec.org/image/thumbnail',
            'http://opds-spec.org/image',
            'http://opds-spec.org/thumbnail',
            'http://opds-spec.org/cover',
          ].includes(rel) &&
          ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type)
        ) {
          if (!coverUrl || rel.endsWith('/thumbnail')) coverUrl = href
        }
        const format = FORMATS[type]
        if ((rel === ACQUIRE || rel === `${ACQUIRE}/open-access`) && format) {
          const id = digest(`${format}\0${href}`)
          urls.set(id, href)
          acquisitions.push({ id, format, label: format.toUpperCase() })
        } else if (rel.startsWith(`${ACQUIRE}/`)) restricted = true
        if (rel === 'alternate' && type === 'text/html') pageUrl = href
        if (OPDS_TYPES.includes(type)) {
          if (rel === 'alternate') detailUrl = href
          if (
            rel === 'subsection' ||
            (rel === 'alternate' && !/type\s*=\s*["']?entry/i.test(rawType))
          )
            navigation = href
        }
      }
      // Navigation feeds are represented as folders, never as downloadable publications.
      if (!acquisitions.length && navigation && !restricted) {
        page.navigation.push({ title, cursor: cursorFor(navigation) })
        continue
      }
      const workId = digest(entryId || detailUrl || `${base}\0${title}`)
      const detail: TextBookDetail = {
        sourceId,
        workId,
        title,
        author:
          childElements(entry, 'author')
            .map((author) => childText(author, 'name'))
            .filter(Boolean)
            .join('、') || null,
        description: childText(entry, 'summary') || childText(entry, 'content') || null,
        pageUrl,
        coverUrl,
        chapters: [],
        acquisitions,
        notice: restricted && !acquisitions.length ? '此条目需要购买或借阅，无法直接导入。' : null,
      }
      this.remember(this.sourceKey(context), { detail, urls, detailUrl })
      page.books.push(detail)
    }
    page.searchable = this.searches.has(this.sourceKey(context))
    return page
  }

  private async feed(context: TextLibraryContext, url: string): Promise<TextBrowsePage> {
    const response = await context.http.get(url, context.signal)
    if (!['application/atom+xml', 'application/xml', 'text/xml', ''].includes(response.contentType))
      throw new SourceError('SOURCE_CHANGED', '此版本支持 OPDS 1.x Atom 目录，请检查书库端点。')
    return this.parseAtom(context, response.bytes.toString('utf8'), response.url)
  }

  private async searchUrl(context: TextLibraryContext, query: string): Promise<string> {
    let search = this.searches.get(this.sourceKey(context))
    if (!search) {
      await this.feed(context, context.connection.baseUrl)
      search = this.searches.get(this.sourceKey(context))
    }
    if (!search)
      throw new SourceError('INVALID_SOURCE_REQUEST', '此书库没有提供搜索接口，请使用分类浏览。')
    let template = search.href
    let base = search.base
    if (search.type === 'application/opensearchdescription+xml') {
      const response = await context.http.get(context.http.resolve(template, base), context.signal)
      const doc = textXml(response.bytes.toString('utf8'))
      const url = Array.from(doc.getElementsByTagNameNS('*', 'Url')).find(
        (entry) => mime(entry.getAttribute('type') ?? '') === 'application/atom+xml',
      )
      template = url?.getAttribute('template') ?? ''
      base = response.url
    }
    if (!template || !/\{searchTerms\??\}|%7BsearchTerms(?:%3F)?%7D/i.test(template))
      throw new SourceError('SOURCE_CHANGED', '书库搜索模板缺少 searchTerms。')
    template = template
      .replace(/\{searchTerms\??\}|%7BsearchTerms(?:%3F)?%7D/gi, encodeURIComponent(query))
      .replace(/\{count\??\}/g, '20')
      .replace(/\{(?:startIndex|startPage)\??\}/g, '1')
      .replace(/\{[^}]+\??\}/g, '')
    return context.http.resolve(template, base)
  }

  async browse(context: TextLibraryContext, request: TextBrowseRequest): Promise<TextBrowsePage> {
    const url = request.cursor
      ? context.http.resolve(cursorUrl(request.cursor))
      : request.query?.trim()
        ? await this.searchUrl(context, request.query.trim())
        : context.connection.baseUrl
    return this.feed(context, url)
  }

  async detail(context: TextLibraryContext, workId: string): Promise<TextBookDetail> {
    let book = this.books.get(this.key(this.sourceKey(context), workId))
    if (!book) throw new SourceError('INVALID_SOURCE_REQUEST', '书目已过期，请重新浏览书库。')
    if (!book.detail.acquisitions.length && book.detailUrl) {
      await this.feed(context, book.detailUrl)
      book = this.books.get(this.key(this.sourceKey(context), workId)) ?? book
    }
    return book.detail
  }

  async download(context: TextLibraryContext, request: TextImportRequest) {
    await this.detail(context, request.workId)
    const book = this.books.get(this.key(this.sourceKey(context), request.workId))!
    const acquisition = book.detail.acquisitions.find((item) => item.id === request.acquisitionId)
    const url = acquisition && book.urls.get(acquisition.id)
    if (!acquisition || !url)
      throw new SourceError('INVALID_SOURCE_REQUEST', '请从详情选择可直接获取的 TXT 或 EPUB。')
    const response = await context.http.get(url, context.signal, {
      maxBytes: MAX_TEXT_DOWNLOAD_BYTES,
      accept: acquisition.format === 'epub' ? 'application/epub+zip' : 'text/plain',
    })
    const allowed =
      acquisition.format === 'epub'
        ? ['application/epub+zip', 'application/octet-stream', 'application/zip']
        : ['text/plain', 'application/octet-stream']
    if (!allowed.includes(response.contentType) || !response.bytes.length)
      throw new SourceError('SOURCE_CHANGED', '书库返回的文件格式与书目不符。')
    if (
      acquisition.format === 'epub' &&
      (response.bytes.length < 4 || response.bytes.readUInt16LE(0) !== 0x4b50)
    )
      throw new SourceError('SOURCE_CHANGED', '书库返回的内容不是 EPUB 文件。')
    return {
      bytes: response.bytes,
      filename: `${[...book.detail.title]
        .map((char) => (char.charCodeAt(0) < 32 ? '_' : char))
        .join('')
        .replace(/[<>:"/\\|?*]/g, '_')
        .slice(0, 120)}.${acquisition.format}`,
    }
  }
}
