import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { Result } from '../../shared/contracts'
import { TEXT_SOURCE_CHANNELS } from '../../shared/text-source-api'
import type {
  RemoteLibraryConfig,
  TextBrowseRequest,
  TextDetailRequest,
  TextImportRequest,
} from '../../shared/text-sources'
import { AppError, isTrustedRenderer } from '../../shared/validation'
import { SourceError } from '../../shared/sources'
import type { TextSourceService } from './text-service'
import { validateTextSourceArgs } from './text-validation'

export function registerTextSourceIpc(
  window: BrowserWindow,
  rendererUrl: string,
  service: TextSourceService,
): () => void {
  const channels = TEXT_SOURCE_CHANNELS
  const actions: Record<string, (request: unknown) => unknown> = {
    [channels.state]: () => service.state(),
    [channels.browse]: (request) => service.browse(request as TextBrowseRequest),
    [channels.detail]: (request) => service.detail(request as TextDetailRequest),
    [channels.import]: (request) => service.import(request as TextImportRequest),
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
