import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { CHANNELS, type Result } from '../shared/contracts'
import type {
  ListeningReviewGet,
  ListeningReviewPrepare,
  ListeningReviewSave,
} from '../shared/listening-review'
import { AppError, isTrustedRenderer, validateRequest } from '../shared/validation'
import type { ListeningReviewStore } from './listening-review-store'

export function registerListeningReviewIpc(
  window: BrowserWindow,
  rendererUrl: string,
  reviews: ListeningReviewStore,
  logError: (error: unknown) => void,
): void {
  const actions: Record<string, (request: unknown) => Promise<unknown>> = {
    [CHANNELS.listeningReviewGet]: (request) => reviews.get(request as ListeningReviewGet),
    [CHANNELS.listeningReviewPrepare]: (request) =>
      reviews.prepare(request as ListeningReviewPrepare),
    [CHANNELS.listeningReviewSave]: (request) => reviews.save(request as ListeningReviewSave),
  }
  for (const [channel, action] of Object.entries(actions))
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
            throw new AppError('FORBIDDEN', '此页面无权访问应用数据。')
          validateRequest(channel, args)
          return { ok: true, value: await action(args[0]) }
        } catch (error) {
          if (error instanceof AppError)
            return { ok: false, error: { code: error.code, message: error.message } }
          logError(error)
          return {
            ok: false,
            error: { code: 'INTERNAL', message: '试听校对未保存，请重试或查看应用日志。' },
          }
        }
      },
    )
}
