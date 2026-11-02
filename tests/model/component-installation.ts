// Opt-in full-size, publisher-pinned component installation through stock Main
// IPC. Only the native ZIP picker is controlled; extraction/probes/ASR are real.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, stat, statfs, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { AsrComponent } from '../../src/main/asr-component'
import { KNOWN_BUNDLES } from '../../src/main/component-installation/catalog'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import type {
  ComponentInstallationState,
  ComponentProfile,
} from '../../src/shared/component-installation'
import type { TranscriptRequest } from '../../src/shared/transcript'
import { closeOwnedElectron } from './electron-lifecycle'

const options: Record<string, string> = {}
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index],
    value = process.argv[index + 1]
  assert(
    name &&
      ['--app-root', '--component', '--archive', '--output', '--user-data'].includes(name) &&
      value,
  )
  assert.equal(options[name], undefined, `Duplicate ${name}`)
  options[name] = value
}
assert(options['--app-root'], 'Pass the frozen preview with --app-root.')
const appRoot = resolve(options['--app-root']),
  externalPath = resolve(
    options['--component'] ?? 'release/PageEcho-ASR-0.8.0-sec.1-win-x64/component.json',
  ),
  archivePath = resolve(options['--archive'] ?? 'release/PageEcho-ASR-0.8.0-sec.1-win-x64.zip'),
  directory = resolve(
    options['--output'] ??
      join(
        'cache/optimization/component-installation-main-runs',
        new Date().toISOString().replaceAll(':', '-'),
      ),
  )
await mkdir(dirname(directory), { recursive: true })
await mkdir(directory) // Never reuse an existing installed state or its receipts.
await copyFile(
  resolve('tests/model/component-installation.ts'),
  join(directory, 'runner-started.ts'),
)
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
async function hash(path: string) {
  const result = createHash('sha256')
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 }))
    result.update(chunk)
  return result.digest('hex')
}
const report: Record<string, unknown> = {
  status: 'preparing',
  startedAt: new Date().toISOString(),
  directory,
  appRoot,
  scope:
    'Real known ZIP, stock Main IPC/core/catalog/default import-and-file preflight, explicit activation, one real Paraformer CPU1 30-second job, muted media/subtitle clock, explicit external restoration and restart persistence. Only the native ZIP picker is controlled. No recognition-quality, timing-accuracy, CPU-percent, memory-limit or performance claim. Unrelated user processes and OS caches are not isolated or modified. The second engine is inspected only; no second installation.',
  stages: [],
  cleanups: [],
}
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
async function stage(name: string, extra: Record<string, unknown> = {}) {
  ;(report.stages as unknown[]).push({ name, at: new Date().toISOString(), ...extra })
  await save()
  console.log(JSON.stringify({ stage: name, ...extra }))
}
const buildManifestPath = resolve(appRoot, '../manifest.json'),
  build = JSON.parse(await readFile(buildManifestPath, 'utf8'))
assert.equal(build.status, 'built')
for (const [path, value] of Object.entries(build.outputHashes))
  assert.equal(await hash(join(appRoot, 'out', path)), value)
for (const [path, value] of Object.entries(build.pythonHashes))
  assert.equal(await hash(join(appRoot, 'python', path)), value)
report.previewVersion = build.previewVersion
report.buildManifestPath = buildManifestPath
report.buildManifestSha256 = await hash(buildManifestPath)
report.runnerSha256 = await hash(join(directory, 'runner-started.ts'))
const archiveBytes = (await stat(archivePath)).size,
  archiveSha256 = await hash(archivePath),
  matchedBundle = KNOWN_BUNDLES.find(
    (value) => value.archiveBytes === archiveBytes && value.archiveSha256 === archiveSha256,
  )
assert(matchedBundle, 'The requested ZIP must exactly match a publisher-pinned catalog entry.')
const bundle = matchedBundle
report.archive = { path: archivePath, ...bundle }
const userData = options['--user-data']
  ? resolve(options['--user-data'])
  : join(directory, 'user-data')
if (options['--user-data']) await mkdir(userData) // Explicit native path must also be fresh.
const paths = createDataPaths(userData),
  settingsPath = join(paths.root, 'asr-component.json'),
  component = new AsrComponent(settingsPath, join(appRoot, 'python/asr_worker.py'))
