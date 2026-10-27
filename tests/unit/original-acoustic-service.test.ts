import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { parseOriginal } from '../../src/main/original/parse'
import { matchOriginal } from '../../src/main/original/match'
import { OriginalAcousticService } from '../../src/main/original/acoustic-service'
import { lexicalCharacters } from '../../src/main/original/acoustic-process'
import type { runOriginalAcoustic } from '../../src/main/original/acoustic-process'
import type { OriginalAcousticSnapshot } from '../../src/main/original/acoustic-snapshot'
import type { OriginalAcousticResult } from '../../src/shared/original-acoustic'

function proposal(snapshot: OriginalAcousticSnapshot): OriginalAcousticResult {
  const characters = lexicalCharacters(snapshot.originalText).map((char, index) => ({
    ...char,
    startMs: 1200 + index * 200,
    endMs: 1400 + index * 200,
    score: 0.9,
  }))
  return {
    contract: 'original-ctc-support-v1',
    status: 'accepted',
    range: snapshot.range,
    startMs: characters[0]!.startMs,
    endMs: characters.at(-1)!.endMs,
    characters,
    sentenceTimes: [
      { ordinal: snapshot.sentences[0]!.ordinal, startMs: 1200, endMs: characters.at(-1)!.endMs },
    ],
    evidence: {
      lexicalCharacters: characters.length,
      timedCharacters: characters.length,
      characterCoverage: 1,
      audioRms: 0.02,
      freePathCharacters: characters.length,
      freePathEditDistance: 0,
      minTokenPosterior: 0.9,
      meanTokenPosterior: 0.9,
      confidence: 0.9,
    },
    reasons: [],
  }
}
async function until(condition: () => boolean) {
  for (let i = 0; i < 200 && !condition(); i++) await delay(5)
  assert.ok(condition())
}
async function fixture(runner?: typeof runOriginalAcoustic) {
  const root = await mkdtemp(join(tmpdir(), 'ralb-acoustic-service-'))
  await writeFile(join(root, '第1集.mp3'), 'synthetic audio identity')
  const store = new LibraryStore(join(root, 'library.sqlite3'))
  store.importBook(await scanBook(root, 'folder'))
  const episode = store.listBooks()[0]!.episodes[0]!
  const target = { episodeId: episode.id, audioHash: episode.contentHash }
  store.recordSourceDuration(episode.id, episode.contentHash, 10000)
  const document = {
    version: 1 as const,
    kind: 'transcript' as const,
    audioHash: episode.contentHash,
    coverage: [{ startMs: 0, endMs: 10000 }],
    segments: [{ id: 's1', startMs: 1000, endMs: 5000, text: '春风吹过山谷。' }],
  }
  const transcript = store.saveTranscript(episode.id, document)
  if (transcript.status !== 'ready') throw new Error('Missing transcript')
  const original = parseOriginal(Buffer.from('春风吹过山谷。'), '原文.txt')
  const originalId = store.originals.import(target, original).info!.id
  store.originals.saveAlignment(
    target,
    originalId,
    transcript.transcript.id,
    1,
    0,
    matchOriginal(original, document),
  )
  const request = () => ({
    ...target,
    originalId,
    revision: store.originals.state(target).alignment!.revision,
    segmentId: 's1',
    device: 'cpu' as const,
  })
  store.originals.correct({
    ...request(),
    selection: { first: 0, last: 0 },
    startMs: 1000,
    endMs: 5000,
  })
  const events: boolean[] = [],
    logs: unknown[] = []
  let calls = 0,
    entered = false
  let release!: () => void
  const queue = {
    maintaining: false,
    withModelLease: async <T>(action: (signal: AbortSignal) => Promise<T>) => {
      calls++
      return action(new AbortController().signal)
    },
  }
  const service = new OriginalAcousticService(
    store,
    {
      configured: true,
      runtime: (engine, device) => ({
        python: '',
        script: '',
        models: '',
        cache: '',
        ffmpeg: '',
        ffprobe: '',
        engine,
        device,
        compute: 'int8',
      }),
    },
    queue,
    (_target, saved) => events.push(saved),
    (error) => logs.push(error),
    runner ??
      (async (_r, snapshot) => {
        entered = true
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return proposal(snapshot)
      }),
  )
  return {
    service,
    store,
    target,
    request,
    document,
    events,
    logs,
    queue,
    entered: () => entered,
    calls: () => calls,
    release: () => release(),
    close: async () => {
      await service.close()
      store.close()
    },
  }
}

