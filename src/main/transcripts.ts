import { open } from 'node:fs/promises'
import { AppError } from '../shared/validation'
import {
  MAX_TRANSCRIPT_BYTES,
  validateTranscript,
  type TranscriptDocument,
} from '../shared/transcript'

// Only native picker results may supply a path. Read at most the stated limit plus one byte.
export async function readTranscript(
  path: string,
  audioHash: string,
  durationMs: number | null,
  signal?: AbortSignal,
): Promise<TranscriptDocument> {
  try {
    signal?.throwIfAborted()
    const file = await open(path, 'r')
    let source: string
    try {
      const before = await file.stat()
      if (!before.isFile() || !before.size || before.size > MAX_TRANSCRIPT_BYTES)
        throw new AppError('INVALID_TRANSCRIPT', '请选择非空且不超过 16 MiB 的 JSON 文稿。')
      const chunks: Buffer[] = []
      let size = 0
      const stream = file.createReadStream({ end: MAX_TRANSCRIPT_BYTES, autoClose: false, signal })
      for await (const chunk of stream) {
        size += chunk.length
        chunks.push(chunk as Buffer)
      }
      const after = await file.stat()
      if (
        size > MAX_TRANSCRIPT_BYTES ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      )
        throw new AppError(
          'INVALID_TRANSCRIPT',
          '文稿过大或在读取时发生变化，请保存完成后重新导入。',
        )
      try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
      } catch {
        throw new AppError('INVALID_TRANSCRIPT', '文稿必须使用 UTF-8 编码，请转换编码后重新导入。')
      }
    } finally {
      await file.close()
    }
    let value: unknown
    try {
      value = JSON.parse(source)
    } catch {
      throw new AppError('INVALID_TRANSCRIPT', '文稿不是有效的 JSON，请检查括号、引号和逗号。')
    }
    signal?.throwIfAborted()
    return validateTranscript(value, audioHash, durationMs)
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('FILE_UNAVAILABLE', '无法读取文稿，请确认文件存在且可访问，再重新导入。')
  }
}
