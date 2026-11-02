// Opt-in acceptance of the publisher-pinned patched component. Uses a separate
// cache and existing public reference audio; never changes installed components.
import assert from 'node:assert/strict'
import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { AsrComponent } from '../../src/main/asr-component'
import { AsrWorkerProcess, type AsrEvent } from '../../src/main/asr-process'
import { KNOWN_BUNDLES } from '../../src/main/component-installation/catalog'

const args = process.argv.slice(2),
  options = new Map<string, string>()
for (let index = 0; index < args.length; index += 2) {
  const key = args[index]!,
    value = args[index + 1]
  assert(['--component', '--output', '--device'].includes(key) && value && !options.has(key))
  options.set(key, value)
}
assert(options.has('--component') && options.has('--output'))
const root = resolve(options.get('--component')!),
  output = resolve(options.get('--output')!)
const device = options.get('--device') ?? 'cpu'
assert(device === 'cpu' || device === 'cuda')
await mkdir(output) // A previous acceptance report must never be overwritten.
async function hash(path: string) {
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(path)) digest.update(bytes)
  return digest.digest('hex')
}
const report: Record<string, unknown> = {
  status: 'running',
  root,
  output,
  device,
  startedAt: new Date().toISOString(),
  runs: [],
  scope:
    'Real preflight, 30-second existing human-reference range, both engines and cache replay. No clean-device, broad quality or framework safety claim.',
}
try {
  const manifestSha = await hash(join(root, 'bundle-manifest.json'))
  const bundle = KNOWN_BUNDLES.find(
    (item) => !item.revokedReason && item.manifestSha256 === manifestSha,
  )
  assert(bundle, 'Component must match a currently installable publisher manifest')
  const manifest = JSON.parse(await readFile(join(root, 'bundle-manifest.json'), 'utf8'))
  const expectedVersions = {
    filelock: '4.2.1',
    'hydra-core': '1.3.8',
    nltk: '3.10.4',
    pillow: '13.0.0',
    setuptools: '84.1.0',
  }
  for (const [name, version] of Object.entries(expectedVersions))
    assert.equal(manifest.packages[name], version)
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  }
  environment.PATH = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32;${process.env.SystemRoot ?? 'C:\\Windows'}`
  delete environment.PYTHONHOME
  delete environment.PYTHONPATH
  const probe = await promisify(execFile)(
    join(root, 'python/python.exe'),
    [
      '-B',
      '-X',
      'utf8',
      resolve('python/asr_component_probe.py'),
      '--models',
      join(root, 'models.json'),
      '--cache',
      join(output, 'probe-cache'),
      '--resources',
      join(root, 'resources'),
      '--ffmpeg',
      join(root, 'tools/ffmpeg.exe'),
      '--ffprobe',
      join(root, 'tools/ffprobe.exe'),
    ],
    {
      env: environment,
      windowsHide: true,
      timeout: 180000,
      maxBuffer: 2 * 1024 ** 2,
      encoding: 'utf8',
    },
  )
  await writeFile(join(output, 'probe.stderr.log'), probe.stderr)
  report.probe = JSON.parse(probe.stdout)
  await writeFile(join(output, 'probe.json'), probe.stdout)
  for (const capability of (
    report.probe as { capabilities: { device: string; available: boolean }[] }
  ).capabilities)
    if (capability.device === device) assert(capability.available, JSON.stringify(report.probe))
  const referencePath = resolve(
    'cache/asr-evaluation/public-reference/aishell4-continuous/manifest.json',
  )
  const reference = JSON.parse(await readFile(referencePath, 'utf8'))
  const sample = reference.samples.find(
    (item: { id: string }) => item.id === 'continuous-solo-first',
  )
  assert(sample)
  assert.equal(await hash(sample.path), sample.audioHash)
  report.sample = {
    path: sample.path,
    audioHash: sample.audioHash,
    range: { startMs: 0, endMs: 30000 },
    manifestSha256: await hash(referencePath),
  }
  const component = new AsrComponent(
    join(output, 'component.json'),
    resolve('python/asr_worker.py'),
  )
  await component.configure(join(root, 'component.json'))
  process.env.PATH = environment.PATH
  delete process.env.PYTHONHOME
  delete process.env.PYTHONPATH
  for (const engine of ['paraformer', 'whisperx'] as const) {
    const folder = join(output, engine)
    await mkdir(folder)
    const worker: AsrWorkerProcess = new AsrWorkerProcess({
      ...component.runtime(engine, device),
      cache: join(folder, 'cache'),
      cpuThreads: 1,
      lowPriority: true,
    })
    const child = Reflect.get(worker, 'child') as ChildProcessWithoutNullStreams
    child.stdout.on('data', (data: Buffer) => appendFileSync(join(folder, 'stdout.jsonl'), data))
    child.stderr.on('data', (data: Buffer) => appendFileSync(join(folder, 'stderr.log'), data))
    const run: Record<string, unknown> = { engine, startedAt: new Date().toISOString() }
    ;(report.runs as unknown[]).push(run)
    const timer = setTimeout(() => {
      void worker.close()
    }, 300000)
    try {
      await worker.ready
      run.configuration = worker.configuration
      assert.equal(
        worker.configuration!.componentSecurity,
        'compatible-component-patch-floor-2026-11-02-v1',
      )
      assert.equal(
        worker.configuration!.modelIntegrity,
        await hash(resolve('python/asr-model-integrity.json')),
      )
      const request = {
        jobId: randomUUID(),
        attempt: 1,
        audioPath: sample.path,
        audioHash: sample.audioHash,
        range: { startMs: 0, endMs: 30000 },
        priorityMs: 0,
      }
      const events: AsrEvent[] = [],
        started = performance.now()
      const cold = await worker.submit(request, (event) => events.push(event))
      assert(cold.status === 'completed')
      assert.equal(cold.cacheHits, 0)
      assert(cold.document.segments.length > 0)
      assert.deepEqual(cold.document.coverage, [{ startMs: 0, endMs: 30000 }])
      run.coldWallMs = Math.round(performance.now() - started)
      run.cold = cold
      run.events = events
      const replayEvents: AsrEvent[] = []
      const replay = await worker.submit({ ...request, jobId: randomUUID() }, (event) =>
        replayEvents.push(event),
      )
      assert(replay.status === 'completed')
      assert.equal(replay.cacheHits, 1)
      assert.equal(replay.cacheKey, cold.cacheKey)
      assert.deepEqual(replay.document, cold.document)
      assert(
        !replayEvents.some(
          (event) =>
            event.type === 'progress' &&
            ['loading', 'decoding', 'recognizing'].includes(event.stage),
        ),
      )
      run.replay = replay
      run.status = 'passed'
    } finally {
      clearTimeout(timer)
      await worker.close()
      await writeFile(join(folder, 'report.json'), JSON.stringify(run, null, 2))
    }
  }
  assert.equal(await hash(join(root, 'bundle-manifest.json')), manifestSha)
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.stack : String(error)
  process.exitCode = 1
}
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ status: report.status, output, error: report.error }))
