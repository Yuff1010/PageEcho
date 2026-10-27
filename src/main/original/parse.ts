import { createHash } from 'node:crypto'
import { basename, extname } from 'node:path'
import { AppError } from '../../shared/validation'
import {
  ORIGINAL_PARSER_VERSION,
  ORIGINAL_EPUB_PARSER_VERSION,
  type ParsedOriginal,
} from '../../shared/original'
import { epubChapters } from './epub'

export const MAX_ORIGINAL_BYTES = 32 * 1024 * 1024
const MAX_CHARACTERS = 12_000_000
const MAX_SENTENCES = 250_000

export function decodeOriginal(bytes: Buffer): { text: string; encoding: string } {
  let encoding = 'utf-8'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le'
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be'
  try {
    return { text: new TextDecoder(encoding, { fatal: true }).decode(bytes), encoding }
  } catch {
    if (encoding !== 'utf-8') throw new AppError('INVALID_ORIGINAL', '原文编码损坏。')
    try {
      return {
        text: new TextDecoder('gb18030', { fatal: true }).decode(bytes),
        encoding: 'gb18030',
      }
    } catch {
      throw new AppError('INVALID_ORIGINAL', '原文需要 UTF-8、UTF-16 或 GB18030 编码。')
    }
  }
}

export function isChapterHeading(line: string): boolean {
  return (
    line.length <= 80 &&
    /^(?:第[〇零一二三四五六七八九十百千万两\d０-９]+[章节卷回部篇].*|[\d０-９]{1,5}[、．.：:]\s*\S.{0,38}|(?:序章|楔子|序言|后记|尾声)(?:\s.*)?)$/u.test(
      line,
    )
  )
}

export function parseOriginal(bytes: Buffer, filename: string): ParsedOriginal {
  if (!bytes.length || bytes.length > MAX_ORIGINAL_BYTES)
    throw new AppError('INVALID_ORIGINAL', '请选择非空且不超过 32 MiB 的 TXT/EPUB。')
  const format = extname(filename).toLowerCase().slice(1)
  if (format !== 'txt' && format !== 'epub')
    throw new AppError('INVALID_ORIGINAL', '仅支持 TXT 或 EPUB 原文。')
  const sourceName = basename(filename).slice(0, 255)
  const decoded = format === 'txt' ? decodeOriginal(bytes) : null
  const sections = decoded ? [{ title: '前言', text: decoded.text }] : epubChapters(bytes)
  if (sections.reduce((sum, section) => sum + section.text.length, 0) > MAX_CHARACTERS)
    throw new AppError('INVALID_ORIGINAL', '解码后的原文超过 1,200 万字符。')
  const result: ParsedOriginal = {
    hash: createHash('sha256').update(bytes).digest('hex'),
    parserVersion: format === 'epub' ? ORIGINAL_EPUB_PARSER_VERSION : ORIGINAL_PARSER_VERSION,
    title: sourceName.replace(/\.(txt|epub)$/i, ''),
    sourceName,
    format,
    encoding: decoded?.encoding ?? 'epub-xml',
    bytes: bytes.length,
    chapters: [],
    sentences: [],
    warnings: [],
  }
  let paragraph = 0
  let split = false
  for (const section of sections) {
    let lastNumber = 0
    let chapter = {
      index: result.chapters.length,
      title: section.title,
      first: result.sentences.length,
      count: 0,
    }
    result.chapters.push(chapter)
    for (const raw of section.text.replaceAll('\r', '').split('\n')) {
      const line = raw.replace(/^\uFEFF/, '').trim()
      if (!line) continue
      if ([...line].some((char) => char.charCodeAt(0) < 32 && char !== '\t'))
        throw new AppError('INVALID_ORIGINAL', '文件含有二进制控制字符，请检查原文编码。')
      const numeric = line.normalize('NFKC').match(/^(?:第)?(\d+)(?:[章节卷回部篇]|[、．.：:])/)
      const plainNumber = /^\d/.test(line.normalize('NFKC'))
      if (isChapterHeading(line) && !(plainNumber && numeric && Number(numeric[1]) < lastNumber)) {
        if (numeric) lastNumber = Number(numeric[1])
        if (!chapter.count) chapter.title = line
        else {
          chapter = {
            index: result.chapters.length,
            title: line,
            first: result.sentences.length,
            count: 0,
          }
          result.chapters.push(chapter)
        }
        if (result.chapters.length > 10_000)
          throw new AppError('INVALID_ORIGINAL', '章节超过 10,000 个。')
        continue
      }
      paragraph++
      const pieces = line.match(/[^。！？!?]+[。！？!?]+[”’」』]*|[^。！？!?]+$/gu) ?? [line]
      for (const piece of pieces) {
        // Bound pathological unpunctuated paragraphs without discarding their text.
        for (let start = 0; start < piece.length;) {
          let end = Math.min(piece.length, start + 600)
          if (end < piece.length && /[\uD800-\uDBFF]/.test(piece[end - 1]!)) end--
          const text = piece.slice(start, end).trim()
          if (text) {
            result.sentences.push({
              ordinal: result.sentences.length,
              chapter: chapter.index,
              paragraph,
              text,
            })
            chapter.count++
          }
          if (end < piece.length) split = true
          start = end
        }
      }
      if (result.sentences.length > MAX_SENTENCES)
        throw new AppError('INVALID_ORIGINAL', '原文超过 250,000 句，请按卷拆分导入。')
    }
  }
  if (!result.sentences.length) throw new AppError('INVALID_ORIGINAL', '原文没有可阅读正文。')
  if (split) result.warnings.push('部分无标点长段按最多 600 字符分段，未删除正文。')
  result.warnings.push('章节依据正文标题或 EPUB 阅读顺序建立；未按音频集号绑定。')
  return result
}
