import { SourceError } from '../../shared/sources'
import type { PluginManifest, PluginSourceInfo, PluginSourceManifest } from '../../shared/plugins'

export const MAX_PLUGIN_ZIP_BYTES = 8 * 1024 * 1024
export const MAX_PLUGIN_EXPANDED_BYTES = 16 * 1024 * 1024
export const MAX_PLUGIN_SCRIPT_BYTES = 2 * 1024 * 1024
export const MAX_PLUGIN_SOURCES = 40
export const PLUGIN_SLUG = /^[a-z0-9][a-z0-9._-]{0,79}$/
export const PLUGIN_SOURCE_ID = /^plugin:([a-z0-9][a-z0-9._-]{0,79}):([a-z0-9][a-z0-9._-]{0,79})$/

export function invalidPlugin(message: string): never {
  throw new SourceError('INVALID_SOURCE_REQUEST', message)
}

export function pluginObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalidPlugin('插件返回的对象格式无效。')
  return value as Record<string, unknown>
}

export function pluginString(value: unknown, maximum = 4000, empty = false): string {
  if (
    typeof value !== 'string' ||
    value.length > maximum ||
    (!empty && !value.trim()) ||
    /\p{Cc}/u.test(value)
  )
    return invalidPlugin('插件文本字段无效或超过限制。')
  return value
}

export function pluginId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !PLUGIN_SLUG.test(value) ||
    ['__proto__', 'constructor', 'prototype'].includes(value)
  )
    return invalidPlugin('插件或来源 ID 无效。')
  return value
}

export function pluginResourceId(value: unknown): string {
  const id = pluginString(value, 512)
  if (['__proto__', 'constructor', 'prototype'].includes(id))
    return invalidPlugin('插件资源 ID 无效。')
  return id
}

export function pluginPath(value: unknown): string {
  const path = pluginString(value, 240)
  if (
    path.startsWith('/') ||
    /[\\:]/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    return invalidPlugin('插件包包含不安全的内部路径。')
  return path
}

export function pluginUrl(value: unknown, allowSensitiveQuery = false): URL {
  const text = pluginString(value, 8000)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return invalidPlugin('插件网址无效。')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    return invalidPlugin('插件网址必须为不含凭据的 HTTP／HTTPS 地址。')
  if (
    !allowSensitiveQuery &&
    [...url.searchParams.keys()].some((key) =>
      /token|password|secret|authorization|api.?key/i.test(key),
    )
  )
    return invalidPlugin('插件网址不能包含连接凭据。')
  return url
}

export function pluginOrigins(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 12)
    return invalidPlugin('插件必须声明 1–12 个精确 HTTP／HTTPS 来源域。')
  const origins = value.map((item) => {
    const url = pluginUrl(item)
    if (url.pathname !== '/' || url.search || String(item).includes('*'))
      return invalidPlugin('插件权限只接受精确来源域，不接受路径或通配符。')
    return url.origin
  })
  if (new Set(origins).size !== origins.length) return invalidPlugin('插件域名权限重复。')
  return origins
}

function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    return invalidPlugin('插件清单含不支持的字段。')
}

export function pluginVersion(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value)
  )
    return invalidPlugin('插件版本须为三段数字，例如 1.0.0。')
  return value
}

export function comparePluginVersions(left: string, right: string): number {
  const a = pluginVersion(left).split('.').map(Number),
    b = pluginVersion(right).split('.').map(Number)
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index]! - b[index]!
  return 0
}

export function parsePluginManifest(value: unknown): PluginManifest {
  const raw = pluginObject(value)
  exact(raw, ['schemaVersion', 'apiVersion', 'id', 'name', 'version', 'scripts', 'main', 'sources'])
  if (raw.schemaVersion !== 1 || raw.apiVersion !== 1)
    return invalidPlugin('插件清单或 SDK 版本不兼容；本版仅支持 schemaVersion=1、apiVersion=1。')
  if ((raw.scripts === undefined) === (raw.main === undefined))
    return invalidPlugin('插件必须声明 main 或 scripts，不能同时声明。')
  const scripts = raw.main === undefined ? raw.scripts : [raw.main]
  if (!Array.isArray(scripts) || !scripts.length || scripts.length > 12)
    return invalidPlugin('插件须包含 1–12 个入口脚本。')
  const paths = scripts.map(pluginPath)
  if (
    paths.some((path) => !path.endsWith('.js')) ||
    new Set(paths.map((path) => path.toLowerCase())).size !== paths.length
  )
    return invalidPlugin('插件入口必须是互不重复的 .js 文件。')
  if (!Array.isArray(raw.sources) || !raw.sources.length || raw.sources.length > MAX_PLUGIN_SOURCES)
    return invalidPlugin('插件须声明 1–40 个来源。')
  const sources: PluginSourceManifest[] = raw.sources.map((value) => {
    const source = pluginObject(value)
    exact(source, [
      'id',
      'name',
      'kind',
      'baseUrl',
      'description',
      'allowedOrigins',
      'mediaOrigins',
      'coverOrigins',
    ])
    if (!['audio', 'text'].includes(String(source.kind)))
      return invalidPlugin('插件来源类型必须为 audio 或 text。')
    const allowedOrigins = pluginOrigins(source.allowedOrigins)
    const baseUrl = pluginUrl(source.baseUrl)
    if (!allowedOrigins.includes(baseUrl.origin))
      return invalidPlugin('插件首页不在已声明的网络权限内。')
    const mediaOrigins =
      source.mediaOrigins === undefined ? undefined : pluginOrigins(source.mediaOrigins)
    const coverOrigins =
      source.coverOrigins === undefined ? undefined : pluginOrigins(source.coverOrigins)
    if (source.kind === 'text' && mediaOrigins)
      return invalidPlugin('正文来源不能声明音频媒体权限。')
    return {
      id: pluginId(source.id),
      name: pluginString(source.name, 100),
      kind: source.kind as 'audio' | 'text',
      baseUrl: baseUrl.href,
      allowedOrigins,
      ...(source.description === undefined
        ? {}
        : { description: pluginString(source.description, 1000, true) }),
      ...(mediaOrigins ? { mediaOrigins } : {}),
      ...(coverOrigins ? { coverOrigins } : {}),
    }
  })
  if (new Set(sources.map((source) => source.id)).size !== sources.length)
    return invalidPlugin('插件清单含重复的来源 ID。')
  return {
    schemaVersion: 1,
    apiVersion: 1,
    id: pluginId(raw.id),
    name: pluginString(raw.name, 100),
    version: pluginVersion(raw.version),
    scripts: paths,
    sources,
  }
}

export function pluginSourceInfo(manifest: PluginManifest): PluginSourceInfo[] {
  return manifest.sources.map((source) => ({
    id: `plugin:${manifest.id}:${source.id}`,
    localId: source.id,
    pluginId: manifest.id,
    name: source.name,
    kind: source.kind,
    baseUrl: source.baseUrl,
    description: source.description ?? '',
    allowedOrigins: [...source.allowedOrigins],
    mediaOrigins: [...(source.mediaOrigins ?? source.allowedOrigins)],
    coverOrigins: [...(source.coverOrigins ?? source.allowedOrigins)],
  }))
}
