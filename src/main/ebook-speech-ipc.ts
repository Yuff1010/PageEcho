import { ipcMain, type BrowserWindow } from 'electron'
import { SPEECH_CHANNELS, type EbookSpeechRequest } from '../shared/ebook-speech'
import { AppError, isTrustedRenderer } from '../shared/validation'
import { validateSpeechRequest } from '../shared/ebook-speech-validation'
import type { EbookSpeech } from './ebook-speech'

export function registerEbookSpeechIpc(
  window: BrowserWindow,
  rendererUrl: string,
  speech: EbookSpeech,
) {
  for (const channel of Object.values(SPEECH_CHANNELS))
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
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
          throw new AppError('FORBIDDEN', '此页面无权使用朗读。')
        validateSpeechRequest(channel, args)
        const value =
          channel === SPEECH_CHANNELS.voices
            ? await speech.available()
            : channel === SPEECH_CHANNELS.synthesize
              ? await speech.synthesize(args[0] as EbookSpeechRequest)
              : speech.release()
        return { ok: true, value }
      } catch (error) {
        return {
          ok: false,
          error: {
            code: error instanceof AppError ? error.code : 'INTERNAL',
            message: error instanceof Error ? error.message : '朗读暂不可用，请重试。',
          },
        }
      }
    })
}
