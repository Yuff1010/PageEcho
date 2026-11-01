import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { Result } from '../../shared/contracts'
import { TEXT_SOURCE_CHANNELS } from '../../shared/text-source-api'
import type {
  RemoteLibraryConfig,
  TextBrowseRequest,
  TextDetailRequest,
  TextImportRequest,
  TextContinueRequest,
} from '../../shared/text-sources'
import { AppError, isTrustedRenderer } from '../../shared/validation'
import { SourceError } from '../../shared/sources'
import type { TextSourceService } from './text-service'
import { validateTextSourceArgs } from './text-validation'
import type { SourceCoverPresenter } from './source-cover-presenter'
import type { PersistentBookCovers } from './persistent-book-covers'
import type { TextBookSummary } from '../../shared/text-sources'

export function registerTextSourceIpc(
  window: BrowserWindow,
  rendererUrl: string,
  service: TextSourceService,
  covers?: SourceCoverPresenter,
  savedCovers?: PersistentBookCovers,
): () => void {
  const channels = TEXT_SOURCE_CHANNELS
  const seen = new Map<string, TextBookSummary>()
  const remember = (book: TextBookSummary) => {
    const key = `${book.sourceId}:${book.workId}`
    seen.delete(key)
    seen.set(key, book)
    if (seen.size > 128) seen.delete(seen.keys().next().value!)
  }
  const actions: Record<string, (request: unknown) => unknown> = {
    [channels.state]: () => service.state(),
    [channels.browse]: async (request) => {
      const page = await service.browse(request as TextBrowseRequest)
      for (const book of page.books) remember(book)
      return covers ? { ...page, books: page.books.map((book) => covers.ebook(book)) } : page
    },
    [channels.detail]: async (request) => {
      const detail = await service.detail(request as TextDetailRequest)
      remember(detail)
      return covers ? { ...detail, ...covers.ebook(detail) } : detail
    },
    [channels.import]: async (request) => {
      const result = await service.import(request as TextImportRequest)
      const raw = seen.get(`${result.sourceId}:${result.workId}`)
      if (savedCovers && covers && raw)
        await savedCovers.remember('ebook', result.book.id, covers.ebook(raw).coverUrl)
      return savedCovers ? { ...result, book: savedCovers.decorate('ebook', result.book) } : result
    },
    [channels.continue]: async (request) => {
      const result = await service.continueReading(request as TextContinueRequest)
      return savedCovers ? { ...result, book: savedCovers.decorate('ebook', result.book) } : result
    },
    [channels.cancel]: (request) => service.cancel((request as { requestId: string }).requestId),
    [channels.save]: (request) => service.save(request as RemoteLibraryConfig),
    [channels.remove]: (request) => service.remove((request as { id: string }).id),
    [channels.check]: (request) =>
      service.check(request as { requestId: string; sourceId: string }),
    [channels.manifestPreview]: (request) =>
      service.manifestPreview((request as { rawJson: string }).rawJson),
    [channels.manifestApply]: (request) =>
      service.manifestApply((request as { rawJson: string }).rawJson),
    [channels.manifestExport]: () => service.manifestExport(),
  }
  for (const [channel, action] of Object.entries(actions)) {
    ipcMain.handle(
      channel,
      async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<Result<unknown>> => {
        try {
          if (
            window.isDestroyed() ||
            !isTrustedRenderer(
              event.sender.id,
              window.webContents.id,
              event.senderFrame === window.webContents.mainFrame,
              event.senderFrame?.url ?? '',
              rendererUrl,
            )
          )
            throw new AppError('FORBIDDEN', '此页面无权访问书库。')
          validateTextSourceArgs(channel, args)
          return { ok: true, value: await action(args[0]) }
        } catch (error) {
          if (error instanceof SourceError || error instanceof AppError)
            return { ok: false, error: { code: error.code, message: error.message } }
          // Never expose arbitrary network/parser errors containing authenticated URLs.
          return {
            ok: false,
            error: {
              code: 'SOURCE_UNAVAILABLE',
              message: '书库操作未完成，请检查连接或缩小本次导入范围。',
            },
          }
        }
      },
    )
  }
  return () => {
    for (const channel of Object.values(channels)) ipcMain.removeHandler(channel)
  }
}
