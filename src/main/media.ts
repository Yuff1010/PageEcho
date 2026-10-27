import { open, realpath } from 'node:fs/promises'
import { extname } from 'node:path'
import { Readable } from 'node:stream'
import type { LibraryStore, StoredAudio } from './database'
import { AppError, isId } from '../shared/validation'

export const MEDIA_PREFIX = 'readlisten://app/media/'

export function parseRange(
  value: string | null,
  size: number,
): { start: number; end: number } | null {
  if (value === null) return { start: 0, end: size - 1 }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (!match || (!match[1] && !match[2])) return null
  const first = match[1] ? Number(match[1]) : null
  const last = match[2] ? Number(match[2]) : null
  if (
    (first !== null && !Number.isSafeInteger(first)) ||
    (last !== null && !Number.isSafeInteger(last))
  )
    return null
  if (first === null)
    return last && last > 0 ? { start: Math.max(0, size - last), end: size - 1 } : null
  if (first >= size || (last !== null && last < first)) return null
  return { start: first, end: Math.min(last ?? size - 1, size - 1) }
}

async function openAudio(audio: StoredAudio) {
  try {
    const canonical = await realpath(audio.path)
    if (canonical !== audio.path) throw new Error('File path changed')
    const file = await open(canonical, 'r')
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size !== audio.sizeBytes || info.mtimeMs !== audio.modifiedAt)
        throw new AppError('FILE_CHANGED', '音频文件已变化，请重新导入后播放。')
      return file
    } catch (error) {
      await file.close()
      throw error
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(
      'FILE_UNAVAILABLE',
      '音频已移动或无法读取。请确认文件位置，再重新导入或选择其他章节。',
    )
  }
}

export async function checkAudio(audio: StoredAudio): Promise<void> {
  const file = await openAudio(audio)
  await file.close()
}

const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
}

export async function serveMedia(
  request: Request,
  store: LibraryStore,
  rendererOrigin: string,
): Promise<Response> {
  const url = new URL(request.url)
  const parts = url.pathname.split('/')
  const id = parts[2]
  const hash = parts[3]
  if (
    url.protocol !== 'readlisten:' ||
    url.host !== 'app' ||
    parts.length !== 4 ||
    parts[1] !== 'media' ||
    !isId(id) ||
    !hash ||
    !/^[0-9a-f]{64}$/.test(hash) ||
    url.search ||
    url.username ||
    url.password
  )
    return new Response(null, { status: 403 })
  if (!['GET', 'HEAD'].includes(request.method))
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
  const audio = store.getAudio(id)
  if (!audio || audio.contentHash !== hash) return new Response(null, { status: 404 })
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Content-Type': MIME[extname(audio.path).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': rendererOrigin,
  })
  const rangeHeader = request.headers.get('range')
  const range = parseRange(rangeHeader, audio.sizeBytes)
  if (!range) {
    headers.set('Content-Range', `bytes */${audio.sizeBytes}`)
    return new Response(null, { status: 416, headers })
  }
  try {
    const file = await openAudio(audio)
    headers.set('Content-Length', String(range.end - range.start + 1))
    if (rangeHeader)
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${audio.sizeBytes}`)
    if (request.method === 'HEAD') {
      await file.close()
      return new Response(null, { status: rangeHeader ? 206 : 200, headers })
    }
    const stream = file.createReadStream({
      start: range.start,
      end: range.end,
      autoClose: true,
      highWaterMark: 64 * 1024,
    })
    const abort = () => stream.destroy()
    request.signal.addEventListener('abort', abort, { once: true })
    stream.once('close', () => request.signal.removeEventListener('abort', abort))
    if (request.signal.aborted) stream.destroy()
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: rangeHeader ? 206 : 200,
      headers,
    })
  } catch (error) {
    return new Response(null, {
      status: error instanceof AppError && error.code === 'FILE_CHANGED' ? 409 : 404,
      headers,
    })
  }
}
