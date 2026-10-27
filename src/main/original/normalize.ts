import { Converter } from 'opencc-js/t2cn'

// Retrieval only: retain the original document and ASR surface text verbatim.
const toSimplified = Converter({ from: 't', to: 'cn' })
export function normalizeOriginal(text: string): string {
  return toSimplified(text.normalize('NFKC'))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
}
