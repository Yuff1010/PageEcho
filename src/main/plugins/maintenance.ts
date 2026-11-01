import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  PluginHealth,
  PluginInfo,
  PluginPermissionChange,
  PluginPreview,
  PluginState,
  PluginTestReport,
  PluginUpdateCheck,
  PluginUpdateStatus,
} from '../../shared/plugins'
import { SourceError } from '../../shared/sources'
import {
  comparePluginVersions,
  invalidPlugin,
  pluginId,
  pluginUrl,
  PLUGIN_SOURCE_ID,
} from './manifest'
import { parsePluginPackage } from './package'
import { downloadPluginPackage } from './download'
import type { PluginService } from './service'

interface Entry {
  id: string
  updateUrl: string | null
  health: PluginHealth[]
  updateCheck: PluginUpdateStatus | null
}
interface PendingPreview {
  id: string
  expiresAt: number
}
export interface PluginMaintenanceOptions {
  directory: string
  service: Pick<
    PluginService,
    'list' | 'previewFile' | 'previewUrl' | 'install' | 'test' | 'cancel'
  >
}

export function cleanPluginUpdateUrl(value: unknown): string {
  const url = pluginUrl(value)
  if (
    url.protocol !== 'https:' ||
    url.search ||
    url.hash ||
    url.href.length > 4000 ||
    !url.pathname.toLowerCase().endsWith('.zip')
  )
    return invalidPlugin('更新地址需为不含参数、片段和账户凭据的 HTTPS ZIP 直链。')
  return url.href
}
function message(value: unknown): string {
  return (typeof value === 'string' ? value : '来源操作未完成，请重试。')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[网址已隐藏]')
    .replace(/(?:bearer\s+)[\w.~-]+/gi, '[凭据已隐藏]')
    .replace(/[\p{Cc}]/gu, ' ')
    .slice(0, 240)
}
const validTime = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value))
const validVersion = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value)

export function pluginPermissionChanges(
  before: PluginInfo | undefined,
  preview: PluginPreview,
): PluginPermissionChange[] {
  const permissions = (sources: PluginInfo['sources']) =>
    sources.flatMap((source) => [
      ...source.allowedOrigins.map((origin) => ({
        sourceId: source.id,
        sourceName: source.name,
        kind: 'request' as const,
        origin,
      })),
      ...(source.kind === 'audio'
        ? source.mediaOrigins.map((origin) => ({
            sourceId: source.id,
            sourceName: source.name,
            kind: 'audio' as const,
            origin,
          }))
        : []),
      ...(source.coverOrigins ?? source.allowedOrigins).map((origin) => ({
        sourceId: source.id,
        sourceName: source.name,
        kind: 'cover' as const,
        origin,
      })),
    ])
  const old = permissions(before?.sources ?? []),
    next = permissions(preview.sources)
  const key = (value: (typeof old)[number]) =>
    JSON.stringify([value.sourceId, value.kind, value.origin])
  const oldKeys = new Set(old.map(key)),
    nextKeys = new Set(next.map(key))
  return [
    ...next
      .filter((value) => !oldKeys.has(key(value)))
      .map((value) => ({ ...value, change: 'added' as const })),
    ...old
      .filter((value) => !nextKeys.has(key(value)))
      .map((value) => ({ ...value, change: 'removed' as const })),
  ]
}

/** Optional maintenance metadata never grants runtime privileges or automatically installs code. */
export class PluginMaintenance {
  private filename: string
  private entries = new Map<string, Entry>()
  private previews = new Map<string, PendingPreview>()
  private requests = new Map<string, AbortController>()
  private notice = ''
  private writable = true
  private closed = false

