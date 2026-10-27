import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath, readdir, unlink } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { LibraryStore } from '../database'
import { AppError } from '../../shared/validation'
import type { SourceCacheUsage, SourceCachePreview } from '../../shared/sources'

type Stored = ReturnType<LibraryStore['sourceCacheFiles']>[number]
interface File extends Stored {
  ino: number
  dev: number
  ctimeMs: number
  offline: boolean
}
interface Scan {
  files: File[]
  retained: number
  protected: Set<string>
  identity: string
}
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const NAME = new RegExp(`^${UUID}-${UUID}\\.mp3$`)

// Only registered, ordinary app cache files are deleted. Unknown entries and links stay put.
export class SourceCache {
  private preview: { token: string; at: number; identity: string } | undefined
  constructor(
    private readonly store: LibraryStore,
    readonly directory: string,
    private readonly pins: () => Set<string>,
    readonly limitBytes = 512 * 1024 * 1024,
  ) {}
  private async root() {
    const info = await lstat(this.directory)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      resolve(await realpath(this.directory)) !== resolve(this.directory)
    )
      throw new AppError('CONFLICT', '在线缓存目录变化或包含链接，已停止清理。')
    return [info.dev, info.ino, info.birthtimeMs]
  }
  private async scan(extraPins = new Set<string>()): Promise<Scan> {
    const protectedIds = new Set([...this.pins(), ...extraPins])
    const offline = this.store.offlineRetainedFiles()
    let root: number[]
    try {
      root = await this.root()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        for (const file of offline)
          this.store.invalidateOfflineMedia(file, '离线音频目录已移除，请重新预览计划。')
        return { files: [], retained: 0, protected: protectedIds, identity: 'missing' }
      }
      throw error
    }
    const names = await readdir(this.directory)
    if (names.length > 100000) throw new AppError('BUSY', '在线缓存项目过多，暂未完成统计。')
    const available = new Set(names),
      files: File[] = []
    for (const file of this.store.sourceCacheFiles()) {
      if (
        file.localReferences ||
        dirname(file.path) !== this.directory ||
        !NAME.test(basename(file.path))
      )
        continue
      let info
      try {
        info = await lstat(file.path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          this.store.invalidateOfflineMedia(file, '离线音频已移除，请重新预览计划。')
          this.store.removeSourceCacheFile(file.path)
          continue
        }
        throw error
      }
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size !== file.sizeBytes ||
        info.mtimeMs !== file.modifiedAt
      ) {
        this.store.invalidateOfflineMedia(file, '离线音频文件已变化，请重新预览计划。')
        continue
      }
      if (resolve(await realpath(file.path)) !== resolve(file.path)) {
        this.store.invalidateOfflineMedia(file, '离线音频路径已变化，请重新预览计划。')
        continue
      }
      available.delete(basename(file.path))
      files.push({
        ...file,
        ino: info.ino,
        dev: info.dev,
        ctimeMs: info.ctimeMs,
        offline: offline.some(
          (ref) =>
            ref.path === file.path &&
            ref.contentHash === file.contentHash &&
            ref.sizeBytes === file.sizeBytes &&
            ref.modifiedAt === file.modifiedAt,
        ),
      })
    }
    files.sort((a, b) => a.accessedAt - b.accessedAt || a.path.localeCompare(b.path))
    const identity = createHash('sha256')
      .update(
        JSON.stringify({
          root,
          files,
          pins: [...protectedIds].sort(),
          retained: [...available].sort(),
          offline,
        }),
      )
      .digest('hex')
    return { files, retained: available.size, protected: protectedIds, identity }
  }
  private usage(scan: Scan): SourceCacheUsage {
    return {
      bytes: scan.files.filter((f) => !f.offline).reduce((sum, f) => sum + f.sizeBytes, 0),
      files: scan.files.filter((f) => !f.offline).length,
      retained: scan.retained,
      protectedFiles: scan.files.filter(
        (f) => !f.offline && f.episodeId && scan.protected.has(f.episodeId),
      ).length,
      limitBytes: this.limitBytes,
      offlineBytes: scan.files.filter((f) => f.offline).reduce((sum, f) => sum + f.sizeBytes, 0),
      offlineFiles: scan.files.filter((f) => f.offline).length,
    }
  }
  async state() {
    return this.usage(await this.scan())
  }
  async prepare(): Promise<SourceCachePreview> {
    const scan = await this.scan(),
      token = randomUUID()
    const targets = scan.files.filter(
      (f) => !f.offline && (!f.episodeId || !scan.protected.has(f.episodeId)),
    )
    this.preview = { token, identity: scan.identity, at: Date.now() }
    return {
      ...this.usage(scan),
      token,
      clearFiles: targets.length,
      clearBytes: targets.reduce((sum, f) => sum + f.sizeBytes, 0),
    }
  }
  private async remove(file: File, protectedIds: Set<string>) {
    await this.root()
    const info = await lstat(file.path)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.ino !== file.ino ||
      info.dev !== file.dev ||
      info.size !== file.sizeBytes ||
      info.mtimeMs !== file.modifiedAt ||
      info.ctimeMs !== file.ctimeMs ||
      file.offline ||
      this.store
        .offlineRetainedFiles()
        .some(
          (ref) =>
            ref.path === file.path &&
            ref.contentHash === file.contentHash &&
            ref.sizeBytes === file.sizeBytes &&
            ref.modifiedAt === file.modifiedAt,
        ) ||
      (file.episodeId && (protectedIds.has(file.episodeId) || this.pins().has(file.episodeId)))
    )
      throw new AppError('CONFLICT', '缓存或活动章节发生变化，已保留剩余文件，请重新预览。')
    await unlink(file.path)
    this.store.removeSourceCacheFile(file.path)
  }
  async clear(token: string): Promise<SourceCacheUsage> {
    const preview = this.preview
    this.preview = undefined
    if (!preview || preview.token !== token || Date.now() - preview.at > 300000)
      throw new AppError('CONFLICT', '清理预览已失效，请重新预览。')
    const scan = await this.scan()
    if (scan.identity !== preview.identity)
      throw new AppError('CONFLICT', '缓存或活动章节变化，请重新预览清理。')
    for (const file of scan.files)
      if (!file.offline && (!file.episodeId || !scan.protected.has(file.episodeId)))
        await this.remove(file, scan.protected)
    return this.state()
  }
  async reserve(bytes: number, episodeId: string, offline = false) {
    if (offline) {
      await this.root()
      return
    }
    const scan = await this.scan(new Set([episodeId]))
    let occupied = scan.files.filter((f) => !f.offline).reduce((sum, f) => sum + f.sizeBytes, 0)
    for (const file of scan.files) {
      if (occupied + bytes <= this.limitBytes) break
      if (file.offline) continue
      if (file.episodeId && scan.protected.has(file.episodeId)) continue
      await this.remove(file, scan.protected)
      occupied -= file.sizeBytes
    }
    if (occupied + bytes > this.limitBytes)
      throw new AppError(
        'SOURCE_MEDIA_UNAVAILABLE',
        '在线缓存配额不足；当前集和活动转写已保留，请稍后清理或重试。',
      )
  }
}
