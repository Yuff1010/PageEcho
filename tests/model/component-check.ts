import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { AsrComponent } from '../../src/main/asr-component'
import { ComponentSetup, componentDiscoveryRoots } from '../../src/main/component-setup'

const [componentPath, outputPath] = process.argv.slice(2)
if (!componentPath || !outputPath)
  throw new Error('Usage: tsx tests/model/component-check.ts <component.json> <report.json>')
const started = performance.now()
const root = await mkdtemp(join(tmpdir(), 'ralb-component-check-'))
const component = new AsrComponent(
  join(root, 'asr-component.json'),
  resolve('python/asr_worker.py'),
)
const setup = new ComponentSetup(
  component,
  componentDiscoveryRoots(resolve('.'), dirname(resolve(componentPath))),
)
const detected = await setup.detect()
const match = detected.candidates.find(
  (candidate) => candidate.configPath.toLowerCase() === resolve(componentPath).toLowerCase(),
)
if (!match?.available)
  throw new Error('The requested local component was not discovered as available')
await setup.useCandidate(match.id)
const checked = await setup.check()
const automaticPreflight = []
for (const capability of checked.capabilities) {
  if (!capability.available) continue
  const preflightStarted = performance.now()
  await setup.ensureRuntime(
    component.runtime(capability.engine, capability.device),
    new AbortController().signal,
  )
  automaticPreflight.push({
    engine: capability.engine,
    device: capability.device,
    elapsedMs: Math.round(performance.now() - preflightStarted),
    status: 'passed',
  })
}
setup.close()
const report = {
  status: checked.ready ? 'passed' : 'failed',
  checkedAt: new Date().toISOString(),
  elapsedMs: Math.round(performance.now() - started),
  componentPath: match.configPath,
  discovered: detected.candidates,
  check: checked,
  automaticPreflight,
  scope:
    'Offline imports, pinned file/device/tools/cache checks; weights not loaded and inference quality not assessed.',
  inputHashes: Object.fromEntries(
    await Promise.all(
      [componentPath, component.probeScript, component.describe()!.models].map(async (path) => [
        resolve(path),
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ]),
    ),
  ),
}
await mkdir(dirname(resolve(outputPath)), { recursive: true })
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n')
console.log(
  JSON.stringify({
    status: report.status,
    elapsedMs: report.elapsedMs,
    report: resolve(outputPath),
  }),
)
if (!checked.ready) process.exitCode = 1
