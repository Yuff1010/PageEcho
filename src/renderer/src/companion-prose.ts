import type { ReadingRow } from '../../shared/regions'
import type { TranscriptSegment } from '../../shared/transcript'

type SentenceRow = Extract<ReadingRow, { type: 'sentence' }>
export type CompanionProseBlock =
  { type: 'paragraph'; rows: SentenceRow[] } | Extract<ReadingRow, { type: 'region' }>

/** Layout groups only: the transcript text, order and media ranges remain unchanged. */
export function companionProseBlocks(
  rows: readonly ReadingRow[],
  segments: readonly TranscriptSegment[],
): CompanionProseBlock[] {
  const blocks: CompanionProseBlock[] = []
  let paragraph: SentenceRow[] = []
  let length = 0
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', rows: paragraph })
    paragraph = []
    length = 0
  }
  for (const row of rows) {
    if (row.type === 'region') {
      flush()
      blocks.push(row)
      continue
    }
    const segment = segments[row.index]!
    const previous = paragraph.length ? segments[paragraph.at(-1)!.index]! : null
    if (
      previous &&
      (/\n\s*$/.test(previous.text) ||
        /^\s*\n/.test(segment.text) ||
        segment.startMs - previous.endMs >= 1800 ||
        (length >= 180 && /[。！？.!?…][”’」』）)]?\s*$/.test(previous.text)))
    )
      flush()
    paragraph.push(row)
    length += segment.text.length
    if (/\n\s*$/.test(segment.text)) flush()
  }
  flush()
  return blocks
}

/** Chinese runs join directly; separate Latin words when the source split them. */
export function companionSentenceSpace(previous: string, next: string): string {
  return /[\p{Script=Latin}\d.!?][”’"']?$/u.test(previous) &&
    /^[\p{Script=Latin}\d“‘"']/u.test(next)
    ? ' '
    : ''
}
