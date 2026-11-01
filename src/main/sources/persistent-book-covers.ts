import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { lstat, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BOOK_COVER_PREFIX, isSourceCoverUrl } from '../../shared/source-covers'
import { sourceCoverMime, type SourceCoverService } from './source-covers'

export type BookCoverKind = 'audio' | 'ebook'
interface Binding {
  kind: BookCoverKind
  id: string
  hash: string
  bytes: number
  usedAt: number
}
export interface PersistentBookCoversOptions {
  directory: string
  sourceCovers: Pick<SourceCoverService, 'serve'>
  thumbnail?: (bytes: Buffer) => Buffer | Promise<Buffer>
  maxBytes?: number
  maxBooks?: number
  onChanged?: () => void
  trustedRendererOrigin?: string
}
const MAX_BYTES = 2 * 1024 * 1024
const MAX_INDEX_BYTES = 256 * 1024
const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(id)
const key = (kind: BookCoverKind, id: string) => `${kind}:${id}`
const hashOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** Content-addressed, bounded generated artwork. No renderer path or remote URL is accepted. */
export class PersistentBookCovers {
  private directory: string
  private bindings = new Map<string, Binding>()
  private queue = Promise.resolve()
  private closed = false
  private available = true
  private dirty = false
  private maxBytes: number
  private maxBooks: number

