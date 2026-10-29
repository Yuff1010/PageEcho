import { DOMParser } from '@xmldom/xmldom'
import { SourceError } from '../../shared/sources'
import type {
  TextBookDetail,
  TextBrowseRequest,
  TextImportRequest,
} from '../../shared/text-sources'
import { MAX_TEXT_DOWNLOAD_BYTES, TextHttpClient } from './text-http'
import type { TextLibraryConnector, TextLibraryContext } from './text-provider'
import {
  checkEbookResponse,
  decodeLibraryCursor,
  ebookFilename,
  ebookFormat,
  encodeLibraryCursor,
} from './remote-library-utils'

const DAV = 'DAV:'
const PAGE_SIZE = 80
const PROPS =
  '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>'

/** A WebDAV connection grants read access only to its configured directory. */
export function webdavUrl(context: TextLibraryContext, value: string): URL {
  const root = new URL(context.connection.baseUrl)
  root.pathname = root.pathname.replace(/\/?$/, '/')
  const url = new URL(context.http.resolve(value, root.href))
  assertDirectory(root, url)
  return url
}

function assertDirectory(root: URL, url: URL) {
  let path: string, rootPath: string
  try {
    path = decodeURIComponent(url.pathname)
    rootPath = decodeURIComponent(root.pathname)
  } catch {
    throw new SourceError('INVALID_SOURCE_REQUEST', 'WebDAV 路径编码无效。')
  }
  if (
    url.search ||
    url.hash ||
    /[\\\p{Cc}]/u.test(path) ||
    /%(?:2e|2f|5c|00)/i.test(path) ||
    path.split('/').some((part) => part === '.' || part === '..') ||
    !(path === rootPath.slice(0, -1) || path.startsWith(rootPath))
  )
    throw new SourceError('INVALID_SOURCE_REQUEST', 'WebDAV 链接超出配置目录。')
}

function scoped(context: TextLibraryContext): TextLibraryContext {
  const root = new URL(context.connection.baseUrl)
  root.pathname = root.pathname.replace(/\/?$/, '/')
  return {
    ...context,
    http: new TextHttpClient({
      ...context.connection,
      validateUrl: (url) => assertDirectory(root, url),
    }),
  }
}

interface DavEntry {
  url: string
  title: string
  directory: boolean
}

async function entries(context: TextLibraryContext, target: string): Promise<DavEntry[]> {
  context = scoped(context)
  const requested = webdavUrl(context, target)
  const response = await context.http.get(requested.href, context.signal, {
    method: 'PROPFIND',
    body: PROPS,
  })
  webdavUrl(context, response.url)
  const xml = response.bytes.toString('utf8')
  if (
    !['application/xml', 'text/xml'].includes(response.contentType) ||
    /<!DOCTYPE|<!ENTITY/i.test(xml)
  )
    throw new SourceError('SOURCE_CHANGED', 'WebDAV 未返回有效目录。')
  let failed = false
  const doc = new DOMParser({
    errorHandler: {
      warning: () => {},
      error: () => {
        failed = true
      },
      fatalError: () => {
        failed = true
      },
    },
  }).parseFromString(xml, 'application/xml')
  if (
    failed ||
    doc.documentElement?.localName !== 'multistatus' ||
    doc.documentElement.namespaceURI !== DAV
  )
    throw new SourceError('SOURCE_CHANGED', 'WebDAV 目录格式无效。')
  const records = Array.from(doc.getElementsByTagNameNS(DAV, 'response'))
  if (records.length > 5000)
    throw new SourceError('SOURCE_CHANGED', 'WebDAV 单层目录超过 5000 项，请按文件夹整理。')
  const result: DavEntry[] = []
  for (const item of records) {
    const href = item.getElementsByTagNameNS(DAV, 'href')[0]?.textContent?.trim()
    if (!href) continue
    const url = webdavUrl(context, new URL(href, response.url).href)
    const stat = Array.from(item.getElementsByTagNameNS(DAV, 'propstat')).find((part) =>
      /\s200\s/.test(part.getElementsByTagNameNS(DAV, 'status')[0]?.textContent ?? ''),
    )
    if (!stat) continue
    const title =
      stat.getElementsByTagNameNS(DAV, 'displayname')[0]?.textContent?.trim() ||
      decodeURIComponent(url.pathname.replace(/\/$/, '').split('/').at(-1) ?? '')
    const directory = stat.getElementsByTagNameNS(DAV, 'collection').length > 0
    // Depth:1 servers must not inject deeper descendants as siblings.
    const parent = new URL('./', url.href.replace(/\/$/, '')).pathname
    if (
      url.pathname.replace(/\/$/, '') !== requested.pathname.replace(/\/$/, '') &&
      parent !== requested.pathname.replace(/\/?$/, '/')
    )
      continue
    result.push({ url: url.href, title: title.slice(0, 400), directory })
  }
  return [...new Map(result.map((entry) => [entry.url, entry])).values()]
}

