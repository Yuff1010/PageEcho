import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type {
  ResolvedSubtitleImportEncoding,
  SubtitleImportEncoding,
} from '../shared/subtitle-import'
import type { SubtitleFormat } from '../shared/subtitles'
import { MAX_TRANSCRIPT_BYTES } from '../shared/transcript'
import { AppError } from '../shared/validation'

export interface SubtitleImportFile {
  bytes: Buffer
  fileName: string
  format: SubtitleFormat
  sha256: string
}

/** Only a main-process native picker may provide this path. */
export async function readSubtitleImportFile(
  path: string,
  signal: AbortSignal,
): Promise<SubtitleImportFile> {
  const extension = extname(path).toLowerCase()
  if (!['.srt', '.vtt', '.webvtt'].includes(extension))
    throw new AppError('INVALID_TRANSCRIPT', '请选择 SRT 或 WebVTT 字幕文件。')
  signal.throwIfAborted()
  try {
    const file = await open(path, 'r')
    let bytes: Buffer
    try {
      const before = await file.stat()
      if (!before.isFile() || !before.size || before.size > MAX_TRANSCRIPT_BYTES)
        throw new AppError('INVALID_TRANSCRIPT', '字幕文件必须非空且不超过 16 MiB。')
      const parts: Buffer[] = []
      let size = 0
      while (size <= MAX_TRANSCRIPT_BYTES) {
        signal.throwIfAborted()
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_TRANSCRIPT_BYTES + 1 - size))
        const { bytesRead } = await file.read(chunk, 0, chunk.length, size)
        if (!bytesRead) break
        size += bytesRead
        parts.push(chunk.subarray(0, bytesRead))
      }
      const after = await file.stat()
      signal.throwIfAborted()
      if (
        size > MAX_TRANSCRIPT_BYTES ||
        size !== before.size ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ino !== after.ino
      )
        throw new AppError(
          'INVALID_TRANSCRIPT',
          '字幕文件过大或在读取时变化，请保存完成后重新选择。',
        )
      bytes = Buffer.concat(parts, size)
    } finally {
      await file.close()
    }
    return {
      bytes,
      fileName:
        Array.from(basename(path).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '_'))
          .slice(0, 120)
          .join('') || '字幕',
      format: extension === '.srt' ? 'srt' : 'vtt',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  } catch (error) {
    if (signal.aborted || error instanceof AppError) throw error
    throw new AppError('FILE_UNAVAILABLE', '无法读取字幕文件，请确认文件存在且可访问。')
  }
}

export function decodeSubtitleImport(
  file: SubtitleImportFile,
  requested: SubtitleImportEncoding,
): { text: string; encoding: ResolvedSubtitleImportEncoding } {
  const bytes = file.bytes,
    bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
      ? 'utf-8'
      : bytes[0] === 0xff && bytes[1] === 0xfe
        ? 'utf-16le'
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? 'utf-16be'
          : null
  const encoding = requested === 'auto' ? (bom ?? 'utf-8') : requested
  if (
    !['utf-8', 'utf-16le', 'utf-16be', 'gb18030', 'big5'].includes(encoding) ||
    (file.format === 'vtt' && encoding !== 'utf-8')
  )
    throw new AppError('INVALID_TRANSCRIPT', 'WebVTT 必须使用 UTF-8；请先转换文件编码。')
  if (bom && bom !== encoding)
    throw new AppError('INVALID_TRANSCRIPT', '所选编码与文件的编码标记不一致，请重新选择编码。')
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
    if (text.includes('\u0000'))
      throw new AppError('INVALID_TRANSCRIPT', '字幕含空字符，请核对编码并重新预览。')
    return { text, encoding }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(
      'INVALID_TRANSCRIPT',
      file.format === 'vtt'
        ? 'WebVTT 不是有效的 UTF-8，请转换编码后重新选择。'
        : '无法按所选编码读取字幕，请明确选择原文件编码后重新预览。',
    )
  }
}
