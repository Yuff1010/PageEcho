import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { CHANNELS, type Result } from '../shared/contracts'
import type { PreviewOfflinePlanRequest, UpdateOfflinePlanRequest } from '../shared/offline'
import { AppError, isTrustedRenderer, validateRequest } from '../shared/validation'
import { SourceError } from '../shared/sources'
import type { OfflinePreparation } from './offline-preparation'

export function registerOfflinePreparationIpc(
  window: BrowserWindow,
  rendererUrl: string,
  service: OfflinePreparation,
  log: (error: unknown) => void,
): void {
  const actions: Record<string, (request: unknown) => unknown> = {
    [CHANNELS.offlinePreview]: (request) => service.preview(request as PreviewOfflinePlanRequest),
    [CHANNELS.offlinePreviewCancel]: (request) =>
      service.cancelPreview((request as { requestId: string }).requestId),
    [CHANNELS.offlineCreate]: (request) => service.create((request as { token: string }).token),
    [CHANNELS.offlineList]: (request) =>
      service.list(request as { page: number; activeOnly: boolean }),
    [CHANNELS.offlineGet]: (request) => service.get(request as { id: string; itemPage: number }),
    [CHANNELS.offlineUpdate]: (request) => service.update(request as UpdateOfflinePlanRequest),
    [CHANNELS.offlineRelease]: (request) =>
      service.release(request as { id: string; revision: number }),
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
          if (error instanceof AppError || error instanceof SourceError)
            return { ok: false, error: { code: error.code, message: error.message } }
          log(error)
          return {
            ok: false,
            error: { code: 'INTERNAL', message: '离线准备未完成，请重试或查看应用日志。' },
          }
        }
      },
    )
}
