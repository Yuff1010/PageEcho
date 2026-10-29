import { SourceError } from '../../shared/sources'
import type {
  TextBookDetail,
  TextBrowsePage,
  TextBrowseRequest,
  TextImportRequest,
} from '../../shared/text-sources'
import { TextHttpClient, MAX_TEXT_DOWNLOAD_BYTES } from './text-http'
import { cleanText, textXml } from './text-xml'

export const WIKISOURCE_URL = 'https://zh.wikisource.org/'
const API = `${WIKISOURCE_URL}w/api.php`
interface WikiParse {
  title: string
  pageid: number
  text: string
  links?: Array<{ ns: number; title: string; exists?: boolean }>
}

function excluded(element: Element): boolean {
  return (
    ['script', 'style', 'noscript'].includes(element.localName.toLowerCase()) ||
    ['headerContainer', 'toc', 'catlinks'].includes(element.getAttribute('id') ?? '') ||
    /(?:^|\s)(?:license\w*|licensetpl|noprint|navbox|metadata|ws-noexport|mw-editsection)(?:\s|$)/i.test(
      element.getAttribute('class') ?? '',
    )
  )
}

function wikiText(element: Element): string {
  let text = ''
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      text += node.nodeValue ?? ''
      return
    }
    if (node.nodeType !== 1) return
    const child = node as Element
    if (excluded(child)) return
    const block = /^(?:p|div|li|h[1-6]|pre|blockquote|tr|br)$/.test(child.localName)
    if (block) text += '\n'
    for (const item of Array.from(child.childNodes)) visit(item)
    if (block) text += '\n'
  }
  visit(element)
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n\n')
}

export class WikisourceTextSource {
  private http: TextHttpClient
  private details = new Map<string, TextBookDetail>()
  constructor(baseUrl = WIKISOURCE_URL) {
    // Custom endpoints are only injected by controlled tests; production uses the official API.
    this.http = new TextHttpClient({ baseUrl })
  }

  private async api(
    params: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const url = new URL('/w/api.php', this.http.base)
    url.search = new URLSearchParams({ format: 'json', formatversion: '2', ...params }).toString()
    const result = await this.http.get(url.href, signal, { accept: 'application/json' })
    if (result.contentType !== 'application/json')
      throw new SourceError('SOURCE_CHANGED', '维基文库未返回 API 数据，请稍后重试。')
    let data: Record<string, unknown>
    try {
      data = JSON.parse(result.bytes.toString('utf8')) as Record<string, unknown>
    } catch {
      throw new SourceError('SOURCE_CHANGED', '维基文库 API 响应无效。')
    }
    if (data.error)
      throw new SourceError('SOURCE_UNAVAILABLE', '维基文库无法获取该页面，可能已删除或移动。')
    return data
  }

