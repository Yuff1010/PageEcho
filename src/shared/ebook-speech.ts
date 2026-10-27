import type { Result } from './contracts'

export const SPEECH_CHANNELS = {
  voices: 'ebook-speech:voices',
  synthesize: 'ebook-speech:synthesize',
  release: 'ebook-speech:release',
} as const

export interface EbookSpeechVoice {
  id: string
  name: string
  language: string
}
export interface EbookSpeechVoices {
  available: boolean
  voices: EbookSpeechVoice[]
  message: string
}
export interface EbookSpeechRequest {
  id: string
  ordinal: number
  offset: number
  voice?: string
}
export interface EbookSpeechAudio {
  url: string
  ordinal: number
  offset: number
  endOffset: number
  next: { ordinal: number; offset: number } | null
}
export interface EbookSpeechApi {
  getEbookSpeechVoices(): Promise<Result<EbookSpeechVoices>>
  synthesizeEbookSpeech(request: EbookSpeechRequest): Promise<Result<EbookSpeechAudio>>
  releaseEbookSpeech(): Promise<Result<void>>
}