  constructor(private options: PluginMaintenanceOptions) {
    this.filename = join(options.directory, 'maintenance.json')
    try {
      mkdirSync(options.directory, { recursive: true })
      if (lstatSync(options.directory).isSymbolicLink()) throw new Error('Linked directory')
      let info
      try {
        info = lstatSync(this.filename)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024)
        throw new Error('Invalid metadata')
      const raw = JSON.parse(readFileSync(this.filename, 'utf8')) as {
        schemaVersion?: unknown
        entries?: unknown
      }
      if (raw?.schemaVersion !== 1 || !Array.isArray(raw.entries) || raw.entries.length > 20)
        throw new Error('Invalid metadata')
      for (const value of raw.entries) {
        const item = value as Entry
        const id = pluginId(item.id)
        if (this.entries.has(id) || !Array.isArray(item.health) || item.health.length > 40)
          throw new Error('Invalid metadata')
        const updateUrl = item.updateUrl === null ? null : cleanPluginUpdateUrl(item.updateUrl)
        const health = item.health.map((row): PluginHealth => {
          if (
            !row ||
            typeof row.sourceId !== 'string' ||
            !PLUGIN_SOURCE_ID.test(row.sourceId) ||
            !row.sourceId.startsWith(`plugin:${id}:`) ||
            !validVersion(row.version) ||
            !validTime(row.checkedAt) ||
            typeof row.passed !== 'boolean' ||
            typeof row.message !== 'string'
          )
            throw new Error('Invalid health')
          return {
            sourceId: row.sourceId,
            version: row.version,
            checkedAt: row.checkedAt,
            passed: row.passed,
            message: message(row.message),
          }
        })
        let updateCheck: PluginUpdateStatus | null = null
        if (item.updateCheck) {
          const row = item.updateCheck
          if (
            !validTime(row.checkedAt) ||
            !validVersion(row.currentVersion) ||
            (row.availableVersion !== null && !validVersion(row.availableVersion)) ||
            !['current', 'update', 'failed'].includes(row.status)
          )
            throw new Error('Invalid check')
          updateCheck = {
            checkedAt: row.checkedAt,
            currentVersion: row.currentVersion,
            availableVersion: row.availableVersion,
            status: row.status,
            message: message(row.message),
          }
        }
        this.entries.set(id, { id, updateUrl, health, updateCheck })
      }
    } catch {
      this.entries.clear()
      this.writable = false
      this.notice = '插件维护记录无法读取，原文件已保留；插件仍可使用，请检查数据目录。'
    }
  }

