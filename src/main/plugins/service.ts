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
  pluginUrl,
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

export class PluginService {
  private filename: string
  private packagesDirectory: string
  private registry: Registry = { schemaVersion: 1, plugins: [] }
  private loadError: SourceError | null = null
  private previews = new Map<string, PreviewRecord>()
  private packages = new Map<string, ParsedPluginPackage>()
  private adapters = new Map<string, SourceAdapter>()
  private requests = new Map<string, AbortController>()
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
    return this.request(request.requestId, async (signal) => {
      const initial = pluginUrl(request.url)
      let url = initial.href
      for (let redirect = 0; redirect <= 4; redirect++) {
        const response = await fetch(url, {
          redirect: 'manual',
          signal,
          headers: { Accept: 'application/zip, application/octet-stream' },
        })
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location')
          await response.body?.cancel()
          if (!location || redirect === 4) return invalidPlugin('插件下载重定向过多或无效。')
          const target = pluginUrl(new URL(location, url).href)
          if (target.origin !== initial.origin)
            return invalidPlugin('插件包下载重定向超出原域名，请使用直接下载地址。')
          url = target.href
          continue
        }
        if (
          response.status !== 200 ||
          response.headers.has('content-range') ||
          Number(response.headers.get('content-length') ?? 0) > MAX_PLUGIN_ZIP_BYTES ||
          !response.body
        ) {
          await response.body?.cancel()
          throw new SourceError('SOURCE_UNAVAILABLE', '插件包下载失败、响应不完整或超过 8 MiB。')
        }
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of response.body) {
          size += chunk.length
          if (size > MAX_PLUGIN_ZIP_BYTES) {
            await response.body.cancel().catch(() => undefined)
            return invalidPlugin('插件包超过 8 MiB。')
          }
          chunks.push(Buffer.from(chunk))
        }
        signal.throwIfAborted()
        return this.previewFile(Buffer.concat(chunks))
      }
      throw new SourceError('SOURCE_UNAVAILABLE', '插件包下载失败。')
    })
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
    const { source, call } = snapshot
    pluginResourceId(request.workId)
    const book = await call('getBook', [request.workId], signal)
    const summary = pluginTextSummary(source, book, request.workId)
    const chapters: TextBookDetail['chapters'] = [],
      seen = new Set<string>(),
      cursors = new Set<string>()
    let cursor: string | null = null
    let complete = false
    for (let index = 0; index < 10; index++) {
      signal.throwIfAborted()
      const page = pluginChapters(await call('getChapters', [request.workId, cursor], signal))
      for (const chapter of page.items) {
        if (seen.has(chapter.id)) return invalidPlugin('插件目录跨页含重复章节 ID。')
        seen.add(chapter.id)
        if (chapters.length < 1000) chapters.push(chapter)
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
    return {
      ...summary,
      chapters,
      acquisitions: [],
      notice: complete
        ? null
        : '这里只显示已读取目录；插件还有后续目录页。请选择本次要导入的章节，最多 20 项。',
    } satisfies TextBookDetail
  }

  textDetail(request: TextDetailRequest, signal: AbortSignal): Promise<TextBookDetail> {
    return this.detailSnapshot(request, signal)
  }

  async textDownload(request: TextImportRequest, signal: AbortSignal): Promise<TextDownload> {
    const snapshot = this.snapshot(request.sourceId, 'text')
    const detail = await this.detailSnapshot(request, signal, snapshot)
    const selected = new Set(request.chapterIds)
    if (!selected.size || selected.size > 20 || selected.size !== request.chapterIds?.length)
      return invalidPlugin('请选择 1–20 个不重复的插件章节。')
    const chapters = detail.chapters.filter((chapter) => selected.has(chapter.id))
    if (chapters.length !== selected.size) return invalidPlugin('所选章节不在插件当前目录中。')
    const pieces: string[] = []
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
    }
    pieces.push(
      `来源：${snapshot.source.name}\n${detail.pageUrl ?? snapshot.source.baseUrl}\n本次导入 ${chapters.length} 项。`,
    )
    signal.throwIfAborted()
    return {
      bytes: Buffer.from(pieces.join('\n\n')),
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
  }
}
