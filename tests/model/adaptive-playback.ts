// Opt-in real-model, real-media-clock check; never supplies artificial ASR output.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { AsrComponent } from '../../src/main/asr-component'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { createDataPaths } from '../../src/main/paths'
import type { TranscriptRequest } from '../../src/shared/transcript'
import { subtitleCoveredUntil } from '../../src/shared/subtitle-preparation'

const [appArgument] = process.argv.slice(2)
if (!appArgument || process.argv.length !== 3)
  throw new Error('Usage: tsx tests/model/adaptive-playback.ts <isolated-app-root>')
const appRoot = resolve(appArgument)
const directory = resolve(
  'cache/optimization',
  `adaptive-playback-${new Date().toISOString().replaceAll(':', '-')}`,
)
await mkdir(directory, { recursive: true })
await copyFile(resolve('tests/model/adaptive-playback.ts'), join(directory, 'runner.ts'))
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const manifestPath = resolve(
  'cache/asr-evaluation/public-reference/aishell4-continuous/manifest.json',
)
const manifestBytes = await readFile(manifestPath)
const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
  referenceKind: string
  samples: { id: string; path: string; audioHash: string; durationMs: number }[]
}
const sample = manifest.samples.find((item) => item.id === 'continuous-solo-first')!
assert.equal(manifest.referenceKind, 'human-continuous')
assert.equal(sha(await readFile(sample.path)), sample.audioHash)
assert.ok(sample.durationMs > 90_000 && sample.durationMs < 120_000)
const paths = createDataPaths(join(directory, 'user-data'))
const component = new AsrComponent(
  join(paths.root, 'asr-component.json'),
  join(appRoot, 'python/asr_worker.py'),
)
await component.configure(resolve('release/asr-component-0.7.0-win-x64/component.json'))
const store = new LibraryStore(paths.database)
store.importBook(await scanBook(sample.path, 'file'))
const book = store.listBooks()[0]!,
  episode = book.episodes[0]!
