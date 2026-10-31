import { randomUUID } from 'node:crypto'
import {
  SourceError,
  type SourceAdapter,
  type SourceBook,
  type SourceEpisode,
} from '../../shared/sources'
import type { Ting13Document } from './ting13-dom'

export const TING13_ORIGIN = 'https://www.ting13.cc'
export type Ting13Load =
  | { kind: 'search'; query: string }
  | { kind: 'page'; url: string; expect: 'search' | 'book' | 'episodes' | 'media' }
export interface Ting13Loader {
  read(request: Ting13Load, signal?: AbortSignal): Promise<Ting13Document>
}
export function sourcePageUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value, TING13_ORIGIN)
  } catch {
    throw new SourceError('INVALID_SOURCE_REQUEST', '无效的书源地址。')
  }
  if (
    url.origin !== TING13_ORIGIN ||
    url.username ||
    url.password ||
    url.hash ||
    value.length > 4000
  )
    throw new SourceError('INVALID_SOURCE_REQUEST', '书源地址不属于已选站点。')
  return url
}
export function sourceMediaUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new SourceError('SOURCE_MEDIA_UNAVAILABLE', '书源未返回可用音频。')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    value.length > 16000 ||
    !(
      url.hostname === 'www.ting13.cc' ||
      url.hostname === 'mp3nn.ysxs.top' ||
      url.hostname === 'kuwo.cn' ||
      url.hostname.endsWith('.kuwo.cn')
    )
  )
    throw new SourceError('SOURCE_MEDIA_UNAVAILABLE', '书源返回了尚未验证的音频服务地址。')
  return url.href
}
function bookId(value: string) {
  if (!/^[1-9]\d{0,8}$/.test(value))
    throw new SourceError('INVALID_SOURCE_REQUEST', '无效的书源书籍标识。')
  return value
}
function bounded(value: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new SourceError('SOURCE_CHANGED', '书源页面结构已变化，请稍后重试。')
  return value.trim()
}
function metadata(id: string, value: Omit<SourceBook, 'sourceId' | 'id' | 'pageUrl'>): SourceBook {
  if (
    ![value.authors, value.narrators].every(
      (list) =>
        Array.isArray(list) &&
        list.length <= 100 &&
        list.every((name) => typeof name === 'string' && name.length <= 200),
    )
  )
    throw new SourceError('SOURCE_CHANGED', '书源作者或演播信息无效。')
  if (typeof value.description !== 'string' || value.description.length > 2000)
    throw new SourceError('SOURCE_CHANGED', '书源简介信息无效。')
  return {
    sourceId: 'ting13',
    id,
    title: bounded(value.title, 300),
    authors: [...new Set(value.authors)],
    narrators: [...new Set(value.narrators)],
    description: value.description,
    pageUrl: `${TING13_ORIGIN}/youshengxiaoshuo/${id}/`,
    coverUrl: (() => {
      try {
        const url = value.coverUrl ? new URL(value.coverUrl, TING13_ORIGIN) : null
        return url &&
          ['https://www.ting13.cc', 'https://image.itingshu.net'].includes(url.origin) &&
          !url.username &&
          !url.password &&
          !url.hash
          ? url.href
          : null
      } catch {
        return null
      }
    })(),
  }
}

