import { SourceError, type SourceAdapter } from '../../shared/sources'

// One source operation owns one cancelable request; a replacement waits for cleanup.
export class SourceOperations {
  private active: { id: string; controller: AbortController; done: Promise<unknown> } | undefined
  private closed = false
  constructor(private readonly closeLoader: () => void) {}
  async run<T>(id: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw new SourceError('SOURCE_CANCELED', '书源已关闭。')
    if (this.active?.id === id)
      throw new SourceError('INVALID_SOURCE_REQUEST', '书源请求标识已在使用。')
    const previous = this.active
    previous?.controller.abort()
    const controller = new AbortController()
    const done = (async () => {
      await previous?.done.catch(() => undefined)
      if (controller.signal.aborted || this.closed)
        throw new SourceError('SOURCE_CANCELED', '书源请求已取消。')
      const result = await action(controller.signal)
      if (controller.signal.aborted || this.closed)
        throw new SourceError('SOURCE_CANCELED', '书源请求已取消。')
      return result
    })()
    const active = { id, controller, done }
    this.active = active
    try {
      return await done
    } finally {
      if (this.active === active) this.active = undefined
    }
  }
  cancel(id: string) {
    if (this.active?.id === id) this.active.controller.abort()
  }
  async whenIdle() {
    await this.active?.done.catch(() => undefined)
  }
  async close() {
    if (this.closed) {
      await this.active?.done.catch(() => undefined)
      return
    }
    this.closed = true
    const active = this.active
    active?.controller.abort()
    this.closeLoader()
    await active?.done.catch(() => undefined)
  }
}

export class SourceBrowser extends SourceOperations {
  constructor(
    readonly adapter: SourceAdapter,
    closeLoader: () => void,
  ) {
    super(closeLoader)
  }
}
