import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  auditLongClock,
  parseJournal,
  type LongEvent,
  type LongSample,
} from '../tests/model/long-playback-analysis'

const args = process.argv.slice(2)
if (args.length !== 1)
  throw new Error('Usage: npm run test:audiobook:audit -- <long-run-directory>')
const directory = resolve(args[0]!)
const sourceReportText = await readFile(join(directory, 'report.json'), 'utf8')
const report = JSON.parse(sourceReportText.replace(/^\uFEFF/, '')) as {
  status: string
  userData: string
  mediaDurationMs: number
  runnerSha256: string
  lifecycleSha256?: string
  inputIsolationSha256?: string
  whole: { sha256: string; sizeBytes: number; sourcePath: string }
  next: { sha256: string; sizeBytes: number; sourcePath: string }
  sourceManifests: { path: string; sha256: string }[]
  buildHashes: { path: string; sha256: string }[]
  nativeWindowEvents: { visible: boolean; destroyed: boolean; wallMs: number; reason: string }[]
  originalsUnchanged?: boolean
  restartRestoredPaused?: boolean
  natural?: { nextPositionMs: number }
  cleanups?: { kind: string }[]
}
const running = report.status === 'running'
const hash = async (path: string) => {
  const digest = createHash('sha256')
  for await (const block of createReadStream(path)) digest.update(block)
  return digest.digest('hex')
}
const sampleText = await readFile(join(directory, 'clock-samples.jsonl'), 'utf8')
const eventText = await readFile(join(directory, 'media-events.json'), 'utf8')
const metricText = await readFile(join(directory, 'app-metrics.jsonl'), 'utf8')
const samples = parseJournal<LongSample>(sampleText, running)
const events = JSON.parse(eventText) as LongEvent[]
const clock = auditLongClock(
  samples.values,
  events,
  report.mediaDurationMs,
  report.whole.sha256,
  report.next.sha256,
)
const checks: Record<string, boolean> = { ...clock.checks }
for (const [index, file] of report.sourceManifests.entries())
  checks[`sourceManifest${index}`] = (await hash(file.path)) === file.sha256
for (const [index, file] of report.buildHashes.entries())
  checks[`buildFile${index}`] = (await hash(file.path)) === file.sha256
for (const [index, source] of [report.whole, report.next].entries())
  checks[`originalFile${index}`] =
    (await stat(source.sourcePath)).size === source.sizeBytes &&
    (await hash(source.sourcePath)) === source.sha256
checks.startedRunnerSnapshot =
  (await hash(join(directory, 'runner-started.ts'))) === report.runnerSha256
if (report.lifecycleSha256)
  checks.startedLifecycleSnapshot =
    (await hash(join(directory, 'lifecycle-started.ts'))) === report.lifecycleSha256
if (report.inputIsolationSha256)
  checks.startedInputIsolationSnapshot =
    (await hash(join(directory, 'input-isolation-started.ts'))) === report.inputIsolationSha256
const snapshots = parseJournal<{
  wallMs: number
  metrics: {
    pid: number
    type: string
    memory: { workingSetSize: number; privateBytes?: number }
  }[]
}>(metricText, running)
const perProcess = new Map<
  number,
  {
    pid: number
    type: string
    samples: number
    firstWorkingSetKB: number
    lastWorkingSetKB: number
    maximumWorkingSetKB: number
    firstPrivateKB: number | null
    lastPrivateKB: number | null
  }
>()
for (const snapshot of snapshots.values) {
  for (const metric of snapshot.metrics) {
    if (!Number.isFinite(metric.memory.workingSetSize) || metric.memory.workingSetSize < 0)
      throw new Error('Invalid memory sample')
    const current = perProcess.get(metric.pid) ?? {
      pid: metric.pid,
      type: metric.type,
      samples: 0,
      firstWorkingSetKB: metric.memory.workingSetSize,
      lastWorkingSetKB: 0,
      maximumWorkingSetKB: 0,
      firstPrivateKB: metric.memory.privateBytes ?? null,
      lastPrivateKB: null,
    }
    current.samples++
    current.lastWorkingSetKB = metric.memory.workingSetSize
    current.maximumWorkingSetKB = Math.max(
      current.maximumWorkingSetKB,
      metric.memory.workingSetSize,
    )
    current.lastPrivateKB = metric.memory.privateBytes ?? null
    perProcess.set(metric.pid, current)
  }
}
const mainPids = [...perProcess.values()]
  .filter((metric) => metric.type === 'Browser')
  .map((metric) => metric.pid)
