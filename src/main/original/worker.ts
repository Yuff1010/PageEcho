import { parentPort, workerData } from 'node:worker_threads'
import { open } from 'node:fs/promises'
import { MAX_ORIGINAL_BYTES, parseOriginal } from './parse'
import { createOriginalMatcher, matchOriginal } from './match'
import { findOriginal } from './search'
import { AppError } from '../../shared/validation'
import type { ParsedOriginal } from '../../shared/original'
import type { TranscriptDocument } from '../../shared/transcript'
import type { OriginalIncrementalBatch } from './incremental'

if (workerData?.kind === 'incremental-session') {
  let originalId: string | null = null
  let matcher: ReturnType<typeof createOriginalMatcher> | undefined
  parentPort!.on(
    'message',
    (input: {
      originalId: string
      original?: ParsedOriginal
      batches: OriginalIncrementalBatch[]
    }) => {
      try {
        if (input.original) {
          matcher = createOriginalMatcher(input.original)
          originalId = input.originalId
        }
        if (!matcher || originalId !== input.originalId)
          throw new AppError('CONFLICT', '增量原文版本已变化。')
        const value = input.batches.flatMap((batch) => {
          const targets = new Set(batch.targetIds)
          return matcher!(batch.transcript, batch.options).filter((match) =>
            targets.has(match.segmentId),
          )
        })
        parentPort!.postMessage({ ok: true, value })
      } catch (error) {
        parentPort!.postMessage({
          ok: false,
          error: {
            code: error instanceof AppError ? error.code : 'INVALID_ORIGINAL',
            message: error instanceof Error ? error.message : '增量原文处理失败。',
          },
        })
      }
    },
  )
} else {
  try {
    const input = workerData as
      | { kind: 'parse'; path: string }
      | { kind: 'match'; original: ParsedOriginal; transcript: TranscriptDocument }
      | {
          kind: 'find'
          original: ParsedOriginal
          originalId: string
          query: string
          offset: number
        }
    let value: unknown
    if (input.kind === 'match') value = matchOriginal(input.original, input.transcript)
    else if (input.kind === 'find')
      value = findOriginal(input.original, input.originalId, input.query, input.offset)
    else {
      const file = await open(input.path, 'r')
      try {
        const before = await file.stat()
        if (!before.isFile() || before.size > MAX_ORIGINAL_BYTES || !before.size)
          throw new AppError('INVALID_ORIGINAL', '请选择非空且不超过 32 MiB 的 TXT/EPUB。')
        const chunks: Buffer[] = []
        for await (const chunk of file.createReadStream({
          end: MAX_ORIGINAL_BYTES,
          autoClose: false,
        }))
          chunks.push(chunk as Buffer)
        const after = await file.stat(),
          bytes = Buffer.concat(chunks)
        if (
          before.size !== bytes.length ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs
        )
          throw new AppError('INVALID_ORIGINAL', '读取期间原文发生变化，请保存后重试。')
        value = parseOriginal(bytes, input.path)
      } finally {
        await file.close()
      }
    }
    parentPort!.postMessage({ ok: true, value })
  } catch (error) {
    parentPort!.postMessage({
      ok: false,
      error: {
        code: error instanceof AppError ? error.code : 'INVALID_ORIGINAL',
        message: error instanceof AppError ? error.message : '原文处理失败，请检查文件后重试。',
      },
    })
  }
}
