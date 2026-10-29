import { SourceError } from '../../shared/sources'
import type { TextHttpResponse } from './text-http'

export function remoteRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SourceError('SOURCE_CHANGED', '书库返回的数据结构无效。')
  return value as Record<string, unknown>
}

export function remoteJson(response: TextHttpResponse): Record<string, unknown> {
  if (response.contentType !== 'application/json')
    throw new SourceError('SOURCE_CHANGED', '书库没有返回 JSON，请检查服务器地址。')
  try {
    return remoteRecord(JSON.parse(response.bytes.toString('utf8')))
  } catch {
    throw new SourceError('SOURCE_CHANGED', '书库返回的数据结构无效。')
  }
}

export function remoteText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.replace(/\p{Cc}/gu, '').slice(0, 4000) : fallback
}

export function ebookFormat(name: string): 'txt' | 'epub' | null {
  return /\.txt$/i.test(name) ? 'txt' : /\.epub$/i.test(name) ? 'epub' : null
}

export function ebookFilename(name: string, format: 'txt' | 'epub'): string {
  return `${
    name
      .replace(/\.(txt|epub)$/i, '')
      .replace(/[<>:"/\\|?*\p{Cc}]/gu, '_')
      .slice(0, 120) || '电子书'
  }.${format}`
}

export function checkEbookResponse(response: TextHttpResponse, format: 'txt' | 'epub') {
  const allowed =
    format === 'epub'
      ? ['application/epub+zip', 'application/zip', 'application/octet-stream']
      : ['text/plain', 'application/octet-stream']
  if (!allowed.includes(response.contentType) || !response.bytes.length)
    throw new SourceError('SOURCE_CHANGED', '书库未返回可阅读的电子书文件，请检查权限或文件格式。')
  if (format === 'epub' && (response.bytes.length < 4 || response.bytes.readUInt16LE(0) !== 0x4b50))
    throw new SourceError('SOURCE_CHANGED', '下载的文件不是有效的 EPUB。')
}

export function encodeLibraryCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

export function decodeLibraryCursor(value: string): Record<string, unknown> {
  try {
    if (value.length > 6000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error()
    return remoteRecord(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')))
  } catch {
    throw new SourceError('INVALID_SOURCE_REQUEST', '书库分页位置无效，请重新打开。')
  }
}
