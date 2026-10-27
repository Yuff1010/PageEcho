import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { CHANNELS, type Result } from '../shared/contracts'
import type { TranscriptRequest } from '../shared/transcript'
import type {
  TranscriptEditRequest,
  TranscriptHistoryRequest,
  TranscriptReplacementRequest,
  ApplyTranscriptReplacement,
  TranscriptAlignmentRequest,
  ApplyTranscriptAlignment,
} from '../shared/transcript-editing'
import { AppError, isTrustedRenderer, validateRequest } from '../shared/validation'
import type { TranscriptEditingService } from './transcript-editing-service'

export function registerTranscriptEditingIpc(
  window: BrowserWindow,
  rendererUrl: string,
  service: TranscriptEditingService,
  log: (error: unknown) => void,
): void {
  const actions: Record<string, (request: unknown) => unknown> = {
    [CHANNELS.transcriptEditingState]: (request) => service.state(request as TranscriptRequest),
    [CHANNELS.transcriptChange]: (request) => service.change(request as TranscriptEditRequest),
    [CHANNELS.transcriptUndo]: (request) => service.undo(request as TranscriptHistoryRequest),
    [CHANNELS.transcriptRedo]: (request) => service.redo(request as TranscriptHistoryRequest),
    [CHANNELS.replacementPreview]: (request) =>
      service.previewReplacement(request as TranscriptReplacementRequest),
    [CHANNELS.replacementPage]: (request) =>
      service.replacementPage(request as { token: string; page: number }),
    [CHANNELS.replacementApply]: (request) =>
      service.applyReplacement(request as ApplyTranscriptReplacement),
    [CHANNELS.replacementCancel]: (request) =>
      service.cancelReplacement((request as { requestId: string }).requestId),
    [CHANNELS.transcriptAlignmentState]: (request) =>
      service.alignmentState(request as TranscriptRequest),
    [CHANNELS.transcriptAlignmentStart]: (request) =>
      service.startAlignment(request as TranscriptAlignmentRequest),
    [CHANNELS.transcriptAlignmentCancel]: (request) =>
      service.cancelAlignment((request as { id: string }).id),
    [CHANNELS.transcriptAlignmentApply]: (request) =>
      service.applyAlignment(request as ApplyTranscriptAlignment),
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
            throw new AppError('FORBIDDEN', '此页面无权修改应用文稿。')
          validateRequest(channel, args)
          return { ok: true, value: await action(args[0]) }
        } catch (error) {
          if (error instanceof AppError)
            return { ok: false, error: { code: error.code, message: error.message } }
          log(error)
          return {
            ok: false,
            error: { code: 'INTERNAL', message: '字幕操作未完成，请刷新文稿后重试。' },
          }
        }
      },
    )
}
