import { randomUUID } from 'node:crypto'
import { SOURCE_COVER_PREFIX } from '../../shared/source-covers'

const MAX_COVER_BYTES = 2 * 1024 * 1024
const MAX_PIXELS = 16_000_000
const ORIGIN = 'readlisten://app'

export interface SourceCoverPolicy {
  allowedOrigins: readonly string[]
  referer?: string
  /** Trusted main-process builtin policy only. Never obtained from a renderer or plugin script. */
  validateUrl?: (url: URL) => boolean
}

export interface SourceCoverOptions {
  request?: typeof fetch
  timeoutMs?: number
  maxEntries?: number
  maxCacheBytes?: number
  /** Exact renderer origin from trusted startup configuration; development server only. */
  trustedRendererOrigin?: string
}

interface CoverCandidate {
  sourceId: string
  url: string
  policy: SourceCoverPolicy
  key: string
}
interface CoverBytes {
  bytes: Buffer
  type: string
}

function httpUrl(value: string): URL {
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    value.length > 8000
  )
    throw new Error('Invalid cover URL')
  return url
}

function approved(url: URL, policy: SourceCoverPolicy): boolean {
  return policy.validateUrl ? policy.validateUrl(url) : policy.allowedOrigins.includes(url.origin)
}

function dimensions(width: number, height: number) {
  if (!width || !height || width > 8000 || height > 8000 || width * height > MAX_PIXELS)
    throw new Error('Cover dimensions exceeded')
}

/** Raster signatures only. SVG/HTML remain blocked even when a server mislabels them. */
export function sourceCoverMime(bytes: Buffer): string | null {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString('ascii', 12, 16) === 'IHDR'
  ) {
    dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
    return 'image/png'
  }
  if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) {
    dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8))
    return 'image/gif'
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP' &&
    bytes.readUInt32LE(4) + 8 === bytes.length
  ) {
    if (bytes.length >= 30 && bytes.toString('ascii', 12, 16) === 'VP8X') {
      dimensions(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1)
      return 'image/webp'
    }
    if (
      bytes.length >= 30 &&
      bytes.toString('ascii', 12, 16) === 'VP8 ' &&
      bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42]))
    ) {
      dimensions(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff)
      return 'image/webp'
    }
    if (bytes.length >= 25 && bytes.toString('ascii', 12, 16) === 'VP8L' && bytes[20] === 47) {
      const bits = bytes.readUInt32LE(21)
      dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
      return 'image/webp'
    }
    return null
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes[bytes.length - 2] === 255 &&
    bytes[bytes.length - 1] === 217
  ) {
    let cursor = 2
    while (cursor + 4 <= bytes.length) {
      if (bytes[cursor] !== 255) break
      while (bytes[cursor] === 255) cursor++
      const marker = bytes[cursor++]!
      if (marker === 217 || marker === 218) break
      if ([1, 216, ...Array.from({ length: 8 }, (_, index) => 208 + index)].includes(marker))
        continue
      if (cursor + 2 > bytes.length) break
      const length = bytes.readUInt16BE(cursor)
      if (length < 2 || cursor + length > bytes.length) throw new Error('Invalid JPEG segment')
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 7) throw new Error('Invalid JPEG dimensions')
        dimensions(bytes.readUInt16BE(cursor + 5), bytes.readUInt16BE(cursor + 3))
        return 'image/jpeg'
      }
      cursor += length
    }
  }
  return null
}

export class SourceCoverService {
  private candidates = new Map<string, CoverCandidate>()
  private tokens = new Map<string, string>()
  private cached = new Map<string, CoverBytes>()
  private pending = new Map<string, Promise<CoverBytes>>()
  private controllers = new Set<AbortController>()
  private slots = new Set<() => void>()
  private cachedBytes = 0
  private closed = false
  private request: typeof fetch
  private rendererOrigin?: string
  constructor(private options: SourceCoverOptions = {}) {
    this.request = options.request ?? fetch
    if (options.trustedRendererOrigin) {
      const origin = httpUrl(options.trustedRendererOrigin)
      if (origin.href !== origin.origin + '/') throw new Error('Invalid renderer origin')
      this.rendererOrigin = origin.origin
    }
  }

