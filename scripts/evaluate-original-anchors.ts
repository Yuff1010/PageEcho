// Opt-in, read-only comparison of frozen recognition text. No models, media
// playback, downloads, user-data migrations or alignment writes are performed.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { matchOriginal } from '../src/main/original/match'
import { parseOriginal } from '../src/main/original/parse'
import {
  ORIGINAL_MATCHER_VERSION,
  type OriginalMatch,
  type ParsedOriginal,
} from '../src/shared/original'
import type { TranscriptDocument } from '../src/shared/transcript'

const defaults = {
  'qing-report': 'cache/asr-evaluation/original-online-runs/2026-10-21T02-05-14.555Z/report.json',
  'sequence-dir': 'cache/asr-evaluation/original-sequence-runs/2026-10-21T04-55-32.681Z',
  'epub-report': 'cache/asr-evaluation/original-epub-runs/2026-10-21T05-48-49.765Z/report.json',
  'baseline-worker':
    'cache/preview-builds/2026-10-25T05-31-22.250Z/app/out/main/original-worker.js',
  output: join(
    'cache/asr-evaluation/original-anchor-evaluations',
    new Date().toISOString().replaceAll(':', '-'),
  ),
}
const options: Record<keyof typeof defaults, string> = { ...defaults }
const args = process.argv.slice(2)
for (let index = 0; index < args.length; index += 2) {
  const key = args[index]?.slice(2)
  if (!args[index]?.startsWith('--') || !key || !(key in defaults) || !args[index + 1])
    throw new Error(
      'Usage: tsx scripts/evaluate-original-anchors.ts [--qing-report path] [--sequence-dir path] [--epub-report path] [--baseline-worker path] [--output directory]',
    )
  options[key as keyof typeof defaults] = args[index + 1]!
}
const directory = resolve(options.output)
await mkdir(directory, { recursive: true })
await copyFile(
  resolve('scripts/evaluate-original-anchors.ts'),
  join(directory, 'runner-started.ts'),
)
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const inputs = new Map<string, string>()
async function source(path: string) {
  const absolute = resolve(path)
  const bytes = await readFile(absolute)
  const hash = sha256(bytes)
  const previous = inputs.get(absolute)
  assert.ok(!previous || previous === hash, `Source changed during evaluation: ${absolute}`)
  inputs.set(absolute, hash)
  return bytes
}
async function json<T>(path: string): Promise<T> {
  return JSON.parse((await source(path)).toString('utf8').replace(/^\uFEFF/, '')) as T
}
const baselineWorker = resolve(options['baseline-worker'])
await source(baselineWorker)
await source(resolve('src/main/original/match.ts'))
await source(resolve('src/shared/original.ts'))

async function baseline(original: ParsedOriginal, transcript: TranscriptDocument) {
  const worker = new Worker(baselineWorker, { workerData: { kind: 'match', original, transcript } })
  try {
    return await new Promise<OriginalMatch[]>((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Rule 4 comparison exceeded 60 seconds')),
        60000,
      )
      const fail = (error: Error) => {
        clearTimeout(timer)
        reject(error)
      }
      worker.once('error', fail)
      worker.once('exit', (code) =>
        fail(new Error(`Rule 4 worker exited before its result (${code})`)),
      )
      worker.once(
        'message',
        (result: { ok: boolean; value: OriginalMatch[]; error?: { message: string } }) => {
          clearTimeout(timer)
          if (result.ok) done(result.value)
          else reject(new Error(result.error?.message ?? 'Rule 4 worker failed'))
        },
      )
    })
  } finally {
    await worker.terminate()
  }
}

function summary(matches: OriginalMatch[]) {
  const selected = matches.filter((match) => match.selected).length
  return {
    total: matches.length,
    selected,
    unmatched: matches.length - selected,
    coverage: matches.length ? Number((selected / matches.length).toFixed(6)) : 0,
    anchored: matches.filter((match) => match.selected && match.candidates[0]?.basis === 'anchors')
      .length,
  }
}
const coordinate = (match: OriginalMatch | undefined) =>
  match?.selected ? { first: match.selected.first, last: match.selected.last } : null
