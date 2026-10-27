import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
  writeFile,
  type FileHandle,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PassThrough, Transform, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { crc32, createInflateRaw } from 'node:zlib'
import { Open, type CentralEntry } from 'unzipper'
import type { ComponentProfile } from '../../shared/component-installation'
import { AppError } from '../../shared/validation'
import { KNOWN_BUNDLES } from './catalog'
import type {
  BundleFile,
  ComponentInstallerCore as CoreContract,
  ComponentInstallPlan,
  InstallProgress,
  ManagedComponentReceipt,
  TrustedBundle,
} from './core-types'

const SHA = /^[a-f0-9]{64}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const ASSET_ID = /^[a-f0-9]{16}$/
const GROUP_NAMES = {
  shared: 's',
  paraformer: 'f',
  vad: 'v',
  punctuation: 'p',
  whisper: 'w',
  alignment: 'l',
} as const
const ROLES = ['paraformer', 'vad', 'punctuation', 'whisper', 'alignment'] as const
const MANIFEST_LIMIT = 16 * 1024 * 1024
const RECEIPT_LIMIT = 64 * 1024
const DISK_MARGIN = 32 * 1024 * 1024
type Role = (typeof ROLES)[number]
type Group = 'shared' | Role
interface Manifest {
  files: BundleFile[]
  bytes: number
}
interface Entry extends CentralEntry {
  dataStart: number
}
interface Archive {
  handle: FileHandle
  bundle: TrustedBundle
  size: number
  modifiedMs: number
  manifestBytes: Buffer
  manifest: Manifest
  entries: Map<string, Entry>
  close(): Promise<void>
}
interface ReceiptData {
  schemaVersion: 1
  id: string
  bundleId: string
  version: string
  profile: ComponentProfile
  bytes: number
  installedAt: string
  archiveSha256: string
  manifestSha256: string
  assets: Record<string, string>
}
interface Loaded {
  data: ReceiptData
  receipt: ManagedComponentReceipt
  manifest: Manifest
  groups: Map<Group, BundleFile[]>
}
function invalid(message = '组件包或安装记录无效，请重新选择完整的离线组件包。'): never {
  throw new AppError('RUNTIME_UNAVAILABLE', message)
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    object(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
}
function profile(value: unknown): asserts value is ComponentProfile {
  if (
    !exact(value, ['engine', 'device']) ||
    !['paraformer', 'whisperx'].includes(String(value.engine)) ||
    !['cpu', 'cuda'].includes(String(value.device))
  )
    invalid('组件引擎或设备选择无效。')
}
function roles(value: ComponentProfile): Role[] {
  return value.engine === 'paraformer'
    ? ['paraformer', 'vad', 'punctuation', 'alignment']
    : ['whisper', 'punctuation', 'alignment']
}
function safePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 2000 ||
    /[\\:<>"|?*]/.test(value) ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32) ||
    value.startsWith('/')
  )
    invalid('组件含无效文件路径。')
  const parts = value.split('/')
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    invalid('组件文件路径不能安全安装。')
  return value
}
function contains(root: string, path: string): boolean {
  const rel = relative(root, path)
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
function parseManifest(bytes: Buffer): Manifest {
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    invalid('组件清单不是有效的 UTF-8 JSON。')
  }
  if (
    !object(raw) ||
    raw.version !== 1 ||
    raw.complete !== true ||
    raw.platform !== 'win-amd64' ||
    !Array.isArray(raw.files) ||
    !raw.files.length ||
    raw.files.length > 100_000 ||
    !integer(raw.bytes, 64 * 1024 ** 3)
  )
    invalid('组件清单格式不受支持。')
  const names = new Set<string>(),
    files: BundleFile[] = []
  let size = 0
  for (const entry of raw.files) {
    if (
      !exact(entry, ['path', 'bytes', 'sha256']) ||
      !integer(entry.bytes, 16 * 1024 ** 3) ||
      typeof entry.sha256 !== 'string' ||
      !SHA.test(entry.sha256)
    )
      invalid()
    const path = safePath(entry.path),
      key = path.toLowerCase()
    if (key === 'bundle-manifest.json' || names.has(key)) invalid('组件清单有重复文件。')
    names.add(key)
    files.push({ path, bytes: entry.bytes, sha256: entry.sha256 })
    size += entry.bytes
  }
  for (const name of names) {
    const parts = name.split('/')
    for (let i = 1; i < parts.length; i++)
      if (names.has(parts.slice(0, i).join('/'))) invalid('组件文件与目录冲突。')
  }
  if (size !== raw.bytes) invalid('组件清单大小不一致。')
  return { files, bytes: size }
}
function selectedGroups(manifest: Manifest, choice: ComponentProfile): Map<Group, BundleFile[]> {
  const groups = new Map<Group, BundleFile[]>([
    ['shared', []],
    ...roles(choice).map((role) => [role, []] as [Group, BundleFile[]]),
  ])
  for (const file of manifest.files) {
    const parts = file.path.split('/')
    if (parts[0] === 'models') {
      if (!ROLES.includes(parts[1] as Role) || parts.length < 3) invalid('组件模型角色无效。')
      groups.get(parts[1] as Role)?.push(file)
    } else groups.get('shared')!.push(file)
  }
  const shared = new Set(groups.get('shared')!.map((file) => file.path))
  if (
    !['python/python.exe', 'tools/ffmpeg.exe', 'tools/ffprobe.exe', 'models.json'].every((name) =>
      shared.has(name),
    ) ||
    ![...shared].some((name) => name.startsWith('resources/'))
  )
    invalid('组件缺少共享运行时或资源。')
  for (const files of groups.values()) if (!files.length) invalid('组件缺少所选引擎的模型。')
  return groups
}
function sumFiles(groups: Map<Group, BundleFile[]>): number {
  return [...groups.values()].flat().reduce((sum, file) => sum + file.bytes, 0)
}
function encoded(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n')
}
function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((done, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(done, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
async function bytesAt(
  handle: FileHandle,
  start: number,
  length: number,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted()
  const bytes = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    signal.throwIfAborted()
    const result = await handle.read(bytes, read, length - read, start + read)
    if (!result.bytesRead) invalid('组件 ZIP 已截断。')
    read += result.bytesRead
  }
  return bytes
}
/** Streams never own/close the shared descriptor or add FileHandle close listeners. */
function rangeStream(
  handle: FileHandle,
  start: number,
  end: number,
  signal: AbortSignal,
): Readable {
  return Readable.from(
    (async function* () {
      let position = start
      while (position < end) {
        signal.throwIfAborted()
        const block = Buffer.allocUnsafe(Math.min(1024 * 1024, end - position))
        const result = await handle.read(block, 0, block.length, position)
        if (!result.bytesRead) invalid('组件文件已截断。')
        position += result.bytesRead
        yield block.subarray(0, result.bytesRead)
      }
    })(),
  )
}
async function zipBounds(
  handle: FileHandle,
  size: number,
  signal: AbortSignal,
): Promise<{ offset: number; entries: number }> {
  if (size < 22) invalid('组件 ZIP 不完整。')
  const tail = await bytesAt(handle, Math.max(0, size - 65557), Math.min(size, 65557), signal)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--)
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
      eocd = i
      break
    }
  if (eocd < 0 || tail.readUInt16LE(eocd + 4) || tail.readUInt16LE(eocd + 6))
    invalid('组件 ZIP 分卷或目录无效。')
  let entries = tail.readUInt16LE(eocd + 10),
    count = tail.readUInt16LE(eocd + 8),
    offset = tail.readUInt32LE(eocd + 16),
    length = tail.readUInt32LE(eocd + 12),
    end = size - tail.length + eocd
  if (entries === 0xffff || offset === 0xffffffff || length === 0xffffffff) {
    const locator = await bytesAt(handle, end - 20, 20, signal)
    if (
      locator.readUInt32LE(0) !== 0x07064b50 ||
      locator.readUInt32LE(4) ||
      locator.readUInt32LE(16) !== 1
    )
      invalid('ZIP64 分卷不受支持。')
    const position = Number(locator.readBigUInt64LE(8))
    if (!integer(position, end - 76)) invalid('ZIP64 目录越界。')
    const record = await bytesAt(handle, position, 56, signal)
    if (record.readUInt32LE(0) !== 0x06064b50 || record.readUInt32LE(16) || record.readUInt32LE(20))
      invalid('ZIP64 目录无效。')
    entries = Number(record.readBigUInt64LE(32))
    count = Number(record.readBigUInt64LE(24))
    length = Number(record.readBigUInt64LE(40))
    offset = Number(record.readBigUInt64LE(48))
    end = position
  }
  if (
    !integer(entries, 100_001) ||
    !entries ||
    count !== entries ||
    !integer(length, 32 * 1024 * 1024) ||
    !integer(offset, size) ||
    offset + length !== end
  )
    invalid('组件 ZIP 目录大小或范围无效。')
  return { offset, entries }
}
async function hashHandle(
  handle: FileHandle,
  size: number,
  signal: AbortSignal,
  progress: (size: number) => void,
): Promise<string> {
  const hash = createHash('sha256'),
    stream = rangeStream(handle, 0, size, signal)
  let processed = 0
  progress(0)
  for await (const block of stream) {
    signal.throwIfAborted()
    hash.update(block)
    processed += block.length
    if (processed > size) invalid('组件包在读取期间变化。')
    progress(processed)
  }
  if (processed !== size) invalid('组件包已截断。')
  return hash.digest('hex')
}
async function entryContent(
  archive: Pick<Archive, 'handle'>,
  entry: Entry,
  expected: BundleFile | undefined,
  signal: AbortSignal,
  destination?: string,
  progress: (bytes: number) => void = () => undefined,
): Promise<Buffer> {
  const size = expected?.bytes ?? entry.uncompressedSize
  if (!destination && size > MANIFEST_LIMIT) invalid('组件元数据过大。')
  const chunks: Buffer[] = [],
    digest = createHash('sha256')
  let processed = 0,
    crc = 0
  const validator = new Transform({
    transform(block: Buffer, _encoding, callback) {
      processed += block.length
      if (processed > size) {
        callback(new AppError('RUNTIME_UNAVAILABLE', '组件解压大小超过清单。'))
        return
      }
      try {
        digest.update(block)
        crc = crc32(block, crc)
        progress(block.length)
        if (!destination) chunks.push(block)
        callback(null, destination ? block : undefined)
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)))
      }
    },
  })
  if (entry.compressedSize) {
    const input = rangeStream(
      archive.handle,
      entry.dataStart,
      entry.dataStart + entry.compressedSize,
      signal,
    )
    await pipeline(
      input,
      entry.compressionMethod === 8 ? createInflateRaw() : new PassThrough(),
      validator,
      destination ? createWriteStream(destination, { flags: 'wx' }) : new PassThrough().resume(),
      { signal },
    )
  } else {
    if (destination) await writeFile(destination, '', { flag: 'wx', signal })
  }
  signal.throwIfAborted()
  if (
    processed !== size ||
    crc !== entry.crc32 ||
    (expected && digest.digest('hex') !== expected.sha256)
  )
    invalid('组件文件大小或校验失败。')
  return destination ? Buffer.alloc(0) : Buffer.concat(chunks)
}