const target: TranscriptRequest = { episodeId: episode.id, audioHash: episode.contentHash }
store.recordSourceDuration(episode.id, episode.contentHash, sample.durationMs)
store.setSubtitlePreparation(book.id, {
  mode: 'ahead',
  engine: 'paraformer',
  device: 'cuda',
  prepareNext: false,
})
store.saveProgress({
  sessionId: '',
  episodeId: episode.id,
  positionMs: 0,
  durationMs: sample.durationMs,
  rate: 2,
  volume: 0,
})
store.close()
const report: Record<string, unknown> = {
  status: 'running',
  createdAt: new Date().toISOString(),
  directory,
  appRoot,
  scope:
    'One 97-second AISHELL-4 recording, Paraformer CUDA, 2x real muted HTMLAudioElement playback from a fresh isolated cache and restart with a completed saved transcript. No human audiobook quality, CPU/device generalization, or sustained whole-book claim.',
  input: { manifestPath, manifestSha256: sha(manifestBytes), sample },
  appManifestSha256: sha(await readFile(join(appRoot, '..', 'manifest.json'))),
}
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
let app: ElectronApplication | undefined
const launch = async () => {
  const env = { ...process.env, RALB_USER_DATA: paths.root }
  Reflect.deleteProperty(env, 'ELECTRON_RUN_AS_NODE')
  return electron.launch({ args: [appRoot], env })
}
async function snapshot(page: Page) {
  return page.evaluate(async (target) => {
    const audio = document.querySelector<HTMLAudioElement>('audio[data-player="persistent"]')!
    const result = await window.desktop.getTranscriptionState(target)
    if (!result.ok) throw new Error(result.error.message)
    return {
      positionMs: audio.currentTime * 1000,
      rate: audio.playbackRate,
      paused: audio.paused,
      ended: audio.ended,
      state: result.value,
    }
  }, target)
}
try {
  await save()
  app = await launch()
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('button', { name: '播放', exact: true }).waitFor({ state: 'visible' })
  const started = performance.now()
  await page.getByRole('button', { name: '播放', exact: true }).click()
  let firstPlaying:
    | { wallMs: number; positionMs: number; coverageLeadMs: number; jobStatus: string | undefined }
    | undefined
  let last = await snapshot(page)
  const deadline = performance.now() + 130_000
  while (performance.now() < deadline) {
    last = await snapshot(page)
    const wallMs = performance.now() - started
    const coverageLeadMs = Math.max(
      0,
      subtitleCoveredUntil(last.state, last.positionMs) - last.positionMs,
    )
    appendFileSync(
      join(directory, 'cold-samples.jsonl'),
      JSON.stringify({
        wallMs,
        positionMs: last.positionMs,
        paused: last.paused,
        ended: last.ended,
        rate: last.rate,
        coverageLeadMs,
        jobStatus: last.state.job?.status,
        completedChunks: last.state.job?.completedChunks,
        stage: last.state.job?.stage,
      }) + '\n',
    )
    if (!last.paused && !firstPlaying) {
      firstPlaying = {
        wallMs,
        positionMs: last.positionMs,
        coverageLeadMs,
        jobStatus: last.state.job?.status,
      }
      assert.equal(last.rate, 2)
      assert.ok(
        coverageLeadMs >= 59_000,
        '2x playback began without approximately 60 seconds of saved media coverage',
      )
      await page.screenshot({ path: join(directory, 'cold-playing.png') })
      console.log(JSON.stringify({ phase: 'cold-playing', ...firstPlaying }))
    }
    if (last.ended) break
    if (last.state.job?.status === 'failed')
      throw new Error(last.state.job.error ?? 'real worker failed')
    await new Promise<void>((done) => setTimeout(done, 200))
  }
  assert.ok(firstPlaying, 'real media never started')
  assert.equal(last.ended, true, 'real playback did not reach the end')
  assert.equal(last.state.job?.status, 'completed')
  assert.equal(last.state.transcript.status, 'ready')
  assert.ok(last.positionMs >= sample.durationMs - 250)
  assert.equal(last.state.job.cacheHits, 0)
  assert.equal(last.state.job.totalChunks, 4)
  assert.equal(errors.length, 0)
  report.cold = {
    firstPlaying,
    endedPositionMs: last.positionMs,
    elapsedMs: performance.now() - started,
    job: last.state.job,
    transcriptSha256: sha(Buffer.from(JSON.stringify(last.state.transcript))),
  }
  await save()
  await app.close()
  app = await launch()
  const warmPage = await app.firstWindow()
  await warmPage.getByRole('slider', { name: '播放进度', exact: true }).fill('0')
  const warmStarted = performance.now()
  await warmPage.getByRole('button', { name: '播放', exact: true }).click()
  let warm = await snapshot(warmPage)
  while (warm.paused && performance.now() - warmStarted < 5000) {
    await new Promise<void>((done) => setTimeout(done, 50))
    warm = await snapshot(warmPage)
  }
  assert.equal(warm.paused, false)
  assert.equal(warm.rate, 2)
  assert.equal(warm.state.job?.id, last.state.job.id)
  assert.equal(warm.state.job?.attempt, last.state.job.attempt)
  assert.equal(warm.state.job?.status, 'completed')
  assert.equal(warm.state.transcript.status, 'ready')
  report.warm = {
    firstPlayingMs: performance.now() - warmStarted,
    positionMs: warm.positionMs,
    reusedJobId: warm.state.job?.id,
    attempt: warm.state.job?.attempt,
  }
  await warmPage.getByRole('button', { name: '暂停', exact: true }).click()
  assert.equal(sha(await readFile(sample.path)), sample.audioHash)
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.stack : String(error)
  process.exitCode = 1
} finally {
  await app?.close()
  report.finishedAt = new Date().toISOString()
  await save()
}
console.log(
  JSON.stringify({
    status: report.status,
    report: join(directory, 'report.json'),
    error: report.error,
  }),
)
