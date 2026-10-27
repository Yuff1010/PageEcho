import { Worker } from 'node:worker_threads'
import { AppError } from '../../shared/validation'
import type { ErrorCode } from '../../shared/contracts'
import type { OriginalMatch, ParsedOriginal } from '../../shared/original'
import type { OriginalIncrementalBatch } from './incremental'

export class OriginalService {
  private closed = false
  private active: { worker: Worker; cancel: () => void } | null = null
  private automatic: { worker: Worker; originalId: string | null; cancel?: () => void } | null =
    null
  private automaticClose?: () => Promise<void>
  attachAutomatic(close: () => Promise<void>) {
    this.automaticClose = close
  }
  async runAutomatic(
    originalId: string,
    original: ParsedOriginal,
    batches: OriginalIncrementalBatch[],
  ): Promise<OriginalMatch[]> {
    if (this.closed) throw new AppError('BUSY', '应用正在退出，原文处理已停止。')
    if (this.automatic?.cancel) throw new AppError('BUSY', '增量原文处理正在进行。')
    const session = (this.automatic ??= {
      worker: new Worker(new URL('./original-worker.js', import.meta.url), {
        workerData: { kind: 'incremental-session' },
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      }),
      originalId: null,
    })
    if (session.worker.listenerCount('error') === 0) {
      session.worker.on('error', () => {})
      session.worker.once('exit', () => {
        if (this.automatic === session) this.automatic = null
      })
    }
    let failed = false
    try {
      return await new Promise<OriginalMatch[]>((resolve, reject) => {
        const timer = setTimeout(
          () => fail(new AppError('INVALID_ORIGINAL', '增量原文处理超过 60 秒，已停止。')),
          60000,
        )
        const cleanup = () => {
          clearTimeout(timer)
          session.worker.removeListener('message', message)
          session.worker.removeListener('error', error)
          session.worker.removeListener('exit', exit)
          session.cancel = undefined
        }
        const fail = (reason: Error) => {
          failed = true
          cleanup()
          reject(reason)
        }
        const error = () =>
          fail(new AppError('INVALID_ORIGINAL', '增量原文处理进程失败，原有校正保留。'))
        const exit = () => fail(new AppError('INVALID_ORIGINAL', '增量原文处理进程已退出。'))
        const message = (result: {
          ok: boolean
          value: OriginalMatch[]
          error: { code: ErrorCode; message: string }
        }) => {
          if (result.ok) {
            cleanup()
            session.originalId = originalId
            resolve(result.value)
          } else fail(new AppError(result.error.code, result.error.message))
        }
        session.cancel = () => fail(new AppError('BUSY', '增量原文处理已停止。'))
        session.worker.once('message', message)
        session.worker.once('error', error)
        session.worker.once('exit', exit)
        session.worker.postMessage({
          originalId,
          ...(session.originalId === originalId ? {} : { original }),
          batches,
        })
      })
    } finally {
      if (failed && this.automatic === session) await this.cancelAutomatic()
    }
  }
  async cancelAutomatic() {
    const session = this.automatic
    this.automatic = null
    if (session) {
      session.cancel?.()
      await session.worker.terminate()
    }
  }
  async run<T>(input: unknown): Promise<T> {
    if (this.closed) throw new AppError('BUSY', '应用正在退出，原文处理已停止。')
    if (this.active) throw new AppError('BUSY', '正在处理原文，请稍候或取消。')
    const worker = new Worker(new URL('./original-worker.js', import.meta.url), {
      workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    })
    try {
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(new AppError('INVALID_ORIGINAL', '原文处理超过 60 秒，已停止，请分卷后重试。')),
          60_000,
        )
        const fail = (error: Error) => {
          clearTimeout(timer)
          reject(error)
        }
        this.active = {
          worker,
          cancel: () => fail(new AppError('BUSY', '原文处理已取消，原有内容保留。')),
        }
        worker.once('error', () =>
          fail(new AppError('INVALID_ORIGINAL', '原文处理进程失败，原有内容保留。')),
        )
        worker.once('exit', () => fail(new AppError('INVALID_ORIGINAL', '原文处理进程已退出。')))
        worker.once(
          'message',
          (result: { ok: boolean; value: T; error: { code: ErrorCode; message: string } }) => {
            clearTimeout(timer)
            if (result.ok) resolve(result.value)
            else reject(new AppError(result.error.code, result.error.message))
          },
        )
      })
    } finally {
      await worker.terminate()
      this.active = null
    }
  }
  async cancel(): Promise<void> {
    const active = this.active
    if (active) {
      active.cancel()
      await active.worker.terminate()
    }
  }
  async close(): Promise<void> {
    this.closed = true
    await this.automaticClose?.()
    await this.cancelAutomatic()
    await this.cancel()
  }
}