/** No code from the imported archive is executed here. Activation belongs to the service. */
export class ComponentInstallerCore implements CoreContract {
  private readonly root: string
  private readonly catalog: readonly TrustedBundle[]
  private busy = false
  constructor(root: string, trustedBundles: readonly TrustedBundle[] = KNOWN_BUNDLES) {
    this.root = resolve(root)
    const ids = new Set<string>()
    this.catalog = trustedBundles.map((bundle) => {
      if (
        !/^[a-z0-9][a-z0-9.-]{0,100}$/.test(bundle.id) ||
        ids.has(bundle.id) ||
        !integer(bundle.archiveBytes) ||
        !bundle.archiveBytes ||
        !SHA.test(bundle.archiveSha256) ||
        !SHA.test(bundle.manifestSha256) ||
        typeof bundle.version !== 'string' ||
        !bundle.version ||
        bundle.version.length > 100 ||
        (bundle.devices !== undefined &&
          (!Array.isArray(bundle.devices) ||
            !bundle.devices.length ||
            bundle.devices.some((device) => !['cpu', 'cuda'].includes(device)) ||
            new Set(bundle.devices).size !== bundle.devices.length))
      )
        invalid('可信组件目录无效。')
      ids.add(bundle.id)
      return { ...bundle, ...(bundle.devices ? { devices: [...bundle.devices] } : {}) }
    })
  }
  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const info = await lstat(this.root)
    if (!info.isDirectory() || info.isSymbolicLink()) invalid('组件管理目录不能是链接。')
    for (const name of ['a', 'receipts', 'staging']) {
      await this.directory(join(this.root, name))
    }
  }
  /** Validate each existing parent before creating any child through it. */
  private async directory(path: string): Promise<void> {
    if (!contains(this.root, resolve(path))) invalid('组件目录创建路径越界。')
    let current = this.root
    for (const part of relative(this.root, resolve(path)).split(sep)) {
      const before = await lstat(current)
      if (!before.isDirectory() || before.isSymbolicLink()) invalid('组件管理目录含链接。')
      current = join(current, part)
      try {
        await mkdir(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink()) invalid('组件管理目录含链接。')
    }
    await this.managed(path, true)
  }
  private async managed(path: string, directory = false): Promise<void> {
    const target = resolve(path)
    if (!contains(this.root, target)) invalid('组件安装路径越界。')
    const rootInfo = await lstat(this.root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) invalid('组件管理目录含链接。')
    const pieces = relative(this.root, target).split(sep)
    let current = this.root
    for (const piece of pieces) {
      current = join(current, piece)
      const info = await lstat(current)
      if (
        info.isSymbolicLink() ||
        (current === target
          ? directory
            ? !info.isDirectory()
            : !info.isFile()
          : !info.isDirectory())
      )
        invalid('组件受管目录含链接或无效文件。')
    }
    const canonicalRoot = await realpath(this.root),
      canonical = await realpath(target)
    if (!contains(canonicalRoot, canonical)) invalid('组件安装路径指向管理目录之外。')
  }
  private async metadata(path: string, limit = RECEIPT_LIMIT): Promise<Buffer> {
    await this.managed(path)
    if ((await lstat(path)).size > limit) invalid('组件安装元数据过大。')
    return readFile(path)
  }
  private async archive(
    path: string,
    signal: AbortSignal,
    progress: InstallProgress,
  ): Promise<Archive> {
    signal.throwIfAborted()
    const handle = await open(resolve(path), 'r')
    const streams = new Set<Readable>()
    const stop = () => {
      for (const stream of streams) stream.destroy()
    }
    signal.addEventListener('abort', stop, { once: true })
    try {
      const info = await handle.stat()
      if (!info.isFile() || !this.catalog.some((bundle) => bundle.archiveBytes === info.size))
        invalid('此离线组件包的大小不在可信目录中。')
      const digest = await hashHandle(handle, info.size, signal, (bytes) =>
        progress('inspecting', bytes, info.size),
      )
      const bundle = this.catalog.find(
        (item) => item.archiveBytes === info.size && item.archiveSha256 === digest,
      )
      if (!bundle) invalid('离线组件包 SHA-256 不在可信目录中。')
      const bounds = await zipBounds(handle, info.size, signal)
      const central = await abortable(
        Open.custom(
          {
            size: async () => info.size,
            stream: (offset, length) => {
              signal.throwIfAborted()
              if (
                !integer(offset, info.size - 1) ||
                (length !== undefined && (!integer(length) || !length))
              )
                invalid('ZIP 读取范围无效。')
              const stream = rangeStream(
                handle,
                offset,
                length ? Math.min(info.size, offset + length) : info.size,
                signal,
              )
              streams.add(stream)
              stream.on('error', () => undefined)
              stream.on('close', () => streams.delete(stream))
              return stream
            },
          },
          { tailSize: Math.min(info.size, 65557) },
        ),
        signal,
      )
      if (central.files.length !== bounds.entries) invalid('ZIP 目录条目数不一致。')
      const entries = new Map<string, Entry>(),
        names = new Set<string>(),
        spans: { start: number; end: number }[] = []
      for (const raw of central.files) {
        signal.throwIfAborted()
        const name = safePath(raw.type === 'Directory' ? raw.path.slice(0, -1) : raw.path),
          key = name.toLowerCase()
        const mode = (raw.externalFileAttributes >>> 16) & 0xf000
        if (
          names.has(key) ||
          !Buffer.from(raw.path, 'utf8').equals(raw.pathBuffer) ||
          raw.flags & 1 ||
          ![0, 8].includes(raw.compressionMethod) ||
          (mode !== 0 && mode !== (raw.type === 'Directory' ? 0x4000 : 0x8000)) ||
          raw.externalFileAttributes & 0x400 ||
          !integer(raw.compressedSize, info.size) ||
          !integer(raw.uncompressedSize, 16 * 1024 ** 3) ||
          !integer(raw.offsetToLocalFileHeader, bounds.offset - 30)
        )
          invalid('组件 ZIP 含重复、链接、加密或越界条目。')
        names.add(key)
        const header = await bytesAt(handle, raw.offsetToLocalFileHeader, 30, signal)
        const nameLength = header.readUInt16LE(26),
          extraLength = header.readUInt16LE(28),
          dataStart = raw.offsetToLocalFileHeader + 30 + nameLength + extraLength
        if (
          header.readUInt32LE(0) !== 0x04034b50 ||
          header.readUInt16LE(6) !== raw.flags ||
          header.readUInt16LE(8) !== raw.compressionMethod ||
          dataStart + raw.compressedSize > bounds.offset ||
          !nameLength ||
          nameLength > 8000
        )
          invalid('ZIP 本地文件头或数据范围无效。')
        if (
          !(await bytesAt(handle, raw.offsetToLocalFileHeader + 30, nameLength, signal)).equals(
            raw.pathBuffer,
          )
        )
          invalid('ZIP 文件名与目录不一致。')
        if (
          !(raw.flags & 8) &&
          (header.readUInt32LE(14) !== raw.crc32 ||
            (header.readUInt32LE(18) !== 0xffffffff &&
              header.readUInt32LE(18) !== raw.compressedSize) ||
            (header.readUInt32LE(22) !== 0xffffffff &&
              header.readUInt32LE(22) !== raw.uncompressedSize))
        )
          invalid('ZIP 本地文件大小与目录不一致。')
        spans.push({ start: raw.offsetToLocalFileHeader, end: dataStart + raw.compressedSize })
        entries.set(raw.path, { ...raw, dataStart })
      }
      spans.sort((a, b) => a.start - b.start)
      if (spans.some((span, i) => i > 0 && span.start < spans[i - 1]!.end))
        invalid('ZIP 条目数据范围重叠。')
      const manifestEntry = entries.get('bundle-manifest.json')
      if (
        !manifestEntry ||
        manifestEntry.type !== 'File' ||
        manifestEntry.uncompressedSize > MANIFEST_LIMIT
      )
        invalid('组件包缺少根清单。')
      const manifestBytes = await entryContent({ handle }, manifestEntry, undefined, signal)
      if (sha(manifestBytes) !== bundle.manifestSha256) invalid('组件清单 SHA-256 与可信目录不符。')
      const manifest = parseManifest(manifestBytes),
        inventory = new Map(manifest.files.map((file) => [file.path, file]))
      for (const entry of entries.values()) {
        if (entry.type === 'Directory') {
          if (
            entry.uncompressedSize ||
            !manifest.files.some((file) => file.path.startsWith(entry.path))
          )
            invalid('ZIP 含未列入清单的目录。')
        } else if (
          entry.path !== 'bundle-manifest.json' &&
          inventory.get(entry.path)?.bytes !== entry.uncompressedSize
        )
          invalid('ZIP 文件与可信清单不一致。')
      }
      for (const file of manifest.files)
        if (entries.get(file.path)?.type !== 'File') invalid('ZIP 缺少清单文件。')
      const after = await handle.stat()
      if (
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs ||
        after.ctimeMs !== info.ctimeMs
      )
        invalid('组件包在检查期间变化。')
      return {
        handle,
        bundle,
        size: info.size,
        modifiedMs: info.mtimeMs,
        manifestBytes,
        manifest,
        entries,
        close: async () => {
          signal.removeEventListener('abort', stop)
          stop()
          await handle.close()
        },
      }
    } catch (error) {
      signal.removeEventListener('abort', stop)
      stop()
      await handle.close()
      throw error
    }
  }
  private async disk(required: number): Promise<number> {
    const info = await statfs(this.root, { bigint: true })
    const available = info.bavail * info.bsize
    const free = Number(
      available > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : available,
    )
    if (free < required + DISK_MARGIN)
      invalid('组件安装磁盘空间不足；旧组件保持可用，请释放空间后重试。')
    return free
  }
  private groupParent(bundle: TrustedBundle, group: Group): string {
    return join(this.root, 'a', bundle.archiveSha256.slice(0, 12), GROUP_NAMES[group])
  }
  private checkDevice(bundle: TrustedBundle, choice: ComponentProfile): void {
    if (bundle.devices && !bundle.devices.includes(choice.device))
      invalid('此组件包仅支持 CPU；请选择 CPU，或为 NVIDIA GPU 选择通用组件包。')
  }
  private checkNativePaths(root: string, files: BundleFile[]): void {
    if (process.platform !== 'win32') return
    if (
      files.some(
        (file) =>
          /\.(dll|pyd|exe)$/i.test(file.path) && join(root, ...file.path.split('/')).length > 240,
      )
    )
      invalid(
        '组件目录过长，Windows 无法可靠加载依赖。请使用更短的数据目录，或将组件解压到短路径后通过“选择组件文件夹”使用。',
      )
  }
  private checkTargetPaths(bundle: TrustedBundle, groups: Map<Group, BundleFile[]>): void {
    for (const [group, files] of groups)
      this.checkNativePaths(join(this.groupParent(bundle, group), '0'.repeat(16)), files)
  }
  private async exactTree(root: string, files: BundleFile[], signal: AbortSignal): Promise<void> {
    await this.managed(root, true)
    const expected = new Set(files.map((file) => file.path)),
      folders = new Set<string>(),
      found = new Set<string>()
    for (const file of files) {
      const parts = file.path.split('/')
      for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'))
    }
    const walk = async (folder: string): Promise<void> => {
      signal.throwIfAborted()
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const target = join(folder, entry.name),
          rel = relative(root, target).split(sep).join('/')
        if (entry.isSymbolicLink()) invalid('受管组件出现链接。')
        if (entry.isDirectory()) {
          if (!folders.has(rel)) invalid('受管组件有额外目录。')
          await walk(target)
        } else if (entry.isFile() && expected.has(rel)) {
          found.add(rel)
        } else invalid('受管组件有额外文件。')
      }
    }
    await walk(root)
    if (found.size !== expected.size) invalid('受管组件缺少文件。')
  }
  private async checkGroup(
    root: string,
    files: BundleFile[],
    signal: AbortSignal,
    progress: (bytes: number) => void,
  ): Promise<void> {
    await this.exactTree(root, files, signal)
    for (const file of files) {
      signal.throwIfAborted()
      const handle = await open(join(root, ...file.path.split('/')), 'r')
      try {
        const before = await handle.stat()
        if (!before.isFile() || before.size !== file.bytes) invalid('受管组件文件大小变化。')
        let previous = 0
        const digest = await hashHandle(handle, file.bytes, signal, (bytes) => {
          progress(bytes - previous)
          previous = bytes
        })
        const after = await handle.stat()
        if (
          digest !== file.sha256 ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs
        )
          invalid('受管组件校验失败；不会覆盖现有资产。')
      } finally {
        await handle.close()
      }
    }
  }
  private async reusable(
    bundle: TrustedBundle,
    groups: Map<Group, BundleFile[]>,
    signal: AbortSignal,
    progress: InstallProgress,
  ): Promise<Map<Group, string>> {
    const result = new Map<Group, string>()
    let processed = 0
    const total = sumFiles(groups)
    progress('checking', 0, total)
    for (const [group, files] of groups) {
      signal.throwIfAborted()
      const parent = this.groupParent(bundle, group)
      let entries
      try {
        await this.managed(parent, true)
        entries = await readdir(parent, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        continue
      }
      for (const entry of entries.slice(0, 64)) {
        signal.throwIfAborted()
        if (!entry.isDirectory() || !ASSET_ID.test(entry.name)) continue
        const candidate = join(parent, entry.name)
        try {
          this.checkNativePaths(candidate, files)
          await this.checkGroup(candidate, files, signal, (bytes) => {
            processed += bytes
            progress('checking', Math.min(processed, total), total)
          })
          result.set(group, candidate)
          break
        } catch (error) {
          if (signal.aborted)
            throw error /* Damaged assets remain untouched; use a fresh generation. */
        }
      }
    }
    return result
  }
  async inspect(
    path: string,
    choice: ComponentProfile,
    signal: AbortSignal,
    progress: InstallProgress,
  ): Promise<ComponentInstallPlan> {
    profile(choice)
    await this.initialize()
    const archive = await this.archive(path, signal, progress)
    try {
      this.checkDevice(archive.bundle, choice)
      const groups = selectedGroups(archive.manifest, choice)
      this.checkTargetPaths(archive.bundle, groups)
      const reused = await this.reusable(archive.bundle, groups, signal, progress)
      const requiredBytes = [...groups]
        .filter(([group]) => !reused.has(group))
        .flatMap(([, files]) => files)
        .reduce((sum, file) => sum + file.bytes, 0)
      signal.throwIfAborted()
      const freeBytes = await this.disk(requiredBytes)
      return {
        archivePath: resolve(path),
        bundle: { ...archive.bundle },
        profile: { ...choice },
        files: [...groups.values()].flat().map((file) => ({ ...file })),
        requiredBytes,
        freeBytes,
        sourceSize: archive.size,
        sourceModifiedMs: archive.modifiedMs,
      }
    } finally {
      await archive.close()
    }
  }
  private async generated(
    data: ReceiptData,
    manifest: Manifest,
  ): Promise<{ component: Buffer; models: Buffer }> {
    const source = manifest.files.find((file) => file.path === 'models.json')
    if (!source) invalid()
    const bytes = await this.metadata(join(this.root, data.assets.shared!, 'models.json'))
    if (bytes.length !== source.bytes || sha(bytes) !== source.sha256)
      invalid('模型源清单校验失败。')
    let original: unknown
    try {
      original = JSON.parse(bytes.toString('utf8'))
    } catch {
      invalid('模型源清单无效。')
    }
    if (!object(original) || original.version !== 1 || !object(original.models))
      invalid('模型源清单无效。')
    const models: Record<string, { repository: string; revision: string; path: string }> = {}
    for (const role of roles(data.profile)) {
      const entry = original.models[role]
      if (
        !exact(entry, ['repository', 'revision', 'path']) ||
        typeof entry.repository !== 'string' ||
        !entry.repository ||
        entry.repository.length > 300 ||
        typeof entry.revision !== 'string' ||
        !entry.revision ||
        entry.revision.length > 200 ||
        entry.path !== `models/${role}`
      )
        invalid('模型源版本或路径无效。')
      models[role] = {
        repository: entry.repository,
        revision: entry.revision,
        path: join(this.root, data.assets[role]!, 'models', role),
      }
    }
    const folder = join(this.root, 'receipts', data.id),
      shared = join(this.root, data.assets.shared!)
    return {
      component: encoded({
        version: 2,
        python: join(shared, 'python', 'python.exe'),
        models: join(folder, 'models.json'),
        resources: join(shared, 'resources'),
        ffmpeg: join(shared, 'tools', 'ffmpeg.exe'),
        ffprobe: join(shared, 'tools', 'ffprobe.exe'),
      }),
      models: encoded({ version: 1, models }),
    }
  }
  async install(
    plan: ComponentInstallPlan,
    signal: AbortSignal,
    progress: InstallProgress,
  ): Promise<ManagedComponentReceipt> {
    if (this.busy) throw new AppError('BUSY', '已有组件正在安装。')
    this.busy = true
    let stage: string | undefined, archive: Archive | undefined
    try {
      profile(plan.profile)
      const choice = { ...plan.profile },
        archivePath = plan.archivePath,
        expectedSize = plan.sourceSize,
        expectedModified = plan.sourceModifiedMs,
        expectedId = plan.bundle.id,
        expectedSha = plan.bundle.archiveSha256
      await this.initialize()
      archive = await this.archive(archivePath, signal, progress)
      if (
        archive.size !== expectedSize ||
        archive.modifiedMs !== expectedModified ||
        archive.bundle.id !== expectedId ||
        archive.bundle.archiveSha256 !== expectedSha
      )
        invalid('离线组件包或安装计划已变化，请重新检查。')
      this.checkDevice(archive.bundle, choice)
      const groups = selectedGroups(archive.manifest, choice)
      this.checkTargetPaths(archive.bundle, groups)
      const reused = await this.reusable(archive.bundle, groups, signal, progress)
      const required = [...groups]
        .filter(([group]) => !reused.has(group))
        .flatMap(([, files]) => files)
        .reduce((sum, file) => sum + file.bytes, 0)
      await this.disk(required)
      signal.throwIfAborted()
      stage = join(this.root, 'staging', randomUUID())
      await mkdir(stage)
      let processed = 0
      progress('installing', 0, required)
      const assets: Record<string, string> = {}
      for (const [group, files] of groups) {
        signal.throwIfAborted()
        const existing = reused.get(group)
        if (existing) {
          assets[group] = relative(this.root, existing).split(sep).join('/')
          continue
        }
        const groupStage = join(stage, group)
        await mkdir(groupStage)
        for (const file of files) {
          signal.throwIfAborted()
          const target = join(groupStage, ...file.path.split('/'))
          await this.directory(dirname(target))
          await entryContent(
            archive,
            archive.entries.get(file.path)!,
            file,
            signal,
            target,
            (bytes) => {
              processed += bytes
              progress('installing', processed, required)
            },
          )
        }
        await this.exactTree(groupStage, files, signal)
        const parent = this.groupParent(archive.bundle, group)
        await this.directory(parent)
        const target = join(parent, randomBytes(8).toString('hex'))
        signal.throwIfAborted()
        await rename(groupStage, target)
        assets[group] = relative(this.root, target).split(sep).join('/')
      }
      const after = await archive.handle.stat()
      if (after.size !== archive.size || after.mtimeMs !== archive.modifiedMs)
        invalid('组件包在安装期间变化。')
      const id = randomUUID(),
        folder = join(stage, 'receipt'),
        data: ReceiptData = {
          schemaVersion: 1,
          id,
          bundleId: archive.bundle.id,
          version: archive.bundle.version,
          profile: choice,
          bytes: sumFiles(groups),
          installedAt: new Date().toISOString(),
          archiveSha256: archive.bundle.archiveSha256,
          manifestSha256: archive.bundle.manifestSha256,
          assets,
        }
      await mkdir(folder)
      const generated = await this.generated(data, archive.manifest)
      await writeFile(join(folder, 'component.json'), generated.component, { flag: 'wx', signal })
      await writeFile(join(folder, 'models.json'), generated.models, { flag: 'wx', signal })
      await writeFile(join(folder, 'bundle-manifest.json'), archive.manifestBytes, {
        flag: 'wx',
        signal,
      })
      await writeFile(join(folder, 'receipt.json'), encoded(data), { flag: 'wx', signal })
      progress('checking', sumFiles(groups), sumFiles(groups))
      signal.throwIfAborted()
      await this.managed(join(this.root, 'receipts'), true)
      await rename(folder, join(this.root, 'receipts', id))
      return this.summary(data)
    } finally {
      try {
        await archive?.close()
      } finally {
        try {
          if (stage) await this.cleanup(stage)
        } finally {
          this.busy = false
        }
      }
    }
  }
  private async cleanup(stage: string): Promise<void> {
    if (
      dirname(stage) !== join(this.root, 'staging') ||
      !UUID.test(relative(join(this.root, 'staging'), stage))
    )
      invalid('临时组件清理路径无效。')
    try {
      await this.managed(stage, true)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    await rm(stage, { recursive: true, force: true })
  }
  private summary(data: ReceiptData): ManagedComponentReceipt {
    const folder = join(this.root, 'receipts', data.id)
    return {
      id: data.id,
      version: data.version,
      profile: { ...data.profile },
      bytes: data.bytes,
      installedAt: data.installedAt,
      componentPath: join(folder, 'component.json'),
      receiptPath: join(folder, 'receipt.json'),
    }
  }
  private async readReceipt(id: string): Promise<Loaded> {
    if (!UUID.test(id)) invalid('受管组件标识无效。')
    const folder = join(this.root, 'receipts', id),
      raw: unknown = JSON.parse(
        (await this.metadata(join(folder, 'receipt.json'))).toString('utf8'),
      )
    if (
      !exact(raw, [
        'schemaVersion',
        'id',
        'bundleId',
        'version',
        'profile',
        'bytes',
        'installedAt',
        'archiveSha256',
        'manifestSha256',
        'assets',
      ]) ||
      raw.schemaVersion !== 1 ||
      raw.id !== id ||
      typeof raw.installedAt !== 'string' ||
      !Number.isFinite(Date.parse(raw.installedAt)) ||
      !integer(raw.bytes) ||
      !object(raw.assets)
    )
      invalid('受管组件安装记录无效。')
    profile(raw.profile)
    const bundle = this.catalog.find(
      (item) =>
        item.id === raw.bundleId &&
        item.version === raw.version &&
        item.archiveSha256 === raw.archiveSha256 &&
        item.manifestSha256 === raw.manifestSha256,
    )
    if (!bundle) invalid('受管组件不在可信目录中。')
    this.checkDevice(bundle, raw.profile)
    const bytes = await this.metadata(join(folder, 'bundle-manifest.json'), MANIFEST_LIMIT)
    if (sha(bytes) !== bundle.manifestSha256) invalid('受管组件清单已变化。')
    const manifest = parseManifest(bytes),
      groups = selectedGroups(manifest, raw.profile)
    if (raw.bytes !== sumFiles(groups) || Object.keys(raw.assets).length !== groups.size)
      invalid('受管组件资产清单无效。')
    for (const group of groups.keys()) {
      const value = raw.assets[group]
      if (typeof value !== 'string') invalid('受管组件资产路径缺失。')
      safePath(value)
      const prefix = relative(this.root, this.groupParent(bundle, group)).split(sep).join('/') + '/'
      const legacy = `assets/${bundle.id}/${group}/`
      if (
        !(value.startsWith(prefix) && ASSET_ID.test(value.slice(prefix.length))) &&
        !(value.startsWith(legacy) && UUID.test(value.slice(legacy.length)))
      )
        invalid('受管组件资产路径越界。')
      await this.managed(join(this.root, value), true)
    }
    const data = raw as unknown as ReceiptData,
      generated = await this.generated(data, manifest)
    if (
      !(await this.metadata(join(folder, 'component.json'))).equals(generated.component) ||
      !(await this.metadata(join(folder, 'models.json'))).equals(generated.models)
    )
      invalid('受管组件生成配置已变化。')
    const receiptFiles = await readdir(folder)
    if (
      receiptFiles.length !== 4 ||
      !['receipt.json', 'component.json', 'models.json', 'bundle-manifest.json'].every((name) =>
        receiptFiles.includes(name),
      )
    )
      invalid('受管组件记录目录有额外文件。')
    return { data, receipt: this.summary(data), manifest, groups }
  }
  async verify(
    receipt: ManagedComponentReceipt,
    signal: AbortSignal,
    progress: InstallProgress,
  ): Promise<void> {
    signal.throwIfAborted()
    await this.initialize()
    const loaded = await this.readReceipt(receipt.id)
    if (
      !exact(receipt, [
        'id',
        'version',
        'profile',
        'bytes',
        'installedAt',
        'componentPath',
        'receiptPath',
      ]) ||
      receipt.id !== loaded.receipt.id ||
      receipt.version !== loaded.receipt.version ||
      receipt.bytes !== loaded.receipt.bytes ||
      receipt.installedAt !== loaded.receipt.installedAt ||
      receipt.componentPath !== loaded.receipt.componentPath ||
      receipt.receiptPath !== loaded.receipt.receiptPath ||
      !exact(receipt.profile, ['engine', 'device']) ||
      receipt.profile.engine !== loaded.receipt.profile.engine ||
      receipt.profile.device !== loaded.receipt.profile.device
    )
      invalid('受管组件选择已变化，请重新读取安装记录。')
    const total = sumFiles(loaded.groups)
    let processed = 0
    progress('checking', 0, total)
    for (const [group, files] of loaded.groups) {
      this.checkNativePaths(join(this.root, loaded.data.assets[group]!), files)
      await this.checkGroup(join(this.root, loaded.data.assets[group]!), files, signal, (bytes) => {
        processed += bytes
        progress('checking', processed, total)
      })
    }
    signal.throwIfAborted()
    await this.readReceipt(receipt.id)
  }
  async load(): Promise<ManagedComponentReceipt[]> {
    await this.initialize()
    const results: ManagedComponentReceipt[] = []
    for (const entry of (await readdir(join(this.root, 'receipts'), { withFileTypes: true })).slice(
      0,
      256,
    )) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue
      try {
        results.push((await this.readReceipt(entry.name)).receipt)
      } catch {
        /* A broken receipt cannot become an executable candidate. */
      }
    }
    return results.sort((a, b) => b.installedAt.localeCompare(a.installedAt))
  }
}