export class WebdavLibraryConnector implements TextLibraryConnector {
  async browse(context: TextLibraryContext, request: TextBrowseRequest) {
    const cursor = request.cursor ? decodeLibraryCursor(request.cursor) : {}
    const url = webdavUrl(
      context,
      typeof cursor.url === 'string' ? cursor.url : context.connection.baseUrl,
    )
    url.pathname = url.pathname.replace(/\/?$/, '/')
    const offset = cursor.offset ?? 0
    if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 5000)
      throw new SourceError('INVALID_SOURCE_REQUEST', 'WebDAV 分页位置无效。')
    const all = await entries(context, url.href)
    const query = request.query?.trim().toLocaleLowerCase() ?? ''
    const visible = all.filter(
      (entry) =>
        entry.url.replace(/\/$/, '') !== url.href.replace(/\/$/, '') &&
        (!query || entry.title.toLocaleLowerCase().includes(query)),
    )
    const files = visible.filter(
      (entry) => !entry.directory && ebookFormat(new URL(entry.url).pathname),
    )
    const root = webdavUrl(context, context.connection.baseUrl)
    const navigation = visible
      .filter((entry) => entry.directory)
      .map((entry) => ({ title: entry.title, cursor: encodeLibraryCursor({ url: entry.url }) }))
    if (url.pathname.replace(/\/$/, '') !== root.pathname.replace(/\/$/, ''))
      navigation.unshift({
        title: '上一级',
        cursor: encodeLibraryCursor({ url: webdavUrl(context, new URL('../', url).href).href }),
      })
    return {
      sourceId: request.sourceId,
      books: files.slice(Number(offset), Number(offset) + PAGE_SIZE).map((file) => ({
        sourceId: request.sourceId,
        workId: file.url,
        title: file.title,
        author: null,
        description: null,
        pageUrl: null,
      })),
      navigation,
      nextCursor:
        Number(offset) + PAGE_SIZE < files.length
          ? encodeLibraryCursor({ url: url.href, offset: Number(offset) + PAGE_SIZE })
          : null,
      searchable: true,
    }
  }

  async detail(context: TextLibraryContext, workId: string): Promise<TextBookDetail> {
    const url = webdavUrl(context, workId)
    const file = (await entries(context, url.href)).find(
      (entry) => !entry.directory && entry.url === url.href,
    )
    const format = ebookFormat(url.pathname)
    if (!file || !format)
      throw new SourceError('SOURCE_CHANGED', 'WebDAV 文件已移除或不是 TXT／EPUB。')
    return {
      sourceId: context.connection.id,
      workId,
      title: file.title,
      author: null,
      description: null,
      pageUrl: null,
      chapters: [],
      acquisitions: [{ id: url.href, format, label: format.toUpperCase() }],
      notice: null,
    }
  }

  async download(context: TextLibraryContext, request: TextImportRequest) {
    context = scoped(context)
    const detail = await this.detail(context, request.workId)
    const acquisition = detail.acquisitions.find((item) => item.id === request.acquisitionId)
    if (!acquisition) throw new SourceError('INVALID_SOURCE_REQUEST', '请选择此文件的可用格式。')
    const response = await context.http.get(acquisition.id, context.signal, {
      maxBytes: MAX_TEXT_DOWNLOAD_BYTES,
      accept: acquisition.format === 'epub' ? 'application/epub+zip' : 'text/plain',
    })
    webdavUrl(context, response.url)
    checkEbookResponse(response, acquisition.format)
    return { bytes: response.bytes, filename: ebookFilename(detail.title, acquisition.format) }
  }
}
