import { promisify } from 'node:util'
import { crc32, deflateRaw, inflateRaw } from 'node:zlib'
import { AppError } from '../../shared/validation'

export const BACKUP_LIMIT = 256 * 1024 * 1024
const deflate = promisify(deflateRaw)
const inflate = promisify(inflateRaw)
const invalid = (): never => {
  throw new AppError('INVALID_REQUEST', '备份 ZIP 无效、内容超限或校验失败。')
}
export function backupPath(value: string): boolean {
  return (
    /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,239}$/.test(value) &&
    value
      .split('/')
      .every(
        (part) =>
          part &&
          part !== '.' &&
          part !== '..' &&
          !part.endsWith('.') &&
          !/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(part),
      )
  )
}
export async function packBackup(files: Map<string, Buffer>): Promise<Buffer> {
  if (!files.size || files.size > 4096) invalid()
  const locals: Buffer[] = [],
    central: Buffer[] = []
  let offset = 0,
    expanded = 0
  for (const [path, bytes] of files) {
    if (!backupPath(path)) invalid()
    expanded += bytes.length
    if (expanded > BACKUP_LIMIT) invalid()
    const name = Buffer.from(path),
      compressed = await deflate(bytes),
      crc = crc32(bytes)
    const local = Buffer.alloc(30),
      entry = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    entry.writeUInt32LE(0x02014b50)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x800, 8)
    entry.writeUInt16LE(8, 10)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(compressed.length, 20)
    entry.writeUInt32LE(bytes.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    locals.push(local, name, compressed)
    central.push(entry, name)
    offset += local.length + name.length + compressed.length
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(files.size, 8)
  end.writeUInt16LE(files.size, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  const result = Buffer.concat([...locals, directory, end])
  if (result.length > BACKUP_LIMIT) invalid()
  return result
}
export async function unpackBackup(bytes: Buffer): Promise<Map<string, Buffer>> {
  if (!bytes.length || bytes.length > BACKUP_LIMIT || bytes.length < 22) invalid()
  const end = bytes.length - 22
  if (
    bytes.readUInt32LE(end) !== 0x06054b50 ||
    bytes.readUInt32LE(end + 4) ||
    bytes.readUInt16LE(end + 20)
  )
    invalid()
  const count = bytes.readUInt16LE(end + 10),
    start = bytes.readUInt32LE(end + 16),
    directorySize = bytes.readUInt32LE(end + 12)
  if (
    !count ||
    count > 4096 ||
    bytes.readUInt16LE(end + 8) !== count ||
    start + directorySize !== end
  )
    invalid()
  const result = new Map<string, Buffer>(),
    names = new Set<string>(),
    ranges: Array<[number, number]> = []
  let cursor = start,
    expanded = 0
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) invalid()
    const flags = bytes.readUInt16LE(cursor + 8),
      method = bytes.readUInt16LE(cursor + 10),
      crc = bytes.readUInt32LE(cursor + 16),
      compressed = bytes.readUInt32LE(cursor + 20),
      length = bytes.readUInt32LE(cursor + 24),
      nameLength = bytes.readUInt16LE(cursor + 28),
      extra = bytes.readUInt16LE(cursor + 30),
      comment = bytes.readUInt16LE(cursor + 32),
      local = bytes.readUInt32LE(cursor + 42)
    const next = cursor + 46 + nameLength + extra + comment
    if (
      next > end ||
      flags !== 0x800 ||
      ![0, 8].includes(method) ||
      extra ||
      comment ||
      bytes.readUInt16LE(cursor + 34) ||
      bytes.readUInt32LE(cursor + 38) ||
      local + 30 > start ||
      bytes.readUInt32LE(local) !== 0x04034b50
    )
      invalid()
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength),
      name = nameBytes.toString('utf8')
    if (!backupPath(name) || !Buffer.from(name).equals(nameBytes) || names.has(name.toLowerCase()))
      invalid()
    names.add(name.toLowerCase())
    expanded += length
    const begin = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    if (
      expanded > BACKUP_LIMIT ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method ||
      bytes.readUInt32LE(local + 14) !== crc ||
      bytes.readUInt32LE(local + 18) !== compressed ||
      bytes.readUInt32LE(local + 22) !== length ||
      bytes.readUInt16LE(local + 26) !== nameLength ||
      bytes.readUInt16LE(local + 28) ||
      !bytes.subarray(local + 30, begin).equals(nameBytes) ||
      begin + compressed > start ||
      ranges.some(([a, b]) => local < b && begin + compressed > a)
    )
      invalid()
    ranges.push([local, begin + compressed])
    let content: Buffer
    try {
      content =
        method === 8
          ? await inflate(bytes.subarray(begin, begin + compressed), {
              maxOutputLength: Math.max(1, length),
            })
          : bytes.subarray(begin, begin + compressed)
    } catch {
      return invalid()
    }
    if (content.length !== length || crc32(content) !== crc) invalid()
    result.set(name, content)
    cursor = next
  }
  if (cursor !== end) invalid()
  return result
}
