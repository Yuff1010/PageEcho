import { inflateRawSync, crc32 } from 'node:zlib'
import { posix } from 'node:path'
import { DOMParser } from '@xmldom/xmldom'
import { AppError } from '../../shared/validation'

const invalid = (message: string): never => {
  throw new AppError('INVALID_ORIGINAL', message)
}
const MAX_EXPANDED = 64 * 1024 * 1024
function safePath(name: string): string {
  if (
    !name ||
    name.length > 2000 ||
    /[\\:]/.test(name) ||
    name.includes(String.fromCharCode(0)) ||
    name.startsWith('/') ||
    name.split('/').includes('..')
  )
    invalid('EPUB 包含无效的内部路径。')
  return posix.normalize(name)
}

// Read only in memory: no archive entry is extracted or fetched from the network.
function zipEntries(bytes: Buffer): Map<string, Buffer> {
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      eocd = i
      break
    }
  if (eocd < 0) invalid('EPUB 不是完整的 ZIP 文件。')
  const count = bytes.readUInt16LE(eocd + 10)
  const offset = bytes.readUInt32LE(eocd + 16)
  const size = bytes.readUInt32LE(eocd + 12)
  if (
    bytes.readUInt32LE(eocd + 4) ||
    bytes.readUInt16LE(eocd + 8) !== count ||
    !count ||
    count > 5000 ||
    offset + size !== eocd
  )
    invalid('EPUB 分卷、ZIP64 或超大目录不受支持。')
  const entries = new Map<string, Buffer>()
  let cursor = offset,
    expanded = 0
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50) invalid('EPUB 目录损坏。')
    const flags = bytes.readUInt16LE(cursor + 8),
      method = bytes.readUInt16LE(cursor + 10)
    const crc = bytes.readUInt32LE(cursor + 16),
      compressed = bytes.readUInt32LE(cursor + 20),
      length = bytes.readUInt32LE(cursor + 24)
    const names = bytes.readUInt16LE(cursor + 28),
      extras = bytes.readUInt16LE(cursor + 30),
      comments = bytes.readUInt16LE(cursor + 32),
      local = bytes.readUInt32LE(cursor + 42)
    const end = cursor + 46 + names + extras + comments
    if (
      end > eocd ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      length > 8 * 1024 * 1024 ||
      (expanded += length) > MAX_EXPANDED ||
      local + 30 > offset
    )
      invalid('EPUB 加密、压缩方式或解压大小不受支持。')
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + names)
    const name = safePath(new TextDecoder('utf-8', { fatal: true }).decode(nameBytes))
    if (entries.has(name)) invalid('EPUB 含重复文件路径。')
    if (
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method
    )
      invalid('EPUB 文件头与目录不一致。')
    const localNames = bytes.readUInt16LE(local + 26)
    const begin = local + 30 + localNames + bytes.readUInt16LE(local + 28)
    if (
      begin + compressed > offset ||
      !bytes.subarray(local + 30, local + 30 + localNames).equals(nameBytes)
    )
      invalid('EPUB 内部文件范围无效。')
    const payload = bytes.subarray(begin, begin + compressed)
    const content =
      method === 0
        ? payload
        : inflateRawSync(payload, { maxOutputLength: Math.min(8 * 1024 * 1024, length + 1) })
    if (content.length !== length || crc32(content) !== crc) invalid('EPUB 文件校验失败。')
    entries.set(name, content)
    cursor = end
  }
  if (cursor !== eocd) invalid('EPUB 目录长度不一致。')
  if (entries.has('META-INF/encryption.xml')) invalid('暂不支持含加密资源的 EPUB。')
  if (entries.get('mimetype')?.toString('ascii').trim() !== 'application/epub+zip')
    invalid('文件不是 EPUB。')
  return entries
}
function xml(bytes: Buffer | undefined) {
  if (!bytes) return invalid('EPUB 缺少目录或正文文件。')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(text)) invalid('EPUB 不支持自定义 XML 实体。')
  let broken = false
  const doc = new DOMParser({
    errorHandler: {
      warning: () => {
        broken = true
      },
      error: () => {
        broken = true
      },
      fatalError: () => {
        broken = true
      },
    },
  }).parseFromString(text, 'application/xml')
  if (broken || !doc.documentElement) invalid('EPUB XML 格式无效。')
  return doc
}
function elements(doc: ReturnType<typeof xml>, name: string) {
  return Array.from(doc.getElementsByTagNameNS('*', name))
}
export function epubChapters(bytes: Buffer): { title: string; text: string }[] {
  try {
    const entries = zipEntries(bytes)
    const root = elements(xml(entries.get('META-INF/container.xml')), 'rootfile').find(
      (node) => node.getAttribute('media-type') === 'application/oebps-package+xml',
    )
    const packagePath = safePath(root?.getAttribute('full-path') ?? '')
    const opf = xml(entries.get(packagePath))
    const manifest = new Map<string, { path: string; type: string }>()
    for (const item of elements(opf, 'item')) {
      const id = item.getAttribute('id') ?? '',
        href = item.getAttribute('href') ?? ''
      if (!id || manifest.has(id) || /^(?:[a-z]+:|\/)/i.test(href) || href.includes('?'))
        invalid('EPUB 清单无效。')
      const path = safePath(
        posix.join(posix.dirname(packagePath), decodeURIComponent(href.split('#')[0]!)),
      )
      manifest.set(id, { path, type: item.getAttribute('media-type') ?? '' })
    }
    const sections: { title: string; text: string }[] = []
    for (const ref of elements(opf, 'itemref')) {
      if (ref.getAttribute('linear') === 'no') continue
      const item = manifest.get(ref.getAttribute('idref') ?? '')
      if (!item || item.type !== 'application/xhtml+xml')
        return invalid('EPUB 阅读顺序缺少 XHTML 正文。')
      const doc = xml(entries.get(item.path))
      const body = elements(doc, 'body')[0]
      if (!body) return invalid('EPUB 正文缺少 body。')
      let text = ''
      const visit = (node: NonNullable<typeof body> | ChildNode) => {
        if (node.nodeType === 3 || node.nodeType === 4) {
          text += node.nodeValue ?? ''
          return
        }
        if (node.nodeType !== 1) return
        const name = node.nodeName.split(':').at(-1)!.toLowerCase()
        if (['script', 'style', 'svg', 'math', 'nav'].includes(name)) return
        const block = /^(?:p|div|section|article|h[1-6]|li|br|hr)$/.test(name)
        if (block) text += '\n'
        for (let child = node.firstChild; child; child = child.nextSibling)
          visit(child as ChildNode)
        if (block) text += '\n'
      }
      visit(body)
      if (!text.trim()) continue
      sections.push({
        title:
          elements(doc, 'h1')[0]?.textContent?.trim().slice(0, 80) || `正文 ${sections.length + 1}`,
        text,
      })
    }
    if (!sections.length) invalid('EPUB 阅读顺序为空。')
    return sections
  } catch (error) {
    if (error instanceof AppError) throw error
    return invalid('无法读取 EPUB，请检查压缩包、XML 和编码。')
  }
}
