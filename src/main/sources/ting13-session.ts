import { BrowserWindow, session, type Session } from 'electron'
import { setTimeout as delay } from 'node:timers/promises'
import { SourceError } from '../../shared/sources'
import { readTing13Document, type Ting13Document } from './ting13-dom'
import { TING13_ORIGIN, sourcePageUrl, type Ting13Load, type Ting13Loader } from './ting13'
import { allowTing13Request } from './ting13-policy'

const initialized = new WeakSet<Session>()
const SNAPSHOT = `(${readTing13Document.toString()})()`
const WORLD = 1001

export class Ting13Session implements Ting13Loader {
  private active: BrowserWindow | undefined
  private closed = false
  private readonly blocked = new Map<string, number>()
  constructor(
    private readonly partition = 'persist:readlisten-source-ting13',
    private readonly timeoutMs = 30000,
  ) {
    if (
      !partition.startsWith('persist:readlisten-source-ting13') ||
      timeoutMs < 1000 ||
      timeoutMs > 60000
    )
      throw new SourceError('INVALID_SOURCE_REQUEST', '书源会话配置无效。')
  }
  diagnostics() {
    return [...this.blocked].map(([resource, count]) => ({ resource, count }))
  }
  close() {
    this.closed = true
    if (this.active && !this.active.isDestroyed()) this.active.destroy()
  }
  async read(request: Ting13Load, signal?: AbortSignal): Promise<Ting13Document> {
    if (this.closed || signal?.aborted) throw new SourceError('SOURCE_CANCELED', '书源请求已取消。')
    if (this.active) throw new SourceError('SOURCE_BUSY', '书源正在读取另一页，请稍候。')
    const url = request.kind === 'search' ? TING13_ORIGIN : sourcePageUrl(request.url).href
    const isolatedSession = session.fromPartition(this.partition)
    if (!initialized.has(isolatedSession)) {
      initialized.add(isolatedSession)
      isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      )
      isolatedSession.setPermissionCheckHandler(() => false)
      isolatedSession.on('will-download', (event) => event.preventDefault())
      isolatedSession.webRequest.onBeforeRequest((details, callback) => {
        const allowed = allowTing13Request(details.url, details.resourceType)
        if (!allowed) {
          let host = details.resourceType
          try {
            host += `:${new URL(details.url).origin}`
          } catch {
            /* No untrusted URL text in diagnostics. */
          }
          this.blocked.set(host, (this.blocked.get(host) ?? 0) + 1)
        }
        callback({ cancel: !allowed })
      })
    }
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        session: isolatedSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
        spellcheck: false,
      },
    })
    this.active = window
    let navigationFailed = false
    window.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) navigationFailed = true
    })
    window.webContents.setAudioMuted(true)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, target) => {
      if (!allowTing13Request(target, 'mainFrame')) event.preventDefault()
    })
    window.webContents.on('will-attach-webview', (event) => event.preventDefault())
    let last: Ting13Document | undefined, timer: ReturnType<typeof setTimeout> | undefined
    const execute = (code: string) =>
      window.webContents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }])
    const abort = () => {
      if (!window.isDestroyed()) window.destroy()
    }
    signal?.addEventListener('abort', abort, { once: true })
    const navigate = async (target: string) => {
      try {
        await window.loadURL(target)
      } catch (error) {
        if (!(error instanceof Error && error.message.includes('ERR_ABORTED'))) throw error
      }
    }
    try {
      const work = async () => {
        await navigate(url)
        let submitted = request.kind !== 'search'
        for (;;) {
          if (this.closed || signal?.aborted || window.isDestroyed())
            throw new SourceError('SOURCE_CANCELED', '书源请求已取消。')
          if (navigationFailed)
            throw new SourceError('SOURCE_UNAVAILABLE', '暂时无法读取书源，请检查网络后重试。')
          try {
            last = (await execute(SNAPSHOT)) as Ting13Document
          } catch {
            await delay(250)
            continue
          }
          if (!last.challenge && last.ready) {
            if (!submitted && request.kind === 'search' && last.searchForm) {
              const query = JSON.stringify(request.query)
              await execute(
                `(() => { const form = document.querySelector('form[action="/novelsearch/search/result.html"]'); const input = form?.querySelector('input[name="searchword"]'); if (!form || !input) throw new Error('Search form missing'); input.value = ${query}; form.requestSubmit(); })()`,
              )
              submitted = true
            } else {
              const expected = request.kind === 'search' ? 'search' : request.expect
              const valid =
                expected === 'search'
                  ? last.title.includes('相关搜索结果')
                  : expected === 'book'
                    ? !!last.book.title && !!last.book.directory
                    : expected === 'episodes'
                      ? last.episodes.length > 0
                      : last.media.length > 0
              if (valid) return last
            }
          }
          await delay(250)
        }
      }
      return await Promise.race([
        work(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new SourceError(
                  last?.challenge ? 'SOURCE_VERIFICATION_REQUIRED' : 'SOURCE_TIMEOUT',
                  last?.challenge
                    ? '书源需要浏览器验证，请稍后重试。'
                    : '书源响应超时，请稍后重试。',
                ),
              ),
            this.timeoutMs,
          )
        }),
      ])
    } catch (error) {
      if (error instanceof SourceError) throw error
      if (signal?.aborted || this.closed)
        throw new SourceError('SOURCE_CANCELED', '书源请求已取消。')
      throw new SourceError('SOURCE_UNAVAILABLE', '暂时无法读取书源，请检查网络后重试。')
    } finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (!window.isDestroyed()) window.destroy()
      if (this.active === window) this.active = undefined
    }
  }
}