  constructor(private options: PersistentBookCoversOptions) {
    this.directory = resolve(options.directory)
    this.maxBytes = Math.max(1, Math.min(64 * 1024 * 1024, options.maxBytes ?? 64 * 1024 * 1024))
    this.maxBooks = Math.max(1, Math.min(512, options.maxBooks ?? 512))
    try {
      mkdirSync(this.directory, { recursive: true })
      if (lstatSync(this.directory).isSymbolicLink()) throw new Error('Linked cover directory')
      const filename = join(this.directory, 'index.json')
      let raw: unknown
      try {
        const info = lstatSync(filename)
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_INDEX_BYTES)
          throw new Error('Invalid cover index')
        raw = JSON.parse(readFileSync(filename, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      const disk = raw as { schemaVersion?: unknown; bindings?: unknown }
      if (disk?.schemaVersion !== 1 || !Array.isArray(disk.bindings) || disk.bindings.length > 512)
        throw new Error('Invalid cover index')
      for (const entry of disk.bindings) {
        const item = entry as Partial<Binding>
        if (
          !item ||
          !['audio', 'ebook'].includes(String(item.kind)) ||
          !validId(item.id) ||
          typeof item.hash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(item.hash) ||
          !Number.isSafeInteger(item.bytes) ||
          item.bytes! < 1 ||
          item.bytes! > MAX_BYTES ||
          !Number.isSafeInteger(item.usedAt) ||
          item.usedAt! < 1 ||
          this.bindings.has(key(item.kind!, item.id))
        )
          throw new Error('Invalid cover binding')
        this.bindings.set(key(item.kind!, item.id), item as Binding)
      }
      this.trim()
      void this.exclusive(async () => {
        if (this.dirty) await this.save()
        await this.sweep()
      }).catch(() => undefined)
    } catch {
      // An optional artwork cache must never prevent opening the user's library.
      this.bindings.clear()
      this.available = false
    }
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action)
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private bytes() {
    return [
      ...new Map([...this.bindings.values()].map((item) => [item.hash, item.bytes])).values(),
    ].reduce((sum, size) => sum + size, 0)
  }

  private trim() {
    while (this.bindings.size > this.maxBooks || this.bytes() > this.maxBytes) {
      const oldest = [...this.bindings.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0]
      if (!oldest) break
      this.bindings.delete(oldest[0])
      this.dirty = true
    }
  }

  private async save() {
    const temporary = join(this.directory, `.index-${randomUUID()}.json`)
    await writeFile(
      temporary,
      JSON.stringify({ schemaVersion: 1, bindings: [...this.bindings.values()] }) + '\n',
      { flag: 'wx' },
    )
    await rename(temporary, join(this.directory, 'index.json'))
    this.dirty = false
  }

  private async sweep() {
    const referenced = new Set([...this.bindings.values()].map((item) => item.hash + '.img'))
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (/^[a-f0-9]{64}\.img$/.test(entry.name) && entry.isFile() && !referenced.has(entry.name))
        await unlink(join(this.directory, entry.name)).catch(() => undefined)
    }
  }

  /** Downloads only an already registered and validated source candidate. Failures are optional. */
  async remember(kind: BookCoverKind, id: string, candidateUrl?: string | null): Promise<boolean> {
    if (
      this.closed ||
      !this.available ||
      !['audio', 'ebook'].includes(kind) ||
      !validId(id) ||
      !isSourceCoverUrl(candidateUrl)
    )
      return false
    try {
      const response = await this.options.sourceCovers.serve(new Request(candidateUrl))
      if (response.status !== 200) return false
      let bytes: Buffer = Buffer.from(await response.arrayBuffer())
      if (!bytes.length || bytes.length > MAX_BYTES || !sourceCoverMime(bytes)) return false
      if (this.options.thumbnail) bytes = await this.options.thumbnail(bytes)
      if (
        !bytes.length ||
        bytes.length > MAX_BYTES ||
        bytes.length > this.maxBytes ||
        !sourceCoverMime(bytes)
      )
        return false
      const hash = hashOf(bytes)
      return await this.exclusive(async () => {
        if (this.closed || !this.available) return false
        const filename = join(this.directory, hash + '.img')
        const info = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
          return null
        })
        if (info && (!info.isFile() || info.isSymbolicLink())) return false
        const intact = info?.size === bytes.length && hashOf(await readFile(filename)) === hash
        if (!intact) {
          const temporary = join(this.directory, `.image-${randomUUID()}.tmp`)
          await writeFile(temporary, bytes, { flag: 'wx' })
          await rename(temporary, filename)
        }
        const before = new Map(this.bindings)
        this.bindings.set(key(kind, id), {
          kind,
          id,
          hash,
          bytes: bytes.length,
          usedAt: Date.now(),
        })
        this.trim()
        this.dirty = true
        try {
          await this.save()
        } catch (error) {
          this.bindings = before
          throw error
        }
        await this.sweep()
        this.options.onChanged?.()
        return this.bindings.has(key(kind, id))
      })
    } catch {
      return false
    }
  }

  decorate<T extends { id: string }>(kind: BookCoverKind, book: T): T & { coverUrl?: string } {
    const item = this.bindings.get(key(kind, book.id))
    return item ? { ...book, coverUrl: BOOK_COVER_PREFIX + item.hash } : book
  }

  stats() {
    return {
      books: this.bindings.size,
      bytes: this.bytes(),
      maxBooks: this.maxBooks,
      maxBytes: this.maxBytes,
    }
  }

  async serve(request: Request): Promise<Response> {
    const unavailable = (status = 404) =>
      new Response(null, { status, headers: { 'Cache-Control': 'no-store' } })
    const origin = request.headers.get('origin')
    if (
      this.closed ||
      !this.available ||
      (origin && origin !== 'readlisten://app' && origin !== this.options.trustedRendererOrigin)
    )
      return unavailable()
    if (!['GET', 'HEAD'].includes(request.method)) return unavailable(405)
    try {
      const url = new URL(request.url)
      const hash = /^\/book-covers\/([a-f0-9]{64})$/.exec(url.pathname)?.[1]
      if (
        url.protocol !== 'readlisten:' ||
        url.hostname !== 'app' ||
        url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !hash
      )
        return unavailable()
      const rows = [...this.bindings.values()].filter((item) => item.hash === hash)
      if (!rows.length) return unavailable()
      const filename = join(this.directory, hash + '.img')
      const info = await lstat(filename)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) return unavailable()
      const file = await open(filename, 'r')
      let bytes: Buffer
      try {
        const opened = await file.stat()
        if (!opened.isFile() || opened.size > MAX_BYTES) return unavailable()
        bytes = await file.readFile()
      } finally {
        await file.close()
      }
      const type = sourceCoverMime(bytes)
      if (!type || hashOf(bytes) !== hash || this.closed || request.signal.aborted)
        return unavailable()
      for (const row of rows) row.usedAt = Date.now()
      this.dirty = true
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), {
        headers: {
          'Content-Type': type,
          'Content-Length': String(bytes.length),
          'Cache-Control': 'private, max-age=86400, immutable',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'",
          'Cross-Origin-Resource-Policy': this.options.trustedRendererOrigin
            ? 'cross-origin'
            : 'same-origin',
        },
      })
    } catch {
      return unavailable()
    }
  }

  /** Serialize a backup copy with cache index writes and bounded eviction. */
  withSnapshot<T>(copy: () => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      if (this.dirty && this.available) await this.save()
      return copy()
    })
  }

  async close(): Promise<void> {
    this.closed = true
    await this.exclusive(async () => {
      if (this.dirty && this.available) await this.save().catch(() => undefined)
    })
  }
}
