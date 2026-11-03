import type { Book } from '../../shared/contracts'
import type { SubtitlePreparation } from '../../shared/transcription'

export function effectiveSubtitleProfile(
  book: Pick<Book, 'subtitlePreparation' | 'online'>,
): SubtitlePreparation | null {
  if (book.subtitlePreparation) return book.subtitlePreparation
  const legacy = book.online?.preparation
  return legacy?.transcribeNext
    ? { mode: 'ahead', engine: legacy.engine, device: legacy.device, prepareNext: true }
    : null
}

export function subtitleProfileLabel(profile: SubtitlePreparation) {
  return `${profile.mode === 'auto' ? '边播放边生成' : profile.mode === 'ahead' ? '先准备字幕再播放' : '手动生成'} · ${profile.engine === 'whisperx' ? 'WhisperX' : 'Paraformer'} · ${profile.device === 'cpu' ? 'CPU' : 'NVIDIA GPU'}`
}
