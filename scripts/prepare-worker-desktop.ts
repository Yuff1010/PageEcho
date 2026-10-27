// Export completed reference-worker documents for existing M2 schema/UI checks.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { validateTranscript } from '../src/shared/transcript'

const directories = process.argv.slice(2).map((value) => resolve(value))
if (!directories.length)
  throw new Error('Usage: npm run asr:desktop:prepare -- <worker-run-directory> [...]')
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function hashFile(path: string) {
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(path)) digest.update(bytes)
  return digest.digest('hex')
}
async function immutable(path: string, bytes: Uint8Array) {
  try {
    if (hash(await readFile(path)) !== hash(bytes))
      throw new Error(`Existing export differs; preserve it and use a separate run: ${path}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await writeFile(path, bytes, { flag: 'wx' })
  }
}
for (const root of directories) {
  const sourceReport = await readFile(join(root, 'report.json'))
  const report = JSON.parse(sourceReport.toString('utf8')) as {
    status: string
    manifestPath: string
    manifestSha256: string
    samples: {
      id: string
      status: string
      audioHash: string
      durationMs: number
      transcript: string
    }[]
  }
  if (report.status !== 'passed')
    throw new Error(`Require a terminal completed reference run: ${root}`)
  const manifestBytes = await readFile(report.manifestPath)
  if (hash(manifestBytes) !== report.manifestSha256)
    throw new Error('Worker source manifest changed')
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    samples: { id: string; audioHash: string; path: string; sourcePath?: string }[]
  }
  if (
    !manifest.samples.length ||
    new Set(manifest.samples.map((sample) => sample.id)).size !== manifest.samples.length ||
    new Set(report.samples.map((sample) => sample.id)).size !== report.samples.length ||
    report.samples.length !== manifest.samples.length
  )
    throw new Error('Worker cohort is missing or duplicates reference samples')
  const prepared = []
  for (const sample of manifest.samples) {
    const result = report.samples.find((value) => value.id === sample.id)
    if (!result || result.status !== 'completed' || result.audioHash !== sample.audioHash)
      throw new Error('Missing completed reference document')
    if ((await hashFile(sample.path)) !== sample.audioHash)
      throw new Error('Source audio no longer matches the completed worker input')
    if (!result.transcript || /[/\\]/.test(result.transcript))
      throw new Error('Worker document must be a basename in its run directory')
    const data = await readFile(join(root, result.transcript))
    const document = validateTranscript(
      JSON.parse(data.toString('utf8')),
      result.audioHash,
      result.durationMs,
    )
    if (
      document.coverage.length !== 1 ||
      document.coverage[0]!.startMs !== 0 ||
      document.coverage[0]!.endMs !== result.durationMs
    )
      throw new Error('Only complete full-input reference runs can be exported')
    prepared.push({
      data,
      transcript: result.transcript,
      sample: {
        id: sample.id,
        audioHash: sample.audioHash,
        path: sample.path,
        originalSourcePath: sample.path,
        recordedSourcePath: sample.sourcePath,
        offsetMs: 0,
        durationMs: result.durationMs,
        sourceDocumentSha256: hash(data),
        attempts: [{ status: 'passed', transcript: result.transcript }],
      },
    })
  }
  const directory = join(root, 'desktop-input')
  await mkdir(directory, { recursive: true })
  for (const item of prepared) await immutable(join(directory, item.transcript), item.data)
  const output = join(directory, 'report.json')
  let existing:
    | {
        sourceReportSha256: string
        sourceManifestSha256?: string
        samples: Record<string, unknown>[]
      }
    | undefined
  try {
    existing = JSON.parse(await readFile(output, 'utf8')) as typeof existing
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existing) {
    if (
      existing.sourceReportSha256 !== hash(sourceReport) ||
      (existing.sourceManifestSha256 && existing.sourceManifestSha256 !== hash(manifestBytes)) ||
      existing.samples.length !== prepared.length ||
      prepared.some(
        (item) =>
          !existing!.samples.some((sample) =>
            (
              [
                'id',
                'audioHash',
                'path',
                'originalSourcePath',
                'offsetMs',
                'durationMs',
                'sourceDocumentSha256',
                'attempts',
              ] as const
            ).every((key) => JSON.stringify(sample[key]) === JSON.stringify(item.sample[key])),
          ),
      )
    )
      throw new Error('Existing desktop export has different ownership; it was preserved')
  } else {
    await writeFile(
      output,
      JSON.stringify(
        {
          status: 'source-worker-completed',
          sourceReport: join(root, 'report.json'),
          sourceReportSha256: hash(sourceReport),
          sourceManifestSha256: hash(manifestBytes),
          scope:
            'Contained copies of actual completed reference-worker documents; playback uses the exact worker input, which may be resampled. No human alignment claim.',
          samples: prepared.map((item) => item.sample),
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    )
  }
  console.log(
    JSON.stringify({ directory, samples: prepared.length, existingExportPreserved: !!existing }),
  )
}