  async browse(request: TextBrowseRequest, signal: AbortSignal): Promise<TextBrowsePage> {
    const query = request.query?.trim() || '三国演义'
    const offset = request.cursor ? Number(request.cursor) : 0
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000)
      throw new SourceError('INVALID_SOURCE_REQUEST', '维基文库分页标识无效。')
    const data = await this.api(
      {
        action: 'query',
        list: 'search',
        srsearch: query,
        srnamespace: '0',
        srlimit: '20',
        sroffset: String(offset),
      },
      signal,
    )
    const result = data.query as
      { search?: Array<{ pageid: number; title: string; snippet?: string }> } | undefined
    if (!Array.isArray(result?.search))
      throw new SourceError('SOURCE_CHANGED', '维基文库搜索格式已变化。')
    const next = data.continue as { sroffset?: number } | undefined
    return {
      sourceId: 'wikisource',
      books: result.search
        .filter((item) => Number.isSafeInteger(item.pageid) && typeof item.title === 'string')
        .map((item) => ({
          sourceId: 'wikisource',
          workId: String(item.pageid),
          title: item.title,
          description: cleanText(item.snippet ?? '') || null,
          author: null,
          pageUrl: `${WIKISOURCE_URL}wiki/${encodeURIComponent(item.title)}`,
        })),
      navigation: [],
      nextCursor: next?.sroffset === undefined ? null : String(next.sroffset),
      searchable: true,
    }
  }

  private async parse(params: Record<string, string>, signal: AbortSignal): Promise<WikiParse> {
    const result = (
      await this.api(
        {
          action: 'parse',
          prop: 'text|links',
          redirects: '1',
          ...params,
        },
        signal,
      )
    ).parse as WikiParse | undefined
    if (!result || typeof result.title !== 'string' || typeof result.text !== 'string')
      throw new SourceError('SOURCE_CHANGED', '维基文库页面内容格式已变化。')
    return result
  }

  async detail(workId: string, signal: AbortSignal): Promise<TextBookDetail> {
    if (!/^[1-9]\d{0,11}$/.test(workId))
      throw new SourceError('INVALID_SOURCE_REQUEST', '维基文库书目标识无效。')
    const parsed = await this.parse({ pageid: workId }, signal)
    const root = textXml(parsed.text, true).documentElement
    const titles = new Set(
      (parsed.links ?? []).filter((link) => link.ns === 0 && link.exists).map((link) => link.title),
    )
    const chapters = [{ id: `pageid:${workId}`, title: '本页正文' }]
    const seen = new Set<string>()
    const walk = (element: Element, inCatalog: boolean) => {
      if (excluded(element)) return
      const catalog = inCatalog || ['ul', 'ol', 'table'].includes(element.localName)
      if (element.localName === 'a' && catalog) {
        const title = element.getAttribute('title') ?? ''
        const href = element.getAttribute('href') ?? ''
        if (
          titles.has(title) &&
          !seen.has(title) &&
          href.startsWith('/wiki/') &&
          chapters.length < 1001
        ) {
          seen.add(title)
          chapters.push({
            id: `title:${title}`,
            title: cleanText(element.textContent ?? title, 250) || title,
          })
        }
      }
      for (const child of Array.from(element.childNodes))
        if (child.nodeType === 1) walk(child as Element, catalog)
    }
    walk(root, false)
    const detail: TextBookDetail = {
      sourceId: 'wikisource',
      workId,
      title: parsed.title,
      author: null,
      description: null,
      pageUrl: `${WIKISOURCE_URL}wiki/${encodeURIComponent(parsed.title)}`,
      chapters,
      acquisitions: [],
      notice:
        '目录仅列出当前页面中的章节链接，不代表全书完整目录。选择本次需要的章节（最多 20 项）；仅在导入时获取所选正文。来源署名及权利信息以维基文库原页面为准。',
    }
    if (this.details.size >= 500) this.details.delete(this.details.keys().next().value!)
    this.details.set(workId, detail)
    return detail
  }

  async download(request: TextImportRequest, signal: AbortSignal) {
    const detail = this.details.get(request.workId) ?? (await this.detail(request.workId, signal))
    const selected = new Set(request.chapterIds)
    if (!selected.size || selected.size > 20 || selected.size !== request.chapterIds?.length)
      throw new SourceError('INVALID_SOURCE_REQUEST', '请选择 1 至 20 个不重复的章节。')
    const chapters = detail.chapters.filter((chapter) => selected.has(chapter.id))
    if (chapters.length !== selected.size)
      throw new SourceError('INVALID_SOURCE_REQUEST', '所选章节不在当前目录中，请重新选择。')
    const pieces: string[] = []
    for (const [index, chapter] of chapters.entries()) {
      signal.throwIfAborted()
      const parsed = await this.parse(
        chapter.id.startsWith('pageid:')
          ? { pageid: chapter.id.slice(7) }
          : { page: chapter.id.slice(6) },
        signal,
      )
      const text = wikiText(textXml(parsed.text, true).documentElement)
      if (text.length < 10)
        throw new SourceError('SOURCE_CHANGED', `章节“${chapter.title}”没有可读取的正文。`)
      pieces.push(`第${index + 1}章 ${chapter.title}\n\n${text}`)
      if (Buffer.byteLength(pieces.join('\n\n'), 'utf8') > MAX_TEXT_DOWNLOAD_BYTES - 2000)
        throw new SourceError('SOURCE_UNAVAILABLE', '所选正文超过 32 MiB，请减少章节数量。')
    }
    pieces.push(
      `来源：中文维基文库\n${detail.pageUrl}\n仅导入本次选择的 ${chapters.length} 项。署名及权利信息请查看上述原页面。`,
    )
    return {
      bytes: Buffer.from(pieces.join('\n\n'), 'utf8'),
      filename: `${[...detail.title]
        .map((char) => (char.charCodeAt(0) < 32 ? '_' : char))
        .join('')
        .replace(/[<>:"/\\|?*]/g, '_')
        .slice(0, 100)}（选${chapters.length}项）.txt`,
    }
  }
}

export const WIKISOURCE_API_URL = API