await component.configure(externalPath)
const external = component.describe()!,
  originalSettings = await readFile(settingsPath),
  referenceManifestPath = resolve(
    'cache/asr-evaluation/public-reference/aishell4-continuous/manifest.json',
  ),
  reference = JSON.parse(await readFile(referenceManifestPath, 'utf8')),
  sample = reference.samples.find((value: { id: string }) => value.id === 'continuous-solo-first')
assert.equal(reference.referenceKind, 'human-continuous')
assert.equal(await hash(sample.path), sample.audioHash)
const clipPath = join(directory, 'aishell4-first-30s.wav'),
  durationMs = 30_000
execFileSync(
  external.ffmpeg,
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-i',
    sample.path,
    '-t',
    '30',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    clipPath,
  ],
  { windowsHide: true, timeout: 30000 },
)
const measuredMs =
  Number(
    execFileSync(
      external.ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', clipPath],
      { encoding: 'utf8', windowsHide: true },
    ).trim(),
  ) * 1000
assert.equal(measuredMs, durationMs)
const store = new LibraryStore(paths.database)
store.importBook(await scanBook(clipPath, 'file'))
const episode = store.listBooks()[0]!.episodes[0]!,
  target: TranscriptRequest = { episodeId: episode.id, audioHash: episode.contentHash }
store.recordSourceDuration(episode.id, episode.contentHash, durationMs)
store.setProcessingPolicy({
  revision: store.processingResources().revision,
  policy: { cpuThreads: 1, lowPriority: true, backgroundIdleOnly: false },
})
store.saveProgress({
  sessionId: '',
  episodeId: episode.id,
  positionMs: 0,
  durationMs,
  rate: 1,
  volume: 0,
})
store.close()
const protectedPaths = [
    externalPath,
    external.models,
    referenceManifestPath,
    sample.path,
    clipPath,
    buildManifestPath,
  ],
  protectedBefore = Object.fromEntries(
    await Promise.all(protectedPaths.map(async (path) => [path, await hash(path)])),
  )
report.input = {
  referenceManifestPath,
  referenceManifestSha256: await hash(referenceManifestPath),
  referenceKind: reference.referenceKind,
  source: reference.source,
  qualityScope: reference.qualityScope,
  originalSample: sample,
  clipPath,
  clipSha256: await hash(clipPath),
  clipRangeMs: [0, durationMs],
  durationMs,
}
report.external = {
  configuration: externalPath,
  configurationSha256: await hash(externalPath),
  settingsSha256: digest(originalSettings),
  paths: external,
}
report.protectedBefore = protectedBefore
report.userData = paths.root
report.target = target
const managedRoot = join(paths.root, 'c'),
  profile: ComponentProfile = { engine: 'paraformer', device: 'cpu' },
  env = { ...process.env, RALB_USER_DATA: paths.root }
// Independent planning only. Main still verifies the archive and computes its
// own profile plan; neither this manifest nor these numbers are sent over IPC.
const manifestBytes = execFileSync(
    external.python,
    [
      '-B',
      '-X',
      'utf8',
      '-c',
      'import sys,zipfile;sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read("bundle-manifest.json"))',
      archivePath,
    ],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 30000 },
  ),
  manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    files: { path: string; bytes: number }[]
  }
assert.equal(digest(manifestBytes), bundle.manifestSha256)
await writeFile(join(directory, 'trusted-bundle-manifest.json'), manifestBytes)
const roles = new Set(['paraformer', 'vad', 'punctuation', 'alignment']),
  selectedFiles = manifest.files.filter(
    (file) => !file.path.startsWith('models/') || roles.has(file.path.split('/')[1]!),
  ),
  expectedRequiredBytes = selectedFiles.reduce((sum, file) => sum + file.bytes, 0),
  nativePaths = selectedFiles
    .filter((file) => /\.(dll|pyd|exe)$/iu.test(file.path))
    .map((file) =>
      join(
        managedRoot,
        'a',
        bundle.archiveSha256.slice(0, 12),
        's',
        '0'.repeat(16),
        ...file.path.split('/'),
      ),
    ),
  longestNativePath = nativePaths.reduce(
    (longest, path) => (path.length > longest.length ? path : longest),
    '',
  )