  private entry(id: string): Entry {
    return this.entries.get(id) ?? { id, updateUrl: null, health: [], updateCheck: null }
  }
  private installed(id: string): PluginInfo {
    pluginId(id)
    const plugin = this.options.service.list().plugins.find((value) => value.id === id)
    if (!plugin) return invalidPlugin('插件不存在。')
    return plugin
  }
  private persist(): void {
    if (!this.writable || this.closed)
      throw new SourceError('SOURCE_UNAVAILABLE', '插件维护记录当前无法保存。')
    const temporary = `${this.filename}.${randomUUID()}.tmp`
    writeFileSync(
      temporary,
      JSON.stringify({ schemaVersion: 1, entries: [...this.entries.values()] }) + '\n',
      { flag: 'wx', mode: 0o600 },
    )
    renameSync(temporary, this.filename)
    this.notice = ''
  }
  private saveOptional(): void {
    try {
      this.persist()
    } catch {
      this.notice = '本次维护结果未能保存，当前插件仍保持原安装状态。'
    }
  }
  state(state = this.options.service.list()): PluginState {
    return {
      ...state,
      plugins: state.plugins.map((plugin) => {
        const item = this.entry(plugin.id)
        return {
          ...plugin,
          updateUrl: item.updateUrl,
          health: item.health.map((row) => ({ ...row })),
          updateCheck: item.updateCheck ? { ...item.updateCheck } : null,
        }
      }),
      ...(this.notice ? { maintenanceNotice: this.notice } : {}),
    }
  }
  decoratePreview(preview: PluginPreview, address?: string): PluginPreview {
    const installed = this.options.service.list().plugins.find((plugin) => plugin.id === preview.id)
    let suggestedUpdateUrl = this.entry(preview.id).updateUrl
    if (address) {
      try {
        suggestedUpdateUrl = cleanPluginUpdateUrl(address)
      } catch {
        /* Temporary query URLs are never saved. */
      }
    }
    for (const [id, item] of this.previews)
      if (item.expiresAt < Date.now()) this.previews.delete(id)
    if (this.previews.size >= 16) this.previews.delete(this.previews.keys().next().value!)
    this.previews.set(preview.previewId, {
      id: preview.id,
      expiresAt: Date.parse(preview.expiresAt),
    })
    return {
      ...preview,
      permissionChanges: pluginPermissionChanges(installed, preview),
      suggestedUpdateUrl,
    }
  }
  async previewUrl(request: { requestId: string; url: string }): Promise<PluginPreview> {
    return this.decoratePreview(await this.options.service.previewUrl(request), request.url)
  }
  async install(request: { previewId: string; updateUrl?: string | null }): Promise<PluginState> {
    const address =
      request.updateUrl === undefined
        ? undefined
        : request.updateUrl === null
          ? null
          : cleanPluginUpdateUrl(request.updateUrl)
    const preview = this.previews.get(request.previewId)
    const state = await this.options.service.install(request.previewId)
    this.previews.delete(request.previewId)
    if (preview && address !== undefined) {
      const old = this.entry(preview.id)
      this.entries.set(preview.id, { ...old, updateUrl: address })
      try {
        this.persist()
      } catch {
        this.entries.set(preview.id, old)
        this.notice = '插件已安装，但更新地址未能保存；可稍后重新设置。'
      }
    }
    return this.state(state)
  }
  setUpdateUrl(request: { id: string; url: string | null }): PluginState {
    this.installed(request.id)
    const address = request.url === null ? null : cleanPluginUpdateUrl(request.url)
    const old = this.entry(request.id)
    this.entries.set(request.id, { ...old, updateUrl: address, updateCheck: null })
    try {
      this.persist()
    } catch (error) {
      this.entries.set(request.id, old)
      throw error
    }
    return this.state()
  }
  forget(id: string): void {
    this.entries.delete(id)
    this.saveOptional()
  }
  async test(request: {
    requestId: string
    id: string
    sourceId: string
    query?: string
  }): Promise<PluginTestReport> {
    const report = await this.options.service.test(request)
    const checkedAt = new Date().toISOString()
    const failure = report.steps.find((step) => step.status !== 'passed')
    const item = this.entry(report.id)
    const row: PluginHealth = {
      sourceId: report.sourceId,
      version: report.version,
      checkedAt,
      passed: report.passed,
      message: report.passed ? '搜索、目录与内容检查通过。' : message(failure?.message),
    }
    this.entries.set(report.id, {
      ...item,
      health: [...item.health.filter((value) => value.sourceId !== row.sourceId), row].slice(-40),
    })
    this.saveOptional()
    return { ...report, checkedAt }
  }
  async checkUpdate(request: { requestId: string; id: string }): Promise<PluginUpdateCheck> {
    const plugin = this.installed(request.id),
      address = this.entry(request.id).updateUrl
    if (!address) return invalidPlugin('请先为此插件设置更新 ZIP 直链。')
    if (!/^[\w-]{1,120}$/.test(request.requestId)) return invalidPlugin('插件请求 ID 无效。')
    if (this.closed) throw new SourceError('SOURCE_CANCELED', '插件维护服务已关闭。')
    if (this.requests.has(request.requestId) || this.requests.size >= 4)
      throw new SourceError('SOURCE_BUSY', '插件更新检查正在执行或数量过多。')
    const controller = new AbortController()
    this.requests.set(request.requestId, controller)
    const timeout = setTimeout(() => controller.abort('timeout'), 60_000)
    const finish = (
      status: PluginUpdateStatus,
      preview: PluginPreview | null,
    ): PluginUpdateCheck => {
      this.entries.set(plugin.id, { ...this.entry(plugin.id), updateCheck: status })
      this.saveOptional()
      return { state: this.state(), preview, status }
    }
    try {
      const bytes = await downloadPluginPackage(address, controller.signal)
      const parsed = parsePluginPackage(bytes)
      controller.signal.throwIfAborted()
      if (this.entry(plugin.id).updateUrl !== address)
        return invalidPlugin('更新地址已变化，请重新检查。')
      if (parsed.manifest.id !== plugin.id)
        return invalidPlugin('更新地址返回了其他插件，未改变当前安装。')
      const installed = this.installed(plugin.id)
      if (installed.sha256 !== plugin.sha256)
        return invalidPlugin('插件在检查期间已变化，请重新检查。')
      const newer = comparePluginVersions(parsed.manifest.version, plugin.version) > 0
      const preview = newer
        ? this.decoratePreview(this.options.service.previewFile(bytes), address)
        : null
      return finish(
        {
          checkedAt: new Date().toISOString(),
          currentVersion: plugin.version,
          availableVersion: parsed.manifest.version,
          status: newer ? 'update' : 'current',
          message: newer
            ? '有新版本，请核对权限变化后确认更新。'
            : comparePluginVersions(parsed.manifest.version, plugin.version) < 0
              ? '更新源版本低于当前安装，已保留现有版本。'
              : '更新源未提供更高版本。',
        },
        preview,
      )
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason !== 'timeout')
        throw new SourceError('SOURCE_CANCELED', '插件更新检查已取消。')
      return finish(
        {
          checkedAt: new Date().toISOString(),
          currentVersion: plugin.version,
          availableVersion: null,
          status: 'failed',
          message: controller.signal.aborted
            ? '插件更新检查超时，请检查网络后重试。'
            : message(
                error instanceof SourceError
                  ? error.message
                  : '插件更新检查未完成，请检查地址或包内容。',
              ),
        },
        null,
      )
    } finally {
      clearTimeout(timeout)
      this.requests.delete(request.requestId)
    }
  }
  cancel(requestId: string): void {
    this.requests.get(requestId)?.abort()
    this.options.service.cancel(requestId)
  }
  close(): void {
    this.closed = true
    for (const request of this.requests.values()) request.abort()
    this.previews.clear()
  }
}
