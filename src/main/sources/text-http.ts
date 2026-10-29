import { SourceError } from '../../shared/sources'

export const MAX_TEXT_DOWNLOAD_BYTES = 32 * 1024 * 1024
export const MAX_TEXT_FEED_BYTES = 2 * 1024 * 1024

export function sourceUrl(value: string, base?: string): URL {
  let url: URL
  try {
    url = new URL(value, base)
  } catch {
    throw new SourceError('INVALID_SOURCE_REQUEST', '书库地址无效，请使用 HTTP 或 HTTPS 地址。')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new SourceError('INVALID_SOURCE_REQUEST', '书库地址不可包含凭据、脚本或片段。')
  return url
}

export interface TextHttpOptions {
  baseUrl: string
  username?: string
  password?: string
  token?: string
  timeoutMs?: number
  validateUrl?: (url: URL) => void
}

export interface TextHttpResponse {
  bytes: Buffer
  contentType: string
  url: string
}

/** Every request, redirect and credential is bound to the explicitly configured origin. */
export class TextHttpClient {
  readonly base: URL
  constructor(private options: TextHttpOptions) {
    this.base = sourceUrl(options.baseUrl)
  }

  resolve(value: string, base = this.base.href): string {
    const url = sourceUrl(value, base)
    if (url.origin !== this.base.origin)
      throw new SourceError('INVALID_SOURCE_REQUEST', '链接超出当前书库域名，请单独配置该书库。')
    this.options.validateUrl?.(url)
    return url.href
  }

  async get(
    value: string,
    signal: AbortSignal,
    options: {
      maxBytes?: number
      accept?: string
      method?: 'GET' | 'PROPFIND'
      body?: string
    } = {},
  ): Promise<TextHttpResponse> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 20_000)
    const combined = AbortSignal.any([signal, timeout])
    let url = this.resolve(value)
    const headers: Record<string, string> = {
      Accept: options.accept ?? 'application/atom+xml, application/xml, text/xml',
      'User-Agent': 'ReadAndListenBook/0.32 (personal ebook reader)',
    }
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`
    else if (this.options.username || this.options.password)
      headers.Authorization = `Basic ${Buffer.from(`${this.options.username ?? ''}:${this.options.password ?? ''}`).toString('base64')}`
    if (options.method === 'PROPFIND') {
      headers.Depth = '1'
      headers['Content-Type'] = 'application/xml; charset=utf-8'
    }
    try {
      for (let redirects = 0; redirects <= 4; redirects++) {
        const response = await fetch(url, {
          method: options.method ?? 'GET',
          headers,
          signal: combined,
          redirect: 'manual',
          ...(options.body === undefined ? {} : { body: options.body }),
        })
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location')
          await response.body?.cancel()
          if (!location || redirects === 4)
            throw new SourceError('SOURCE_UNAVAILABLE', '书库重定向过多或缺少目标。')
          url = this.resolve(location, url)
          continue
        }
        const completeStatus =
          options.method === 'PROPFIND' ? response.status === 207 : response.status === 200
        if (!completeStatus || response.headers.has('content-range')) {
          await response.body?.cancel()
          throw new SourceError(
            'SOURCE_UNAVAILABLE',
            response.status === 401 || response.status === 403
              ? '书库拒绝访问，请检查连接凭据和访问权限。'
              : `书库请求失败（HTTP ${response.status}）。`,
          )
        }
        const max = options.maxBytes ?? MAX_TEXT_FEED_BYTES
        if (Number(response.headers.get('content-length') ?? 0) > max) {
          await response.body?.cancel()
          throw new SourceError('SOURCE_UNAVAILABLE', '书库响应超过大小限制。')
        }
        const chunks: Buffer[] = []
        let size = 0
        if (response.body) {
          const reader = response.body.getReader()
          try {
            while (true) {
              const item = await reader.read()
              if (item.done) break
              size += item.value.length
              if (size > max) {
                await reader.cancel()
                throw new SourceError('SOURCE_UNAVAILABLE', '书库响应超过大小限制。')
              }
              chunks.push(Buffer.from(item.value))
            }
          } finally {
            reader.releaseLock()
          }
        }
        return {
          bytes: Buffer.concat(chunks),
          contentType: (response.headers.get('content-type') ?? '')
            .split(';')[0]!
            .trim()
            .toLowerCase(),
          url,
        }
      }
      throw new SourceError('SOURCE_UNAVAILABLE', '书库重定向失败。')
    } catch (error) {
      if (signal.aborted) throw new SourceError('SOURCE_CANCELED', '书库请求已取消。')
      if (timeout.aborted) throw new SourceError('SOURCE_TIMEOUT', '书库响应超时，请稍后重试。')
      if (error instanceof SourceError) throw error
      // Fetch errors can include request URLs and credentials; use a fixed public error.
      throw new SourceError('SOURCE_UNAVAILABLE', '无法连接书库，请检查地址和网络。')
    }
  }
}
