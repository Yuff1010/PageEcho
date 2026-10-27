import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { LibraryStore } from './database'
import type { SubtitleExportRequest, SubtitleFormat } from '../shared/subtitles'
import type { TimeRange } from '../shared/transcript'
import { AppError } from '../shared/validation'

export interface SubtitleCue extends TimeRange {
  text: string
}
const MAX_SUBTITLE_BYTES = 32 * 1024 * 1024

function timestamp(ms: number, format: SubtitleFormat): string {
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor(ms / 60_000) % 60
  const seconds = Math.floor(ms / 1000) % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${format === 'srt' ? ',' : '.'}${String(ms % 1000).padStart(3, '0')}`
}

export function serializeSubtitles(cues: SubtitleCue[], format: SubtitleFormat): string {
  const parts = format === 'vtt' ? ['WEBVTT\n\n'] : []
  let bytes = parts.join('').length,
    lastEnd = 0
  for (const [index, cue] of cues.entries()) {
    if (
      !Number.isSafeInteger(cue.startMs) ||
      !Number.isSafeInteger(cue.endMs) ||
      cue.startMs < lastEnd ||
      cue.endMs <= cue.startMs ||
      cue.endMs > 3.6e10
    )
      throw new AppError('INVALID_TRANSCRIPT', '字幕时间必须是按顺序排列、互不重叠的原始毫秒位置。')
    // A single payload line prevents text from injecting extra subtitle blocks or WebVTT markup.
    const text = cue.text
      .replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ')
      .trim()
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
    if (!text) throw new AppError('INVALID_TRANSCRIPT', '字幕片段没有可导出的文字。')
    const block = `${index + 1}\n${timestamp(cue.startMs, format)} --> ${timestamp(cue.endMs, format)}\n${text}\n\n`
    bytes += Buffer.byteLength(block, 'utf8')
    if (bytes > MAX_SUBTITLE_BYTES)
      throw new AppError('INVALID_TRANSCRIPT', '字幕超过 32 MiB，请分集导出。')
    parts.push(block)
    lastEnd = cue.endMs
  }
  if (!cues.length) throw new AppError('INVALID_TRANSCRIPT', '当前没有可导出的字幕片段。')
  return parts.join('')
}

export function subtitleSnapshot(store: LibraryStore, request: SubtitleExportRequest) {
  const episode = store.getEpisode(request.episodeId)
  if (!episode || episode.contentHash !== request.audioHash)
    throw new AppError('FILE_CHANGED', '音频版本已变化，请重新打开后导出。')
  const state = store.getTranscript(request.episodeId, request.audioHash)
  if (
    state.status !== 'ready' ||
    state.transcript.id !== request.transcriptId ||
    state.transcript.revision !== request.transcriptRevision
  )
    throw new AppError('CONFLICT', '文稿版本已变化，请刷新后重新导出。')
  let cues: SubtitleCue[] = state.transcript.document.segments
  let skippedSegments = 0
  if (request.source === 'original') {
    const original = store.originals.state(request),
      alignment = original.alignment
    if (
      original.stale ||
      original.info?.id !== request.originalId ||
      !alignment ||
      alignment.revision !== request.alignmentRevision
    )
      throw new AppError('CONFLICT', '原文或匹配版本已变化，请重新匹配后导出。')
    const document = store.originals.document(request, request.originalId)
    skippedSegments = alignment.matches.filter((match) => !match.selected).length
    cues = alignment.matches
      .filter((match) => match.selected)
      .map((match) => ({
        startMs: match.startMs,
        endMs: match.endMs,
        text: document.sentences
          .slice(match.selected!.first, match.selected!.last + 1)
          .map((sentence) => sentence.text)
          .join(''),
      }))
  }
  return {
    contents: serializeSubtitles(cues, request.format),
    cueCount: cues.length,
    skippedSegments,
    suggestedName: `${
      Array.from(episode.title.replace(/[<>:"/\\|?*\p{Cc}]/gu, '_'))
        .slice(0, 100)
        .join('') || '字幕'
    }-${request.source === 'original' ? '原文' : '文稿'}.${request.format}`,
  }
}

export async function writeSubtitleFile(path: string, contents: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  let owned = false
  try {
    const file = await open(temporary, 'wx', 0o600)
    owned = true
    try {
      await file.writeFile(contents, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
  } catch {
    throw new AppError('FILE_UNAVAILABLE', '字幕未保存，请检查目标目录权限和磁盘空间后重试。')
  } finally {
    if (owned) await unlink(temporary).catch(() => {})
  }
}