  register(sourceId: string, value: unknown, policy: SourceCoverPolicy): string | null {
    if (
      this.closed ||
      typeof value !== 'string' ||
      !value ||
      typeof sourceId !== 'string' ||
      sourceId.length > 200 ||
      !sourceId ||
      policy.allowedOrigins.length > 64
    )
      return null
    try {
      const url = httpUrl(value)
      const origins = policy.allowedOrigins.map((value) => {
        const origin = httpUrl(value)
        if (origin.pathname !== '/' || origin.search) throw new Error('Invalid origin')
        return origin.origin
      })
      const referer = policy.referer ? httpUrl(policy.referer) : undefined
      const safePolicy = {
        allowedOrigins: origins,
        ...(referer ? { referer: `${referer.origin}${referer.pathname}` } : {}),
        ...(policy.validateUrl ? { validateUrl: policy.validateUrl } : {}),
      }
      if (!approved(url, safePolicy)) return null
      const key = JSON.stringify([sourceId, url.href, origins, safePolicy.referer])
      const known = this.tokens.get(key)
      if (known && this.candidates.has(known)) {
        const candidate = this.candidates.get(known)!
        this.candidates.delete(known)
        this.candidates.set(known, candidate)
        return SOURCE_COVER_PREFIX + known
      }
      const token = randomUUID()
      this.candidates.set(token, { sourceId, url: url.href, policy: safePolicy, key })
      this.tokens.set(key, token)
      while (this.candidates.size > (this.options.maxEntries ?? 512)) {
        const oldest = this.candidates.keys().next().value!
        const candidate = this.candidates.get(oldest)!
        this.candidates.delete(oldest)
        this.tokens.delete(candidate.key)
        this.dropCache(oldest)
      }
      return SOURCE_COVER_PREFIX + token
    } catch {
      return null
    }
  }

  private dropCache(token: string) {
    const value = this.cached.get(token)
    if (value) {
      this.cachedBytes -= value.bytes.length
      this.cached.delete(token)
    }
  }

  private async download(candidate: CoverCandidate): Promise<CoverBytes> {
    while (this.controllers.size >= 8 && !this.closed)
      await new Promise<void>((resolve) => {
        this.slots.add(resolve)
      })
    if (this.closed) throw new Error('Cover service closed')
    const controller = new AbortController()
    this.controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 12_000)
    try {
      let url = httpUrl(candidate.url)
      for (let redirects = 0; redirects <= 4; redirects++) {
        if (!approved(url, candidate.policy)) throw new Error('Cover origin denied')
        const response = await this.request(url.href, {
          method: 'GET',
          signal: controller.signal,
          redirect: 'manual',
          credentials: 'omit',
          headers: {
            Accept: 'image/png, image/jpeg, image/webp, image/gif',
            ...(candidate.policy.referer ? { Referer: candidate.policy.referer } : {}),
          },
        })
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location')
          await response.body?.cancel()
          if (!location || redirects === 4) throw new Error('Invalid cover redirect')
          url = httpUrl(new URL(location, url).href)
          continue
        }
        const type = (response.headers.get('content-type') ?? '')
          .split(';')[0]!
          .trim()
          .toLowerCase()
        const length = response.headers.get('content-length')
        if (
          response.status !== 200 ||
          response.headers.has('content-range') ||
          !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type) ||
          !response.body ||
          (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_COVER_BYTES))
        ) {
          await response.body?.cancel()
          throw new Error('Invalid cover response')
        }
        const chunks: Buffer[] = []
        let size = 0
        const reader = response.body.getReader()
        try {
          while (true) {
            const item = await reader.read()
            if (item.done) break
            size += item.value.length
            if (size > MAX_COVER_BYTES) {
              await reader.cancel()
              throw new Error('Cover too large')
            }
            chunks.push(Buffer.from(item.value))
          }
        } finally {
          reader.releaseLock()
        }
        controller.signal.throwIfAborted()
        const bytes = Buffer.concat(chunks)
        const actualType = sourceCoverMime(bytes)
        if (!bytes.length || (length !== null && Number(length) !== bytes.length) || !actualType)
          throw new Error('Cover signature mismatch')
        return { bytes, type: actualType }
      }
      throw new Error('Cover redirect loop')
    } finally {
      clearTimeout(timer)
      this.controllers.delete(controller)
      for (const slot of this.slots) slot()
      this.slots.clear()
    }
  }

  async serve(request: Request): Promise<Response> {
    const unavailable = (status = 404) =>
      new Response(null, { status, headers: { 'Cache-Control': 'no-store' } })
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return unavailable()
    }
    const origin = request.headers.get('origin')
    if (
      this.closed ||
      url.protocol !== 'readlisten:' ||
      url.hostname !== 'app' ||
      url.port ||
      url.search ||
      url.hash ||
      (origin && origin !== ORIGIN && origin !== this.rendererOrigin)
    )
      return unavailable()
    if (!['GET', 'HEAD'].includes(request.method)) return unavailable(405)
    const token = /^\/covers\/([a-f0-9-]{36})$/.exec(url.pathname)?.[1]
    const candidate = token ? this.candidates.get(token) : undefined
    if (!token || !candidate) return unavailable()
    this.candidates.delete(token)
    this.candidates.set(token, candidate)
    try {
      let value = this.cached.get(token)
      if (value) {
        this.cached.delete(token)
        this.cached.set(token, value)
      } else {
        let pending = this.pending.get(token)
        if (!pending) {
          pending = this.download(candidate)
          this.pending.set(token, pending)
          void pending
            .finally(() => {
              this.pending.delete(token)
            })
            .catch(() => undefined)
        }
        value = await pending
        if (!this.closed && this.candidates.has(token) && !this.cached.has(token)) {
          this.cached.set(token, value)
          this.cachedBytes += value.bytes.length
          while (
            this.cachedBytes > (this.options.maxCacheBytes ?? 16 * 1024 * 1024) ||
            this.cached.size > 128
          )
            this.dropCache(this.cached.keys().next().value!)
        }
      }
      if (this.closed || request.signal.aborted) return unavailable()
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(value.bytes), {
        headers: {
          'Content-Type': value.type,
          'Content-Length': String(value.bytes.length),
          'Cache-Control': 'private, max-age=300',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'",
          'Cross-Origin-Resource-Policy': this.rendererOrigin ? 'cross-origin' : 'same-origin',
        },
      })
    } catch {
      return unavailable()
    }
  }

  close() {
    this.closed = true
    for (const controller of this.controllers) controller.abort()
    for (const slot of this.slots) slot()
    this.slots.clear()
    this.cached.clear()
    this.candidates.clear()
    this.tokens.clear()
    this.cachedBytes = 0
  }
}

