import { createHash } from 'node:crypto'
import { crc32, inflateRawSync } from 'node:zlib'
import type { PluginManifest } from '../../shared/plugins'
import {
  invalidPlugin,
  MAX_PLUGIN_EXPANDED_BYTES,
  MAX_PLUGIN_SCRIPT_BYTES,
  MAX_PLUGIN_ZIP_BYTES,
  parsePluginManifest,
  pluginPath,
} from './manifest'

export interface ParsedPluginPackage {
  manifest: PluginManifest
  scripts: string[]
  sha256: string
  bytes: number
}

function entries(bytes: Buffer): Map<string, Buffer> {
  if (!bytes.length || bytes.length > MAX_PLUGIN_ZIP_BYTES)
    return invalidPlugin('插件 ZIP 必须非空且不超过 8 MiB。')
  let end = -1
  for (let cursor = bytes.length - 22; cursor >= Math.max(0, bytes.length - 65557); cursor--)
    if (
      bytes.readUInt32LE(cursor) === 0x06054b50 &&
      cursor + 22 + bytes.readUInt16LE(cursor + 20) === bytes.length
    ) {
      end = cursor
      break
    }
  if (end < 0) return invalidPlugin('插件不是完整的 ZIP 包。')
  const count = bytes.readUInt16LE(end + 10),
    offset = bytes.readUInt32LE(end + 16),
    size = bytes.readUInt32LE(end + 12)
  if (
    bytes.readUInt32LE(end + 4) ||
    bytes.readUInt16LE(end + 8) !== count ||
    !count ||
    count > 128 ||
    offset + size !== end
  )
    return invalidPlugin('插件 ZIP 分卷、ZIP64 或目录大小不受支持。')
  const result = new Map<string, Buffer>(),
    seen = new Set<string>()
  const ranges: Array<[number, number]> = []
  let cursor = offset,
    expanded = 0
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50)
      return invalidPlugin('插件 ZIP 目录损坏。')
    const flags = bytes.readUInt16LE(cursor + 8),
      method = bytes.readUInt16LE(cursor + 10)
    const crc = bytes.readUInt32LE(cursor + 16),
      compressed = bytes.readUInt32LE(cursor + 20),
      length = bytes.readUInt32LE(cursor + 24)
    const names = bytes.readUInt16LE(cursor + 28),
      extra = bytes.readUInt16LE(cursor + 30),
      comments = bytes.readUInt16LE(cursor + 32),
      local = bytes.readUInt32LE(cursor + 42)
    const attributes = bytes.readUInt32LE(cursor + 38),
      unixType = (attributes >>> 16) & 0xf000
    const next = cursor + 46 + names + extra + comments
    if (
      next > end ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      length > MAX_PLUGIN_SCRIPT_BYTES ||
      (expanded += length) > MAX_PLUGIN_EXPANDED_BYTES ||
      local + 30 > offset ||
      ![0, 0x4000, 0x8000].includes(unixType)
    )
      return invalidPlugin('插件 ZIP 含加密、链接、超限文件或不支持的压缩。')
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + names)
    let raw: string
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes)
    } catch {
      return invalidPlugin('插件 ZIP 文件名不是 UTF-8。')
    }
    const directory = raw.endsWith('/')
    const name = pluginPath(directory ? raw.slice(0, -1) : raw)
    const normalized = name.normalize('NFC').toLowerCase()
    if (seen.has(normalized)) return invalidPlugin('插件 ZIP 含重复或大小写冲突路径。')
    seen.add(normalized)
    if (
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method
    )
      return invalidPlugin('插件 ZIP 本地文件头不匹配。')
    const begin = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    if (
      begin + compressed > offset ||
      !bytes.subarray(local + 30, local + 30 + bytes.readUInt16LE(local + 26)).equals(nameBytes) ||
      ranges.some(([a, b]) => local < b && begin + compressed > a)
    )
      return invalidPlugin('插件 ZIP 文件范围无效或重叠。')
    ranges.push([local, begin + compressed])
    let contents: Buffer
    try {
      contents =
        method === 8
          ? inflateRawSync(bytes.subarray(begin, begin + compressed), {
              maxOutputLength: Math.max(1, length),
            })
          : bytes.subarray(begin, begin + compressed)
    } catch {
      return invalidPlugin('插件 ZIP 解压失败或内容超过限制。')
    }
    if (contents.length !== length || crc32(contents) !== crc || (directory && contents.length))
      return invalidPlugin('插件 ZIP 文件校验失败。')
    if (!directory) result.set(name, contents)
    cursor = next
  }
  if (cursor !== end) return invalidPlugin('插件 ZIP 目录尾部不一致。')
  return result
}

export function parsePluginPackage(bytes: Buffer): ParsedPluginPackage {
  const files = entries(bytes)
  const candidates = [...files.keys()].filter(
    (name) => name === 'manifest.json' || /^[^/]+\/manifest\.json$/.test(name),
  )
  if (candidates.length !== 1)
    return invalidPlugin('插件包必须在根目录或单层目录包含唯一 manifest.json。')
  const manifestPath = candidates[0]!,
    prefix = manifestPath.slice(0, -'manifest.json'.length)
  if ([...files.keys()].some((name) => !name.startsWith(prefix)))
    return invalidPlugin('插件包根目录不一致。')
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files.get(manifestPath)!))
  } catch {
    return invalidPlugin('插件清单不是有效的 UTF-8 JSON。')
  }
  const manifest = parsePluginManifest(json)
  const scripts = manifest.scripts.map((path) => {
    const bytes = files.get(prefix + path)
    if (!bytes) return invalidPlugin('插件清单指定的脚本缺失。')
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return invalidPlugin('插件脚本不是有效的 UTF-8 文本。')
    }
  })
  if (
    scripts.reduce((size, script) => size + Buffer.byteLength(script, 'utf8'), 0) >
    4 * 1024 * 1024
  )
    return invalidPlugin('插件入口脚本总量超过 4 MiB。')
  if ([...files.keys()].some((name) => !/\.(?:json|js|png|jpg|jpeg|webp|svg|md|txt)$/i.test(name)))
    return invalidPlugin('插件包含不支持的文件类型；不加载 DLL 或可执行文件。')
  return {
    manifest,
    scripts,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  }
}
