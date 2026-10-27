// Opt-in real CPU artifact acceptance. Never installs/copies managed model assets.
import assert from 'node:assert/strict'
import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { AsrComponent } from '../../src/main/asr-component'
import { AsrWorkerProcess, type AsrEvent, type AsrOutcome } from '../../src/main/asr-process'

const args = process.argv.slice(2),
  options = new Map<string, string>()
for (let i = 0; i < args.length; i += 2) {
  if (!['--phase', '--directory'].includes(args[i]!) || !args[i + 1] || options.has(args[i]!))
    throw new Error('Use --phase imports|models [--directory absolute-path]')
  options.set(args[i]!, args[i + 1]!)
}
const phase = options.get('--phase')
assert(['imports', 'models'].includes(phase!))
const output = resolve(
  options.get('--directory') ?? 'cache/optimization/cpu-component-acceptance-2026-10-23',
)
const componentRoot = resolve('release/asr-component-0.7.1-cpu.1-win-x64')
const legacyRoot = resolve('release/asr-component-0.7.0-win-x64')
const python = join(componentRoot, 'python', 'python.exe')
const componentPath = join(componentRoot, 'component.json')
const manifestHash = 'f88c9095ddacc33ad2d1c21a19a6c073c064833481a4bfef85e54d5662ef2cbe'
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const hashFile = async (path: string) => sha(await readFile(path))
const sourcePaths = [
  resolve('tests/model/cpu-component.ts'),
  resolve('src/main/asr-process.ts'),
  resolve('src/main/asr-component.ts'),
  ...(await readdir(resolve('python')))
    .filter((name) => /^asr_.*\.py$/.test(name) || name === 'evaluation-models.json')
    .sort()
    .map((name) => resolve('python', name)),
]
const sourceHashes = Object.fromEntries(
  await Promise.all(sourcePaths.map(async (path) => [path, await hashFile(path)])),
)
const environment = { ...process.env }
environment.PATH = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32;${process.env.SystemRoot ?? 'C:\\Windows'}`
delete environment.PYTHONHOME
delete environment.PYTHONPATH
for (const key of [
  'OMP_NUM_THREADS',
  'MKL_NUM_THREADS',
  'OPENBLAS_NUM_THREADS',
  'NUMEXPR_NUM_THREADS',
])
  environment[key] = '1'
environment.PYTHONNOUSERSITE = '1'
environment.PYTHONDONTWRITEBYTECODE = '1'
const isolatedEnvironment = {
  PATH: environment.PATH,
  PYTHONHOME: null,
  PYTHONPATH: null,
  cpuThreads: 1,
}
assert.equal(await hashFile(join(componentRoot, 'bundle-manifest.json')), manifestHash)
const execute = promisify(execFile)

async function diagnostic(
  name: string,
  code: string,
  values: unknown,
  timeout = 180_000,
): Promise<Record<string, unknown>> {
  const argv = ['-B', '-X', 'utf8', '-c', code, JSON.stringify(values)]
  await writeFile(
    join(output, name + '.command.json'),
    JSON.stringify({ executable: python, argv, environment: isolatedEnvironment }, null, 2),
  )
  try {
    const result = await execute(python, argv, {
      cwd: output,
      env: environment,
      windowsHide: true,
      encoding: 'utf8',
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    })
    await writeFile(join(output, name + '.stdout.json'), result.stdout)
    await writeFile(join(output, name + '.stderr.log'), result.stderr)
    return JSON.parse(result.stdout) as Record<string, unknown>
  } catch (error) {
    const value = error as Error & { stdout?: string; stderr?: string }
    await writeFile(join(output, name + '.stdout.json'), value.stdout ?? '')
    await writeFile(join(output, name + '.stderr.log'), value.stderr ?? value.message)
    throw error
  }
}
async function integrity(name: string, root: string): Promise<Record<string, unknown>> {
  return diagnostic(
    name,
    `import sys,json\nfrom pathlib import Path\na=json.loads(sys.argv[1])\nsys.path.insert(0,a['scripts'])\nfrom component_bundle import verify_bundle\nprint(json.dumps(verify_bundle(a['root'])))`,
    { scripts: resolve('python'), root },
  )
}
async function sourcesUnchanged() {
  for (const path of sourcePaths)
    assert.equal(await hashFile(path), sourceHashes[path], `source changed: ${path}`)
}

if (phase === 'imports') {
  await mkdir(output)
  await mkdir(join(output, 'sources'))
  for (const path of sourcePaths)
    await writeFile(join(output, 'sources', basename(path)), await readFile(path))
  const report: Record<string, unknown> = {
    status: 'running',
    phase,
    preparedAt: new Date().toISOString(),
    sourceHashes,
    isolatedEnvironment,
    componentRoot,
    manifestHash,
    scope:
      'official CPU artifact isolated imports, default prerequisite probe and all-file integrity; no model inference or quality acceptance',
  }
  try {
    const imports = await diagnostic(
      'isolated-imports',
      `import sys,json\nfrom pathlib import Path\na=json.loads(sys.argv[1])\ninitial=list(sys.path)\nsys.path.insert(0,a['scripts'])\nfrom asr_runtime import configure_cache,configure_offline_network,protect_worker_process\nfrom asr_resources import configure_cpu_environment\nprotect_worker_process()\nconfigure_offline_network()\nconfigure_cpu_environment(1)\nconfigure_cache(a['cache'],a['tools'],a['resources'])\nimport torch,torchaudio,torchvision\nprint(json.dumps({'isolated':sys.flags.isolated,'initialSysPath':initial,'sysPath':sys.path,'executable':sys.executable,'torch':torch.__version__,'torchaudio':torchaudio.__version__,'torchvision':torchvision.__version__,'torchCudaVersion':torch.version.cuda,'cudaAvailable':torch.cuda.is_available(),'torchFile':torch.__file__,'torchaudioFile':torchaudio.__file__,'torchvisionFile':torchvision.__file__}))`,
      {
        scripts: resolve('python'),
        cache: join(output, 'imports-cache'),
        tools: join(componentRoot, 'tools'),
        resources: join(componentRoot, 'resources'),
      },
    )
    assert.equal(imports.isolated, 1)
    assert.equal(imports.torch, '2.8.0+cpu')
    assert.equal(imports.torchaudio, '2.8.0+cpu')
    assert.equal(imports.torchvision, '0.23.0+cpu')
    assert.equal(imports.torchCudaVersion, null)
    assert.equal(imports.cudaAvailable, false)
    for (const value of imports.initialSysPath as string[])
      assert(value.toLowerCase().startsWith(join(componentRoot, 'python').toLowerCase()))
    for (const name of ['torchFile', 'torchaudioFile', 'torchvisionFile'])
      assert((imports[name] as string).toLowerCase().startsWith(componentRoot.toLowerCase()))
    report.imports = imports
    const argv = [
      '-B',
      '-X',
      'utf8',
      resolve('python/asr_component_probe.py'),
      '--models',
      join(componentRoot, 'models.json'),
      '--cache',
      join(output, 'probe-cache'),
      '--resources',
      join(componentRoot, 'resources'),
      '--ffmpeg',
      join(componentRoot, 'tools/ffmpeg.exe'),
      '--ffprobe',
      join(componentRoot, 'tools/ffprobe.exe'),
    ]
    await writeFile(
      join(output, 'probe.command.json'),
      JSON.stringify({ executable: python, argv, environment: isolatedEnvironment }, null, 2),
    )
    const probeOutput = await execute(python, argv, {
      cwd: output,
      env: environment,
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8',
    })
    await writeFile(join(output, 'probe.stdout.json'), probeOutput.stdout)
    await writeFile(join(output, 'probe.stderr.log'), probeOutput.stderr)
    const probe = JSON.parse(probeOutput.stdout) as {
      capabilities: { engine: string; device: string; available: boolean }[]
    }
    assert.equal(probe.capabilities.length, 4)
    for (const capability of probe.capabilities)
      assert.equal(capability.available, capability.device === 'cpu')
    report.probe = probe
    report.componentIntegrity = await integrity('integrity-after-imports', componentRoot)
    await sourcesUnchanged()
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.error = error instanceof Error ? error.stack : String(error)
    process.exitCode = 1
  }
  await writeFile(join(output, 'imports.report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ status: report.status, phase, output, error: report.error }))
} else {
  const prior = JSON.parse(await readFile(join(output, 'imports.report.json'), 'utf8')) as {
    status: string
    sourceHashes: Record<string, string>
  }
  assert.equal(prior.status, 'passed')
  assert.deepEqual(sourceHashes, prior.sourceHashes)
  const manifestPath = resolve(
    'cache/asr-evaluation/public-reference/aishell4-continuous/manifest.json',
  )
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    samples: { id: string; path: string; audioHash: string; durationMs: number }[]
  }
  const sample = manifest.samples.find((item) => item.id === 'continuous-solo-first')!
  assert(sample)
  assert.equal(await hashFile(sample.path), sample.audioHash)
  const report: Record<string, unknown> = {
    status: 'running',
    phase,
    preparedAt: new Date().toISOString(),
    sourceHashes,
    componentRoot,
    manifestHash,
    isolatedEnvironment,
    sample: { ...sample, range: { startMs: 0, endMs: 30000 } },
    sourceManifestSha256: await hashFile(manifestPath),
    runs: [],
    scope:
      'one existing 30s public human-reference audio range per CPU engine, one cold inference and cache replay each; no new quality denominator or universal performance claim',
  }
  // AsrWorkerProcess inherits this environment; no user's running app is changed.
  process.env.PATH = environment.PATH
  delete process.env.PYTHONHOME
  delete process.env.PYTHONPATH
  for (const key of [
    'OMP_NUM_THREADS',
    'MKL_NUM_THREADS',
    'OPENBLAS_NUM_THREADS',
    'NUMEXPR_NUM_THREADS',
  ])
    process.env[key] = '1'
  try {
    const component = new AsrComponent(
      join(output, 'selected-component.json'),
      resolve('python/asr_worker.py'),
    )
    await component.configure(componentPath)
    for (const engine of ['paraformer', 'whisperx'] as const) {
      const folder = join(output, engine)
      await mkdir(folder)
      const runtime = {
        ...component.runtime(engine, 'cpu'),
        cache: join(folder, 'cache'),
        cpuThreads: 1 as const,
        lowPriority: true,
      }
      const worker = new AsrWorkerProcess(runtime),
        child = Reflect.get(worker, 'child') as ChildProcessWithoutNullStreams
      const pid = child.pid,
        run: Record<string, unknown> = { engine, runtime, pid, startedAt: new Date().toISOString() }
      ;(report.runs as unknown[]).push(run)
      child.stdout.on('data', (bytes: Buffer) =>
        appendFileSync(join(folder, 'stdout.jsonl'), bytes),
      )
      child.stderr.on('data', (bytes: Buffer) => appendFileSync(join(folder, 'stderr.log'), bytes))
      await writeFile(
        join(folder, 'command.json'),
        JSON.stringify(
          { executable: child.spawnfile, argv: child.spawnargs, environment: isolatedEnvironment },
          null,
          2,
        ),
      )
      const timeout = setTimeout(() => {
        run.timeout = true
        void worker.close()
      }, 240_000)
      try {
        await worker.ready
        run.configuration = worker.configuration
        const versions = worker.configuration!.versions as Record<string, string>
        assert.equal(versions.torch, '2.8.0+cpu')
        assert.equal(versions.torchaudio, '2.8.0+cpu')
        assert.equal(worker.configuration!.threads, 1)
        const request = {
          jobId: randomUUID(),
          attempt: 1,
          audioHash: sample.audioHash,
          audioPath: sample.path,
          range: { startMs: 0, endMs: 30000 },
          priorityMs: 0,
        }
        await writeFile(join(folder, 'request.json'), JSON.stringify(request, null, 2))
        const events: AsrEvent[] = [],
          started = performance.now()
        const cold = await worker.submit(request, (event) => events.push(event))
        assert.equal(cold.status, 'completed')
        const result = cold as Extract<AsrOutcome, { status: 'completed' }>
        assert.equal(result.cacheHits, 0)
        assert.equal(result.totalChunks, 1)
        assert.deepEqual(result.document.coverage, [{ startMs: 0, endMs: 30000 }])
        run.coldWallMs = Math.round(performance.now() - started)
        run.cold = cold
        run.events = events
        run.resources = worker.resources()
        assert.equal(worker.resources()!.cpuThreads, 1)
        assert.equal(worker.resources()!.priority, 'low')
        const replayEvents: AsrEvent[] = [],
          replayStarted = performance.now()
        const replay = await worker.submit({ ...request, jobId: randomUUID() }, (event) =>
          replayEvents.push(event),
        )
        assert.equal(replay.status, 'completed')
        if (replay.status !== 'completed') throw new Error('Cache replay canceled')
        assert.equal(replay.cacheHits, 1)
        assert.equal(replay.cacheKey, result.cacheKey)
        assert.deepEqual(replay.document, result.document)
        assert(
          !replayEvents.some(
            (event) =>
              event.type === 'progress' &&
              ['decoding', 'loading', 'recognizing'].includes(event.stage),
          ),
        )
        run.replay = replay
        run.replayWallMs = Math.round(performance.now() - replayStarted)
        run.replayEvents = replayEvents
        if (engine === 'paraformer') {
          const legacy = JSON.parse(
            await readFile(
              resolve('cache/optimization/asr-cpu-resources-2026-10-23/report.json'),
              'utf8',
            ),
          ) as { runs: { threads: number; coldResult: { cacheKey: string } }[] }
          const oldKey = legacy.runs.find((item) => item.threads === 1)!.coldResult.cacheKey
          assert.notEqual(result.cacheKey, oldKey)
          run.legacySameRangeThread1Key = oldKey
        }
        run.status = 'passed'
      } finally {
        clearTimeout(timeout)
        await worker.close()
        let exists = false
        if (pid) {
          try {
            process.kill(pid, 0)
            exists = true
          } catch {
            /* Owned process exited. */
          }
        }
        run.ownedWorkerExited = !exists
        assert.equal(exists, false)
        await writeFile(join(folder, 'report.json'), JSON.stringify(run, null, 2))
      }
    }
    report.cpuComponentIntegrity = await integrity('integrity-after-models', componentRoot)
    report.legacyComponentIntegrity = await integrity('legacy-integrity-after-models', legacyRoot)
    await sourcesUnchanged()
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.error = error instanceof Error ? error.stack : String(error)
    process.exitCode = 1
  }
  await writeFile(join(output, 'models.report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ status: report.status, phase, output, error: report.error }))
}
