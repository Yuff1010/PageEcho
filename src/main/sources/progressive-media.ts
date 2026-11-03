import { randomUUID } from 'node:crypto'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { parseRange } from '../media'
import { AppError, isId } from '../../shared/validation'
import { SourceError } from '../../shared/sources'

export const PROGRESSIVE_MEDIA_PREFIX = 'readlisten://app/stream/'
const MAX_BYTES = 256 * 1024 * 1024
const BLOCK_BYTES = 64 * 1024
const MAX_SESSIONS = 16

export interface ProgressiveMediaOptions {
  /** A stalled reader times out independently of the producer's download deadline. */
  waitTimeoutMs?: number
  maxReaders?: number
}
export interface ProgressiveMediaSession {
  readonly id: string
  readonly episodeId: string
  readonly url: string
  readonly expectedBytes: number
  readonly writtenBytes: number
  readonly state: 'open' | 'complete' | 'failed' | 'closed'
  /** Call only after these bytes have been completely written to the file. */
  markWritten(total: number): void
  complete(): Promise<void>
  fail(error: unknown): Promise<void>
  close(): Promise<void>
}

interface Reader {
  stopped: boolean
  controller?: ReadableStreamDefaultController<Uint8Array>
  interruptions: Set<() => void>
  stop(error?: Error): void
}
const canceled = () => new SourceError('SOURCE_CANCELED', '音频播放请求已取消。')
const incomplete = () =>
  new SourceError('SOURCE_MEDIA_UNAVAILABLE', '音频缓存未完整落盘，已停止读取，请重试。')

/** A file-backed, sequential producer. This never fetches or gives a partial file an audio hash. */
class SpoolSession implements ProgressiveMediaSession {
  readonly id = randomUUID()
  readonly url = `${PROGRESSIVE_MEDIA_PREFIX}${this.id}`
  writtenBytes = 0
  state: ProgressiveMediaSession['state'] = 'open'
  private failure?: Error
  private closing?: Promise<void>
  private readonly readers = new Set<Reader>()
  private readonly changes = new Set<() => void>()
  private readonly io = new Set<Promise<unknown>>()
  constructor(
    readonly episodeId: string,
    readonly expectedBytes: number,
    private readonly file: FileHandle,
    private readonly waitTimeoutMs: number,
    private readonly acquire: () => boolean,
    private readonly relinquish: () => void,
    private readonly release: (id: string) => Promise<void>,
  ) {}

