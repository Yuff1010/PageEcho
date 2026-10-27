// Opt-in bounded real-model scheduling/cache check. No synthetic inference or quality claim.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { AsrComponent } from '../../src/main/asr-component'
import { AsrWorkerProcess, type AsrEvent, type AsrOutcome } from '../../src/main/asr-process'
import { subtitleBufferState, SubtitleThroughput } from '../../src/shared/subtitle-preparation'
import type { TranscriptionState } from '../../src/shared/transcription'

const componentPath = resolve('release/asr-component-0.7.0-win-x64/component.json')
const manifestPath = resolve(
  'cache/asr-evaluation/public-reference/aishell4-continuous/manifest.json',
)
const output = resolve('cache/optimization/priority-model-report.json')
const directory = resolve(
  'cache/optimization',
  `priority-model-${new Date().toISOString().replaceAll(':', '-')}`,
)
await mkdir(directory, { recursive: true })
const digest = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
const fileHash = async (path: string) => digest(await readFile(path))
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
  referenceKind: string
  qualityScope: string
  source: { dataset: string; recording: string; revision: string }
  samples: {
    id: string
    path: string
    audioHash: string
    durationMs: number
    sourceOffsetMs: number
  }[]
}
const sample = manifest.samples.find((item) => item.id === 'continuous-solo-first')!
assert.ok(sample)
assert.equal(manifest.referenceKind, 'human-continuous')
assert.equal(await fileHash(sample.path), sample.audioHash)
assert.ok(sample.durationMs > 90000 && sample.durationMs < 120000)
const sourcePaths = [
  resolve('tests/model/priority-generation.ts'),
  resolve('src/main/asr-process.ts'),
  resolve('src/main/asr-component.ts'),
  resolve('src/shared/subtitle-preparation.ts'),
  ...(await readdir(resolve('python')))
    .filter((name) => /^asr_.*\.py$/.test(name))
    .sort()
    .map((name) => resolve('python', name)),
]
const sources = Object.fromEntries(
  await Promise.all(sourcePaths.map(async (path) => [path, await fileHash(path)])),
)
const snapshots = join(directory, 'source-snapshots')
await mkdir(snapshots)
for (const path of sourcePaths)
  await writeFile(join(snapshots, basename(path)), await readFile(path))
