import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReadingBook } from '../../shared/reading'
import { SourceError } from '../../shared/sources'
import type {
  RemoteLibraryConfig,
  RemoteLibraryInfo,
  RemoteLibraryKind,
  RemoteLibraryManifest,
  RemoteManifestPreview,
  TextBrowseRequest,
  TextDetailRequest,
  TextImportRequest,
  TextImportResult,
  TextSourceState,
  SourceReadingImport,
  SourceReadingState,
  TextBookDetail,
  SourceReadingContext,
  TextContinueRequest,
  TextContinueResult,
} from '../../shared/text-sources'
import { sourceUrl, TextHttpClient } from './text-http'
import { OpdsTextConnector } from './text-opds'
import type {
  StoredRemoteLibrary,
  TextLibraryConnector,
  TextLibraryContext,
  PluginTextSources,
} from './text-provider'
import { WikisourceTextSource, WIKISOURCE_URL } from './text-wikisource'

export interface TextSourceOptions {
  directory: string
  importBook: (
    bytes: Buffer,
    filename: string,
    signal: AbortSignal,
  ) => Promise<ReadingBook> | ReadingBook
  getReadingBook: (id: string) => ReadingBook | null
  importChapters?: (
    input: SourceReadingImport,
    signal: AbortSignal,
  ) => Promise<ReadingBook> | ReadingBook
  getSourceReading?: (sourceKey: string) => SourceReadingState | null
  getSourceReadingByBook?: (readingBookId: string) => SourceReadingContext | null
  connectors?: Partial<Record<RemoteLibraryKind, TextLibraryConnector>>
  secretCodec?: { encrypt(value: string): string; decrypt(value: string): string }
  /** Controlled fixtures only; production leaves this unset. */
  wikisource?: WikisourceTextSource
  plugins?: PluginTextSources
}
interface DiskLibrary extends Omit<RemoteLibraryInfo, 'hasCredentials'> {
  secret?: string
}
interface DiskState {
  schemaVersion: 1
  libraries: DiskLibrary[]
  manifests: Record<string, number>
  imports: Record<string, string>
}
const KINDS: RemoteLibraryKind[] = ['opds', 'webdav', 'audiobookshelf']
const invalid = (message: string): never => {
  throw new SourceError('INVALID_SOURCE_REQUEST', message)
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const validId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-zA-Z0-9_-]{1,100}$/.test(value) &&
  value !== 'wikisource' &&
  !['__proto__', 'constructor', 'prototype'].includes(value)

export function validateRemoteLibrary(input: unknown, requireId = false): RemoteLibraryConfig {
  if (
    !object(input) ||
    Object.keys(input).some(
      (key) =>
        !['id', 'kind', 'label', 'baseUrl', 'enabled', 'username', 'password', 'token'].includes(
          key,
        ),
    )
  )
    return invalid('书库配置字段无效。')
  if ((requireId || input.id !== undefined) && !validId(input.id))
    return invalid('书库连接标识无效。')
  if (
    !KINDS.includes(input.kind as RemoteLibraryKind) ||
    typeof input.label !== 'string' ||
    !input.label.trim() ||
    input.label.length > 100 ||
    typeof input.baseUrl !== 'string' ||
    input.baseUrl.length > 4000 ||
    typeof input.enabled !== 'boolean'
  )
    return invalid('请填写书库类型、名称和地址。')
  const url = sourceUrl(input.baseUrl)
  if (
    [...url.searchParams.keys()].some((key) =>
      /token|password|secret|authorization|api.?key/i.test(key),
    )
  )
    return invalid('请把连接凭据填写到专用凭据字段，不要写在书库地址中。')
  for (const key of ['username', 'password', 'token']) {
    const value = input[key]
    if (
      value !== undefined &&
      (typeof value !== 'string' ||
        value.length > 4000 ||
        /[\r\n]/.test(value) ||
        value.includes('\u0000'))
    )
      return invalid('书库凭据格式无效。')
  }
  return {
    ...input,
    label: input.label.trim(),
    baseUrl: url.href,
  } as unknown as RemoteLibraryConfig
}