  markWritten(total: number): void {
    if (this.state !== 'open') throw this.failure ?? canceled()
    if (!Number.isSafeInteger(total) || total < this.writtenBytes || total > this.expectedBytes)
      throw new AppError('INVALID_REQUEST', '音频落盘进度无效。')
    if (total !== this.writtenBytes) {
      this.writtenBytes = total
      this.changed()
    }
  }
  private changed() {
    for (const change of [...this.changes]) change()
  }
  private async owned<T>(operation: Promise<T>): Promise<T> {
    this.io.add(operation)
    try {
      return await operation
    } finally {
      this.io.delete(operation)
    }
  }
  async complete(): Promise<void> {
    if (this.state === 'complete') return
    if (this.state !== 'open') throw this.failure ?? canceled()
    try {
      if (this.writtenBytes !== this.expectedBytes) throw incomplete()
      const info = await this.owned(this.file.stat())
      if (this.state !== 'open') throw this.failure ?? canceled()
      if (!info.isFile() || info.size !== this.expectedBytes) throw incomplete()
      this.state = 'complete'
      this.changed()
    } catch (error) {
      if (this.state === 'open') await this.fail(error)
      throw this.failure ?? canceled()
    }
  }
  fail(error: unknown): Promise<void> {
    if (this.state === 'closed') return this.closing ?? Promise.resolve()
    this.state = 'failed'
    // Network errors can contain signed URLs. The producer handles its own
    // detailed error; a media stream receives only this fixed public message.
    this.failure ??=
      error instanceof SourceError && error.code === 'SOURCE_CANCELED' ? canceled() : incomplete()
    return this.shutdown(this.failure)
  }
  close(): Promise<void> {
    return this.release(this.id)
  }
  dispose(): Promise<void> {
    this.state = 'closed'
    this.failure ??= canceled()
    return this.shutdown(this.failure)
  }
  private shutdown(error: Error): Promise<void> {
    if (!this.closing) {
      for (const reader of [...this.readers]) reader.stop(error)
      this.changed()
      this.closing = (async () => {
        await Promise.allSettled([...this.io])
        await this.file.close()
      })()
    }
    return this.closing
  }
  private readable() {
    if (this.state === 'closed' || this.state === 'failed') throw this.failure ?? canceled()
  }
  private async wait(reader: Reader, offset: number): Promise<void> {
    const deadline = Date.now() + this.waitTimeoutMs
    for (;;) {
      this.readable()
      if (reader.stopped) throw canceled()
      if (this.writtenBytes > offset) return
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new SourceError('SOURCE_TIMEOUT', '等待音频缓冲超时，请重试。')
      await new Promise<void>((done, reject) => {
        const cleanup = () => {
          clearTimeout(timer)
          this.changes.delete(changed)
          reader.interruptions.delete(interrupted)
        }
        const changed = () => {
          cleanup()
          done()
        }
        const interrupted = () => {
          cleanup()
          reject(canceled())
        }
        const timer = setTimeout(() => {
          cleanup()
          reject(new SourceError('SOURCE_TIMEOUT', '等待音频缓冲超时，请重试。'))
        }, remaining)
        this.changes.add(changed)
        reader.interruptions.add(interrupted)
      })
    }
  }
  response(request: Request, rendererOrigin: string): Response {
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': rendererOrigin,
    })
    if (this.state === 'failed' || this.state === 'closed')
      return new Response(null, { status: 410, headers })
    const rangeHeader = request.headers.get('range')
    const range = parseRange(rangeHeader, this.expectedBytes)
    if (!range) {
      headers.set('Content-Range', `bytes */${this.expectedBytes}`)
      return new Response(null, { status: 416, headers })
    }
    headers.set('Content-Length', String(range.end - range.start + 1))
    if (rangeHeader)
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${this.expectedBytes}`)
    const status = rangeHeader ? 206 : 200
    if (request.method === 'HEAD') return new Response(null, { status, headers })
    if (request.signal.aborted) return new Response(null, { status: 408 })
    if (!this.acquire()) return new Response(null, { status: 503, headers: { 'Retry-After': '1' } })
    const stop = (error?: Error) => {
      if (reader.stopped) return
      reader.stopped = true
      this.readers.delete(reader)
      this.relinquish()
      request.signal.removeEventListener('abort', abort)
      for (const interrupt of [...reader.interruptions]) interrupt()
      if (error) reader.controller?.error(error)
    }
    const abort = () => stop(canceled())
    const reader: Reader = { stopped: false, interruptions: new Set(), stop }
    this.readers.add(reader)
    let offset = range.start
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          reader.controller = controller
          request.signal.addEventListener('abort', abort, { once: true })
          if (request.signal.aborted) abort()
        },
        pull: async (controller) => {
          try {
            await this.wait(reader, offset)
            if (reader.stopped) return
            const length = Math.min(BLOCK_BYTES, range.end - offset + 1, this.writtenBytes - offset)
            const bytes = Buffer.allocUnsafe(length)
            const result = await this.owned(this.file.read(bytes, 0, length, offset))
            if (reader.stopped) return
            if (result.bytesRead !== length) {
              void this.fail(incomplete()).catch(() => undefined)
              return
            }
            offset += length
            controller.enqueue(bytes)
            if (offset > range.end) {
              controller.close()
              stop()
            }
          } catch (error) {
            if (!reader.stopped) {
              if (!(error instanceof SourceError && error.code === 'SOURCE_TIMEOUT'))
                void this.fail(error).catch(() => undefined)
              else stop(error)
            }
          }
        },
        cancel: () => stop(),
      },
      { highWaterMark: 0 },
    )
    return new Response(stream, { status, headers })
  }
}

/** Main-owned registry. Every session owns exactly one read-only file handle. */
export class ProgressiveMedia {
  private readonly sessions = new Map<string, SpoolSession>()
  private readonly creating = new Set<Promise<ProgressiveMediaSession>>()
  private readonly releasing = new Map<string, Promise<void>>()
  private readonly directory: string
  private readonly waitTimeoutMs: number
  private readonly maxReaders: number
  private readers = 0
  private closed = false
  private closing?: Promise<void>
  constructor(directory: string, options: ProgressiveMediaOptions = {}) {
    if (!isAbsolute(directory) || directory.includes('\0'))
      throw new AppError('INVALID_REQUEST', '音频缓冲目录必须是绝对路径。')
    this.directory = resolve(directory)
    this.waitTimeoutMs = options.waitTimeoutMs ?? 120000
    this.maxReaders = options.maxReaders ?? 16
    if (
      !Number.isInteger(this.waitTimeoutMs) ||
      this.waitTimeoutMs < 1 ||
      this.waitTimeoutMs > 120000 ||
      !Number.isInteger(this.maxReaders) ||
      this.maxReaders < 1 ||
      this.maxReaders > 16
    )
      throw new AppError('INVALID_REQUEST', '音频缓冲资源上限无效。')
  }
  create(
    episodeId: string,
    temporaryPath: string,
    expectedBytes: number,
  ): Promise<ProgressiveMediaSession> {
    if (this.closed) return Promise.reject(canceled())
    if (this.sessions.size + this.creating.size >= MAX_SESSIONS)
      return Promise.reject(new SourceError('SOURCE_BUSY', '音频缓冲会话过多，请稍后重试。'))
    const operation = this.createSession(episodeId, temporaryPath, expectedBytes).finally(() =>
      this.creating.delete(operation),
    )
    this.creating.add(operation)
    return operation
  }
  private async createSession(
    episodeId: string,
    temporaryPath: string,
    expectedBytes: number,
  ): Promise<ProgressiveMediaSession> {
    if (
      !isId(episodeId) ||
      !isAbsolute(temporaryPath) ||
      temporaryPath.includes('\0') ||
      dirname(resolve(temporaryPath)) !== this.directory ||
      extname(temporaryPath) !== '.part' ||
      !Number.isSafeInteger(expectedBytes) ||
      expectedBytes < 1 ||
      expectedBytes > MAX_BYTES
    )
      throw new AppError('INVALID_REQUEST', '音频缓冲文件或大小无效。')
    let file: FileHandle | undefined
    try {
      const root = await lstat(this.directory)
      const original = await lstat(temporaryPath)
      if (
        !root.isDirectory() ||
        root.isSymbolicLink() ||
        !original.isFile() ||
        original.isSymbolicLink()
      )
        throw incomplete()
      const canonical = await realpath(temporaryPath)
      if (canonical !== join(await realpath(this.directory), basename(temporaryPath)))
        throw incomplete()
      file = await open(canonical, 'r')
      const opened = await file.stat()
      if (
        !opened.isFile() ||
        opened.size > expectedBytes ||
        opened.dev !== original.dev ||
        opened.ino !== original.ino
      )
        throw incomplete()
      if (this.closed) throw canceled()
      const session = new SpoolSession(
        episodeId,
        expectedBytes,
        file,
        this.waitTimeoutMs,
        () => {
          if (this.readers >= this.maxReaders) return false
          this.readers++
          return true
        },
        () => {
          this.readers--
        },
        (id) => this.release(id),
      )
      this.sessions.set(session.id, session)
      return session
    } catch (error) {
      await file?.close()
      if (error instanceof SourceError || error instanceof AppError) throw error
      throw incomplete()
    }
  }
  async serve(request: Request, rendererOrigin: string): Promise<Response> {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response(null, { status: 403 })
    }
    const parts = url.pathname.split('/')
    if (
      url.protocol !== 'readlisten:' ||
      url.host !== 'app' ||
      parts.length !== 3 ||
      parts[1] !== 'stream' ||
      !isId(parts[2]) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      return new Response(null, { status: 403 })
    if (!['GET', 'HEAD'].includes(request.method))
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
    const session = this.sessions.get(parts[2]!)
    return session ? session.response(request, rendererOrigin) : new Response(null, { status: 404 })
  }
  release(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return this.releasing.get(id) ?? Promise.resolve()
    this.sessions.delete(id)
    const operation = session.dispose().finally(() => this.releasing.delete(id))
    this.releasing.set(id, operation)
    return operation
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true
      this.closing = (async () => {
        await Promise.allSettled([...this.creating])
        await Promise.all([...this.sessions.keys()].map((id) => this.release(id)))
        await Promise.all([...this.releasing.values()])
      })()
    }
    return this.closing
  }
}