checks.singleObservedMainProcess = mainPids.length === 1
const metricGaps = snapshots.values
  .slice(1)
  .map((snapshot, index) => snapshot.wallMs - snapshots.values[index]!.wallMs)
checks.resourceTimelineWhole =
  !!clock.firstPlayingWallMs &&
  !!clock.endedWallMs &&
  !!snapshots.values.length &&
  snapshots.values[0]!.wallMs <= clock.firstPlayingWallMs + 60000 &&
  snapshots.values.at(-1)!.wallMs >= clock.endedWallMs - 90000 &&
  metricGaps.every((gap) => gap > 0 && gap <= 90000)
checks.nativeWindowsSurvived =
  report.nativeWindowEvents.length > 0 &&
  report.nativeWindowEvents.every((event) => !event.destroyed)
const expectedRestores = Math.max(0, Math.ceil((report.mediaDurationMs - 120000) / 3600000) - 1) + 1
checks.allWindowRestoresObserved =
  report.nativeWindowEvents.length === expectedRestores * 2 &&
  report.nativeWindowEvents.every((event, index) => event.visible === (index % 2 === 1)) &&
  report.nativeWindowEvents.filter((event) => event.visible).length === expectedRestores &&
  report.nativeWindowEvents.at(-1)?.visible === true
checks.runnerReportedOriginalsUnchanged = report.originalsUnchanged === true
checks.runnerReportedPausedRestart = report.restartRestoredPaused === true
checks.noForcedFinalCleanup =
  !!report.cleanups?.length && report.cleanups.every((cleanup) => cleanup.kind === 'graceful')
const db = new DatabaseSync(join(report.userData, 'data', 'library.sqlite3'), { readOnly: true })
let database: unknown
try {
  const rows = db
    .prepare(
      'SELECT id,content_hash AS audioHash,position_ms AS positionMs,duration_ms AS durationMs FROM episodes ORDER BY sort_order',
    )
    .all() as { id: string; audioHash: string; positionMs: number; durationMs: number | null }[]
  const current = db.prepare('SELECT current_episode_id AS currentId FROM books LIMIT 1').get() as {
    currentId: string
  }
  database = { rows, ...current }
  const completed = rows.find((row) => row.audioHash === report.whole.sha256)
  const next = rows.find((row) => row.audioHash === report.next.sha256)
  checks.databaseWholeComplete = !!completed && completed.positionMs >= report.mediaDurationMs - 100
  checks.databaseNextRestored =
    !!next &&
    current.currentId === next.id &&
    next.positionMs >= 10000 &&
    !!report.natural &&
    Math.abs(next.positionMs - report.natural.nextPositionMs) < 100
} finally {
  db.close()
}
const missing = Object.entries(checks)
  .filter(([, passed]) => !passed)
  .map(([name]) => name)
const audit = {
  status: running
    ? 'in-progress'
    : report.status === 'passed' && missing.length === 0
      ? 'passed'
      : 'failed',
  auditedAt: new Date().toISOString(),
  sourceReportStatus: report.status,
  sourceReportSha256: createHash('sha256').update(sourceReportText).digest('hex'),
  journalHashes: Object.fromEntries(
    Object.entries({ samples: sampleText, events: eventText, metrics: metricText }).map(
      ([key, value]) => [key, createHash('sha256').update(value).digest('hex')],
    ),
  ),
  checks,
  incompleteOrFailed: missing,
  incompleteJournalTail: samples.incompleteTail || snapshots.incompleteTail,
  clock,
  database,
  resources: {
    unit: 'Electron MemoryInfo KB',
    snapshots: snapshots.values.length,
    mainPids,
    processes: [...perProcess.values()],
    scope:
      'Per-process observations; shared working-set pages are not added into a physical-memory claim. No leak verdict from endpoints.',
  },
  scope:
    'Whole-source native 1x playback, raw EOF/next events, input/build integrity and read-only SQLite checks. Observation gaps remain explicit; no acoustic or ASR accuracy claim.',
}
await writeFile(join(directory, 'independent-audit.json'), JSON.stringify(audit, null, 2) + '\n')
console.log(
  JSON.stringify({
    status: audit.status,
    samples: clock.samples,
    incompleteOrFailed: missing,
    audit: join(directory, 'independent-audit.json'),
  }),
)
if (audit.status === 'failed') process.exitCode = 1