report.independentPlan = {
  expectedRequiredBytes,
  selectedFiles: selectedFiles.length,
  longestNativePath,
  longestNativePathCharacters: longestNativePath.length,
  maximumAllowedNativePathCharacters: 240,
}
assert(
  longestNativePath.length <= 240,
  'Use a shorter explicit output or user-data path; do not bypass the native path guard.',
)
for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'RALB_EXECUTABLE'])
  Reflect.deleteProperty(env, name)
let app: ElectronApplication | undefined
const errors: string[] = []
async function launch() {
  const owned = await electron.launch({ args: [appRoot], env })
  const page = await owned.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.context().setOffline(true)
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeEnabled()
  return { owned, page }
}
async function installation(page: Page) {
  const result = await page.evaluate(() => window.desktop.getComponentInstallations())
  assert(result.ok, result.ok ? undefined : result.error.message)
  return result.value
}
async function waitInstallation(
  page: Page,
  label: string,
  predicate: (state: ComponentInstallationState) => boolean,
  timeoutMs = 900000,
) {
  const deadline = Date.now() + timeoutMs
  let lastLog = 0
  do {
    const value = await installation(page)
    appendFileSync(
      join(directory, 'installation-samples.jsonl'),
      JSON.stringify({ label, at: new Date().toISOString(), ...value }) + '\n',
    )
    if (value.activity?.status === 'failed') throw new Error(`${label}: ${value.activity.error}`)
    if (predicate(value)) return value
    if (Date.now() - lastLog > 15000) {
      console.log(JSON.stringify({ waiting: label, activity: value.activity }))
      lastLog = Date.now()
    }
    await delay(500)
  } while (Date.now() < deadline)
  throw new Error(`Timed out: ${label}`)
}
async function picker(owned: ElectronApplication) {
  await owned.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, archivePath)
}
async function transcript(page: Page) {
  return page.evaluate(async (input) => {
    const state = await window.desktop.getTranscriptionState(input),
      resources = await window.desktop.getProcessingResources()
    if (!state.ok) throw new Error(state.error.message)
    if (!resources.ok) throw new Error(resources.error.message)
    const audio = document.querySelector<HTMLAudioElement>('audio[data-player="persistent"]')!
    return {
      state: state.value,
      resources: resources.value,
      media: {
        positionMs: audio.currentTime * 1000,
        paused: audio.paused,
        ended: audio.ended,
        volume: audio.volume,
      },
    }
  }, target)
}
interface ProcessInfo {
  id: number
  parentId: number
  name: string
  created: string
}
function ownedTree(pid: number): ProcessInfo[] {
  assert(Number.isSafeInteger(pid) && pid > 0)
  const script = `$rows=@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{id=[int]$_.ProcessId;parentId=[int]$_.ParentProcessId;name=$_.Name;created=[string]$_.CreationDate} }); $ids=[Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${pid}); do { $added=$false; foreach($row in $rows) { if($ids.Contains($row.parentId) -and $ids.Add($row.id)) { $added=$true } } } while($added); ConvertTo-Json -InputObject @($rows | Where-Object { $ids.Contains($_.id) }) -Compress`
  return JSON.parse(
    execFileSync(
      join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      ['-NoProfile', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 },
    ),
  ) as ProcessInfo[]
}
async function verifyInstalledFiles(id: string) {
  const folder = join(managedRoot, 'receipts', id),
    receipt = JSON.parse(await readFile(join(folder, 'receipt.json'), 'utf8')),
    manifestPath = join(folder, 'bundle-manifest.json'),
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      files: { path: string; bytes: number; sha256: string }[]
    },
    generated = JSON.parse(await readFile(join(folder, 'component.json'), 'utf8')),
    models = JSON.parse(await readFile(generated.models, 'utf8'))
  assert.equal(await hash(manifestPath), bundle.manifestSha256)
  assert.deepEqual(Object.keys(receipt.assets).sort(), [
    'alignment',
    'paraformer',
    'punctuation',
    'shared',
    'vad',
  ])
  assert.deepEqual(Object.keys(models.models).sort(), [
    'alignment',
    'paraformer',
    'punctuation',
    'vad',
  ])
  const groups = await readdir(join(managedRoot, 'a', bundle.archiveSha256.slice(0, 12)))
  assert.equal(
    groups.length,
    5,
    'Only shared runtime and the four selected model groups may be extracted.',
  )
  for (const asset of Object.values(receipt.assets) as string[]) {
    assert.match(asset, new RegExp(`^a/${bundle.archiveSha256.slice(0, 12)}/[a-z]/[a-f0-9]{16}$`))
  }
  assert.equal((await readdir(join(managedRoot, 'staging'))).length, 0)
  const selected = manifest.files.filter(
    (file) =>
      !file.path.startsWith('models/') || Object.hasOwn(receipt.assets, file.path.split('/')[1]!),
  )
  let cursor = 0,
    bytes = 0,
    checked = 0
  const start = Date.now()
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (;;) {
        const file = selected[cursor++]
        if (!file) return
        const role = file.path.startsWith('models/') ? file.path.split('/')[1]! : 'shared',
          path = join(managedRoot, receipt.assets[role], file.path),
          info = await stat(path)
        assert.equal(info.size, file.bytes, path)
        assert.equal(await hash(path), file.sha256, path)
        bytes += file.bytes
        checked++
        appendFileSync(
          join(directory, 'verified-installed-files.jsonl'),
          JSON.stringify({ role, path: file.path, bytes: file.bytes, sha256: file.sha256 }) + '\n',
        )
      }
    }),
  )
  assert.equal(bytes, receipt.bytes)
  await copyFile(join(folder, 'receipt.json'), join(directory, 'managed-receipt.json'))
  await copyFile(generated.models, join(directory, 'managed-models.json'))
  await copyFile(join(folder, 'component.json'), join(directory, 'managed-component.json'))
  return {
    receipt,
    generated,
    modelManifest: models,
    groups,
    checkedFiles: checked,
    checkedBytes: bytes,
    elapsedMs: Date.now() - start,
    inventorySha256: await hash(join(directory, 'verified-installed-files.jsonl')),
    manifestSha256: await hash(manifestPath),
  }
}
try {
  report.status = 'running'
  const disk = await statfs(paths.root)
  assert(disk.bavail * disk.bsize > expectedRequiredBytes + 2 * 1024 ** 3)
  await stage('prepared', {
    freeBytes: disk.bavail * disk.bsize,
    previewVersion: build.previewVersion,
  })
  let launched = await launch()
  app = launched.owned
  let page = launched.page
  await picker(app)
  const selected = await page.evaluate(
    (choice) => window.desktop.chooseComponentPackage(choice),
    profile,
  )
  assert(selected.ok && !selected.value.canceled && selected.value.state.activity)
  const operationId = selected.value.state.activity.id
  const ready = await waitInstallation(
    page,
    'known-package-inspected',
    (value) => value.activity?.status === 'ready',
  )
  assert.equal(ready.activity!.version, bundle.version)
  assert.equal(ready.activity!.requiredBytes, expectedRequiredBytes)
  assert.deepEqual(await readFile(settingsPath), originalSettings)
  assert.deepEqual(ready.installations, [])
  await writeFile(join(directory, 'ready-plan.json'), JSON.stringify(ready, null, 2))
  await stage('ready-original-still-active', {
    operationId,
    requiredBytes: ready.activity!.requiredBytes,
    freeBytes: ready.activity!.freeBytes,
  })
  const installStartedAt = Date.now(),
    started = await page.evaluate(
      (id) => window.desktop.startComponentInstallation({ id }),
      operationId,
    )
  assert(started.ok)
  const installed = await waitInstallation(
    page,
    'real-extraction-and-default-preflight',
    (value) => value.activity?.status === 'installed',
  )
  const managed = installed.installations.find((value) => value.managed)!
  assert(managed && !managed.active)
  assert.deepEqual(await readFile(settingsPath), originalSettings)
  assert.equal(installed.activity!.installedId, managed.id)
  report.installed = installed
  await stage('installed-probed-without-activation', {
    elapsedMs: Date.now() - installStartedAt,
    managedId: managed.id,
    state: installed,
  })
  const activated = await page.evaluate(
    (id) => window.desktop.activateComponentInstallation({ id }),
    managed.id,
  )
  assert(activated.ok, activated.ok ? undefined : activated.error.message)
  const recovery = activated.value.installations.find((value) => !value.managed)!
  assert(recovery)
  assert.equal(activated.value.installations.find((value) => value.id === managed.id)?.active, true)
  assert.equal(recovery.active, false)
  const activeSettings = JSON.parse(await readFile(settingsPath, 'utf8'))
  assert(activeSettings.python.startsWith(managedRoot))
  assert.notEqual(digest(await readFile(settingsPath)), digest(originalSettings))
  report.activated = {
    state: activated.value,
    settings: activeSettings,
    settingsSha256: await hash(settingsPath),
  }
  await stage('explicitly-activated-managed-version', {
    managedId: managed.id,
    recoveryId: recovery.id,
  })
  await page.getByRole('button', { name: '播放', exact: true }).click()
  const mediaBefore = (await transcript(page)).media
  assert.equal(mediaBefore.paused, false)
  assert.equal(mediaBefore.volume, 0)
  const asrStarted = await page.evaluate((input) => window.desktop.startTranscription(input), {
    ...target,
    ...profile,
  })
  assert(asrStarted.ok && asrStarted.value.job)
  assert.equal(asrStarted.value.job.cpuThreads, 1)
  let completed: Awaited<ReturnType<typeof transcript>> | undefined,
    live: Awaited<ReturnType<typeof transcript>> | undefined
  const deadline = Date.now() + 240000
  do {
    const value = await transcript(page)
    appendFileSync(
      join(directory, 'asr-samples.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n',
    )
    if (value.state.job && ['failed', 'canceled'].includes(value.state.job.status))
      throw new Error(`Real ASR ${value.state.job.status}: ${value.state.job.error}`)
    if (value.resources.worker?.cpuThreads === 1 && !live) {
      live = value
      report.ownedWorkerTree = ownedTree(value.resources.worker.pid)
      await stage('managed-runtime-running-real-model', { worker: value.resources.worker })
    }
    if (value.state.job?.status === 'completed') {
      completed = value
      break
    }
    await delay(250)
  } while (Date.now() < deadline)
  assert(completed && live, 'Real model must report its threads and finish.')
  assert.equal(completed.state.job!.cpuThreads, 1)
  assert.equal(completed.state.transcript.status, 'ready')
  if (completed.state.transcript.status !== 'ready')
    throw new Error('No adopted subtitle document.')
  assert(completed.state.transcript.transcript.document.segments.length > 0)
  assert.deepEqual(completed.state.transcript.transcript.document.coverage, [
    { startMs: 0, endMs: durationMs },
  ])
  assert(completed.media.positionMs > mediaBefore.positionMs + 250)
  await page.getByRole('button', { name: '伴读阅读', exact: true }).click()
  const reader = page.getByRole('region', { name: '同步伴读', exact: true })
  await expect(reader.locator('.transcript-sentence').first()).toBeVisible()
  if (!completed.media.paused) await page.getByRole('button', { name: '暂停', exact: true }).click()
  await reader.locator('.transcript-sentence').first().click()
  await expect(reader.locator('.transcript-sentence[aria-current="true"]')).not.toHaveCount(0)
  const subtitleClock = await transcript(page)
  assert.equal(subtitleClock.media.paused, true)
  const firstSentence = completed.state.transcript.transcript.document.segments[0]!
  assert(
    subtitleClock.media.positionMs >= firstSentence.startMs &&
      subtitleClock.media.positionMs <= firstSentence.endMs,
  )
  report.asr = {
    job: completed.state.job,
    liveResources: live.resources,
    mediaBefore,
    mediaAfter: completed.media,
    subtitleClock: subtitleClock.media,
    transcriptSha256: digest(JSON.stringify(completed.state.transcript)),
    segments: completed.state.transcript.transcript.document.segments.length,
  }
  await writeFile(
    join(directory, 'completed-transcription.json'),
    JSON.stringify(completed, null, 2),
  )
  await page.screenshot({
    path: join(directory, 'managed-model-subtitle-clock.png'),
    animations: 'disabled',
  })
  await stage('real-paraformer-cpu1-completed-subtitle-clock', {
    jobId: completed.state.job!.id,
    mediaAfter: completed.media,
    subtitleClock: subtitleClock.media,
  })
  const restored = await page.evaluate(
    (id) => window.desktop.activateComponentInstallation({ id }),
    recovery.id,
  )
  assert(restored.ok, restored.ok ? undefined : restored.error.message)
  assert.equal(restored.value.installations.find((value) => value.id === recovery.id)?.active, true)
  assert.equal(restored.value.installations.find((value) => value.id === managed.id)?.active, false)
  assert.deepEqual(await readFile(settingsPath), originalSettings)
  const afterRestore = await transcript(page)
  assert.equal(afterRestore.resources.worker, null)
  assert.deepEqual(ownedTree(live.resources.worker!.pid), [])
  report.restored = restored.value
  await stage('external-restored-and-owned-model-worker-exited')
  ;(report.cleanups as unknown[]).push(await closeOwnedElectron(app))
  app = undefined
  launched = await launch()
  app = launched.owned
  page = launched.page
  const restarted = await installation(page)
  assert.equal(restarted.installations.length, 2)
  assert.equal(restarted.installations.find((value) => value.id === recovery.id)?.active, true)
  assert.equal(restarted.installations.find((value) => value.id === managed.id)?.active, false)
  assert.deepEqual(await readFile(settingsPath), originalSettings)
  report.restarted = restarted
  await stage('restart-keeps-versions-and-external-active')
  report.installedIntegrity = await verifyInstalledFiles(managed.id)
  await stage('all-managed-files-independently-hashed', {
    files: (report.installedIntegrity as { checkedFiles: number }).checkedFiles,
    bytes: managed.bytes,
  })
  await picker(app)
  const second = await page.evaluate(() =>
    window.desktop.chooseComponentPackage({ engine: 'whisperx', device: 'cpu' }),
  )
  assert(second.ok && !second.value.canceled)
  const incremental = await waitInstallation(
    page,
    'second-engine-incremental-inspect-only',
    (value) => value.activity?.status === 'ready',
  )
  const manifest = JSON.parse(
      await readFile(join(managedRoot, 'receipts', managed.id, 'bundle-manifest.json'), 'utf8'),
    ) as { files: { path: string; bytes: number }[] },
    whisperBytes = manifest.files
      .filter((file) => file.path.startsWith('models/whisper/'))
      .reduce((sum, file) => sum + file.bytes, 0)
  assert(whisperBytes > 0 && whisperBytes < 2 * 1024 ** 3)
  assert.equal(incremental.activity!.requiredBytes, whisperBytes)
  assert.deepEqual(await readFile(settingsPath), originalSettings)
  const canceled = await page.evaluate(
    (id) => window.desktop.cancelComponentInstallation({ id }),
    incremental.activity!.id,
  )
  assert(canceled.ok)
  report.secondEngine = {
    scope: 'inspect-only; explicit start never called',
    requiredBytes: whisperBytes,
    state: incremental,
  }
  await stage('second-engine-only-whisper-would-be-added', { requiredBytes: whisperBytes })
  assert.equal((await readdir(join(managedRoot, 'a', bundle.archiveSha256.slice(0, 12)))).length, 5)
  for (const [path, expected] of Object.entries(protectedBefore))
    assert.equal(await hash(path), expected)
  assert.equal(await hash(archivePath), bundle.archiveSha256)
  assert.deepEqual(errors, [])
  report.rendererErrors = errors
  ;(report.cleanups as unknown[]).push(await closeOwnedElectron(app))
  app = undefined
  assert((report.cleanups as { kind: string }[]).every((value) => value.kind === 'graceful'))
  assert.deepEqual(ownedTree(live.resources.worker!.pid), [])
  report.status = 'passed'
  report.finishedAt = new Date().toISOString()
  await stage('passed')
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
  report.finishedAt = new Date().toISOString()
  await save()
  throw error
} finally {
  if (app) {
    ;(report.cleanups as unknown[]).push(await closeOwnedElectron(app))
    await save()
  }
}