export function parseRemoteManifest(rawJson: string): RemoteLibraryManifest {
  if (typeof rawJson !== 'string' || Buffer.byteLength(rawJson) > 128 * 1024)
    return invalid('连接清单必须是不超过 128 KiB 的 JSON。')
  let raw: unknown
  try {
    raw = JSON.parse(rawJson)
  } catch {
    return invalid('连接清单不是有效 JSON。')
  }
  if (
    !object(raw) ||
    Object.keys(raw).some(
      (key) => !['schemaVersion', 'id', 'version', 'libraries'].includes(key),
    ) ||
    raw.schemaVersion !== 1 ||
    !validId(raw.id) ||
    !Number.isSafeInteger(raw.version) ||
    Number(raw.version) < 1 ||
    !Array.isArray(raw.libraries) ||
    raw.libraries.length > 40
  )
    return invalid('只支持 schemaVersion=1、正整数 version 的受限连接清单。')
  const ids = new Set<string>()
  const libraries = raw.libraries.map((entry: unknown) => {
    if (
      !object(entry) ||
      Object.keys(entry).some((key) => !['id', 'kind', 'label', 'baseUrl', 'enabled'].includes(key))
    )
      return invalid('连接清单只接受连接信息，不接受凭据、脚本或第三方解析规则。')
    const config = validateRemoteLibrary(entry, true)
    if (ids.has(config.id!)) return invalid('连接清单包含重复连接标识。')
    ids.add(config.id!)
    return config as RemoteLibraryManifest['libraries'][number]
  })
  return { schemaVersion: 1, id: raw.id, version: Number(raw.version), libraries }
}

export class TextSourceService {
  private filename: string
  private disk: DiskState = { schemaVersion: 1, libraries: [], manifests: {}, imports: {} }
  private connectors: Partial<Record<RemoteLibraryKind, TextLibraryConnector>>
  private wiki: WikisourceTextSource
  private requests = new Map<string, AbortController>()
  private importing = new Set<string>()
  private closed = false

  constructor(private options: TextSourceOptions) {
    mkdirSync(options.directory, { recursive: true })
    this.filename = join(options.directory, 'text-libraries.json')
    this.connectors = { opds: new OpdsTextConnector(), ...options.connectors }
    this.wiki = options.wikisource ?? new WikisourceTextSource()
    if (existsSync(this.filename)) {
      const raw = JSON.parse(readFileSync(this.filename, 'utf8')) as DiskState
      if (
        raw.schemaVersion !== 1 ||
        !Array.isArray(raw.libraries) ||
        raw.libraries.length > 40 ||
        !object(raw.manifests) ||
        !object(raw.imports)
      )
        throw new SourceError('SOURCE_CHANGED', '个人书库配置格式无效，请保留文件并检查配置。')
      // Validate public values before any persisted address can trigger a request.
      for (const library of raw.libraries)
        validateRemoteLibrary(
          {
            id: library.id,
            kind: library.kind,
            label: library.label,
            baseUrl: library.baseUrl,
            enabled: library.enabled,
          },
          true,
        )
      this.disk = raw
    }
  }

