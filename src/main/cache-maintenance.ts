import { createHash, randomUUID } from 'node:crypto'
import { lstat, stat, realpath, readdir, readFile, unlink, rmdir, open } from 'node:fs/promises'
import { join, relative, isAbsolute, resolve, dirname } from 'node:path'
import type { AsrComponent } from './asr-component'
import type {
  MaintenanceState,
  DirectoryUsage,
  CacheClearPreview,
  CacheClearResult,
  AppLog,
} from '../shared/maintenance'
import { AppError } from '../shared/validation'

interface FileStamp {
  name: string
  bytes: number
  mtime: number
  ctime: number
  ino: number
  dev: number
}
interface Group {
  name: string
  files: FileStamp[]
  identity: string
  bytes: number
}
interface Scan {
  root: string
  groups: Group[]
  retained: number
  identity: string
}
const HASH = /^[0-9a-f]{64}$/
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    )
  return value
}
function digest(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}
function contained(root: string, path: string) {
  const difference = relative(root, path)
  return (
    difference !== '' &&
    !isAbsolute(difference) &&
    difference !== '..' &&
    !difference.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  )
}
async function directory(path: string, expected = path): Promise<void> {
  const info = await lstat(path)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    resolve(await realpath(path)) !== resolve(expected)
  )
    throw new AppError('CONFLICT', '缓存目录已变化或包含链接，请检查组件配置后重试。')
}
function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

// Never follows links or recursively removes a directory. Only known worker files are candidates.
export async function scanCheckpoints(cacheRoot: string): Promise<Scan> {
  await directory(cacheRoot)
  const root = join(cacheRoot, 'jobs')
  try {
    await directory(root)
  } catch (error) {
    if (missing(error)) return { root, groups: [], retained: 0, identity: digest([]) }
    throw error
  }
  const names = await readdir(root)
  if (names.length > 10000) throw new AppError('BUSY', '缓存目录项目过多，请分批整理后重试。')
  const groups: Group[] = []
  let retained = 0
  let visited = 0
  const deadline = Date.now() + 15000
  for (const name of names.sort()) {
    if (visited > 100000 || Date.now() > deadline)
      throw new AppError('BUSY', '缓存统计暂未完成，目录过大或读取缓慢，请稍后重试。')
    if (!HASH.test(name)) {
      retained++
      continue
    }
    const target = join(root, name)
    try {
      await directory(target)
      const info = await lstat(target)
      const children = await readdir(target)
      visited += children.length
      if (children.length > 20000 || !children.includes('manifest.json'))
        throw new Error('Unknown cache')
      const files: FileStamp[] = []
      for (const file of children.sort()) {
        if (
          !/^(manifest\.json|chunk-\d{6}\.json)(\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp)?$/.test(
            file,
          )
        )
          throw new Error('Unknown file')
        const stat = await lstat(join(target, file))
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unknown type')
        files.push({
          name: file,
          bytes: stat.size,
          mtime: stat.mtimeMs,
          ctime: stat.ctimeMs,
          ino: stat.ino,
          dev: stat.dev,
        })
      }
      const manifestStat = files.find((file) => file.name === 'manifest.json')!
      if (manifestStat.bytes > 65536) throw new Error('Oversized manifest')
      const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'))
      if (
        !manifest ||
        manifest.version !== 1 ||
        Object.keys(manifest).length !== 5 ||
        typeof manifest.audioHash !== 'string' ||
        !HASH.test(manifest.audioHash) ||
        !Number.isSafeInteger(manifest.startMs) ||
        !Number.isSafeInteger(manifest.endMs) ||
        manifest.startMs < 0 ||
        manifest.endMs <= manifest.startMs ||
        manifest.endMs > 3.6e10 ||
        !['whisperx', 'paraformer'].includes(manifest.configuration?.engine) ||
        manifest.configuration?.transcriptVersion !== 1 ||
        digest({
          audioHash: manifest.audioHash,
          configuration: manifest.configuration,
          startMs: manifest.startMs,
          endMs: manifest.endMs,
        }) !== name
      )
        throw new Error('Unrecognized manifest')
      groups.push({
        name,
        files,
        identity: digest({ dev: info.dev, ino: info.ino, manifest, files }),
        bytes: files.reduce((n, file) => n + file.bytes, 0),
      })
    } catch {
      retained++
    }
  }
  return { root, groups, retained, identity: digest(groups) }
}

export async function directoryUsage(root: string): Promise<DirectoryUsage> {
  const usage: DirectoryUsage = { bytes: 0, files: 0, skipped: 0, complete: true }
  const deadline = Date.now() + 5000
  const pending = [{ path: root, depth: 0 }]
  let visited = 0
  while (pending.length) {
    if (++visited > 100000 || Date.now() > deadline) {
      usage.complete = false
      break
    }
    const item = pending.pop()!
    try {
      const info = await lstat(item.path)
      if (info.isSymbolicLink()) {
        usage.skipped++
        continue
      }
      if (info.isFile()) {
        usage.bytes += info.size
        usage.files++
        continue
      }
      if (!info.isDirectory() || item.depth >= 24) {
        usage.skipped++
        usage.complete = false
        continue
      }
      const entries = await readdir(item.path)
      if (entries.length > 100000 - visited) {
        usage.complete = false
        break
      }
      for (const name of entries)
        pending.push({ path: join(item.path, name), depth: item.depth + 1 })
    } catch {
      usage.skipped++
      usage.complete = false
    }
  }
  return usage
}

