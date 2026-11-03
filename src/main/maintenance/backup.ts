import { createHash, randomUUID } from 'node:crypto'
import { backup, DatabaseSync } from 'node:sqlite'
import { cp, lstat, mkdir, open, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type {
  BackupExportResult,
  BackupPreview,
  RestoredPreferences,
} from '../../shared/backup-storage'
import { AppError } from '../../shared/validation'
import { BACKUP_LIMIT, backupPath, packBackup, unpackBackup } from './archive'
import { GeneratedStorageService } from './storage-policy'
import { validateRemoteLibrary } from '../sources/text-service'
import { sourceCoverMime } from '../sources/source-covers'
import { LIBRARY_SCHEMA_VERSION } from '../database-schema'

const EXCLUDED = [
  '原音频／原书籍文件、离线模型和可重建缓存',
  '个人书库密码、令牌、Cookie 及组件绝对路径',
  '插件执行包（保留公开名称／版本，迁移后按需重新安装）',
]
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const reject = (message: string): never => {
  throw new AppError('INVALID_REQUEST', message)
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const optionalStat = (path: string) =>
  lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n')

export function validateBackupSettings(value: unknown): Record<string, string> {
  if (!object(value) || Object.keys(value).length > 2048) return reject('阅读设置格式无效。')
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (
      !/^ralb:(?:(?:app|reader|reading|companion):[a-zA-Z0-9:_-]{1,160}|ebook-speech:v1|library:layout|reader-preferences:v1)$/.test(
        key,
      ) ||
      typeof item !== 'string' ||
      Buffer.byteLength(item) > 128 * 1024
    )
      return reject('只备份应用外观、阅读偏好和阅读书签，不接受其他本地存储。')
    result[key] = item
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) return reject('阅读设置过大。')
  return result
}
function publicUrl(value: unknown) {
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.href
  } catch {
    return ''
  }
}
function sanitizeLibraries(bytes: Buffer): Buffer {
  const value: unknown = JSON.parse(bytes.toString('utf8'))
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.libraries) ||
    value.libraries.length > 40
  )
    return reject('书库配置无效，备份未创建。')
  const manifests: Record<string, number> = {},
    imports: Record<string, string> = {}
  if (object(value.manifests))
    for (const [id, version] of Object.entries(value.manifests)) {
      if (/^[a-zA-Z0-9_-]{1,100}$/.test(id) && Number.isSafeInteger(version) && Number(version) > 0)
        manifests[id] = Number(version)
    }
  if (object(value.imports))
    for (const [id, book] of Object.entries(value.imports)) {
      if (
        /^[a-f0-9]{64}$/.test(id) &&
        typeof book === 'string' &&
        /^[a-zA-Z0-9_.:-]{1,160}$/.test(book)
      )
        imports[id] = book
    }
  return json({
    schemaVersion: 1,
    libraries: value.libraries.map((item) => {
      if (!object(item)) return reject('书库配置无效。')
      return validateRemoteLibrary(
        {
          id: item.id,
          kind: item.kind,
          label: item.label,
          baseUrl: publicUrl(item.baseUrl),
          enabled: !!item.enabled,
        },
        true,
      )
    }),
    manifests,
    imports,
  })
}
interface Manifest {
  format: 'readlisten-backup'
  formatVersion: 1
  version: string
  createdAt: string
  schemaVersion: number
  counts: { books: number; readingBooks: number; bookmarks: number; transcripts: number }
  plugins: Array<{ id: string; name: string; version: string }>
  files: Array<{ path: string; bytes: number; sha256: string }>
}
function readManifest(raw: unknown, maximum: number): Manifest {
  if (
    !object(raw) ||
    raw.format !== 'readlisten-backup' ||
    raw.formatVersion !== 1 ||
    typeof raw.version !== 'string' ||
    raw.version.length > 80 ||
    typeof raw.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(raw.createdAt)) ||
    !Number.isSafeInteger(raw.schemaVersion) ||
    Number(raw.schemaVersion) < 1 ||
    Number(raw.schemaVersion) > maximum ||
    !object(raw.counts) ||
    !['books', 'readingBooks', 'bookmarks', 'transcripts'].every(
      (key) =>
        Number.isSafeInteger((raw.counts as Record<string, unknown>)[key]) &&
        Number((raw.counts as Record<string, unknown>)[key]) >= 0,
    ) ||
    !Array.isArray(raw.files) ||
    raw.files.length < 2 ||
    raw.files.length > 4094 ||
    !Array.isArray(raw.plugins) ||
    raw.plugins.length > 20
  )
    return reject('备份格式或版本不兼容。')
  const seen = new Set<string>()
  let total = 0
  for (const item of raw.files) {
    if (
      !object(item) ||
      typeof item.path !== 'string' ||
      !validEntry(item.path) ||
      !backupPath(item.path) ||
      seen.has(item.path) ||
      !Number.isSafeInteger(item.bytes) ||
      Number(item.bytes) < 0 ||
      typeof item.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.sha256)
    )
      return reject('备份包含不允许的路径或摘要。')
    total += Number(item.bytes)
    if (total > BACKUP_LIMIT) return reject('备份内容超限。')
    seen.add(item.path)
  }
  if (!seen.has('data/library.sqlite3') || !seen.has('preferences.json'))
    return reject('备份缺少书库或偏好。')
  for (const plugin of raw.plugins)
    if (
      !object(plugin) ||
      Object.keys(plugin).length !== 3 ||
      typeof plugin.id !== 'string' ||
      typeof plugin.name !== 'string' ||
      typeof plugin.version !== 'string' ||
      plugin.id.length > 100 ||
      plugin.name.length > 200 ||
      plugin.version.length > 80
    )
      return reject('备份插件信息无效。')
  return raw as unknown as Manifest
}
function validateFileContents(manifest: Manifest, files: Map<string, Buffer>) {
  for (const item of manifest.files) {
    const bytes = files.get(item.path)
    if (!bytes || bytes.length !== item.bytes || digest(bytes) !== item.sha256)
      return reject('备份内容摘要不匹配。')
    validateCover(item.path, bytes)
  }
  validateBackupSettings(JSON.parse(files.get('preferences.json')!.toString('utf8')))
  const config = files.get('data/text-libraries.json')
  if (config && !sanitizeLibraries(config).equals(config))
    return reject('备份书库配置含未知字段或凭据。')
}
function validEntry(path: string): boolean {
  return (
    [
      'data/library.sqlite3',
      'data/listening-reviews.sqlite3',
      'data/text-libraries.json',
      'preferences.json',
    ].includes(path) || /^data\/book-covers\/(?:index\.json|[a-f0-9]{64}\.img)$/.test(path)
  )
}
function validateCover(path: string, bytes: Buffer) {
  if (path.endsWith('.img')) {
    if (
      bytes.length > 2 * 1024 * 1024 ||
      !sourceCoverMime(bytes) ||
      digest(bytes) !== path.slice(path.lastIndexOf('/') + 1, -4)
    )
      return reject('封面文件身份或图片格式无效。')
  } else if (path === 'data/book-covers/index.json') {
    const raw: unknown = JSON.parse(bytes.toString('utf8'))
    if (
      !object(raw) ||
      Object.keys(raw).length !== 2 ||
      raw.schemaVersion !== 1 ||
      !Array.isArray(raw.bindings) ||
      raw.bindings.length > 512 ||
      bytes.length > 256 * 1024
    )
      return reject('封面索引格式无效。')
    const seen = new Set<string>()
    for (const item of raw.bindings) {
      if (
        !object(item) ||
        Object.keys(item).length !== 5 ||
        !['kind', 'id', 'hash', 'bytes', 'usedAt'].every((key) => Object.hasOwn(item, key)) ||
        !['audio', 'ebook'].includes(String(item.kind)) ||
        typeof item.id !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,160}$/.test(item.id) ||
        typeof item.hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(item.hash) ||
        !Number.isSafeInteger(item.bytes) ||
        Number(item.bytes) < 1 ||
        Number(item.bytes) > 2 * 1024 * 1024 ||
        !Number.isSafeInteger(item.usedAt) ||
        Number(item.usedAt) < 1 ||
        seen.has(`${item.kind}:${item.id}`)
      )
        return reject('封面索引含无效或重复关联。')
      seen.add(`${item.kind}:${item.id}`)
    }
  }
}
function inspectDatabase(path: string, maximum: number, library: boolean) {
  const db = new DatabaseSync(path, { readOnly: true, enableForeignKeyConstraints: true })
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;')
    const check = db.prepare('PRAGMA quick_check(1)').get()
    if (!check || Object.values(check)[0] !== 'ok') return reject('备份数据库完整性校验失败。')
    const schema = Number(db.prepare('PRAGMA user_version').get()?.user_version)
    if (!Number.isSafeInteger(schema) || schema < 1 || schema > maximum)
      return reject('备份数据库来自不兼容版本，请先升级软件。')
    const count = (table: string) => {
      if (db.prepare('SELECT type FROM sqlite_master WHERE name=?').get(table)?.type !== 'table')
        return reject('备份缺少必要的书库数据。')
      return Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count)
    }
    return {
      schema,
      counts: library
        ? {
            books: count('books'),
            readingBooks: count('reading_books'),
            bookmarks: count('bookmarks'),
            transcripts: count('transcripts'),
          }
        : { books: 0, readingBooks: 0, bookmarks: 0, transcripts: 0 },
    }
  } finally {
    db.close()
  }
}
async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${randomUUID()}.json`)
  await writeFile(temporary, json(value), { flag: 'wx', mode: 0o600 })
  await rename(temporary, path)
}
async function regularRead(path: string, maximum = BACKUP_LIMIT) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum)
    return reject('备份文件包含链接、特殊文件或超限内容。')
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maximum) return reject('备份文件在读取时发生变化。')
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of file.createReadStream({ autoClose: false, end: maximum })) {
      length += chunk.length
      if (length > maximum) return reject('备份文件在读取时超出限制。')
      chunks.push(Buffer.from(chunk))
    }
    const bytes = Buffer.concat(chunks)
    if (bytes.length !== stat.size) return reject('备份文件在读取时发生变化。')
    return bytes
  } finally {
    await file.close()
  }
}
async function assertDirectory(path: string) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) return reject('备份数据目录包含链接。')
}
export interface BackupOptions {
  root: string
  version: string
  maxSchemaVersion: number
  isBusy?: () => boolean
  beforeSnapshot?: () => Promise<void>
  publicPlugins?: () => Array<{ id: string; name: string; version: string }>
  generated?: GeneratedStorageService
  withSnapshot?: <T>(copy: () => Promise<T>) => Promise<T>
}
interface Parsed {
  manifest: Manifest
  files: Map<string, Buffer>
}
interface PreviewRecord extends Parsed {
  directory: string
  expires: number
}
export class BackupService {
  private previews = new Map<string, PreviewRecord>()
  private working = false
  private staged = false
  private generated: GeneratedStorageService
  readonly directory: string
  constructor(private options: BackupOptions) {
    this.directory = join(resolve(options.root), 'maintenance')
    this.generated =
      options.generated ??
      new GeneratedStorageService({ directory: join(options.root, 'cache', 'generated-artifacts') })
  }
  private check() {
    if (this.working || this.staged || this.options.isBusy?.())
      throw new AppError(
        'BUSY',
        '请先暂停播放并等待正在运行的导入、字幕和离线任务结束，再操作备份恢复。',
      )
  }
  async exportTo(destination: string, settings: unknown): Promise<BackupExportResult> {
    return this.options.withSnapshot
      ? this.options.withSnapshot(() => this.createExport(destination, settings))
      : this.createExport(destination, settings)
  }
  private async createExport(destination: string, settings: unknown): Promise<BackupExportResult> {
    this.check()
    this.working = true
    let generatedId: string | undefined
    try {
      const preferences = validateBackupSettings(settings)
      await this.options.beforeSnapshot?.()
      if (this.options.isBusy?.()) throw new AppError('BUSY', '仍有活动任务，备份未开始。')
      const slot = await this.generated.create('temporary', 'backup-snapshot')
      generatedId = slot.id
      const run = slot.directory
      await assertDirectory(join(this.options.root, 'data'))
      const files = new Map<string, Buffer>()
      let expandedBytes = 0
      const addFile = (path: string, bytes: Buffer) => {
        expandedBytes += bytes.length
        if (expandedBytes > BACKUP_LIMIT - 2 * 1024 * 1024)
          return reject('书库超过本版 256 MiB 备份限制，备份未创建。')
        files.set(path, bytes)
      }
      for (const name of ['library.sqlite3', 'listening-reviews.sqlite3']) {
        const source = join(this.options.root, 'data', name)
        if (!(await optionalStat(source))) {
          if (name === 'library.sqlite3') return reject('当前书库数据库不存在。')
          continue
        }
        const info = await lstat(source)
        if (!info.isFile() || info.isSymbolicLink() || info.size > BACKUP_LIMIT)
          return reject('数据库路径无效或超过本版 256 MiB 备份限制。')
        const db = new DatabaseSync(source, { readOnly: true })
        try {
          await backup(db, join(run, name), { rate: 100 })
        } finally {
          db.close()
        }
        // A standalone snapshot must not depend on an unexported WAL sidecar.
        const snapshot = new DatabaseSync(join(run, name))
        try {
          snapshot.exec('PRAGMA journal_mode=DELETE;')
        } finally {
          snapshot.close()
        }
        addFile('data/' + name, await regularRead(join(run, name)))
      }
      const summary = inspectDatabase(
        join(run, 'library.sqlite3'),
        this.options.maxSchemaVersion,
        true,
      )
      const libraries = join(this.options.root, 'data', 'text-libraries.json')
      if (await optionalStat(libraries))
        addFile(
          'data/text-libraries.json',
          sanitizeLibraries(await regularRead(libraries, 2 * 1024 * 1024)),
        )
      const covers = join(this.options.root, 'data', 'book-covers')
      if (await optionalStat(covers)) {
        const stack = [covers]
        while (stack.length) {
          const directory = stack.pop()!
          await assertDirectory(directory)
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name)
            if (entry.isSymbolicLink()) return reject('封面目录包含链接，备份未创建。')
            if (entry.isDirectory()) stack.push(path)
            else if (entry.isFile()) {
              const local =
                'data/book-covers/' + path.slice(covers.length + 1).replaceAll('\\', '/')
              if (!validEntry(local) || !backupPath(local))
                return reject('封面目录含非封面文件，备份未创建。')
              const bytes = await regularRead(path, 4 * 1024 * 1024)
              validateCover(local, bytes)
              addFile(local, bytes)
              if (files.size > 4094) return reject('封面数量超过本次备份限制。')
            }
          }
        }
      }
      addFile('preferences.json', json(preferences))
      let plugins: Array<{ id: string; name: string; version: string }> = []
      try {
        plugins = (this.options.publicPlugins?.() ?? [])
          .slice(0, 20)
          .map((p) => ({ id: p.id, name: p.name, version: p.version }))
      } catch {
        /* A damaged optional plugin registry must not prevent books from being backed up. */
      }
      const manifest: Manifest = {
        format: 'readlisten-backup',
        formatVersion: 1,
        version: this.options.version,
        createdAt: new Date().toISOString(),
        schemaVersion: summary.schema,
        counts: summary.counts,
        plugins,
        files: [...files].map(([path, bytes]) => ({
          path,
          bytes: bytes.length,
          sha256: digest(bytes),
        })),
      }
      files.set('manifest.json', json(manifest))
      const bytes = await packBackup(files)
      if (!destination.toLowerCase().endsWith('.zip'))
        return reject('备份文件必须使用 ZIP 扩展名。')
      const existing = await optionalStat(destination)
      if (existing) return reject('备份文件已存在，请选择新的文件名。')
      await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 })
      return {
        path: destination,
        bytes: bytes.length,
        sha256: digest(bytes),
        files: manifest.files.length,
        createdAt: manifest.createdAt,
      }
    } finally {
      if (generatedId) await this.generated.complete(generatedId).catch(() => undefined)
      this.working = false
    }
  }
  private async parse(path: string): Promise<Parsed> {
    const files = await unpackBackup(await regularRead(path))
    const manifestBytes = files.get('manifest.json')
    if (!manifestBytes || manifestBytes.length > 1024 * 1024) return reject('备份缺少有效清单。')
    const manifest = readManifest(
      JSON.parse(manifestBytes.toString('utf8')),
      this.options.maxSchemaVersion,
    )
    if (manifest.files.length !== files.size - 1) return reject('备份文件数与清单不一致。')
    validateFileContents(manifest, files)
    return { manifest, files }
  }
  async previewFile(path: string): Promise<BackupPreview> {
    this.check()
    this.working = true
    let generatedId: string | undefined
    try {
      const parsed = await this.parse(path),
        previewId = randomUUID(),
        slot = await this.generated.create('temporary', 'backup-inspection'),
        directory = slot.directory
      generatedId = slot.id
      for (const name of ['data/library.sqlite3', 'data/listening-reviews.sqlite3']) {
        const bytes = parsed.files.get(name)
        if (!bytes) continue
        const target = join(directory, name)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, bytes, { flag: 'wx', mode: 0o600 })
      }
      const summary = inspectDatabase(
        join(directory, 'data/library.sqlite3'),
        this.options.maxSchemaVersion,
        true,
      )
      if (
        summary.schema !== parsed.manifest.schemaVersion ||
        JSON.stringify(summary.counts) !== JSON.stringify(parsed.manifest.counts)
      )
        return reject('备份书库统计与清单不一致。')
      if (parsed.files.has('data/listening-reviews.sqlite3'))
        inspectDatabase(join(directory, 'data/listening-reviews.sqlite3'), 1, false)
      const expires = Date.now() + 15 * 60 * 1000
      this.previews.clear()
      this.previews.set(previewId, { ...parsed, directory, expires })
      return {
        previewId,
        createdAt: parsed.manifest.createdAt,
        version: parsed.manifest.version,
        schemaVersion: summary.schema,
        files: parsed.manifest.files.length,
        bytes: parsed.manifest.files.reduce((n, x) => n + x.bytes, 0),
        ...summary.counts,
        plugins: parsed.manifest.plugins,
        excluded: EXCLUDED,
        expiresAt: new Date(expires).toISOString(),
      }
    } finally {
      if (generatedId) await this.generated.complete(generatedId).catch(() => undefined)
      this.working = false
    }
  }
  async stageRestore(previewId: string): Promise<{ needsRestart: true }> {
    this.check()
    this.working = true
    try {
      const preview = this.previews.get(previewId)
      if (!preview || preview.expires < Date.now())
        throw new AppError('CONFLICT', '恢复预览已失效，请重新选择备份。')
      if (await optionalStat(join(this.directory, 'pending-restore.json')))
        throw new AppError('BUSY', '已有待重启恢复，请先重启软件。')
      const token = randomUUID(),
        staging = join(this.directory, 'staged', token)
      await mkdir(staging, { recursive: true })
      for (const item of preview.manifest.files) {
        const bytes = preview.files.get(item.path)!
        if (bytes.length !== item.bytes || digest(bytes) !== item.sha256)
          throw new AppError('CONFLICT', '备份预览内容发生变化，请重新选择。')
        const target = join(staging, item.path)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, bytes, { flag: 'wx', mode: 0o600 })
      }
      await writeJson(join(staging, 'manifest.json'), preview.manifest)
      await writeJson(join(this.directory, 'pending-restore.json'), { version: 1, token })
      this.staged = true
      this.previews.clear()
      return { needsRestart: true }
    } finally {
      this.working = false
    }
  }
  async restoredSettings(): Promise<RestoredPreferences | null> {
    const path = join(this.directory, 'restored-preferences.json')
    if (!(await optionalStat(path))) return null
    const raw = JSON.parse(
      (await regularRead(path, 3 * 1024 * 1024)).toString('utf8'),
    ) as RestoredPreferences
    return { ...raw, settings: validateBackupSettings(raw.settings) }
  }
  async acknowledgeSettings() {
    const previous = await this.restoredSettings()
    if (previous)
      await writeJson(join(this.directory, 'restored-preferences.json'), {
        ...previous,
        acknowledged: true,
      })
  }
}

/** Runs before any store/queue is opened. Old data is retained for recovery, never deleted. */
export async function applyPendingRestoreAtStartup(
  root: string,
  options: { maxSchemaVersion?: number; move?: typeof rename } = {},
): Promise<{ applied: boolean; notice?: string }> {
  const directory = join(resolve(root), 'maintenance'),
    pendingPath = join(directory, 'pending-restore.json')
  if (!(await optionalStat(pendingPath))) return { applied: false }
  const invalidPending = async () => {
    await assertDirectory(directory)
    // Quarantine a bad intent only when there is a healthy current library to open.
    // Otherwise an interrupted rename could be mistaken for a new empty library.
    try {
      await assertDirectory(join(resolve(root), 'data'))
      inspectDatabase(
        join(resolve(root), 'data/library.sqlite3'),
        options.maxSchemaVersion ?? LIBRARY_SCHEMA_VERSION,
        true,
      )
    } catch {
      throw new AppError(
        'CONFLICT',
        `待恢复记录损坏且当前书库无法校验，请保留 ${directory} 并先恢复原 data 目录。`,
      )
    }
    await rename(pendingPath, join(directory, 'failed-invalid-' + randomUUID() + '.json'))
    return { applied: false, notice: '待恢复记录无法校验，原书库未替换，请重新选择备份。' }
  }
  let token: string
  try {
    await assertDirectory(directory)
    const pending: unknown = JSON.parse((await regularRead(pendingPath, 4096)).toString('utf8'))
    if (
      !object(pending) ||
      Object.keys(pending).length !== 2 ||
      pending.version !== 1 ||
      typeof pending.token !== 'string' ||
      !UUID.test(pending.token)
    )
      return invalidPending()
    token = pending.token
  } catch {
    return invalidPending()
  }
  const staging = join(directory, 'staged', token),
    newData = join(staging, 'data'),
    current = join(resolve(root), 'data'),
    rollback = join(directory, 'rollback', token),
    oldData = join(rollback, 'data')
  const move = options.move ?? rename
  let oldMoved = false,
    newMoved = false
  try {
    await assertDirectory(staging)
    // If the previous process stopped between renames, prefer the preserved original.
    if (await optionalStat(oldData)) {
      await assertDirectory(oldData)
      if (await optionalStat(newData)) {
        if (await optionalStat(current)) {
          await assertDirectory(current)
          await move(current, join(rollback, 'interrupted-current-' + randomUUID()))
        }
        await move(oldData, current)
        await move(pendingPath, join(directory, 'failed-' + token + '.json'))
        return { applied: false, notice: '上次恢复被中断，已恢复原书库；请选择备份后重试。' }
      }
      oldMoved = true
      newMoved = !!(await optionalStat(current))
    }
    const manifest = readManifest(
      JSON.parse((await regularRead(join(staging, 'manifest.json'), 1024 * 1024)).toString('utf8')),
      options.maxSchemaVersion ?? LIBRARY_SCHEMA_VERSION,
    )
    const data = newMoved ? current : newData
    await assertDirectory(data)
    const files = new Map<string, Buffer>()
    for (const item of manifest.files) {
      const path = item.path.startsWith('data/')
        ? join(data, item.path.slice(5))
        : join(staging, item.path)
      files.set(item.path, await regularRead(path, item.bytes))
    }
    validateFileContents(manifest, files)
    const summary = inspectDatabase(
      join(data, 'library.sqlite3'),
      options.maxSchemaVersion ?? LIBRARY_SCHEMA_VERSION,
      true,
    )
    if (
      summary.schema !== manifest.schemaVersion ||
      !Object.entries(summary.counts).every(
        ([key, value]) => manifest.counts[key as keyof Manifest['counts']] === value,
      )
    )
      return reject('待恢复书库统计与清单不一致，原书库未替换。')
    if (files.has('data/listening-reviews.sqlite3'))
      inspectDatabase(join(data, 'listening-reviews.sqlite3'), 1, false)
    const settings = validateBackupSettings(
      JSON.parse(files.get('preferences.json')!.toString('utf8')),
    )
    if (!newMoved) {
      // Backups cannot supply executable plugins or any unlisted data files.
      const expected = new Set(
          manifest.files
            .filter((item) => item.path.startsWith('data/'))
            .map((item) => item.path.slice(5)),
        ),
        stack = [newData]
      let entries = 0
      while (stack.length) {
        const parent = stack.pop()!
        await assertDirectory(parent)
        for (const entry of await readdir(parent, { withFileTypes: true })) {
          const path = join(parent, entry.name)
          if (entry.isSymbolicLink()) return reject('待恢复目录含链接，原书库未替换。')
          if (entry.isDirectory()) stack.push(path)
          else if (
            !entry.isFile() ||
            !expected.delete(path.slice(newData.length + 1).replaceAll('\\', '/'))
          )
            return reject('待恢复目录含未列入清单的文件，原书库未替换。')
          if (++entries > 8192) return reject('待恢复目录条目过多。')
        }
      }
      if (expected.size) return reject('待恢复目录缺少文件。')
      // Installed scripts and their local health/update records are never supplied by a ZIP.
      for (const name of ['source-plugins', 'plugin-maintenance']) {
        const installed = join(current, name)
        if (!(await optionalStat(installed))) continue
        await assertDirectory(current)
        await assertDirectory(installed)
        const paths = [installed]
        let entries = 0
        while (paths.length) {
          const parent = paths.pop()!
          await assertDirectory(parent)
          for (const entry of await readdir(parent, { withFileTypes: true })) {
            if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
              return reject('当前插件目录含链接或特殊文件，恢复未开始。')
            if (entry.isDirectory()) paths.push(join(parent, entry.name))
            if (++entries > 20000) return reject('当前插件目录条目超限，恢复未开始。')
          }
        }
        await cp(installed, join(newData, name), {
          recursive: true,
          errorOnExist: true,
          force: false,
        })
      }
      await assertDirectory(current)
      await mkdir(rollback, { recursive: true })
      await move(current, oldData)
      oldMoved = true
      await move(newData, current)
      newMoved = true
    }
    await writeJson(join(directory, 'restored-preferences.json'), {
      settings,
      plugins: manifest.plugins,
      restoredAt: new Date().toISOString(),
      acknowledged: false,
    })
    await move(pendingPath, join(directory, 'completed-' + token + '.json'))
    return { applied: true }
  } catch (error) {
    try {
      if (newMoved && (await optionalStat(current)))
        await rename(current, join(staging, 'failed-data-' + randomUUID()))
      if (oldMoved && (await optionalStat(oldData))) await rename(oldData, current)
      if (await optionalStat(pendingPath))
        await rename(pendingPath, join(directory, 'failed-' + token + '.json'))
    } catch {
      throw new AppError(
        'CONFLICT',
        `恢复与自动回退未完成，请保留 ${rollback} 并关闭软件后恢复原 data 目录。`,
      )
    }
    return {
      applied: false,
      notice:
        error instanceof AppError
          ? error.message
          : '恢复未完成，已保留并恢复原书库，请重新选择备份。',
    }
  }
}
