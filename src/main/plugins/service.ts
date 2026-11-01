import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AudioSourceInfo,
  PluginInfo,
  PluginPreview,
  PluginState,
  PluginTestReport,
} from '../../shared/plugins'
import { SourceError, type SourceAdapter } from '../../shared/sources'
import { downloadPluginPackage } from './download'
import type {
  TextBookDetail,
  TextBrowseRequest,
  TextDetailRequest,
  TextImportRequest,
  TextSourceInfo,
} from '../../shared/text-sources'
import type { TextDownload } from '../sources/text-provider'
import {
  MAX_PLUGIN_ZIP_BYTES,
  comparePluginVersions,
  invalidPlugin,
  pluginId,
  pluginObject,
  pluginResourceId,
  pluginSourceInfo,
  pluginString,
  PLUGIN_SOURCE_ID,
} from './manifest'
import { parsePluginPackage, type ParsedPluginPackage } from './package'
import {
  chapterBody,
  pluginAudioAdapter,
  pluginChapters,
  pluginTextSummary,
  textBrowsePage,
} from './adapters'
import type {
  PluginInspectRequest,
  PluginMethod,
  PluginRuntimeRequest,
  PluginRuntimeSource,
} from './runtime-types'

export interface PluginExecutor {
  inspect(request: PluginInspectRequest): Promise<PluginRuntimeSource[]>
  execute(request: PluginRuntimeRequest): Promise<unknown>
}

interface StoredPlugin {
  id: string
  current: string
  previous: string | null
  enabled: boolean
  installedAt: string
}
interface Registry {
  schemaVersion: 1
  plugins: StoredPlugin[]
}
interface PreviewRecord {
  value: PluginPreview
  parsed: ParsedPluginPackage
  bytes: Buffer
  previous: string | null
}

export interface PluginServiceOptions {
  directory: string
  runtime: PluginExecutor
  onChanged?: () => void
}

const digestPattern = /^[a-f0-9]{64}$/
const requestPattern = /^[\w-]{1,120}$/
const REQUIRED: Record<'audio' | 'text', PluginMethod[]> = {
  audio: ['search', 'getBook', 'getEpisodes', 'resolveAudio'],
  text: ['search', 'getBook', 'getChapters', 'getChapterText'],
}
interface TextCatalogCursor {
  sourceId: string
  workId: string
  packageHash: string
  cursor: string
  offset: number
  prefixHashes: string[]
  anchor: { cursor: string | null; hash: string }
}

export class PluginService {
  private filename: string
  private packagesDirectory: string
  private registry: Registry = { schemaVersion: 1, plugins: [] }
  private loadError: SourceError | null = null
  private previews = new Map<string, PreviewRecord>()
  private packages = new Map<string, ParsedPluginPackage>()
  private adapters = new Map<string, SourceAdapter>()
  private requests = new Map<string, AbortController>()
  private textCursors = new Map<string, TextCatalogCursor>()
  private mutating = false
  private closed = false

  constructor(private options: PluginServiceOptions) {
    mkdirSync(options.directory, { recursive: true })
    this.filename = join(options.directory, 'plugins.json')
    this.packagesDirectory = join(options.directory, 'packages')
    mkdirSync(this.packagesDirectory, { recursive: true })
    if (existsSync(this.filename)) {
      try {
        if (statSync(this.filename).size > 128 * 1024) throw new Error()
        const raw = pluginObject(JSON.parse(readFileSync(this.filename, 'utf8')))
        if (raw.schemaVersion !== 1 || !Array.isArray(raw.plugins) || raw.plugins.length > 20)
          throw new Error()
        const records = raw.plugins.map((value): StoredPlugin => {
          const row = pluginObject(value)
          if (
            !digestPattern.test(String(row.current)) ||
            (row.previous !== null && !digestPattern.test(String(row.previous))) ||
            typeof row.enabled !== 'boolean' ||
            typeof row.installedAt !== 'string' ||
            !Number.isFinite(Date.parse(row.installedAt))
          )
            throw new Error()
          const id = pluginId(row.id)
          const parsed = this.readPackage(String(row.current))
          if (parsed.manifest.id !== id) throw new Error()
          if (row.previous !== null && this.readPackage(String(row.previous)).manifest.id !== id)
            throw new Error()
          return {
            id,
            current: String(row.current),
            previous: row.previous === null ? null : String(row.previous),
            enabled: row.enabled,
            installedAt: row.installedAt,
          }
        })
        if (new Set(records.map((row) => row.id)).size !== records.length) throw new Error()
        this.registry = { schemaVersion: 1, plugins: records }
      } catch {
        // Existing files remain untouched; a broken plugin registry must not stop local reading.
        this.loadError = new SourceError(
          'SOURCE_CHANGED',
          '插件登记文件损坏或插件包缺失，文件已保留；请检查插件目录后重试。',
        )
      }
    }
  }

