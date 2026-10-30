import { SourceError } from '../../shared/sources'
import type { PluginHttpOptions } from './runtime-types'

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_BYTES = 8 * 1024 * 1024
const SAFE_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'referer',
  'user-agent',
  'x-requested-with',
])

export function pluginRequestUrl(value: string, allowedOrigins: readonly string[]): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new SourceError('INVALID_SOURCE_REQUEST', '插件请求地址无效。')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    value.length > 16_000 ||
    !allowedOrigins.includes(url.origin)
  )
    throw new SourceError('INVALID_SOURCE_REQUEST', '插件请求超出已授权的网址范围。')
  return url
}

function requestOptions(value: unknown, allowedOrigins: readonly string[]) {
  if (value === undefined)
    return {
      method: 'GET' as const,
      headers: {} as Record<string, string>,
      body: undefined as string | undefined,
    }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SourceError('INVALID_SOURCE_REQUEST', '插件网络选项无效。')
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).some((key) => !['method', 'headers', 'body'].includes(key)) ||
    (input.method !== undefined && input.method !== 'GET' && input.method !== 'POST') ||
    (input.body !== undefined &&
      (typeof input.body !== 'string' || Buffer.byteLength(input.body) > 128 * 1024))
  )
    throw new SourceError('INVALID_SOURCE_REQUEST', '插件网络选项超出支持范围。')
  const method = input.method === 'POST' ? ('POST' as const) : ('GET' as const)
  if (method === 'GET' && input.body !== undefined)
    throw new SourceError('INVALID_SOURCE_REQUEST', 'GET 请求不能携带请求体。')
  const headers: Record<string, string> = {}
  if (input.headers !== undefined) {
    if (!input.headers || typeof input.headers !== 'object' || Array.isArray(input.headers))
      throw new SourceError('INVALID_SOURCE_REQUEST', '插件请求头无效。')
    const entries = Object.entries(input.headers)
    if (entries.length > 12) throw new SourceError('INVALID_SOURCE_REQUEST', '插件请求头过多。')
    for (const [key, header] of entries) {
      const name = key.toLowerCase()
      if (
        !SAFE_HEADERS.has(name) ||
        name in headers ||
        typeof header !== 'string' ||
        header.length > 2048 ||
        /\p{Cc}/u.test(header)
      )
        throw new SourceError('INVALID_SOURCE_REQUEST', '插件请求包含不允许的请求头。')
      if (name === 'referer') pluginRequestUrl(header, allowedOrigins)
      headers[name] = header
    }
  }
  return { method, headers, body: input.body as string | undefined }
}

/** No browser session, cookies, credentials or ambient application headers enter this transport. */
export class PluginHttpSession {
  private count = 0
  private bytes = 0
  private readonly origins: string[]
  constructor(
    allowedOrigins: string[],
    private signal: AbortSignal,
  ) {
    if (!Array.isArray(allowedOrigins) || allowedOrigins.length > 64)
      throw new SourceError('INVALID_SOURCE_REQUEST', '插件网址授权无效。')
    this.origins = allowedOrigins.map((value) => {
      if (typeof value !== 'string')
        throw new SourceError('INVALID_SOURCE_REQUEST', '插件网址授权无效。')
      let url: URL
      try {
        url = new URL(value)
      } catch {
        throw new SourceError('INVALID_SOURCE_REQUEST', '插件网址授权无效。')
      }
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash ||
        url.search ||
        url.pathname !== '/' ||
        (value !== url.origin && value !== `${url.origin}/`)
      )
        throw new SourceError('INVALID_SOURCE_REQUEST', '插件授权必须是完整的 HTTP／HTTPS 来源域。')
      return url.origin
    })
  }

  async request(value: string, options?: PluginHttpOptions): Promise<string> {
    this.signal.throwIfAborted()
    if (++this.count > 32)
      throw new SourceError('SOURCE_UNAVAILABLE', '插件单次操作超过 32 次网络请求。')
    let url = pluginRequestUrl(value, this.origins)
    let { method, headers, body } = requestOptions(options, this.origins)
    headers = { 'user-agent': 'ReadAndListenBook/0.33 source-plugin', ...headers }
    const timeout = AbortSignal.timeout(15_000)
    const signal = AbortSignal.any([this.signal, timeout])
    try {
      for (let redirects = 0; redirects <= 4; redirects++) {
        const response = await fetch(url.href, {
          method,
          headers,
          signal,
          redirect: 'manual',
          credentials: 'omit',
          ...(body === undefined ? {} : { body }),
        })
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel()
          const location = response.headers.get('location')
          if (!location || redirects === 4)
            throw new SourceError('SOURCE_UNAVAILABLE', '插件请求重定向无效或过多。')
          const next = pluginRequestUrl(new URL(location, url).href, this.origins)
          if (method === 'POST' && next.origin !== url.origin)
            throw new SourceError(
              'INVALID_SOURCE_REQUEST',
              '插件 POST 请求不能重定向到其他来源域。',
            )
          if (
            response.status === 303 ||
            (method === 'POST' && [301, 302].includes(response.status))
          ) {
            method = 'GET'
            body = undefined
            delete headers['content-type']
          }
          url = next
          continue
        }
        if (
          ![200, ...(method === 'POST' ? [201] : [])].includes(response.status) ||
          response.headers.has('content-range')
        ) {
          await response.body?.cancel()
          throw new SourceError(
            'SOURCE_UNAVAILABLE',
            `插件网站返回 HTTP ${response.status}，请检查来源或稍后重试。`,
          )
        }
        if (Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE_BYTES) {
          await response.body?.cancel()
          throw new SourceError('SOURCE_UNAVAILABLE', '插件网站响应超过 2 MiB。')
        }
        const chunks: Buffer[] = []
        let size = 0
        if (response.body) {
          const reader = response.body.getReader()
          try {
            while (true) {
              const chunk = await reader.read()
              if (chunk.done) break
              size += chunk.value.byteLength
              this.bytes += chunk.value.byteLength
              if (size > MAX_RESPONSE_BYTES || this.bytes > MAX_TOTAL_BYTES) {
                await reader.cancel()
                throw new SourceError('SOURCE_UNAVAILABLE', '插件网络响应超过单次操作的大小限制。')
              }
              chunks.push(Buffer.from(chunk.value))
            }
          } finally {
            reader.releaseLock()
          }
        }
        signal.throwIfAborted()
        const charset =
          /charset\s*=\s*["']?([\w-]+)/i
            .exec(response.headers.get('content-type') ?? '')?.[1]
            ?.toLowerCase() ?? 'utf-8'
        const encoding = charset === 'gbk' || charset === 'gb2312' ? 'gb18030' : charset
        if (
          ![
            'utf-8',
            'utf8',
            'utf-16le',
            'utf-16be',
            'gb18030',
            'big5',
            'shift_jis',
            'iso-8859-1',
            'windows-1252',
          ].includes(encoding)
        )
          throw new SourceError('SOURCE_CHANGED', '插件网站使用了不支持的文字编码。')
        return new TextDecoder(encoding).decode(Buffer.concat(chunks))
      }
      throw new SourceError('SOURCE_UNAVAILABLE', '插件网站重定向失败。')
    } catch (error) {
      if (this.signal.aborted) throw new SourceError('SOURCE_CANCELED', '插件请求已取消。')
      if (timeout.aborted) throw new SourceError('SOURCE_TIMEOUT', '插件网站响应超时。')
      if (error instanceof SourceError) throw error
      throw new SourceError('SOURCE_UNAVAILABLE', '无法连接插件网站，请检查来源和网络。')
    }
  }
}