function samePosition(a: OriginalMatch | undefined, b: OriginalMatch | undefined) {
  return JSON.stringify(coordinate(a)) === JSON.stringify(coordinate(b))
}
function excerpt(original: ParsedOriginal, match: OriginalMatch | undefined) {
  return match?.selected
    ? original.sentences
        .slice(match.selected.first, match.selected.last + 1)
        .map((sentence) => sentence.text)
        .join('')
        .slice(0, 240)
    : null
}
type Comparison = {
  id: string
  status: 'evaluated' | 'unavailable'
  message?: string
  [key: string]: unknown
}
const comparisons: Comparison[] = []
async function compare(id: string, original: ParsedOriginal, transcript: TranscriptDocument) {
  const oldStarted = performance.now()
  const old = await baseline(original, transcript)
  const baselineWallMs = performance.now() - oldStarted
  const newStarted = performance.now()
  const current = matchOriginal(original, transcript)
  const currentWallMs = performance.now() - newStarted
  const previous = new Map(old.map((match) => [match.segmentId, match]))
  const changes = current
    .filter((match) => !samePosition(previous.get(match.segmentId), match))
    .map((match) => {
      const before = previous.get(match.segmentId)
      return {
        segmentId: match.segmentId,
        startMs: match.startMs,
        endMs: match.endMs,
        kind: !before?.selected ? 'added' : !match.selected ? 'removed' : 'remapped',
        asrText: match.asrText.slice(0, 240),
        before: coordinate(before),
        after: coordinate(match),
        beforeOriginal: excerpt(original, before),
        afterOriginal: excerpt(original, match),
        candidateBasis: match.candidates[0]?.basis ?? null,
        similarity: match.candidates[0]?.score ?? null,
        humanReviewed: false,
      }
    })
  const result: Comparison = {
    id,
    status: 'evaluated',
    originalHash: original.hash,
    parserVersion: original.parserVersion,
    originalSentences: original.sentences.length,
    transcriptHash: sha256(JSON.stringify(transcript)),
    audioHash: transcript.audioHash,
    baseline: { version: 4, wallMs: Number(baselineWallMs.toFixed(3)), ...summary(old) },
    current: {
      version: ORIGINAL_MATCHER_VERSION,
      wallMs: Number(currentWallMs.toFixed(3)),
      ...summary(current),
    },
    added: changes.filter((change) => change.kind === 'added').length,
    removed: changes.filter((change) => change.kind === 'removed').length,
    remapped: changes.filter((change) => change.kind === 'remapped').length,
    changes,
  }
  comparisons.push(result)
  await writeFile(
    join(directory, `${id}.json`),
    JSON.stringify({ ...result, baselineMatches: old, currentMatches: current }, null, 2) + '\n',
    { flag: 'wx' },
  )
  console.log(JSON.stringify(result))
}
async function optional(id: string, action: () => Promise<void>) {
  try {
    await action()
  } catch (error) {
    comparisons.push({
      id,
      status: 'unavailable',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

await optional('qing-shan', async () => {
  const report = await json<{
    userData: string
    originalFileHash: string
    audio: { id: string; contentHash: string }
    transcription: { documentSha256: string }
  }>(options['qing-report'])
  const databasePath = join(report.userData, 'data/library.sqlite3')
  await source(databasePath)
  const db = new DatabaseSync(databasePath, { readOnly: true })
  let original: ParsedOriginal, transcript: TranscriptDocument
  try {
    const originalRow = db
      .prepare(
        'SELECT document_json FROM original_documents WHERE content_hash=? ORDER BY parser_version DESC LIMIT 1',
      )
      .get(report.originalFileHash)
    const transcriptRow = db
      .prepare('SELECT document_json FROM transcripts WHERE episode_id=? AND audio_hash=?')
      .get(report.audio.id, report.audio.contentHash)
    assert.ok(originalRow && transcriptRow, 'Frozen Qing Shan document or transcript is missing')
    original = JSON.parse(String(originalRow.document_json)) as ParsedOriginal
    transcript = JSON.parse(String(transcriptRow.document_json)) as TranscriptDocument
    assert.equal(original.hash, report.originalFileHash)
    assert.equal(sha256(JSON.stringify(transcript)), report.transcription.documentSha256)
  } finally {
    db.close()
  }
  assert.equal(
    sha256(await readFile(databasePath)),
    inputs.get(resolve(databasePath)),
    'Read-only source database changed',
  )
  await compare('qing-shan-episode-1', original, transcript)
  for (const episode of [2, 3]) {
    await optional(`qing-shan-episode-${episode}`, async () => {
      const file = await json<{ document: TranscriptDocument }>(
        join(options['sequence-dir'], `episode-${episode}-transcript.json`),
      )
      await compare(`qing-shan-episode-${episode}`, original, file.document)
    })
  }
})
await optional('nahan', async () => {
  const report = await json<{
    epubManifestPath: string
    transcriptPath: string
    transcriptHash: string
  }>(options['epub-report'])
  const manifest = await json<{ files: { variant: string; path: string; sha256: string }[] }>(
    report.epubManifestPath,
  )
  const transcriptBytes = await source(report.transcriptPath)
  assert.equal(sha256(transcriptBytes), report.transcriptHash)
  const transcript = JSON.parse(
    transcriptBytes.toString('utf8').replace(/^\uFEFF/, ''),
  ) as TranscriptDocument
  for (const file of manifest.files) {
    await optional(`nahan-${file.variant}`, async () => {
      const bytes = await source(file.path)
      assert.equal(sha256(bytes), file.sha256)
      const original = parseOriginal(bytes, file.path)
      await compare(`nahan-${file.variant}`, original, transcript)
    })
  }
})
const sourceIntegrity = []
for (const [path, before] of inputs) {
  const after = sha256(await readFile(path))
  sourceIntegrity.push({ path, before, after, unchanged: before === after })
}
const report = {
  status: sourceIntegrity.every((entry) => entry.unchanged) ? 'evaluated' : 'source-changed',
  createdAt: new Date().toISOString(),
  directory,
  baselineWorker,
  baselineWorkerSha256: inputs.get(baselineWorker),
  matcherVersion: ORIGINAL_MATCHER_VERSION,
  scope:
    'Frozen text-only retrieval comparison. No model inference, network access, media playback, database migration or alignment writes.',
  quality:
    'Coverage is not correctness. Every added or remapped passage is unreviewed; no phonetic boundary or human matching accuracy conclusion is made.',
  comparisons,
  sourceIntegrity,
}
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
  flag: 'wx',
})
console.log(
  JSON.stringify({
    status: report.status,
    report: join(directory, 'report.json'),
    evaluated: comparisons.filter((comparison) => comparison.status === 'evaluated').length,
  }),
)
assert.equal(report.status, 'evaluated', 'A frozen input changed during evaluation')