const component = new AsrComponent(
  join(directory, 'component.json'),
  resolve('python/asr_worker.py'),
)
await component.configure(componentPath)
const runtime = component.runtime('paraformer', 'cuda')
const protectedPaths = [
  componentPath,
  runtime.python,
  runtime.models,
  runtime.ffmpeg,
  runtime.ffprobe,
]
const protectedBefore = Object.fromEntries(
  await Promise.all(protectedPaths.map(async (path) => [path, await fileHash(path)])),
)
// Fixed local component and model paths; every writable runtime/cache path is isolated.
process.env.PATH = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32;${process.env.SystemRoot ?? 'C:\\Windows'}`
delete process.env.PYTHONHOME
delete process.env.PYTHONPATH
const report: Record<string, unknown> = {
  status: 'running',
  startedAt: new Date().toISOString(),
  directory,
  scope:
    'Real Paraformer CUDA on one existing 97-second AISHELL-4 continuous human-reference clip. Target-first generation and whole-range cache replay only; no audiobook human quality, default engine, sustained playback, device throughput or adaptive-policy acceptance claim.',
  sources,
  inputManifest: { path: manifestPath, sha256: await fileHash(manifestPath) },
  sample: {
    ...sample,
    source: manifest.source,
    referenceKind: manifest.referenceKind,
    qualityScope: manifest.qualityScope,
  },
  runtime: {
    ...runtime,
    cacheIsolated: true,
    externalDownloads:
      'Worker enforces local-model/offline Python network and FFmpeg file/pipe policy; no packet-capture claim.',
  },
  protectedBefore,
  gates: {},
  runs: [],
}
const save = async () => {
  const encoded = JSON.stringify(report, null, 2) + '\n'
  await writeFile(join(directory, 'report.json'), encoded)
  await writeFile(output, encoded)
}
await save()
let worker: AsrWorkerProcess | undefined
try {
  worker = new AsrWorkerProcess(runtime)
  const readyStarted = performance.now()
  await worker.ready
  report.readyMs = performance.now() - readyStarted
  report.workerConfiguration = worker.configuration
  assert.equal(worker.configuration?.engine, 'paraformer')
  assert.equal(worker.configuration?.device, 'cuda')
  assert.equal(worker.configuration?.offlineNetwork, 'python-loopback-only-ffmpeg-file-pipe-v1')
  const request = {
    jobId: randomUUID(),
    attempt: 1,
    audioPath: sample.path,
    audioHash: sample.audioHash,
    range: { startMs: 0, endMs: sample.durationMs },
    priorityMs: 60000,
  }
  const metrics = new SubtitleThroughput()
  const partials: (Extract<AsrEvent, { type: 'partial' }> & { elapsedMs: number })[] = []
  const generationStarted = performance.now()
  const metricsState = (event: Extract<AsrEvent, { type: 'partial' }>): TranscriptionState => ({
    configured: true,
    job: {
      id: request.jobId,
      attempt: 1,
      autoApply: true,
      status: 'running',
      error: null,
      completedChunks: event.completedChunks,
      cacheHits: event.cacheHits,
    } as TranscriptionState['job'],
    transcript: {
      status: 'ready',
      transcript: {
        id: request.jobId,
        episodeId: request.jobId,
        importedAt: '',
        revision: event.completedChunks,
        document: event.document,
      },
    },
  })
  const initial = {
    ...metricsState({ completedChunks: 0, cacheHits: 0 } as Extract<AsrEvent, { type: 'partial' }>),
    transcript: { status: 'missing' as const },
  }
  metrics.observe(initial, 0)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    worker?.cancel(request.jobId, request.attempt)
  }, 180000)
  let result: AsrOutcome
  try {
    result = await worker.submit(request, (event) => {
      const elapsedMs = performance.now() - generationStarted
      appendFileSync(
        join(directory, 'generation-events.jsonl'),
        JSON.stringify({ elapsedMs, ...event }) + '\n',
      )
      if (event.type === 'partial') {
        partials.push({ ...event, elapsedMs })
        const state = metricsState(event)
        const observed = metrics.observe(state, elapsedMs)
        appendFileSync(
          join(directory, 'buffer-observations.jsonl'),
          JSON.stringify({
            elapsedMs,
            completedChunks: event.completedChunks,
            coverage: event.document.coverage,
            observed,
            at1x: subtitleBufferState(state, 60000, sample.durationMs, { ...observed, rate: 1 }),
            at2x: subtitleBufferState(state, 60000, sample.durationMs, { ...observed, rate: 2 }),
          }) + '\n',
        )
      }
      console.log(
        JSON.stringify({
          run: 'generate',
          elapsedMs: Math.round(elapsedMs),
          type: event.type,
          stage: event.type === 'progress' ? event.stage : undefined,
          prefixMs: event.processedUntilMs,
          completedChunks: event.type === 'partial' ? event.completedChunks : undefined,
        }),
      )
    })
  } finally {
    clearTimeout(timer)
  }
  assert.equal(timedOut, false, 'bounded model run exceeded three minutes')
  assert.equal(result.status, 'completed')
  if (result.status !== 'completed') throw new Error('real generation was canceled')
  const first = partials[0]!
  assert.ok(first)
  assert.equal(first.cacheHits, 0)
  assert.equal(first.completedChunks, 1)
  assert.equal(first.processedUntilMs, 0)
  assert.deepEqual(first.document.coverage, [{ startMs: 60000, endMs: 90000 }])
  assert.equal(result.totalChunks, 4)
  assert.equal(result.cacheHits, 0)
  assert.equal(result.processedUntilMs, sample.durationMs)
  assert.deepEqual(result.document.coverage, [{ startMs: 0, endMs: sample.durationMs }])
  assert.deepEqual(
    partials.map((item) => item.processedUntilMs),
    [0, 0, 30000, sample.durationMs],
  )
  await writeFile(
    join(directory, 'generated-transcript.json'),
    JSON.stringify(result.document, null, 2) + '\n',
  )
  ;(report.runs as unknown[]).push({
    kind: 'fresh-priority-60000',
    elapsedMs: performance.now() - generationStarted,
    firstPartialMs: first.elapsedMs,
    firstCoverage: first.document.coverage,
    prefixSequence: partials.map((item) => item.processedUntilMs),
    partials: partials.length,
    totalChunks: result.totalChunks,
    cacheHits: result.cacheHits,
    cacheKey: result.cacheKey,
    segments: result.document.segments.length,
    transcriptSha256: digest(JSON.stringify(result.document)),
    issueCount: result.issues.length,
  })
  await save()
  await worker.close()
  await writeFile(join(directory, 'generation-worker.log'), worker.diagnosticLog)
  worker = new AsrWorkerProcess(runtime)
  await worker.ready
  const replayStarted = performance.now()
  const replay = await worker.submit({ ...request, attempt: 2, priorityMs: 0 }, (event) => {
    appendFileSync(
      join(directory, 'replay-events.jsonl'),
      JSON.stringify({ elapsedMs: performance.now() - replayStarted, ...event }) + '\n',
    )
  })
  assert.equal(replay.status, 'completed')
  if (replay.status !== 'completed') throw new Error('cache replay was canceled')
  assert.equal(replay.cacheKey, result.cacheKey)
  assert.equal(replay.cacheHits, replay.totalChunks)
  assert.deepEqual(replay.document, result.document)
  ;(report.runs as unknown[]).push({
    kind: 'restarted-cache-priority-0',
    elapsedMs: performance.now() - replayStarted,
    totalChunks: replay.totalChunks,
    cacheHits: replay.cacheHits,
    cacheKey: replay.cacheKey,
    transcriptSha256: digest(JSON.stringify(replay.document)),
    identicalTextTimesAndIds: true,
  })
  const protectedAfter = Object.fromEntries(
    await Promise.all(protectedPaths.map(async (path) => [path, await fileHash(path)])),
  )
  assert.deepEqual(protectedAfter, protectedBefore)
  assert.equal(await fileHash(sample.path), sample.audioHash)
  report.protectedAfter = protectedAfter
  report.gates = {
    freshIsolatedCache: true,
    realParaformerCuda: true,
    targetCoreFirst: true,
    firstPrefixZero: true,
    honestPrefixSequence: true,
    finalWholeCoverage: true,
    changedPrioritySameCacheKey: true,
    restartAllChunksHit: true,
    identicalTextTimesAndIds: true,
    protectedRuntimeFilesUnchanged: true,
    sourceAudioUnchanged: true,
    adaptiveMeasurementsRecorded: true,
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.stack : String(error)
  process.exitCode = 1
} finally {
  if (worker) {
    await worker.close()
    await writeFile(join(directory, 'final-worker.log'), worker.diagnosticLog)
  }
  report.finishedAt = new Date().toISOString()
  await save()
}
console.log(
  JSON.stringify({ status: report.status, report: output, directory, error: report.error }),
)
