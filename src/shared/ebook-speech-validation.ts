import { SPEECH_CHANNELS, type EbookSpeechRequest } from './ebook-speech'
import { AppError, isId } from './validation'

export function validateSpeechRequest(channel: string, args: unknown[]): void {
  if (channel === SPEECH_CHANNELS.voices || channel === SPEECH_CHANNELS.release) {
    if (args.length) throw new AppError('INVALID_REQUEST', '此朗读操作不接受参数。')
    return
  }
  const request = args[0] as Partial<EbookSpeechRequest> | undefined
  if (
    channel !== SPEECH_CHANNELS.synthesize ||
    args.length !== 1 ||
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    Object.keys(request).some((key) => !['id', 'ordinal', 'offset', 'voice'].includes(key)) ||
    !isId(request.id) ||
    !Number.isSafeInteger(request.ordinal) ||
    request.ordinal! < 0 ||
    request.ordinal! >= 250000 ||
    !Number.isSafeInteger(request.offset) ||
    request.offset! < 0 ||
    request.offset! > 12000000 ||
    (request.voice !== undefined &&
      (typeof request.voice !== 'string' || request.voice.length > 300))
  )
    throw new AppError('INVALID_REQUEST', '朗读位置或声音选择无效。')
}
