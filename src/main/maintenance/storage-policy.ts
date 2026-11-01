import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  GeneratedStoragePolicy,
  GeneratedStoragePreview,
  GeneratedStorageResult,
  GeneratedStorageState,
} from '../../shared/backup-storage'
import { AppError } from '../../shared/validation'

export const DEFAULT_GENERATED_STORAGE_POLICY: GeneratedStoragePolicy = {
  automatic: false,
  keepLatest: 2,
  maxBytes: 2 * 1024 ** 3,
  maxAgeDays: 30,
}
type Kind = 'build' | 'package' | 'temporary'
interface Receipt {
  id: string
  kind: Kind
  createdAt: string
  label: string
  ready: boolean
}
interface FileStamp {
  path: string
  bytes: number
  mtime: number
  ino: number
  dev: number
  directory: boolean
}
interface Item {
  receipt: Receipt
  bytes: number
  files: FileStamp[]
  identity: string
  active: boolean
}
interface Plan {
  items: Item[]
  retained: number
  expires: number
}
interface SavedPlan {
  token: string
  items: Array<{ id: string; identity: string }>
  retained: number
  expires: number
  consumed: boolean
  policyHash: string
}
export interface GeneratedStorageOptions {
  directory: string
  isActive?: (path: string) => boolean
  /** Controlled synthetic fixtures only. */ remove?: (
    path: string,
    directory: boolean,
  ) => Promise<void>
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const safe = (root: string, path: string) => {
  const local = relative(root, path)
  return local !== '' && local !== '..' && !local.startsWith('..' + sep) && !isAbsolute(local)
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const invalid = (message: string): never => {
  throw new AppError('CONFLICT', message)
}
export function validateGeneratedStoragePolicy(value: unknown): GeneratedStoragePolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AppError('INVALID_REQUEST', '存储策略格式无效。')
  const p = value as Record<string, unknown>
  if (
    Object.keys(p).length !== 4 ||
    typeof p.automatic !== 'boolean' ||
    !Number.isSafeInteger(p.keepLatest) ||
    Number(p.keepLatest) < 2 ||
    Number(p.keepLatest) > 20 ||
    !Number.isSafeInteger(p.maxBytes) ||
    Number(p.maxBytes) < 64 * 1024 ** 2 ||
    Number(p.maxBytes) > 100 * 1024 ** 3 ||
    !Number.isSafeInteger(p.maxAgeDays) ||
    Number(p.maxAgeDays) < 1 ||
    Number(p.maxAgeDays) > 365
  )
    throw new AppError(
      'INVALID_REQUEST',
      '至少保留每类最新两份；配额范围为64 MiB–100 GiB，保留期1–365天。',
    )
  return p as unknown as GeneratedStoragePolicy
}
export class GeneratedStorageService {
  readonly directory: string
  private plans = new Map<string, Plan>()
  private policy: GeneratedStoragePolicy = { ...DEFAULT_GENERATED_STORAGE_POLICY }
  private working = false
  constructor(private options: GeneratedStorageOptions) {
    this.directory = resolve(options.directory)
  }
  private async root() {
    await mkdir(this.directory, { recursive: true })
    const info = await lstat(this.directory)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      resolve(await realpath(this.directory)) !== this.directory
    )
      invalid('生成物目录包含链接，清理已停止。')
  }
  private async readPolicy() {
    await this.root()
    try {
      const path = join(this.directory, 'policy.json'),
        info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) invalid('存储策略文件无效。')
      this.policy = validateGeneratedStoragePolicy(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if (!missing(error)) throw error
    }
    return this.policy
  }
  async savePolicy(value: unknown) {
    this.policy = validateGeneratedStoragePolicy(value)
    await this.root()
    const temporary = join(this.directory, randomUUID() + '.policy.json')
    await writeFile(temporary, JSON.stringify(this.policy, null, 2) + '\n', { flag: 'wx' })
    await rename(temporary, join(this.directory, 'policy.json'))
    this.plans.clear()
    return this.state()
  }
  /** Internal callers receive a fresh owned path, never register arbitrary existing directories. */
  async create(kind: Kind, label: string): Promise<{ id: string; directory: string }> {
    await this.root()
    if (!['build', 'package', 'temporary'].includes(kind) || !label || label.length > 160)
      throw new AppError('INVALID_REQUEST', '生成物类型或名称无效。')
    const id = randomUUID(),
      directory = join(this.directory, id)
    await mkdir(directory, { recursive: false })
    const receipt: Receipt = { id, kind, label, createdAt: new Date().toISOString(), ready: false }
    await writeFile(join(directory, '.generated-receipt.json'), JSON.stringify(receipt) + '\n', {
      flag: 'wx',
    })
    return { id, directory }
  }
  async complete(id: string) {
    if (!UUID.test(id)) throw new AppError('INVALID_REQUEST', '生成物标识无效。')
    const path = join(this.directory, id, '.generated-receipt.json'),
      info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) invalid('生成物回执已变化。')
    const receipt = JSON.parse(await readFile(path, 'utf8')) as Receipt
    if (receipt.id !== id) invalid('生成物身份已变化。')
    const temporary = join(this.directory, id, randomUUID() + '.receipt.json')
    await writeFile(temporary, JSON.stringify({ ...receipt, ready: true }) + '\n', { flag: 'wx' })
    await rename(temporary, path)
    return this.enforceAutomatic()
  }
  private async scan(): Promise<{ items: Item[]; warnings: string[]; unmanaged: number }> {
    await this.readPolicy()
    const items: Item[] = [],
      warnings: string[] = []
    let unmanaged = 0
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (['policy.json', 'cleanup-preview.json'].includes(entry.name)) continue
      if (!entry.isDirectory() || entry.isSymbolicLink() || !UUID.test(entry.name)) {
        unmanaged++
        continue
      }
      const root = join(this.directory, entry.name)
      try {
        const receiptPath = join(root, '.generated-receipt.json'),
          receiptInfo = await lstat(receiptPath)
        if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink() || receiptInfo.size > 4096)
          throw new Error()
        const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Receipt
        if (
          receipt.id !== entry.name ||
          !['build', 'package', 'temporary'].includes(receipt.kind) ||
          typeof receipt.ready !== 'boolean' ||
          typeof receipt.createdAt !== 'string' ||
          !Number.isFinite(Date.parse(receipt.createdAt))
        )
          throw new Error()
        const files: FileStamp[] = [],
          stack = [root]
        let bytes = 0
        while (stack.length) {
          const parent = stack.pop()!
          const stat = await lstat(parent)
          if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            resolve(await realpath(parent)) !== parent
          )
            throw new Error()
          files.push({
            path: parent,
            bytes: 0,
            mtime: stat.mtimeMs,
            ino: stat.ino,
            dev: stat.dev,
            directory: true,
          })
          for (const child of await readdir(parent, { withFileTypes: true })) {
            const path = join(parent, child.name)
            if (!safe(root, path) || child.isSymbolicLink()) throw new Error()
            const info = await lstat(path)
            if (info.isSymbolicLink()) throw new Error()
            if (info.isDirectory()) stack.push(path)
            else if (info.isFile()) {
              bytes += info.size
              files.push({
                path,
                bytes: info.size,
                mtime: info.mtimeMs,
                ino: info.ino,
                dev: info.dev,
                directory: false,
              })
            } else throw new Error()
            if (files.length > 50000) throw new Error()
          }
        }
        files.sort((a, b) => a.path.localeCompare(b.path))
        const identity = createHash('sha256').update(JSON.stringify(files)).digest('hex')
        items.push({
          receipt,
          bytes,
          files,
          identity,
          active: !receipt.ready || !!this.options.isActive?.(root),
        })
      } catch {
        unmanaged++
        warnings.push(`已保留无法核验的生成物 ${entry.name}。`)
      }
    }
    return { items, warnings, unmanaged }
  }
  async state(): Promise<GeneratedStorageState> {
    const scan = await this.scan()
    const bytes = scan.items.reduce((n, x) => n + x.bytes, 0)
    if (bytes > this.policy.maxBytes)
      scan.warnings.push('当前生成物超过配额；每类最新保留项、活动任务和无法核验的内容仍受保护。')
    return {
      directory: this.directory,
      policy: { ...this.policy },
      bytes,
      items: scan.items.length,
      protectedItems: scan.items.filter((x) => x.active).length + scan.unmanaged,
      warnings: scan.warnings,
    }
  }
  async preview(): Promise<GeneratedStoragePreview> {
    const { items } = await this.scan()
    const kept = new Set<string>()
    for (const kind of ['build', 'package', 'temporary'] as const)
      for (const item of items
        .filter((x) => x.receipt.kind === kind && x.receipt.ready)
        .sort((a, b) => b.receipt.createdAt.localeCompare(a.receipt.createdAt))
        .slice(0, this.policy.keepLatest))
        kept.add(item.receipt.id)
    const ordered = items
      .filter((x) => !x.active && !kept.has(x.receipt.id))
      .sort((a, b) => a.receipt.createdAt.localeCompare(b.receipt.createdAt))
    let total = items.reduce((n, x) => n + x.bytes, 0)
    const selected: Item[] = []
    for (const item of ordered) {
      const expired =
        Date.now() - Date.parse(item.receipt.createdAt) > this.policy.maxAgeDays * 86400_000
      if (expired || total > this.policy.maxBytes) {
        selected.push(item)
        total -= item.bytes
      }
    }
    const token = randomUUID(),
      expires = Date.now() + 5 * 60_000
    this.plans.clear()
    this.plans.set(token, { items: selected, expires, retained: items.length - selected.length })
    await this.savePlan({
      token,
      items: selected.map((x) => ({ id: x.receipt.id, identity: x.identity })),
      expires,
      retained: items.length - selected.length,
      consumed: false,
      policyHash: createHash('sha256').update(JSON.stringify(this.policy)).digest('hex'),
    })
    return {
      token,
      bytes: selected.reduce((n, x) => n + x.bytes, 0),
      items: selected.length,
      retained: items.length - selected.length,
      expiresAt: new Date(expires).toISOString(),
    }
  }
  async clear(token: string): Promise<GeneratedStorageResult> {
    if (this.working) throw new AppError('BUSY', '已有生成物清理正在进行。')
    if (!UUID.test(token)) invalid('清理预览无效。')
    const path = join(this.directory, 'cleanup-preview.json'),
      info = await lstat(path).catch((error) => {
        if (!missing(error)) throw error
        return null
      })
    if (!info || !info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
      invalid('清理预览不存在，请重新预览。')
    const plan = JSON.parse(await readFile(path, 'utf8')) as SavedPlan
    this.plans.delete(token)
    if (
      !plan ||
      plan.token !== token ||
      plan.consumed ||
      !Array.isArray(plan.items) ||
      plan.items.length > 10000 ||
      !Number.isFinite(plan.expires) ||
      plan.expires < Date.now()
    )
      invalid('清理预览已失效，请重新预览。')
    this.working = true
    try {
      const scan = await this.scan()
      if (
        plan.policyHash !== createHash('sha256').update(JSON.stringify(this.policy)).digest('hex')
      )
        invalid('存储策略已变化，请重新预览。')
      const protectedIds = new Set<string>()
      for (const kind of ['build', 'package', 'temporary'] as const)
        for (const item of scan.items
          .filter((x) => x.receipt.ready && x.receipt.kind === kind)
          .sort((a, b) => b.receipt.createdAt.localeCompare(a.receipt.createdAt))
          .slice(0, this.policy.keepLatest))
          protectedIds.add(item.receipt.id)
      const selected: Item[] = []
      for (const item of plan.items) {
        const current = scan.items.find((x) => x.receipt.id === item.id)
        if (
          !UUID.test(item.id) ||
          typeof item.identity !== 'string' ||
          !current ||
          current.active ||
          protectedIds.has(item.id) ||
          current.identity !== item.identity
        )
          invalid('生成物在预览后变化，未开始清理，请重新预览。')
        selected.push(current!)
      }
      await this.savePlan({ ...plan, consumed: true })
      const result: GeneratedStorageResult = { bytes: 0, items: 0, skipped: 0 }
      for (const item of selected) {
        const root = join(this.directory, item.receipt.id)
        if (this.options.isActive?.(root)) {
          result.skipped++
          continue
        }
        // Keep the ownership receipt until all payloads are removed, so an I/O failure
        // leaves the remaining generated directory recognizable for a later preview.
        for (const file of item.files
          .filter((x) => !x.directory)
          .sort(
            (a, b) =>
              Number(a.path.endsWith(sep + '.generated-receipt.json')) -
              Number(b.path.endsWith(sep + '.generated-receipt.json')),
          )) {
          if (!safe(this.directory, file.path)) invalid('清理路径越界，已停止。')
          for (
            let ancestor = dirname(file.path);
            safe(this.directory, ancestor);
            ancestor = dirname(ancestor)
          ) {
            const parent = await lstat(ancestor)
            if (
              !parent.isDirectory() ||
              parent.isSymbolicLink() ||
              resolve(await realpath(ancestor)) !== ancestor
            )
              invalid('清理期间目录变化，已停止。')
          }
          const info = await lstat(file.path)
          if (
            !info.isFile() ||
            info.isSymbolicLink() ||
            info.size !== file.bytes ||
            info.mtimeMs !== file.mtime ||
            info.ino !== file.ino ||
            info.dev !== file.dev
          )
            invalid('清理期间文件变化，已停止并保留剩余内容。')
          if (this.options.remove) await this.options.remove(file.path, false)
          else await unlink(file.path)
          result.bytes += file.bytes
        }
        for (const directory of item.files
          .filter((x) => x.directory)
          .sort((a, b) => b.path.length - a.path.length)) {
          const info = await lstat(directory.path)
          if (
            !safe(this.directory, directory.path) ||
            !info.isDirectory() ||
            info.isSymbolicLink() ||
            resolve(await realpath(directory.path)) !== directory.path
          )
            invalid('清理目录变化，已停止。')
          if (this.options.remove) await this.options.remove(directory.path, true)
          else await rmdir(directory.path)
        }
        result.items++
      }
      return result
    } finally {
      this.working = false
    }
  }
  async enforceAutomatic(): Promise<GeneratedStorageResult> {
    await this.readPolicy()
    if (!this.policy.automatic) return { bytes: 0, items: 0, skipped: 0 }
    const preview = await this.preview()
    return this.clear(preview.token)
  }
  private async savePlan(plan: SavedPlan) {
    await this.root()
    const temporary = join(this.directory, randomUUID() + '.plan.json')
    await writeFile(temporary, JSON.stringify(plan) + '\n', { flag: 'wx' })
    await rename(temporary, join(this.directory, 'cleanup-preview.json'))
  }
}
