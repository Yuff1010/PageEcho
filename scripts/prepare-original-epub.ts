// Opt-in official EPUB files; keep original bytes and capture versions before app checks.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseOriginal } from '../src/main/original/parse'

assert.deepEqual(
  process.argv.slice(2),
  ['--download'],
  'Use --download to explicitly fetch the two official EPUB variants',
)
const directory = resolve(
  'cache/asr-evaluation/original-epub-source',
  new Date().toISOString().replaceAll(':', '-'),
)
await mkdir(directory, { recursive: true })
const catalog = 'https://www.gutenberg.org/ebooks/27166'
const files = []
for (const variant of ['epub3', 'epub'] as const) {
  const url = `${catalog}.${variant}.images`
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  assert.ok(response.ok && response.body, `Download failed: ${response.status}`)
  assert.equal(new URL(response.url).hostname, 'www.gutenberg.org')
  const parts: Uint8Array[] = []
  let bytes = 0
  for await (const part of response.body) {
    bytes += part.byteLength
    assert.ok(bytes <= 32 * 1024 * 1024, 'EPUB download exceeds 32 MiB')
    parts.push(part)
  }
  const contents = Buffer.concat(parts)
  assert.ok(
    contents.length > 100 && contents.readUInt32LE(0) === 0x04034b50,
    'Expected an original ZIP EPUB',
  )
  const path = join(directory, `nahan-${variant}.epub`)
  await writeFile(path, contents, { flag: 'wx' })
  let parsing: Record<string, unknown>
  try {
    const parsed = parseOriginal(contents, path)
    parsing = {
      status: 'parsed',
      parserVersion: parsed.parserVersion,
      sections: parsed.chapters.length,
      sentences: parsed.sentences.length,
      firstSections: parsed.chapters.slice(0, 5),
    }
  } catch (error) {
    parsing = { status: 'rejected', error: error instanceof Error ? error.message : String(error) }
  }
  const item = {
    variant,
    url,
    finalUrl: response.url,
    path,
    bytes,
    sha256: createHash('sha256').update(contents).digest('hex'),
    contentType: response.headers.get('content-type'),
    lastModified: response.headers.get('last-modified'),
    etag: response.headers.get('etag'),
    parsing,
  }
  files.push(item)
  console.log(JSON.stringify(item))
}
const manifest = {
  status: 'downloaded',
  preparedAt: new Date().toISOString(),
  catalog,
  work: 'Lu Xun, Nahan, Project Gutenberg ebook 27166',
  publisherCopyrightStatement: 'Public domain in the USA (catalog statement)',
  scope:
    'Unmodified official EPUB2/EPUB3 files for opt-in compatibility and same-work retrieval checks; published text is not a human audio transcription or phonetic reference.',
  files,
}
await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ status: manifest.status, manifest: join(directory, 'manifest.json') }))