export class CacheMaintenance {
  private preview?: {
    token: string
    created: number
    cacheRoot: string
    componentHash: string
    scan: Scan
  }
  private inspecting?: Promise<MaintenanceState>
  constructor(
    private readonly component: AsrComponent,
    private readonly dataPath: string,
    private readonly logsPath: string,
  ) {}
  get logsDirectory(): string {
    return this.logsPath
  }
  state(): Promise<MaintenanceState> {
    if (this.inspecting) return this.inspecting
    const pending = this.inspect().finally(() => {
      if (this.inspecting === pending) this.inspecting = undefined
    })
    this.inspecting = pending
    return pending
  }
  private async inspect(): Promise<MaintenanceState> {
    const component = this.component.describe()
    const result: MaintenanceState = {
      dataPath: this.dataPath,
      logsPath: this.logsPath,
      configured: !!component,
      component,
      models: [],
      usage: null,
      cache: { bytes: 0, files: 0, groups: 0, retained: 0 },
      warnings: [],
    }
    if (!component) return result
    try {
      await directory(component.cache)
      result.usage = await directoryUsage(component.cache)
      const scan = await scanCheckpoints(component.cache)
      result.cache = {
        bytes: scan.groups.reduce((n, g) => n + g.bytes, 0),
        files: scan.groups.reduce((n, g) => n + g.files.length, 0),
        groups: scan.groups.length,
        retained: scan.retained,
      }
    } catch (error) {
      result.warnings.push(
        error instanceof AppError ? error.message : '组件资源目录不可读，普通播放仍可使用。',
      )
    }
    try {
      const info = await lstat(component.models)
      if (!info.isFile() || info.size > 65536) throw new Error('Invalid manifest')
      const manifest = JSON.parse(await readFile(component.models, 'utf8'))
      if (manifest.version !== 1 || !manifest.models || typeof manifest.models !== 'object')
        throw new Error('Invalid models')
      for (const [name, item] of Object.entries(manifest.models).slice(0, 20)) {
        const model = item as Record<string, unknown>
        if (
          !model ||
          typeof model.path !== 'string' ||
          typeof model.repository !== 'string' ||
          typeof model.revision !== 'string'
        )
          continue
        const path = resolve(dirname(component.models), model.path)
        let available = false
        try {
          const entry = await stat(path)
          available = entry.isDirectory() || entry.isFile()
        } catch {
          /* Report missing without loading models. */
        }
        result.models.push({
          name,
          repository: model.repository,
          revision: model.revision,
          path,
          available,
        })
      }
    } catch {
      result.warnings.push('无法读取模型清单，请重新配置本地组件。')
    }
    return result
  }
  async prepare(): Promise<CacheClearPreview> {
    const cacheRoot = this.component.describe()?.cache
    if (!cacheRoot) throw new AppError('RUNTIME_UNAVAILABLE', '请先配置本地转写组件。')
    const scan = await scanCheckpoints(cacheRoot),
      token = randomUUID()
    this.preview = {
      token,
      created: Date.now(),
      cacheRoot,
      componentHash: digest(this.component.describe()),
      scan,
    }
    return {
      token,
      bytes: scan.groups.reduce((n, g) => n + g.bytes, 0),
      files: scan.groups.reduce((n, g) => n + g.files.length, 0),
      groups: scan.groups.length,
      retained: scan.retained,
    }
  }
  async clear(token: string): Promise<CacheClearResult> {
    this.inspecting = undefined
    const draft = this.preview
    this.preview = undefined
    if (
      !draft ||
      draft.token !== token ||
      Date.now() - draft.created > 300000 ||
      this.component.describe()?.cache !== draft.cacheRoot ||
      digest(this.component.describe()) !== draft.componentHash
    )
      throw new AppError('CONFLICT', '清理预览已过期或组件已变化，请重新预览。')
    const scan = await scanCheckpoints(draft.cacheRoot)
    if (scan.identity !== draft.scan.identity)
      throw new AppError('CONFLICT', '缓存自预览后已变化，请重新预览。')
    const result = { bytes: 0, files: 0, groups: 0 }
    for (const group of scan.groups) {
      const target = resolve(scan.root, group.name)
      if (!contained(scan.root, target) || !contained(draft.cacheRoot, target))
        throw new AppError('CONFLICT', '缓存目录超出配置范围。')
      // Revalidate resolved containment before every unlink; rmdir below is non-recursive.
      for (const file of group.files
        .filter((f) => f.name !== 'manifest.json')
        .concat(group.files.filter((f) => f.name === 'manifest.json'))) {
        await directory(draft.cacheRoot)
        await directory(scan.root)
        await directory(target)
        const path = join(target, file.name),
          stat = await lstat(path)
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size !== file.bytes ||
          stat.mtimeMs !== file.mtime ||
          stat.ctimeMs !== file.ctime ||
          stat.ino !== file.ino ||
          stat.dev !== file.dev
        )
          throw new AppError('CONFLICT', '缓存清理期间发生变化，剩余文件已保留，请刷新查看。')
        await unlink(path)
        result.bytes += file.bytes
        result.files++
      }
      await directory(target)
      await rmdir(target)
      result.groups++
    }
    return result
  }
  async log(): Promise<AppLog> {
    const path = join(this.logsPath, 'app.log')
    try {
      if ((await lstat(path)).isSymbolicLink())
        throw new AppError('FILE_UNAVAILABLE', '应用日志位置包含链接，请检查日志目录。')
      const file = await open(path, 'r')
      try {
        const size = (await file.stat()).size,
          bytes = Math.min(size, 65536),
          buffer = Buffer.alloc(bytes)
        const read = await file.read(buffer, 0, bytes, size - bytes)
        return {
          text: buffer.subarray(0, read.bytesRead).toString('utf8'),
          truncated: size > bytes,
        }
      } finally {
        await file.close()
      }
    } catch (error) {
      if (missing(error)) return { text: '', truncated: false }
      throw new AppError('FILE_UNAVAILABLE', '应用日志暂时不可读。')
    }
  }
}
