import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { CHANNELS, type Result } from '../../shared/contracts'
import type { OriginalTarget } from '../../shared/original'
import type {
  ApplyOriginalAcousticRequest,
  OriginalAcousticRequest,
  RestoreOriginalAcousticRequest,
} from '../../shared/original-acoustic'
import { AppError, isTrustedRenderer, validateRequest } from '../../shared/validation'
import type { OriginalAcousticService } from './acoustic-service'

export function registerOriginalAcousticIpc(
  window: BrowserWindow,
  rendererUrl: string,
  service: OriginalAcousticService,
  log: (error: unknown) => void,
): void {
  const actions: Record<string, (request: unknown) => unknown> = {
    [CHANNELS.originalAcousticState]: (value) => service.state(value as OriginalTarget),
    [CHANNELS.originalAcousticStart]: (value) => service.start(value as OriginalAcousticRequest),
    [CHANNELS.originalAcousticCancel]: (value) => service.cancel((value as { id: string }).id),
    [CHANNELS.originalAcousticApply]: (value) =>
      service.apply(value as ApplyOriginalAcousticRequest),
    [CHANNELS.originalAcousticRestore]: (value) =>
      service.restore(value as RestoreOriginalAcousticRequest),
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
          log(error)
          return {
            ok: false,
            error: { code: 'INTERNAL', message: '声音对齐未完成，原同步点保留。' },
          }
        }
      },
    )
}
