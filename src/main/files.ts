import { access, realpath, stat, readdir } from 'node:fs/promises'
import { constants, createReadStream } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, extname, join, relative } from 'node:path'
import { AUDIO_EXTENSIONS } from '../shared/contracts'
import { AppError } from '../shared/validation'
import type { FileMetadata } from './database'

export interface ImportedAudio extends FileMetadata {
  id: string
  contentHash: string
}

export interface ScannedBook {
  id: string
  title: string
  sourcePath: string
  kind: 'file' | 'folder'
  episodes: ImportedAudio[]
}

const chapterCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
export function compareChapters(a: string, b: string): number {
  return chapterCollator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0)
}

async function hashAudio(path: string): Promise<ImportedAudio> {
  const before = await inspectSelectedAudio(path)
  const hash = createHash('sha256')
  try {
    for await (const chunk of createReadStream(before.path)) hash.update(chunk)
    const after = await stat(before.path)
    if (after.size !== before.sizeBytes || after.mtimeMs !== before.modifiedAt)
      throw new AppError('FILE_CHANGED', '音频在导入时发生变化，请等待文件写入完成后重新导入。')
    return { ...before, id: randomUUID(), contentHash: hash.digest('hex') }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('FILE_UNAVAILABLE', '读取音频失败，请确认文件仍在原处且可访问，再重新导入。')
  }
}

// Paths only enter here from the native picker. Symbolic links are not followed during recursion.
export async function scanBook(
  selectedPath: string,
  kind: 'file' | 'folder',
): Promise<ScannedBook> {
  if (kind === 'file') {
    const audio = await hashAudio(selectedPath)
    return { id: randomUUID(), title: audio.name, sourcePath: audio.path, kind, episodes: [audio] }
  }
  let root: string
  const files: string[] = []
  try {
    root = await realpath(selectedPath)
    if (!(await stat(root)).isDirectory()) throw new Error('Not a directory')
    const directories = [root]
    let visited = 0
    while (directories.length) {
      if (++visited > 20000) throw new Error('Too many directories')
      const directory = directories.pop()!
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue
        const path = join(directory, entry.name)
        if (entry.isDirectory()) directories.push(path)
        else if (
          entry.isFile() &&
          AUDIO_EXTENSIONS.some((ext) => ext === extname(path).slice(1).toLowerCase())
        ) {
          files.push(path)
          if (files.length > 10000) throw new Error('Too many files')
        }
      }
    }
  } catch {
    throw new AppError(
      'FILE_UNAVAILABLE',
      '无法扫描文件夹。请检查访问权限，单次最多导入 10,000 个音频、扫描 20,000 个文件夹。',
    )
  }
  if (!files.length)
    throw new AppError('FILE_UNAVAILABLE', '文件夹中没有支持的音频文件。请选择包含音频的文件夹。')
  files.sort((a, b) => compareChapters(relative(root, a), relative(root, b)))
  const episodes: ImportedAudio[] = []
  for (const path of files) {
    const audio = await hashAudio(path)
    episodes.push({ ...audio, name: relative(root, path) })
  }
  return { id: randomUUID(), title: basename(root), sourcePath: root, kind, episodes }
}

// Only call with the native dialog's result. Renderer input must never supply a path.
export async function inspectSelectedAudio(selectedPath: string): Promise<FileMetadata> {
  try {
    const path = await realpath(selectedPath)
    const extension = extname(path).slice(1).toLowerCase()
    if (!AUDIO_EXTENSIONS.some((allowed) => allowed === extension)) {
      throw new Error('Unsupported extension')
    }
    await access(path, constants.R_OK)
    const info = await stat(path)
    if (!info.isFile() || info.size === 0 || !Number.isSafeInteger(info.size)) {
      throw new Error('Invalid audio file')
    }
    return { path, name: basename(path), sizeBytes: info.size, modifiedAt: info.mtimeMs }
  } catch {
    throw new AppError('FILE_UNAVAILABLE', '无法读取这个音频文件，请选择可访问、非空的本地音频。')
  }
}
