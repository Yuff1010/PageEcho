import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { SourceError } from '../../shared/sources'
import { PluginHttpSession } from './http'
import type {
  PluginHostMessage,
  PluginInspectRequest,
  PluginRuntimeRequest,
  PluginRuntimeSource,
  PluginWorkerInput,
  PluginWorkerMessage,
} from './runtime-types'

const METHODS = [
  'search',
  'getBook',
  'getEpisodes',
  'resolveAudio',
  'getChapters',
  'getChapterText',
]

export class PluginRuntime {
  private closed = false
  private active = new Set<{ cancel: () => void; done: Promise<unknown> }>()

  inspect(request: PluginInspectRequest): Promise<PluginRuntimeSource[]> {
    return this.run(request) as Promise<PluginRuntimeSource[]>
  }
  execute(request: PluginRuntimeRequest): Promise<unknown> {
    return this.run(request)
  }

  private async run(request: PluginInspectRequest | PluginRuntimeRequest): Promise<unknown> {
    if (this.closed) throw new SourceError('SOURCE_CANCELED', '插件运行服务已关闭。')
    if (request.signal.aborted) throw new SourceError('SOURCE_CANCELED', '插件操作已取消。')
    if (this.active.size >= 4) throw new SourceError('SOURCE_BUSY', '插件操作过多，请稍后重试。')
    if (
      !Array.isArray(request.scripts) ||
      !request.scripts.length ||
      request.scripts.length > 32 ||
      request.scripts.some((script) => typeof script !== 'string') ||
      request.scripts.reduce((sum, script) => sum + Buffer.byteLength(script), 0) > 4 * 1024 * 1024
    )
      throw new SourceError('INVALID_SOURCE_REQUEST', '插件脚本为空、过多或超过 4 MiB。')
    const executing = 'method' in request
    if (
      executing &&
      (!METHODS.includes(request.method) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(request.sourceId) ||
        !Array.isArray(request.args))
    )
      throw new SourceError('INVALID_SOURCE_REQUEST', '插件调用参数无效。')
    if (executing && Buffer.byteLength(JSON.stringify(request.args)) > 2 * 1024 * 1024)
      throw new SourceError('INVALID_SOURCE_REQUEST', '插件调用参数过大。')
    const timeoutMs = request.timeoutMs ?? 20_000
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120_000)
      throw new SourceError('INVALID_SOURCE_REQUEST', '插件运行时限无效。')
    const controller = new AbortController()
    const http = new PluginHttpSession(executing ? request.allowedOrigins : [], controller.signal)
    const input: PluginWorkerInput = {
      scripts: request.scripts,
      deadline: Date.now() + timeoutMs,
      ...(executing
        ? { sourceId: request.sourceId, method: request.method, args: request.args }
        : {}),
    }
    const compiled = new URL('./plugin-worker.js', import.meta.url)
    const worker = existsSync(compiled)
      ? new Worker(compiled, {
          workerData: input,
          execArgv: [],
          resourceLimits: {
            maxOldGenerationSizeMb: 128,
            maxYoungGenerationSizeMb: 16,
            stackSizeMb: 4,
          },
        })
      : new Worker(
          `require('tsx/cjs'); require(${JSON.stringify(fileURLToPath(new URL('./worker.ts', import.meta.url)))});`,
          {
            eval: true,
            workerData: input,
            execArgv: [],
            resourceLimits: {
              maxOldGenerationSizeMb: 128,
              maxYoungGenerationSizeMb: 16,
              stackSizeMb: 4,
            },
          },
        )
    let stopped = false
    let rejectTask!: (error: SourceError) => void
    const abort = () => rejectTask(new SourceError('SOURCE_CANCELED', '插件操作已取消。'))
    let timer: NodeJS.Timeout | undefined
    const done = new Promise<unknown>((resolve, reject) => {
      const finish = (error?: SourceError, value?: unknown) => {
        if (stopped) return
        stopped = true
        if (error) reject(error)
        else resolve(value)
      }
      rejectTask = (error) => {
        controller.abort()
        finish(error)
      }
      timer = setTimeout(
        () => rejectTask(new SourceError('SOURCE_TIMEOUT', '插件运行超时，已停止。')),
        timeoutMs,
      )
      request.signal.addEventListener('abort', abort, { once: true })
      worker.on('error', () =>
        rejectTask(new SourceError('SOURCE_UNAVAILABLE', '插件运行进程失败或超过资源限制。')),
      )
      worker.on('exit', () => {
        if (!stopped) rejectTask(new SourceError('SOURCE_UNAVAILABLE', '插件运行进程意外退出。'))
      })
      worker.on('message', (message: PluginWorkerMessage) => {
        if (stopped || !message || typeof message !== 'object') return
        if (message.kind === 'request') {
          const reply = (result: PluginHostMessage) => {
            if (!stopped) worker.postMessage(result)
          }
          if (!executing) {
            reply({
              kind: 'response',
              id: message.id,
              code: 'INVALID_SOURCE_REQUEST',
              error: '插件校验阶段不可访问网站，请在来源操作中请求。',
            })
            return
          }
          void http.request(message.url, message.options).then(
            (text) => reply({ kind: 'response', id: message.id, text }),
            (error: unknown) =>
              reply({
                kind: 'response',
                id: message.id,
                code: error instanceof SourceError ? error.code : 'SOURCE_UNAVAILABLE',
                error: error instanceof SourceError ? error.message : '插件网络请求失败。',
              }),
          )
        } else if (message.kind === 'done') finish(undefined, message.value)
        else if (message.kind === 'error') finish(new SourceError(message.code, message.message))
      })
    })
    let cleaned!: () => void
    const cleanupDone = new Promise<void>((resolve) => {
      cleaned = resolve
    })
    const active = { cancel: abort, done: cleanupDone }
    this.active.add(active)
    try {
      return await done
    } finally {
      clearTimeout(timer)
      request.signal.removeEventListener('abort', abort)
      controller.abort()
      try {
        await worker.terminate()
      } finally {
        this.active.delete(active)
        cleaned()
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true
    const active = [...this.active]
    for (const task of active) task.cancel()
    await Promise.allSettled(active.map((task) => task.done))
  }
}
