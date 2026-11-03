// Opt-in real worker verification for a pinned, published human-reference subset.
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AsrComponent } from '../../src/main/asr-component'
import { AsrProcessError, AsrWorkerProcess, type AsrRuntime } from '../../src/main/asr-process'

const args = process.argv.slice(2)
let continuous = false
let studio = false
let filmManifest = ''
let componentPath = '',
  engine: AsrRuntime['engine'] = 'whisperx',
  device: AsrRuntime['device'] = 'cuda'
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--component' && args[index + 1]) componentPath = resolve(args[++index]!)
  else if (args[index] === '--engine' && ['whisperx', 'paraformer'].includes(args[index + 1] ?? ''))
    engine = args[++index] as AsrRuntime['engine']
  else if (args[index] === '--cpu') device = 'cpu'
  else if (args[index] === '--continuous') continuous = true
  else if (args[index] === '--studio') studio = true
  else if (args[index] === '--film' && args[index + 1]) filmManifest = resolve(args[++index]!)
  else
    throw new Error(
      '支持 --component 路径、--engine whisperx/paraformer、--cpu、--continuous、--studio、--film 清单。',
    )
}
if (!componentPath) throw new Error('需要 --component 指定本地组件。')
if ([continuous, studio, !!filmManifest].filter(Boolean).length > 1)
  throw new Error('连续、干声与影视参考集请分别运行。')