test('acoustic preview returns a cancelable id before inference and writes only after explicit adoption', async () => {
  const f = await fixture()
  try {
    const before = f.store.originals.state(f.target)
    const job = f.service.start(f.request()).job!
    assert.equal(job.status, 'running')
    await until(f.entered)
    assert.throws(() => f.service.start(f.request()), { code: 'BUSY' })
    assert.deepEqual(f.store.originals.state(f.target), before)
    f.release()
    await until(() => job.status === 'ready')
    assert.deepEqual(f.store.originals.state(f.target), before)
    const after = await f.service.apply({ id: job.id, revision: f.request().revision })
    assert.equal(after.alignment!.matches[0]!.startMs, 1200)
    assert.deepEqual(after.alignment!.matches[0]!.acoustic!.manualRange, {
      startMs: 1000,
      endMs: 5000,
    })
    assert.ok(f.events.includes(true))
    const restored = await f.service.restore({ ...f.request(), historyId: job.id })
    assert.equal(restored.alignment!.matches[0]!.startMs, 1000)
    assert.equal(restored.alignment!.matches[0]!.acoustic, undefined)
  } finally {
    await f.close()
  }
})

test('cancel and close discard late acoustic completion without adopting or emitting after close', async () => {
  const f = await fixture()
  try {
    const before = f.store.originals.state(f.target)
    const job = f.service.start(f.request()).job!
    await until(f.entered)
    f.service.cancel(job.id)
    assert.equal(job.status, 'canceled')
    const count = f.events.length
    const closing = f.service.close()
    f.release()
    await closing
    assert.equal(job.status, 'canceled')
    assert.deepEqual(f.store.originals.state(f.target), before)
    assert.equal(f.events.length, count)
    await assert.rejects(() => f.service.apply({ id: job.id, revision: f.request().revision }), {
      code: 'CONFLICT',
    })
  } finally {
    await f.close()
  }
})

test('source revision changes while acoustic inference is pending invalidate the old suggestion', async () => {
  const f = await fixture()
  try {
    const job = f.service.start(f.request()).job!
    await until(f.entered)
    f.store.originals.correct({
      ...f.request(),
      selection: { first: 0, last: 0 },
      startMs: 1500,
      endMs: 4500,
    })
    f.release()
    await until(() => job.status === 'failed')
    assert.equal(f.store.originals.state(f.target).alignment!.matches[0]!.startMs, 1500)
    assert.match(job.error!, /变化|更新/)
    await assert.rejects(() => f.service.apply({ id: job.id, revision: f.request().revision }))
  } finally {
    await f.close()
  }
})

test('unavailable model lease does not run a child or change stored manual alignment', async () => {
  const f = await fixture()
  try {
    f.queue.maintaining = true
    assert.throws(() => f.service.start(f.request()), { code: 'BUSY' })
    assert.equal(f.calls(), 0)
    assert.equal(f.service.state(f.target).job, null)
  } finally {
    await f.close()
  }
})

test('a parked offline job does not prevent original acoustic proposals or change its persisted ownership', async () => {
  const f = await fixture()
  try {
    const plan = f.store.createOfflinePlan({
      bookId: f.store.getEpisode(f.target.episodeId)!.bookId,
      episodeIds: [f.target.episodeId],
      scope: 'ids',
      profile: { engine: 'paraformer', device: 'cpu' },
      audioBudgetBytes: 0,
    })
    const item = f.store.storedOfflineItems(plan.id)[0]!,
      planned = f.store.createOrAttachOfflineJob(item.id, {
        ...f.target,
        engine: 'paraformer',
        device: 'cpu',
      }).job
    f.store.updateOfflinePlan({ id: plan.id, revision: plan.revision, action: 'pause' })
    const owner = f.store.offlineJobOwnership(planned.id),
      before = f.store.originals.state(f.target),
      job = f.service.start(f.request()).job!
    assert.deepEqual(owner, { planned: true, runnable: false, manual: false })
    await until(f.entered)
    f.release()
    await until(() => job.status === 'ready')
    assert.equal(f.calls(), 1)
    assert.deepEqual(f.store.offlineJobOwnership(planned.id), owner)
    assert.equal(f.store.getJob(planned.id)!.status, 'queued')
    assert.deepEqual(f.store.originals.state(f.target), before)
  } finally {
    if (f.entered()) f.release()
    await f.close()
  }
})

test('an actually runnable offline job still prevents original acoustic inference', async () => {
  const f = await fixture()
  try {
    const plan = f.store.createOfflinePlan({
      bookId: f.store.getEpisode(f.target.episodeId)!.bookId,
      episodeIds: [f.target.episodeId],
      scope: 'ids',
      profile: { engine: 'paraformer', device: 'cpu' },
      audioBudgetBytes: 0,
    })
    const item = f.store.storedOfflineItems(plan.id)[0]!,
      job = f.store.createOrAttachOfflineJob(item.id, {
        ...f.target,
        engine: 'paraformer',
        device: 'cpu',
      }).job
    assert.deepEqual(f.store.offlineJobOwnership(job.id), {
      planned: true,
      runnable: true,
      manual: false,
    })
    assert.throws(() => f.service.start(f.request()), { code: 'BUSY' })
    assert.equal(f.calls(), 0)
    assert.equal(f.service.state(f.target).job, null)
  } finally {
    await f.close()
  }
})
