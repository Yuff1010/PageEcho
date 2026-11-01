import type { Result } from '../../shared/contracts'

export const ALL_SOURCES = '__all_sources__'
export interface AggregateProgress<T> {
  items: T[]
  completed: number
  total: number
  errors: Array<{ source: string; message: string }>
  truncated: boolean
}
/** First-page discovery, bounded concurrency/results; an individual failure never loses other results. */
export async function aggregateSearch<T>(options: {
  sources: Array<{ id: string; name: string }>
  signal: AbortSignal
  request: (sourceId: string, requestId: string) => Promise<Result<T[]>>
  cancel: (requestId: string) => Promise<unknown>
  key: (item: T) => string
  onProgress: (progress: AggregateProgress<T>) => void
  limit?: number
}) {
  const limit = options.limit ?? 300
  const items = new Map<string, T>()
  const errors: AggregateProgress<T>['errors'] = []
  let index = 0,
    completed = 0,
    truncated = false
  const emit = () =>
    options.onProgress({
      items: [...items.values()],
      completed,
      total: options.sources.length,
      errors: [...errors],
      truncated,
    })
  emit()
  await Promise.all(
    Array.from({ length: Math.min(3, options.sources.length) }, async () => {
      while (!options.signal.aborted && !truncated) {
        const source = options.sources[index++]
        if (!source) return
        const requestId = crypto.randomUUID()
        const cancel = () => {
          void options.cancel(requestId).catch(() => undefined)
        }
        options.signal.addEventListener('abort', cancel, { once: true })
        try {
          const result = await options.request(source.id, requestId)
          if (options.signal.aborted) return
          if (result.ok) {
            for (const item of result.value) {
              const key = options.key(item)
              if (items.has(key)) continue
              if (items.size >= limit) {
                truncated = true
                break
              }
              items.set(key, item)
            }
          } else {
            errors.push({ source: source.name, message: result.error.message })
          }
        } catch {
          if (!options.signal.aborted)
            errors.push({ source: source.name, message: '连接未完成，请选择此来源单独重试。' })
        } finally {
          options.signal.removeEventListener('abort', cancel)
        }
        if (options.signal.aborted) return
        completed++
        emit()
      }
    }),
  )
  return { items: [...items.values()], completed, total: options.sources.length, errors, truncated }
}