const directory = resolve(
  filmManifest
    ? 'cache/asr-evaluation/film-worker-runs'
    : studio
      ? 'cache/asr-evaluation/studio-worker-runs'
      : continuous
        ? 'cache/asr-evaluation/continuous-worker-runs'
        : 'cache/asr-evaluation/public-worker-runs',
  `${new Date().toISOString().replaceAll(':', '-')}-${engine}-${device}`,
)
await mkdir(directory, { recursive: true })
await copyFile(resolve('tests/model/public-reference.ts'), join(directory, 'runner-started.ts'))
const component = new AsrComponent(
  join(directory, 'component.json'),
  resolve('python/asr_worker.py'),
)
await component.configure(componentPath)
const runtime = component.runtime(engine, device)
const manifestPath = resolve(
  filmManifest ||
    (studio
      ? 'cache/asr-evaluation/public-reference/aishell3-studio/manifest.json'
      : continuous
        ? 'cache/asr-evaluation/public-reference/aishell4-continuous/manifest.json'
        : 'cache/asr-evaluation/public-reference/aishell4/manifest.json'),
)
await promisify(execFile)(
  runtime.python,
  [
    '-B',
    '-X',
    'utf8',
    '-c',
    filmManifest
      ? 'import sys; sys.path.insert(0, sys.argv[1]); from chsims_reference import load_film_manifest; load_film_manifest(sys.argv[2])'
      : studio
        ? 'import sys; sys.path.insert(0, sys.argv[1]); from studio_reference import load_studio_manifest; load_studio_manifest(sys.argv[2], tool_overrides={"ffmpeg": sys.argv[3], "ffprobe": sys.argv[4]})'
        : continuous
          ? 'import sys; sys.path.insert(0, sys.argv[1]); from continuous_reference import load_continuous_manifest; load_continuous_manifest(sys.argv[2])'
          : 'import sys; sys.path.insert(0, sys.argv[1]); from public_reference import load_reference_manifest; load_reference_manifest(sys.argv[2])',
    resolve('python'),
    manifestPath,
    ...(studio ? [runtime.ffmpeg, runtime.ffprobe] : []),
  ],
  { windowsHide: true, timeout: 30000 },
)
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
  samples: { id: string; path: string; audioHash: string; speaker?: string; sourceVideo?: string }[]
}
const report: {
  status: string
  engine: string
  device: string
  manifestPath: string
  manifestSha256: string
  referenceKind: 'human-continuous' | 'human-isolated' | 'human-studio-text' | 'human-film-text'
  startedAt: string
  finishedAt?: string
  runnerSha256: string
  samples: Record<string, unknown>[]
  configuration?: unknown
  error?: string
  restartCheckpointReused?: boolean
} = {
  status: 'running',
  startedAt: new Date().toISOString(),
  runnerSha256: createHash('sha256')
    .update(await readFile(join(directory, 'runner-started.ts')))
    .digest('hex'),
  engine,
  device,
  manifestPath,
  manifestSha256: createHash('sha256')
    .update(await readFile(manifestPath))
    .digest('hex'),
  referenceKind: filmManifest
    ? 'human-film-text'
    : studio
      ? 'human-studio-text'
      : continuous
        ? 'human-continuous'
        : 'human-isolated',
  samples: [],
}
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2))
await save()
let worker = new AsrWorkerProcess(runtime)
try {
  await worker.ready
  report.configuration = worker.configuration
  for (const sample of manifest.samples) {
    const started = performance.now()
    const measured: Record<string, unknown> = {
      id: sample.id,
      audioHash: sample.audioHash,
      speaker: sample.speaker,
      sourceVideo: sample.sourceVideo,
      status: 'running',
    }
    report.samples.push(measured)
    try {
      const jobId = randomUUID()
      let firstReadablePartialMs: number | null = null
      const result = await worker.submit(
        {
          jobId,
          attempt: 1,
          audioPath: sample.path,
          audioHash: sample.audioHash,
          range: { startMs: 0, endMs: null },
        },
        (event) => {
          if (event.type === 'partial' && event.document.segments.length)
            firstReadablePartialMs ??= performance.now() - started
        },
      )
      const generationMs = performance.now() - started
      if (result.status !== 'completed') throw new Error('Unexpected canceled result')
      if (result.cacheHits !== 0) throw new Error('A fresh diagnostic must not reuse checkpoints')
      const transcript = `${sample.id}.transcript.json`
      await writeFile(join(directory, transcript), JSON.stringify(result.document, null, 2))
      Object.assign(measured, {
        status: 'completed',
        transcript,
        cacheHits: result.cacheHits,
        totalChunks: result.totalChunks,
        durationMs: result.durationMs,
        cacheKey: result.cacheKey,
        generationMs,
        firstReadablePartialMs,
        issues: result.issues,
      })
      const replay = await worker.submit({
        jobId,
        attempt: 2,
        audioPath: sample.path,
        audioHash: sample.audioHash,
        range: { startMs: 0, endMs: null },
      })
      if (
        replay.status !== 'completed' ||
        replay.cacheHits !== replay.totalChunks ||
        JSON.stringify(replay.document) !== JSON.stringify(result.document) ||
        JSON.stringify(replay.issues) !== JSON.stringify(result.issues)
      )
        throw new Error('Checkpoint replay changed the transcript or realignment evidence')
      measured.replayCacheHits = replay.cacheHits
    } catch (error) {
      Object.assign(measured, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof AsrProcessError ? error.code : null,
      })
    }
    measured.elapsedMs = performance.now() - started
    await save()
    console.log(JSON.stringify({ id: sample.id, status: measured.status, code: measured.code }))
  }
  if (report.samples.every((sample) => sample.status === 'completed')) {
    await worker.close()
    await writeFile(join(directory, 'worker-first.log'), worker.diagnosticLog)
    worker = new AsrWorkerProcess(runtime)
    const sample = manifest.samples[0]!
    const restarted = await worker.submit({
      jobId: randomUUID(),
      attempt: 1,
      audioPath: sample.path,
      audioHash: sample.audioHash,
      range: { startMs: 0, endMs: null },
    })
    const saved = JSON.parse(
      await readFile(join(directory, `${sample.id}.transcript.json`), 'utf8'),
    )
    if (
      restarted.status !== 'completed' ||
      restarted.cacheHits !== restarted.totalChunks ||
      JSON.stringify(restarted.document) !== JSON.stringify(saved)
    )
      throw new Error('Restarted worker did not reuse the completed reference checkpoint')
    report.restartCheckpointReused = true
  }
  report.status = report.samples.every((sample) => sample.status === 'completed')
    ? 'passed'
    : 'failed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.message : String(error)
} finally {
  await worker.close()
  await writeFile(join(directory, 'worker.log'), worker.diagnosticLog)
  report.finishedAt = new Date().toISOString()
  await save()
}
if (report.status !== 'passed') process.exitCode = 1
console.log(JSON.stringify({ status: report.status, report: join(directory, 'report.json') }))
