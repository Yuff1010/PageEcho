import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { AsrWorkerProcess, type AsrRuntime, type AsrEvent } from '../src/main/asr-process'
import { AsrComponent } from '../src/main/asr-component'

// Opt-in real model acceptance, deliberately excluded from ordinary CI.
const root = resolve('cache/asr-evaluation')
const args = process.argv.slice(2),
  options: string[] = []
let componentPath: string | undefined
let inputManifest = join(root, 'samples.json')
let customManifest = false
let engine: AsrRuntime['engine'] = 'whisperx'
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--component' && args[index + 1]) componentPath = resolve(args[++index]!)
  else if (args[index] === '--manifest' && args[index + 1]) {
    inputManifest = resolve(args[++index]!)
    customManifest = true
  } else if (
    args[index] === '--engine' &&
    ['whisperx', 'paraformer'].includes(args[index + 1] ?? '')
  )
    engine = args[++index] as AsrRuntime['engine']
  else if (['--cpu', '--control-only', '--isolated-runtime'].includes(args[index]!))
    options.push(args[index]!)
  else
    throw new Error(
      '支持 --cpu、--control-only、--component 路径、--manifest 路径、--isolated-runtime、--engine whisperx/paraformer。',
    )
}
if (customManifest && options.includes('--control-only'))
  throw new Error('人工对照与外部样本清单需分别运行。')
const manifest = JSON.parse(await readFile(inputManifest, 'utf8')) as {
  tools: { ffmpeg: string; ffprobe: string }
  samples: {
    id: string
    sourcePath: string
    category?: string
    clip: { startMs: number; endMs: number }
  }[]
}
if (options.includes('--control-only')) {
  const reference = JSON.parse(
    await readFile(resolve('tests/fixtures/reading-manual.json'), 'utf8'),
  ) as { audioHash: string }
  manifest.samples = [
    {
      id: reference.audioHash,
      sourcePath: resolve('tests/fixtures/第32集-伴读样本.wav'),
      clip: { startMs: 0, endMs: 16360 },
    },
  ]
}
let runtime: AsrRuntime = {
  python: join(root, 'venv', 'Scripts', 'python.exe'),
  script: resolve('python/asr_worker.py'),
  models: join(root, 'models.json'),
  cache: root,
  ffmpeg: manifest.tools.ffmpeg,
  ffprobe: manifest.tools.ffprobe,
  engine,
  device: options.includes('--cpu') ? 'cpu' : 'cuda',
  compute: options.includes('--cpu') ? 'int8' : 'int8_float16',
}
const directory = join(root, 'worker-runs', new Date().toISOString().replaceAll(':', '-'))
await mkdir(directory, { recursive: true })
if (componentPath) {
  const component = new AsrComponent(
    join(directory, 'component.json'),
    resolve('python/asr_worker.py'),
  )
  await component.configure(componentPath)
  runtime = component.runtime(engine, options.includes('--cpu') ? 'cpu' : 'cuda')
}
if (options.includes('--isolated-runtime')) {
  if (!runtime.resources) throw new Error('独立运行时验收需要便携组件 v2。')
  process.env.PATH = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32;${process.env.SystemRoot ?? 'C:\\Windows'}`
  delete process.env.PYTHONHOME
  delete process.env.PYTHONPATH
}
const report: {
  status: string
  runs: unknown[]
  samples: unknown[]
  error?: string
  configuration?: Record<string, unknown>
  inputManifest: string
} = {
  status: 'running',
  runs: [],
  samples: [],
  inputManifest,
}
let worker = new AsrWorkerProcess(runtime)
try {
  await worker.ready
  report.configuration = worker.configuration
  for (const [index, sample] of manifest.samples.entries()) {
    const sampleId = options.includes('--control-only')
      ? 'known-tts-control'
      : `${customManifest ? 'source' : 'song'}-${index + 1}`
    const jobId = randomUUID()
    const partials: AsrEvent[] = []
    const started = performance.now()
    let firstPartialMs: number | null = null
    const result = await worker.submit(
      {
        jobId,
        attempt: 1,
        audioPath: sample.sourcePath,
        audioHash: sample.id,
        range: { startMs: sample.clip.startMs, endMs: sample.clip.endMs },
      },
      (event) => {
        if (event.type === 'partial') {
          partials.push(event)
          firstPartialMs ??= performance.now() - started
        }
        console.log(
          JSON.stringify({
            sample: index + 1,
            type: event.type,
            stage: event.type === 'progress' ? event.stage : undefined,
            processedUntilMs: event.processedUntilMs,
          }),
        )
      },
    )
    if (result.status !== 'completed') throw new Error('Unexpected canceled result')
    const generationMs = performance.now() - started
    const replayStarted = performance.now()
    const repeat = await worker.submit({
      jobId,
      attempt: 2,
      audioPath: sample.sourcePath,
      audioHash: sample.id,
      range: { startMs: sample.clip.startMs, endMs: sample.clip.endMs },
    })
    const replayMs = performance.now() - replayStarted
    if (
      repeat.status !== 'completed' ||
      repeat.cacheHits !== repeat.totalChunks ||
      JSON.stringify(repeat.document) !== JSON.stringify(result.document)
    )
      throw new Error('Checkpoint replay mismatch')
    await writeFile(
      join(directory, `${sampleId}.transcript.json`),
      JSON.stringify(result.document, null, 2),
    )
    report.runs.push({
      sample: index + 1,
      elapsedMs: performance.now() - started,
      generationMs,
      firstPartialMs,
      replayMs,
      realTimeFactor: generationMs / (sample.clip.endMs - sample.clip.startMs),
      partials: partials.length,
      sentences: result.document.segments.length,
      result,
      replayCacheHits: repeat.cacheHits,
    })
    report.samples.push({
      id: sampleId,
      audioHash: sample.id,
      path: sample.sourcePath,
      originalSourcePath: sample.sourcePath,
      category: sample.category ?? 'unspecified-local-source',
      offsetMs: sample.clip.startMs,
      durationMs: sample.clip.endMs - sample.clip.startMs,
      attempts: [{ status: 'passed', transcript: `${sampleId}.transcript.json` }],
    })
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2))
  }
  await worker.close()
  await writeFile(join(directory, 'worker.log'), worker.diagnosticLog)
  worker = new AsrWorkerProcess(runtime)
  const sample = manifest.samples[0]!
  const jobId = randomUUID()
  const restarted = await worker.submit({
    jobId,
    attempt: 3,
    audioPath: sample.sourcePath,
    audioHash: sample.id,
    range: { startMs: sample.clip.startMs, endMs: sample.clip.endMs },
  })
  if (restarted.status !== 'completed' || restarted.cacheHits !== restarted.totalChunks)
    throw new Error('Restart replay did not use checkpoints')
  const cancelId = randomUUID()
  const canceled = await worker.submit(
    {
      jobId: cancelId,
      attempt: 1,
      audioPath: sample.sourcePath,
      audioHash: sample.id,
      range: { startMs: 0, endMs: 10000 },
    },
    (event) => {
      if ((event.type === 'progress' && event.stage === 'recognizing') || event.type === 'partial')
        worker.cancel(cancelId, 1)
    },
  )
  if (canceled.status !== 'canceled') throw new Error('Cancellation did not suppress the result')
  report.runs.push({ restartCacheHits: restarted.cacheHits, canceled: canceled.status })
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  process.exitCode = 1
} finally {
  await worker.close()
  await writeFile(join(directory, 'last-worker.log'), worker.diagnosticLog)
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2))
}
console.log(
  JSON.stringify({
    status: report.status,
    error: report.error,
    report: join(directory, 'report.json'),
  }),
)