  private ready() {
    if (this.closed) throw new SourceError('SOURCE_CANCELED', '插件服务已关闭。')
    if (this.loadError) throw this.loadError
  }

  private readPackage(sha: string): ParsedPluginPackage {
    if (!digestPattern.test(sha)) return invalidPlugin('插件包校验标识无效。')
    const cached = this.packages.get(sha)
    if (cached) return cached
    const filename = join(this.packagesDirectory, `${sha}.zip`)
    if (statSync(filename).size > MAX_PLUGIN_ZIP_BYTES)
      return invalidPlugin('已安装插件包超过 8 MiB。')
    const bytes = readFileSync(filename)
    const parsed = parsePluginPackage(bytes)
    if (parsed.sha256 !== sha)
      throw new SourceError('SOURCE_CHANGED', '已安装插件包的校验值已改变。')
    this.rememberPackage(parsed)
    return parsed
  }

  private rememberPackage(parsed: ParsedPluginPackage) {
    if (this.packages.size >= 8) this.packages.delete(this.packages.keys().next().value!)
    this.packages.set(parsed.sha256, parsed)
  }

  private info(record: StoredPlugin): PluginInfo {
    const parsed = this.readPackage(record.current)
    return {
      id: record.id,
      name: parsed.manifest.name,
      version: parsed.manifest.version,
      enabled: record.enabled,
      installedAt: record.installedAt,
      sha256: record.current,
      previousVersion: record.previous ? this.readPackage(record.previous).manifest.version : null,
      sources: pluginSourceInfo(parsed.manifest),
    }
  }

  list(): PluginState {
    this.ready()
    const plugins = this.registry.plugins.map((record) => this.info(record))
    return {
      plugins,
      sources: plugins.filter((plugin) => plugin.enabled).flatMap((plugin) => plugin.sources),
    }
  }

  audioSources(): AudioSourceInfo[] {
    if (this.loadError || this.closed) return []
    return this.list()
      .sources.filter((source) => source.kind === 'audio')
      .map((source) => ({
        id: source.id,
        name: source.name,
        kind: 'audio',
        description: source.description,
        homepage: source.baseUrl,
        language: '由插件提供',
        maxQueryLength: 200,
        pluginId: source.pluginId,
      }))
  }

  textSources(): TextSourceInfo[] {
    if (this.loadError || this.closed) return []
    return this.list()
      .sources.filter((source) => source.kind === 'text')
      .map((source) => ({
        id: source.id,
        name: source.name,
        kind: 'plugin',
        baseUrl: source.baseUrl,
        description: source.description,
      }))
  }