export class Ting13Adapter implements SourceAdapter {
  readonly id = 'ting13' as const
  private readonly directories = new Map<string, { url: string; at: number }>()
  private readonly cursors = new Map<string, { owner: string; url: string; at: number }>()
  constructor(
    private readonly loader: Ting13Loader,
    private readonly now = Date.now,
  ) {}
  private remember(owner: string, url: string) {
    while (this.cursors.size >= 100) this.cursors.delete(this.cursors.keys().next().value!)
    const token = randomUUID()
    this.cursors.set(token, { owner, url, at: this.now() })
    return token
  }
  private cursor(owner: string, token: string) {
    const value = this.cursors.get(token)
    if (!value || value.owner !== owner || this.now() - value.at > 300000)
      throw new SourceError('INVALID_SOURCE_REQUEST', '目录或搜索分页已失效，请重新打开。')
    return value.url
  }
  private next(document: Ting13Document, owner: string, kind: 'search' | 'episodes') {
    const current = sourcePageUrl(document.url)
    const page =
      kind === 'search'
        ? Number(/\/(\d+)\.html$/.exec(current.pathname)?.[1] ?? 1)
        : Number(current.searchParams.get('page') ?? 1)
    const next = document.pages.find((link) => {
      let candidate: URL
      try {
        candidate = sourcePageUrl(link.url)
      } catch {
        return false
      }
      if (kind === 'episodes')
        return (
          candidate.pathname === current.pathname &&
          candidate.searchParams.get('sort') === 'asc' &&
          Number(candidate.searchParams.get('page')) === page + 1
        )
      return (
        candidate.pathname.startsWith('/search/') &&
        /\/(\d+)\.html$/.exec(candidate.pathname)?.[1] === String(page + 1) &&
        (link.text === String(page + 1) || /下[一]?页/.test(link.text + link.title))
      )
    })
    return next ? this.remember(owner, sourcePageUrl(next.url).href) : null
  }
  async search(query: string, cursor?: string, signal?: AbortSignal) {
    if (typeof query !== 'string' || !query.trim() || query.trim().length > 20)
      throw new SourceError('INVALID_SOURCE_REQUEST', '请输入 1–20 字的书名、主播或作者。')
    query = query.trim()
    const owner = `search:${query}`
    const document = await this.loader.read(
      cursor
        ? { kind: 'page', url: this.cursor(owner, cursor), expect: 'search' }
        : { kind: 'search', query },
      signal,
    )
    sourcePageUrl(document.url)
    if (!document.title.includes('相关搜索结果'))
      throw new SourceError('SOURCE_CHANGED', '书源没有返回搜索结果页。')
    const seen = new Set<string>()
    const items = document.searchResults.map((card) => {
      const id = /^\/youshengxiaoshuo\/([1-9]\d{0,8})\/$/.exec(
        sourcePageUrl(card.url).pathname,
      )?.[1]
      if (!id || seen.has(id))
        throw new SourceError('SOURCE_CHANGED', '书源搜索结果缺少或重复书籍标识。')
      seen.add(id)
      return metadata(id, card)
    })
    return { items, nextCursor: this.next(document, owner, 'search') }
  }
  async getBook(id: string, signal?: AbortSignal) {
    bookId(id)
    const url = `${TING13_ORIGIN}/youshengxiaoshuo/${id}/`
    const document = await this.loader.read({ kind: 'page', url, expect: 'book' }, signal)
    if (sourcePageUrl(document.url).href !== url)
      throw new SourceError('SOURCE_CHANGED', '书源书籍页面发生了跳转。')
    const directory = sourcePageUrl(document.book.directory)
    if (!/^\/tingdirs\/[A-Za-z0-9]+\/[A-Za-z0-9]+\.html$/.test(directory.pathname))
      throw new SourceError('SOURCE_CHANGED', '书源缺少完整目录入口。')
    while (this.directories.size >= 100)
      this.directories.delete(this.directories.keys().next().value!)
    this.directories.set(id, { url: directory.href, at: this.now() })
    return metadata(id, document.book)
  }
  async getEpisodes(id: string, cursor?: string, signal?: AbortSignal) {
    bookId(id)
    const owner = `episodes:${id}`
    let url: string
    if (cursor) url = this.cursor(owner, cursor)
    else {
      const cached = this.directories.get(id)
      if (!cached || this.now() - cached.at > 300000) await this.getBook(id, signal)
      url = this.directories.get(id)!.url
    }
    const document = await this.loader.read({ kind: 'page', url, expect: 'episodes' }, signal)
    const current = sourcePageUrl(document.url)
    if (current.pathname !== sourcePageUrl(url).pathname)
      throw new SourceError('SOURCE_CHANGED', '书源目录页面发生了跳转。')
    const items: SourceEpisode[] = []
    const seen = new Set<string>(),
      orders = new Set<number>()
    for (const link of document.episodes) {
      const page = sourcePageUrl(link.url)
      const match = /^\/play\/([1-9]\d{0,8})_([1-9]\d{0,8})_([1-9]\d{0,8})\.html$/.exec(
        page.pathname,
      )
      const order = Number(/第(\d+)集$/.exec(link.title)?.[1])
      if (!match || match[1] !== id || !Number.isSafeInteger(order) || order <= 0)
        throw new SourceError('SOURCE_CHANGED', '书源目录的集数标识无效。')
      const episodeId = `${match[1]}_${match[2]}_${match[3]}`
      if (
        seen.has(episodeId) ||
        orders.has(order) ||
        (items.length && order <= items.at(-1)!.order)
      )
        throw new SourceError('SOURCE_CHANGED', '书源目录存在重复或非正序集数。')
      seen.add(episodeId)
      orders.add(order)
      items.push({
        sourceId: this.id,
        bookId: id,
        id: episodeId,
        title: bounded(link.text, 300),
        order,
        pageUrl: page.href,
      })
    }
    if (!items.length) throw new SourceError('SOURCE_CHANGED', '书源未返回播放目录。')
    return { items, nextCursor: this.next(document, owner, 'episodes') }
  }
  async resolveAudio(id: string, episodeId: string, signal?: AbortSignal) {
    bookId(id)
    if (!new RegExp(`^${id}_[1-9]\\d{0,8}_[1-9]\\d{0,8}$`).test(episodeId))
      throw new SourceError('INVALID_SOURCE_REQUEST', '播放集数不属于当前书籍。')
    const pageUrl = `${TING13_ORIGIN}/play/${episodeId}.html`
    const document = await this.loader.read({ kind: 'page', url: pageUrl, expect: 'media' }, signal)
    if (sourcePageUrl(document.url).href !== pageUrl || document.media.length !== 1)
      throw new SourceError('SOURCE_MEDIA_UNAVAILABLE', '书源未返回唯一可用音频。')
    return {
      sourceId: this.id,
      episodeId,
      url: sourceMediaUrl(document.media[0]!),
      pageUrl,
      headers: { Referer: pageUrl },
      expiresAt: null,
    }
  }
}