  private persist() {
    const temporary = `${this.filename}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(this.disk, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.filename)
  }

  private publicInfo(library: DiskLibrary): RemoteLibraryInfo {
    const { id, kind, label, baseUrl, enabled, lastCheckedAt, lastCheckError } = library
    return {
      id,
      kind,
      label,
      baseUrl,
      enabled,
      lastCheckedAt,
      lastCheckError,
      hasCredentials: !!library.secret,
    }
  }

  state(): TextSourceState {
    return {
      sources: [
        {
          id: 'wikisource',
          name: '中文维基文库',
          kind: 'wikisource',
          baseUrl: WIKISOURCE_URL,
          description: '官方 API · 先选章节，再导入正文',
        },
        ...(this.options.plugins?.sources() ?? []),
        ...this.disk.libraries
          .filter((item) => item.enabled && this.connectors[item.kind])
          .map((item) => ({
            id: item.id,
            name: item.label,
            kind: item.kind,
            baseUrl: item.baseUrl,
            description: item.kind === 'opds' ? '个人 OPDS 1.x 书库' : '个人书库连接',
          })),
      ],
      libraries: this.disk.libraries.map((item) => this.publicInfo(item)),
    }
  }

  save(input: RemoteLibraryConfig): RemoteLibraryInfo {
    const config = validateRemoteLibrary(input)
    const id = config.id ?? `lib-${randomUUID()}`
    const previous = this.disk.libraries.find((item) => item.id === id)
    if (!previous && this.disk.libraries.length >= 40) return invalid('最多可配置 40 个个人书库。')
    let credentials: { username?: string; password?: string; token?: string } = {}
    if (
      previous?.secret &&
      previous.kind === config.kind &&
      new URL(previous.baseUrl).origin === new URL(config.baseUrl).origin
    ) {
      if (!this.options.secretCodec) return invalid('当前系统无法读取书库凭据，请重新填写。')
      try {
        credentials = JSON.parse(this.options.secretCodec.decrypt(previous.secret))
      } catch {
        if (config.password === undefined && config.token === undefined)
          return invalid('书库凭据已不可读取，请重新填写。')
      }
    }
    for (const key of ['username', 'password', 'token'] as const)
      if (config[key] !== undefined) credentials[key] = config[key] || undefined
    const hasSecrets = !!(credentials.username || credentials.password || credentials.token)
    if (hasSecrets && !this.options.secretCodec) return invalid('系统凭据保护不可用，未保存密码。')
    const library: DiskLibrary = {
      id,
      kind: config.kind,
      label: config.label,
      baseUrl: config.baseUrl,
      enabled: config.enabled,
      lastCheckedAt: null,
      lastCheckError: null,
      ...(hasSecrets
        ? { secret: this.options.secretCodec!.encrypt(JSON.stringify(credentials)) }
        : {}),
    }
    this.disk.libraries = [...this.disk.libraries.filter((item) => item.id !== id), library]
    this.persist()
    return this.publicInfo(library)
  }

  remove(id: string): void {
    if (!validId(id)) return invalid('书库连接标识无效。')
    this.disk.libraries = this.disk.libraries.filter((item) => item.id !== id)
    this.persist()
  }

  private pluginSource(id: string) {
    const source = this.options.plugins?.sources().find((item) => item.id === id)
    if (!source)
      throw new SourceError(
        'SOURCE_UNAVAILABLE',
        '此正文插件已停用或移除，已导入的电子书仍可阅读。',
      )
    return source
  }

  private context(
    sourceId: string,
    signal: AbortSignal,
  ): { context: TextLibraryContext; connector: TextLibraryConnector } {
    const library = this.disk.libraries.find((item) => item.id === sourceId && item.enabled)
    if (!library) return invalid('个人书库不存在或已停用，请检查连接设置。')
    const connector = this.connectors[library.kind]
    if (!connector) return invalid('此书库类型尚未配置连接器。')
    let secret: { username?: string; password?: string; token?: string } = {}
    if (library.secret) {
      if (!this.options.secretCodec) return invalid('系统凭据保护不可用，请重新填写连接凭据。')
      try {
        secret = JSON.parse(this.options.secretCodec.decrypt(library.secret))
      } catch {
        return invalid('书库凭据不可读取，请重新填写连接凭据。')
      }
    }
    const connection: StoredRemoteLibrary = { ...this.publicInfo(library), ...secret }
    return { connector, context: { connection, http: new TextHttpClient(connection), signal } }
  }

  private async run<T>(requestId: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!/^[\w-]{1,120}$/.test(requestId)) return invalid('书库请求标识无效。')
    if (this.closed) throw new SourceError('SOURCE_CANCELED', '书库服务已关闭。')
    if (this.requests.has(requestId)) throw new SourceError('SOURCE_BUSY', '书库请求标识正在使用。')
    if (this.requests.size >= 8) throw new SourceError('SOURCE_BUSY', '书库请求过多，请稍后重试。')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort('timeout'), 120_000)
    this.requests.set(requestId, controller)
    try {
      return await action(controller.signal)
    } catch (error) {
      if (controller.signal.aborted)
        throw new SourceError(
          controller.signal.reason === 'timeout' ? 'SOURCE_TIMEOUT' : 'SOURCE_CANCELED',
          controller.signal.reason === 'timeout'
            ? '书库操作超时，请减少本次章节范围。'
            : '书库请求已取消。',
        )
      throw error
    } finally {
      clearTimeout(timeout)
      this.requests.delete(requestId)
    }
  }

  cancel(requestId: string): void {
    this.requests.get(requestId)?.abort()
  }
  get busy(): boolean {
    return this.requests.size > 0 || this.importing.size > 0
  }
  close(): void {
    this.closed = true
    for (const request of this.requests.values()) request.abort()
  }

  browse(request: TextBrowseRequest) {
    return this.run(request.requestId, async (signal) => {
      if (request.sourceId === 'wikisource') return this.wiki.browse(request, signal)
      if (request.sourceId.startsWith('plugin:')) {
        this.pluginSource(request.sourceId)
        return this.options.plugins!.browse(request, signal)
      }
      const { connector, context } = this.context(request.sourceId, signal)
      return connector.browse(context, request)
    })
  }

  detail(request: TextDetailRequest) {
    return this.run(request.requestId, (signal) => this.readDetail(request, signal))
  }

  private async readDetail(request: TextDetailRequest, signal: AbortSignal) {
    let detail: TextBookDetail
    if (request.sourceId === 'wikisource') {
      if (request.cursor) return invalid('此来源目录没有后续分页。')
      detail = await this.wiki.detail(request.workId, signal)
    } else if (request.sourceId.startsWith('plugin:')) {
      this.pluginSource(request.sourceId)
      detail = await this.options.plugins!.detail(request, signal)
    } else {
      if (request.cursor) return invalid('文件书库目录不使用章节分页。')
      const { connector, context } = this.context(request.sourceId, signal)
      detail = await connector.detail(context, request.workId)
    }
    const saved = this.sourceReading(this.sourceIdentity(request))
    if (saved) this.checkSourceOrders(saved, detail.chapters)
    return {
      ...detail,
      downloadedChapterIds: saved?.downloadedChapterIds ?? [],
      readingBookId: saved?.readingBookId ?? null,
      lastDownloadedOrder: saved ? Math.max(-1, ...Object.values(saved.chapterOrders)) : -1,
    }
  }

  private sourceIdentity(request: Pick<TextDetailRequest, 'sourceId' | 'workId'>) {
    const plugin = request.sourceId.startsWith('plugin:')
      ? this.pluginSource(request.sourceId)
      : null
    const library = this.disk.libraries.find((item) => item.id === request.sourceId)
    const endpoint = plugin
      ? ['plugin', plugin.baseUrl]
      : library
        ? [library.kind, library.baseUrl]
        : ['wikisource', WIKISOURCE_URL]
    return createHash('sha256')
      .update(JSON.stringify([endpoint, request.sourceId, request.workId]))
      .digest('hex')
  }

  private sourceReading(key: string) {
    const saved = this.options.getSourceReading?.(key)
    return saved && this.options.getReadingBook(saved.readingBookId) ? saved : null
  }

  private checkSourceOrders(saved: SourceReadingState, chapters: TextBookDetail['chapters']) {
    for (const chapter of chapters)
      if (
        Object.hasOwn(saved.chapterOrders, chapter.id) &&
        saved.chapterOrders[chapter.id] !== chapter.order
      )
        throw new SourceError(
          'SOURCE_CHANGED',
          '网站已改变已下载章节的目录顺序；原书与阅读位置保留，请重新核对。',
        )
  }

  import(request: TextImportRequest): Promise<TextImportResult> {
    return this.run(request.requestId, (signal) => this.importSelected(request, signal))
  }

  private async importSelected(
    request: TextImportRequest,
    signal: AbortSignal,
  ): Promise<TextImportResult> {
    const plugin = request.sourceId.startsWith('plugin:')
      ? this.pluginSource(request.sourceId)
      : null
    const remote =
      request.sourceId === 'wikisource' || plugin ? null : this.context(request.sourceId, signal)
    const endpoint = remote
      ? [remote.context.connection.kind, remote.context.connection.baseUrl]
      : plugin
        ? ['plugin', plugin.baseUrl]
        : ['wikisource', WIKISOURCE_URL]
    const selection =
      request.sourceId === 'wikisource' || plugin
        ? [...(request.chapterIds ?? [])].sort()
        : (request.acquisitionId ?? '')
    if (!selection.length) return invalid('请先选择本次导入范围或获取格式。')
    const chapterSource = request.sourceId === 'wikisource' || !!plugin
    if (chapterSource && this.options.importChapters) {
      const ids = request.chapterIds ?? []
      if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length)
        return invalid('请选择 1–20 个不重复的章节。')
      const sourceKey = this.sourceIdentity(request)
      if (this.importing.has(sourceKey))
        throw new SourceError('SOURCE_BUSY', '这本书正在追加章节，请稍候。')
      this.importing.add(sourceKey)
      try {
        const prior = this.sourceReading(sourceKey)
        const downloaded = new Set(prior?.downloadedChapterIds ?? [])
        const fresh = ids.filter((id) => !downloaded.has(id))
        if (!fresh.length && prior) {
          signal.throwIfAborted()
          return {
            book: this.options.getReadingBook(prior.readingBookId)!,
            reused: true,
            sourceId: request.sourceId,
            workId: request.workId,
            appended: false,
            addedChapterIds: [],
          }
        }
        const narrowed = { ...request, chapterIds: fresh }
        const download =
          request.sourceId === 'wikisource'
            ? await this.wiki.download(narrowed, signal)
            : await this.options.plugins!.download(narrowed, signal)
        signal.throwIfAborted()
        if (
          !download.chapters ||
          download.chapters.length !== fresh.length ||
          new Set(download.chapters.map((chapter) => chapter.id)).size !== fresh.length ||
          download.chapters.some((chapter) => !fresh.includes(chapter.id))
        )
          return invalid('来源没有返回所选章节的完整身份信息，未更改已有电子书。')
        if (prior) this.checkSourceOrders(prior, download.catalog ?? download.chapters)
        const book = await this.options.importChapters(
          {
            sourceKey,
            sourceId: request.sourceId,
            workId: request.workId,
            title: download.title ?? download.filename.replace(/\.txt$/i, ''),
            pageUrl: download.pageUrl ?? null,
            chapters: download.chapters,
          },
          signal,
        )
        return {
          book,
          reused: false,
          sourceId: request.sourceId,
          workId: request.workId,
          appended: !!prior,
          addedChapterIds: download.chapters.map((chapter) => chapter.id),
        }
      } finally {
        this.importing.delete(sourceKey)
      }
    }
    const identity = createHash('sha256')
      .update(JSON.stringify([endpoint, request.sourceId, request.workId, selection]))
      .digest('hex')
    const prior = this.disk.imports[identity]
    if (prior) {
      const book = this.options.getReadingBook(prior)
      if (book) return { book, reused: true, sourceId: request.sourceId, workId: request.workId }
    }
    if (this.importing.has(identity))
      throw new SourceError('SOURCE_BUSY', '相同书目正在导入，请稍候。')
    this.importing.add(identity)
    try {
      const download =
        request.sourceId === 'wikisource'
          ? await this.wiki.download(request, signal)
          : plugin
            ? await this.options.plugins!.download(request, signal)
            : await remote!.connector.download(remote!.context, request)
      // Last cancellation point precedes the immutable reading import transaction.
      signal.throwIfAborted()
      const book = await this.options.importBook(download.bytes, download.filename, signal)
      this.disk.imports[identity] = book.id
      this.persist()
      return { book, reused: false, sourceId: request.sourceId, workId: request.workId }
    } finally {
      this.importing.delete(identity)
    }
  }

  continueReading(request: TextContinueRequest): Promise<TextContinueResult> {
    return this.run(request.requestId, async (signal) => {
      const context = this.options.getSourceReadingByBook?.(request.readingBookId)
      const book = this.options.getReadingBook(request.readingBookId)
      if (!context || !book) return invalid('只有来源分章导入的电子书可以获取后续章节。')
      if (this.sourceReading(this.sourceIdentity(context))?.readingBookId !== book.id)
        throw new SourceError(
          'SOURCE_CHANGED',
          '来源地址或书目身份已变化，原书保留，请先核对来源。',
        )
      const last = Math.max(-1, ...Object.values(context.chapterOrders))
      const downloaded = new Set(context.downloadedChapterIds)
      const cursors = new Set<string>()
      let cursor: string | undefined
      for (let page = 0; page < 32; page++) {
        signal.throwIfAborted()
        const detail = await this.readDetail(
          {
            requestId: request.requestId,
            sourceId: context.sourceId,
            workId: context.workId,
            ...(cursor ? { cursor } : {}),
          },
          signal,
        )
        const next = detail.chapters.find(
          (chapter) =>
            !downloaded.has(chapter.id) && chapter.order !== undefined && chapter.order > last,
        )
        if (next) {
          const imported = await this.importSelected(
            {
              requestId: request.requestId,
              sourceId: context.sourceId,
              workId: context.workId,
              chapterIds: [next.id],
              ...(detail.chapterCursor ? { chapterCursor: detail.chapterCursor } : {}),
            },
            signal,
          )
          return {
            book: imported.book,
            noMore: false,
            appended: !!imported.appended,
            addedChapterIds: imported.addedChapterIds ?? [],
            lastDownloadedOrder: Math.max(last, next.order ?? last),
            message: `已获取“${next.title}”，阅读位置已保留。`,
          }
        }
        if (!detail.nextCursor) {
          if (detail.catalogComplete === false)
            throw new SourceError(
              'SOURCE_UNAVAILABLE',
              '当前已读取目录没有后续章节，尚不能确认全书目录完整；请到来源目录核对。',
            )
          return {
            book,
            noMore: true,
            appended: false,
            addedChapterIds: [],
            lastDownloadedOrder: last,
            message: '当前来源目录没有后续章节。',
          }
        }
        if (cursors.has(detail.nextCursor))
          throw new SourceError('SOURCE_CHANGED', '来源目录分页重复，请重新打开目录。')
        cursors.add(detail.nextCursor)
        cursor = detail.nextCursor
      }
      throw new SourceError(
        'SOURCE_UNAVAILABLE',
        '本次已达到目录检查上限，尚未确认全书结束；请在来源目录继续加载后选择章节。',
      )
    })
  }

  check(request: { requestId: string; sourceId: string }): Promise<RemoteLibraryInfo> {
    return this.run(request.requestId, async (signal) => {
      const library = this.disk.libraries.find((item) => item.id === request.sourceId)
      if (!library) return invalid('找不到该书库连接。')
      try {
        const { connector, context } = this.context(request.sourceId, signal)
        await connector.browse(context, { ...request })
        signal.throwIfAborted()
        library.lastCheckedAt = new Date().toISOString()
        library.lastCheckError = null
      } catch (error) {
        if (signal.aborted) throw error
        library.lastCheckedAt = new Date().toISOString()
        library.lastCheckError =
          error instanceof SourceError ? error.message : '连接检查失败，请检查书库地址。'
      }
      this.persist()
      return this.publicInfo(library)
    })
  }

  manifestPreview(rawJson: string): RemoteManifestPreview {
    const manifest = parseRemoteManifest(rawJson)
    const currentVersion = this.disk.manifests[manifest.id] ?? null
    return {
      manifest,
      additions: manifest.libraries
        .filter((item) => !this.disk.libraries.some((saved) => saved.id === item.id))
        .map((item) => item.id),
      updates: manifest.libraries
        .filter((item) => this.disk.libraries.some((saved) => saved.id === item.id))
        .map((item) => item.id),
      currentVersion,
      applicable: currentVersion === null || manifest.version > currentVersion,
    }
  }

  manifestApply(rawJson: string): TextSourceState {
    const preview = this.manifestPreview(rawJson)
    if (!preview.applicable) return invalid('该连接清单版本没有增加，不能覆盖当前版本。')
    const merged = new Set([
      ...this.disk.libraries.map((item) => item.id),
      ...preview.manifest.libraries.map((item) => item.id),
    ])
    if (merged.size > 40) return invalid('应用后将超过 40 个书库连接。')
    // Preview is side-effect free. Explicit apply merges only public connection values.
    const replacements = preview.manifest.libraries.map((config): DiskLibrary => {
      const old = this.disk.libraries.find((item) => item.id === config.id)
      const preserveSecret =
        old?.secret &&
        old.kind === config.kind &&
        new URL(old.baseUrl).origin === new URL(config.baseUrl).origin
      return {
        ...config,
        lastCheckedAt: null,
        lastCheckError: null,
        ...(preserveSecret ? { secret: old.secret } : {}),
      }
    })
    const replaced = new Set(replacements.map((item) => item.id))
    this.disk.libraries = [
      ...this.disk.libraries.filter((item) => !replaced.has(item.id)),
      ...replacements,
    ]
    this.disk.manifests[preview.manifest.id] = preview.manifest.version
    this.persist()
    return this.state()
  }

  manifestExport(): string {
    const manifest: RemoteLibraryManifest = {
      schemaVersion: 1,
      id: 'personal-libraries',
      version: Date.now(),
      libraries: this.disk.libraries.map(({ id, kind, label, baseUrl, enabled }) => ({
        id,
        kind,
        label,
        baseUrl,
        enabled,
      })),
    }
    return JSON.stringify(manifest, null, 2)
  }
}