  private persist(registry: Registry) {
    const temporary = `${this.filename}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(registry, null, 2), {
      flag: 'wx',
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporary, this.filename)
    this.registry = registry
    this.options.onChanged?.()
  }

  private assertUpdate(parsed: ParsedPluginPackage): StoredPlugin | undefined {
    const existing = this.registry.plugins.find((plugin) => plugin.id === parsed.manifest.id)
    if (!existing) {
      if (this.registry.plugins.length >= 20) return invalidPlugin('最多可安装 20 个插件包。')
      return undefined
    }
    const old = this.readPackage(existing.current)
    if (comparePluginVersions(parsed.manifest.version, old.manifest.version) <= 0)
      return invalidPlugin('插件版本必须高于当前已安装版本。')
    for (const source of old.manifest.sources)
      if (
        !parsed.manifest.sources.some(
          (candidate) => candidate.id === source.id && candidate.kind === source.kind,
        )
      )
        return invalidPlugin('更新不能删除已有来源 ID 或改变来源类型；请使用新的插件 ID。')
    return existing
  }

  previewFile(bytes: Buffer): PluginPreview {
    this.ready()
    const parsed = parsePluginPackage(bytes)
    const existing = this.assertUpdate(parsed)
    const value: PluginPreview = {
      previewId: randomUUID(),
      id: parsed.manifest.id,
      name: parsed.manifest.name,
      version: parsed.manifest.version,
      sha256: parsed.sha256,
      action: existing ? 'update' : 'install',
      previousVersion: existing ? this.readPackage(existing.current).manifest.version : null,
      sources: pluginSourceInfo(parsed.manifest),
      bytes: bytes.length,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    }
    if (this.previews.size >= 4) this.previews.delete(this.previews.keys().next().value!)
    this.previews.set(value.previewId, {
      value,
      parsed,
      bytes: Buffer.from(bytes),
      previous: existing?.current ?? null,
    })
    return structuredClone(value)
  }

  private async request<T>(id: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.ready()
    if (!requestPattern.test(id)) return invalidPlugin('插件请求 ID 无效。')
    if (this.requests.has(id) || this.requests.size >= 8)
      throw new SourceError('SOURCE_BUSY', '插件请求正在执行或数量过多。')
    const controller = new AbortController()
    this.requests.set(id, controller)
    const timeout = setTimeout(() => controller.abort('timeout'), 60_000)
    try {
      const result = await action(controller.signal)
      controller.signal.throwIfAborted()
      return result
    } catch (error) {
      if (controller.signal.aborted)
        throw new SourceError(
          controller.signal.reason === 'timeout' ? 'SOURCE_TIMEOUT' : 'SOURCE_CANCELED',
          controller.signal.reason === 'timeout' ? '插件操作超时。' : '插件操作已取消。',
        )
      throw error
    } finally {
      clearTimeout(timeout)
      this.requests.delete(id)
    }
  }

  previewUrl(request: { requestId: string; url: string }): Promise<PluginPreview> {
    return this.request(request.requestId, async (signal) =>
      this.previewFile(await downloadPluginPackage(request.url, signal)),
    )
  }

  async install(previewId: string): Promise<PluginState> {
    this.ready()
    if (this.mutating) throw new SourceError('SOURCE_BUSY', '插件管理正在处理另一个操作。')
    const preview = this.previews.get(previewId)
    if (!preview || Date.parse(preview.value.expiresAt) < Date.now())
      return invalidPlugin('插件预览已过期，请重新选择。')
    const existing = this.assertUpdate(preview.parsed)
    if ((existing?.current ?? null) !== preview.previous)
      return invalidPlugin('已安装插件在预览后发生变化，请重新预览。')
    this.mutating = true
    try {
      const sources = await this.request(previewId, (signal) =>
        this.options.runtime.inspect({
          scripts: preview.parsed.scripts,
          signal,
          timeoutMs: 10_000,
        }),
      )
      if (
        sources.length !== preview.parsed.manifest.sources.length ||
        new Set(sources.map((source) => source.id)).size !== sources.length
      )
        return invalidPlugin('脚本注册的来源与清单不一致。')
      for (const source of preview.parsed.manifest.sources) {
        const registered = sources.find((candidate) => candidate.id === source.id)
        if (
          !registered ||
          REQUIRED[source.kind].some((method) => !registered.methods.includes(method))
        )
          return invalidPlugin('插件缺少清单中来源所需的 SDK 方法。')
      }
      this.ready()
      const filename = join(this.packagesDirectory, `${preview.parsed.sha256}.zip`)
      if (!existsSync(filename)) {
        const temporary = `${filename}.${randomUUID()}.tmp`
        writeFileSync(temporary, preview.bytes, { flag: 'wx', mode: 0o600 })
        renameSync(temporary, filename)
      } else if (
        statSync(filename).size > MAX_PLUGIN_ZIP_BYTES ||
        createHash('sha256').update(readFileSync(filename)).digest('hex') !== preview.parsed.sha256
      )
        throw new SourceError('SOURCE_CHANGED', '已有同校验名插件包已损坏，保留现有版本。')
      this.rememberPackage(preview.parsed)
      const record: StoredPlugin = {
        id: preview.parsed.manifest.id,
        current: preview.parsed.sha256,
        previous: existing?.current ?? null,
        enabled: existing?.enabled ?? true,
        installedAt: new Date().toISOString(),
      }
      this.persist({
        schemaVersion: 1,
        plugins: [...this.registry.plugins.filter((plugin) => plugin.id !== record.id), record],
      })
      this.previews.delete(previewId)
      return this.list()
    } finally {
      this.mutating = false
    }
  }

  private change(id: string, mutate: (record: StoredPlugin) => StoredPlugin | null): PluginState {
    this.ready()
    pluginId(id)
    if (this.mutating) throw new SourceError('SOURCE_BUSY', '插件管理正在处理另一个操作。')
    const old = this.registry.plugins.find((record) => record.id === id)
    if (!old) return invalidPlugin('插件不存在。')
    const next = mutate(old)
    this.persist({
      schemaVersion: 1,
      plugins: this.registry.plugins.flatMap((record) =>
        record.id === id ? (next ? [next] : []) : [record],
      ),
    })
    return this.list()
  }

  toggle(id: string, enabled: boolean): PluginState {
    if (typeof enabled !== 'boolean') return invalidPlugin('插件启停值无效。')
    return this.change(id, (record) => ({ ...record, enabled }))
  }
  remove(id: string): PluginState {
    return this.change(id, () => null)
  }
  rollback(id: string): PluginState {
    return this.change(id, (record) => {
      if (!record.previous) return invalidPlugin('此插件没有可回滚版本。')
      this.readPackage(record.previous)
      return {
        ...record,
        current: record.previous,
        previous: record.current,
        installedAt: new Date().toISOString(),
      }
    })
  }

  private snapshot(sourceId: string, kind?: 'audio' | 'text') {
    this.ready()
    const match = PLUGIN_SOURCE_ID.exec(sourceId)
    if (!match) return invalidPlugin('插件来源 ID 无效。')
    const record = this.registry.plugins.find((plugin) => plugin.id === match[1] && plugin.enabled)
    if (!record)
      throw new SourceError('SOURCE_UNAVAILABLE', '该插件已停用或移除；已有书籍和进度仍保留。')
    const parsed = this.readPackage(record.current)
    const source = pluginSourceInfo(parsed.manifest).find(
      (source) => source.localId === match[2] && (!kind || source.kind === kind),
    )
    if (!source) return invalidPlugin('插件没有提供此类来源。')
    const call = (method: PluginMethod, args: unknown[], signal: AbortSignal) =>
      this.options.runtime.execute({
        scripts: parsed.scripts,
        sourceId: source.localId,
        method,
        args,
        allowedOrigins: source.allowedOrigins,
        signal,
      })
    return { parsed, source, call }
  }

  audioAdapter(sourceId: string): SourceAdapter {
    const { parsed, source, call } = this.snapshot(sourceId, 'audio')
    const key = `${parsed.sha256}:${source.id}`
    let adapter = this.adapters.get(key)
    if (!adapter) {
      adapter = pluginAudioAdapter(source, call)
      this.adapters.set(key, adapter)
    }
    return adapter
  }

  textBrowse(request: TextBrowseRequest, signal: AbortSignal) {
    const { source, call } = this.snapshot(request.sourceId, 'text')
    const query = request.query === undefined ? '' : pluginString(request.query, 200, true).trim()
    const cursor = request.cursor === undefined ? null : pluginString(request.cursor, 2048)
    return call('search', [query, cursor], signal).then((value) => textBrowsePage(source, value))
  }

  private async detailSnapshot(
    request: TextDetailRequest,
    signal: AbortSignal,
    snapshot = this.snapshot(request.sourceId, 'text'),
  ) {
    const { source, call, parsed } = snapshot
    pluginResourceId(request.workId)
    const book = await call('getBook', [request.workId], signal)
    const summary = pluginTextSummary(source, book, request.workId)
    const ownedCursor = request.cursor ? this.textCursors.get(request.cursor) : undefined
    if (
      request.cursor &&
      (!ownedCursor ||
        ownedCursor.sourceId !== request.sourceId ||
        ownedCursor.workId !== request.workId ||
        ownedCursor.packageHash !== parsed.sha256)
    )
      return invalidPlugin('目录页已失效或属于另一书目，请重新打开目录。')
    if (request.cursor && ownedCursor) {
      this.textCursors.delete(request.cursor)
      this.textCursors.set(request.cursor, ownedCursor)
      const anchor = pluginChapters(
        await call('getChapters', [request.workId, ownedCursor.anchor.cursor], signal),
      )
      if (this.catalogPageHash(anchor.items) !== ownedCursor.anchor.hash)
        return invalidPlugin('网站目录顺序已变化，请重新打开目录核对；已下载正文保持不变。')
    }
    const chapters: TextBookDetail['chapters'] = [],
      seen = new Set<string>(ownedCursor?.prefixHashes ?? []),
      cursors = new Set<string>()
    let cursor: string | null = ownedCursor?.cursor ?? null
    const offset = ownedCursor?.offset ?? 0
    let anchor: TextCatalogCursor['anchor'] | null = null
    let complete = false
    for (let index = 0; index < 10; index++) {
      signal.throwIfAborted()
      const page = pluginChapters(await call('getChapters', [request.workId, cursor], signal))
      if (chapters.length && chapters.length + page.items.length > 1000) break
      anchor = { cursor, hash: this.catalogPageHash(page.items) }
      for (const chapter of page.items) {
        const hash = createHash('sha256').update(chapter.id).digest('hex')
        if (seen.has(hash)) return invalidPlugin('插件目录跨页含重复章节 ID。')
        seen.add(hash)
        if (offset + chapters.length >= 100000)
          return invalidPlugin('来源目录超过 100000 项，请按卷选择书目。')
        chapters.push({ ...chapter, order: offset + chapters.length })
      }
      if (!page.nextCursor) {
        complete = true
        break
      }
      if (cursors.has(page.nextCursor) || !page.items.length)
        return invalidPlugin('插件目录分页循环或为空。')
      cursors.add(page.nextCursor)
      cursor = page.nextCursor
      if (chapters.length >= 1000) break
    }
    let nextCursor: string | null = null
    if (!complete && cursor && anchor) {
      nextCursor = randomUUID()
      this.textCursors.set(nextCursor, {
        sourceId: request.sourceId,
        workId: request.workId,
        packageHash: parsed.sha256,
        cursor,
        offset: offset + chapters.length,
        prefixHashes: [...seen],
        anchor,
      })
      // Two adjacent long-book pages remain available for selection/import; older sessions expire.
      while (
        this.textCursors.size > 64 ||
        [...this.textCursors.values()].reduce((sum, item) => sum + item.prefixHashes.length, 0) >
          200000
      )
        this.textCursors.delete(this.textCursors.keys().next().value!)
    }
    return {
      ...summary,
      chapters,
      acquisitions: [],
      nextCursor,
      catalogComplete: complete,
      ...(request.cursor ? { chapterCursor: request.cursor } : {}),
      notice: complete
        ? null
        : '插件还有后续目录，可继续加载。每次选择最多 20 章，后续内容会追加到同一本书。',
    } satisfies TextBookDetail
  }

  private catalogPageHash(chapters: TextBookDetail['chapters']) {
    return createHash('sha256')
      .update(JSON.stringify(chapters.map((item) => [item.id, item.title])))
      .digest('hex')
  }

  textDetail(request: TextDetailRequest, signal: AbortSignal): Promise<TextBookDetail> {
    return this.detailSnapshot(request, signal)
  }

  async textDownload(request: TextImportRequest, signal: AbortSignal): Promise<TextDownload> {
    const snapshot = this.snapshot(request.sourceId, 'text')
    const detail = await this.detailSnapshot(
      {
        requestId: request.requestId,
        sourceId: request.sourceId,
        workId: request.workId,
        ...(request.chapterCursor ? { cursor: request.chapterCursor } : {}),
      },
      signal,
      snapshot,
    )
    const selected = new Set(request.chapterIds)
    if (!selected.size || selected.size > 20 || selected.size !== request.chapterIds?.length)
      return invalidPlugin('请选择 1–20 个不重复的插件章节。')
    const chapters = detail.chapters.filter((chapter) => selected.has(chapter.id))
    if (chapters.length !== selected.size) return invalidPlugin('所选章节不在插件当前目录中。')
    const pieces: string[] = []
    const contents: NonNullable<TextDownload['chapters']> = []
    let bytes = 0
    for (const [index, chapter] of chapters.entries()) {
      signal.throwIfAborted()
      const text = chapterBody(
        await snapshot.call('getChapterText', [request.workId, chapter.id], signal),
      )
      const piece = `第${index + 1}章 ${chapter.title}\n\n${text}`
      bytes += Buffer.byteLength(piece, 'utf8')
      if (bytes > 32 * 1024 * 1024 - 5000)
        return invalidPlugin('所选插件正文超过 32 MiB，请减少章节数量。')
      pieces.push(piece)
      contents.push({ ...chapter, text })
    }
    pieces.push(
      `来源：${snapshot.source.name}\n${detail.pageUrl ?? snapshot.source.baseUrl}\n本次导入 ${chapters.length} 项。`,
    )
    signal.throwIfAborted()
    return {
      bytes: Buffer.from(pieces.join('\n\n')),
      chapters: contents,
      title: detail.title,
      pageUrl: detail.pageUrl,
      catalog: detail.chapters,
      filename: `${detail.title.replace(/[<>:"/\\|?*\p{Cc}]/gu, '_').slice(0, 100) || '插件电子书'}（选${chapters.length}项）.txt`,
    }
  }

  test(request: {
    requestId: string
    id: string
    sourceId: string
    query?: string
  }): Promise<PluginTestReport> {
    return this.request(request.requestId, async (signal) => {
      const { parsed, source, call } = this.snapshot(request.sourceId)
      if (parsed.manifest.id !== request.id) return invalidPlugin('插件测试来源不匹配。')
      const steps: PluginTestReport['steps'] = []
      const report = (): PluginTestReport => ({
        id: request.id,
        sourceId: request.sourceId,
        version: parsed.manifest.version,
        passed: steps.length > 0 && steps.every((step) => step.status === 'passed'),
        steps,
      })
      try {
        const page = textBrowsePage(
          source,
          await call('search', [request.query?.trim() || '测试', null], signal),
        )
        steps.push({ name: '搜索', status: 'passed', message: `返回 ${page.books.length} 本书。` })
        const first = page.books[0]
        if (!first) {
          steps.push({
            name: '详情与内容',
            status: 'skipped',
            message: '搜索无结果，请更换测试关键词。',
          })
          return report()
        }
        const book = await call('getBook', [first.workId], signal)
        pluginTextSummary(source, book, first.workId)
        steps.push({ name: '详情', status: 'passed', message: first.title })
        if (source.kind === 'audio') {
          const adapter = pluginAudioAdapter(source, call)
          const page = await adapter.getEpisodes(first.workId, undefined, signal)
          steps.push({ name: '目录', status: 'passed', message: `读取 ${page.items.length} 集。` })
          if (page.items[0]) {
            await adapter.resolveAudio(first.workId, page.items[0].id, signal)
            steps.push({
              name: '音频解析',
              status: 'passed',
              message: '已验证媒体地址和请求头；未下载整集。',
            })
          } else steps.push({ name: '音频解析', status: 'skipped', message: '当前目录没有章节。' })
        } else {
          const chapters = pluginChapters(await call('getChapters', [first.workId, null], signal))
          steps.push({
            name: '目录',
            status: 'passed',
            message: `读取 ${chapters.items.length} 章。`,
          })
          if (chapters.items[0]) {
            const text = chapterBody(
              await call('getChapterText', [first.workId, chapters.items[0].id], signal),
            )
            steps.push({ name: '正文', status: 'passed', message: `取得 ${text.length} 字正文。` })
          } else steps.push({ name: '正文', status: 'skipped', message: '当前目录没有章节。' })
        }
      } catch (error) {
        if (signal.aborted) throw error
        steps.push({
          name: '执行',
          status: 'failed',
          message:
            error instanceof SourceError ? error.message : '插件执行失败，请检查脚本和返回结构。',
        })
      }
      return report()
    })
  }

  cancel(requestId: string): void {
    this.requests.get(requestId)?.abort()
  }
  close(): void {
    this.closed = true
    for (const request of this.requests.values()) request.abort()
    this.previews.clear()
    this.textCursors.clear()
  }
}
