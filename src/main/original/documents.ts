import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { OriginalInfo, ParsedOriginal } from '../../shared/original'

// Call within the importing library's transaction. Both reading modes share immutable text.
export function storeOriginalDocument(db: DatabaseSync, parsed: ParsedOriginal): string {
  const row = db
    .prepare('SELECT id FROM original_documents WHERE content_hash=? AND parser_version=?')
    .get(parsed.hash, parsed.parserVersion)
  if (row) return String(row.id)
  const id = randomUUID()
  const { sentences, ...meta } = parsed
  const info: OriginalInfo = {
    ...meta,
    id,
    sentenceCount: sentences.length,
    importedAt: new Date().toISOString(),
  }
  db.prepare('INSERT INTO original_documents VALUES (?,?,?,?,?)').run(
    id,
    parsed.hash,
    parsed.parserVersion,
    JSON.stringify(info),
    JSON.stringify(parsed),
  )
  return id
}