export function builtinSourceCoverOrigins(sourceId: string, pageUrl?: string): string[] {
  if (sourceId === 'ting13') return ['https://www.ting13.cc', 'https://image.itingshu.net']
  if (sourceId === 'librivox')
    return ['https://librivox.org', 'https://archive.org', 'https://www.archive.org']
  if (sourceId === 'wikisource')
    return ['https://zh.wikisource.org', 'https://upload.wikimedia.org']
  try {
    return pageUrl ? [httpUrl(pageUrl).origin] : []
  } catch {
    return []
  }
}

export function builtinSourceCoverPolicy(
  sourceId: string,
  pageUrl: string,
  coverUrl: string,
): SourceCoverPolicy {
  const allowedOrigins = builtinSourceCoverOrigins(sourceId, pageUrl)
  if (sourceId !== 'librivox') return { allowedOrigins, referer: pageUrl }
  let identity: string | undefined
  try {
    const initial = httpUrl(coverUrl)
    if (['archive.org', 'www.archive.org'].includes(initial.hostname))
      identity = /^\/download\/(.+\/[^/]+\.(?:png|jpe?g|gif|webp))$/i.exec(initial.pathname)?.[1]
  } catch {
    /* An invalid candidate is rejected during registration. */
  }
  return {
    allowedOrigins,
    referer: pageUrl,
    validateUrl: (url) => {
      if (!identity) return allowedOrigins.includes(url.origin)
      const primary = ['archive.org', 'www.archive.org'].includes(url.hostname)
      const storage = /^(?:ia|dn)\d+\.(?:us|ca|eu)\.archive\.org$/.test(url.hostname)
      const path = primary
        ? /^\/download\/(.+)$/.exec(url.pathname)?.[1]
        : storage
          ? /^\/\d+\/items\/(.+)$/.exec(url.pathname)?.[1]
          : undefined
      return (
        url.protocol === 'https:' &&
        !url.port &&
        path === identity &&
        !/%(?:2f|5c|00)/i.test(url.pathname)
      )
    },
  }
}
