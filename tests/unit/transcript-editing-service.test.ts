import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { lexicalCharacters } from '../../src/main/original/acoustic-process'
import type { AcousticTextSnapshot } from '../../src/main/original/acoustic-snapshot'
import { TranscriptEditingService } from '../../src/main/transcript-editing-service'
import type { OriginalAcousticResult } from '../../src/shared/original-acoustic'
import type { TranscriptDocument } from '../../src/shared/transcript'
import type { TranscriptReplacementRequest } from '../../src/shared/transcript-editing'
import { AppError } from '../../src/shared/validation'

type Options = ConstructorParameters<typeof TranscriptEditingService>[0]
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function until(condition: () => boolean) {
  for (let index = 0; index < 400 && !condition(); index++) await delay(5)
  assert.ok(condition(), 'Expected editing service state was not reached')
}
function proposal(snapshot: AcousticTextSnapshot, rejected = false): OriginalAcousticResult {
  const chars = lexicalCharacters(snapshot.originalText),
    step = (snapshot.range.endMs - snapshot.range.startMs) / snapshot.sentences.length,
    sentenceTimes = snapshot.sentences.map((sentence, index) => ({
      ordinal: sentence.ordinal,
      startMs: Math.ceil(snapshot.range.startMs + step * (index + 0.25)),
      endMs: Math.floor(snapshot.range.startMs + step * (index + 0.75)),
    })),
    characters = snapshot.sentences.flatMap((sentence, index) => {
      const selected = chars.filter(
          (char) => char.textStart >= sentence.textStart && char.textEnd <= sentence.textEnd,
        ),
        range = sentenceTimes[index]!,
        width = (range.endMs - range.startMs) / selected.length
      return selected.map((char, offset) => ({
        ...char,
        startMs: Math.floor(range.startMs + offset * width),
        endMs: Math.floor(range.startMs + (offset + 1) * width),
        score: 0.9,
      }))
    })
  return {
    contract: 'original-ctc-support-v1',
    status: rejected ? 'rejected' : 'accepted',
    range: snapshot.range,
    startMs: rejected ? null : characters[0]!.startMs,
    endMs: rejected ? null : characters.at(-1)!.endMs,
    characters: rejected ? [] : characters,
    sentenceTimes: rejected ? [] : sentenceTimes,
    evidence: {
      lexicalCharacters: chars.length,
      timedCharacters: rejected ? 0 : chars.length,
      characterCoverage: rejected ? 0 : 1,
      audioRms: 0.02,
      freePathCharacters: chars.length,
      freePathEditDistance: rejected ? chars.length : 0,
      minTokenPosterior: 0.9,
      meanTokenPosterior: 0.9,
      confidence: rejected ? 0 : 0.9,
    },
    reasons: rejected ? [{ code: 'LOW_SUPPORT', message: 'Controlled low acoustic support.' }] : [],
  }
}
async function fixture(
  t: TestContext,
  options: {
    count?: number
    segments?: number
    runner?: Options['runner']
    checkRuntime?: Options['checkRuntime']
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'ralb-editing-service-')),
    audioDirectory = join(root, 'audio'),
    filename = join(root, 'library.sqlite3'),
    fixed = new Date('2026-01-01T00:00:00Z')
  await mkdir(audioDirectory)
  for (let index = 0; index < (options.count ?? 2); index++) {
    const path = join(audioDirectory, `${index}.mp3`)
    await writeFile(path, `owned identity ${index}; no codec or model is involved`)
    await utimes(path, fixed, fixed)
  }
  const store = new LibraryStore(filename)
  store.importBook(await scanBook(audioDirectory, 'folder'))
  const book = store.listBooks()[0]!,
    episodes = book.episodes,
    duration = Math.max(10000, (options.segments ?? 3) * 2000 + 2000)
  for (const episode of episodes) {
    store.recordSourceDuration(episode.id, episode.contentHash, duration)
    store.saveTranscript(episode.id, {
      version: 1,
      kind: 'transcript',
      audioHash: episode.contentHash,
      coverage: [{ startMs: 0, endMs: duration }],
      segments: Array.from({ length: options.segments ?? 3 }, (_, index) => ({
        id: `s${index}`,
        startMs: index * 2000 + 1000,
        endMs: index * 2000 + 2000,
        text: `李明春风第${index}句。`,
      })),
    })
  }
  store.saveProgress({
    sessionId: '',
    episodeId: episodes[0]!.id,
    positionMs: 750,
    durationMs: duration,
    rate: 1.5,
    volume: 0,
  })
  const events: { episodeId: string; saved: boolean }[] = [],
    logs: unknown[] = [],
    snapshots: AcousticTextSnapshot[] = [],
    signals: AbortSignal[] = [],
    cleanup: (() => void)[] = []
  let clock = 1000,
    runnerCalls = 0,
    leaseCalls = 0
  const queue = {
    maintaining: false,
    withModelLease: async <T>(action: (signal: AbortSignal) => Promise<T>) => {
      if (queue.maintaining) throw new AppError('BUSY', 'Controlled lease is occupied')
      queue.maintaining = true
      leaseCalls++
      try {
        return await action(new AbortController().signal)
      } finally {
        queue.maintaining = false
      }
    },
  }
  const service = new TranscriptEditingService({
    store,
    queue,
    component: {
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
    notify: (target, saved) => events.push({ episodeId: target.episodeId, saved }),
    log: (error) => logs.push(error),
    runner: async (...args) => {
      runnerCalls++
      snapshots.push(structuredClone(args[1]))
      signals.push(args[4])
      return options.runner ? options.runner(...args) : proposal(args[1])
    },
    checkRuntime: options.checkRuntime,
    now: () => clock,
  })
  t.after(async () => {
    cleanup.forEach((release) => release())
    await service.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  const target = (index = 0) => ({
    episodeId: episodes[index]!.id,
    audioHash: episodes[index]!.contentHash,
  })
  const saved = (index = 0) => {
    const state = store.getTranscript(target(index).episodeId, target(index).audioHash)
    assert.equal(state.status, 'ready')
    if (state.status !== 'ready') throw Error('Missing fixture transcript')
    return state.transcript
  }
  const replacement = (bookScope = false): TranscriptReplacementRequest => ({
    ...target(),
    revision: saved().revision,
    requestId: randomUUID(),
    find: '李明',
    replacement: '李萌',
    scope: bookScope
      ? { kind: 'book', bookId: book.id, episodeIds: episodes.map((episode) => episode.id) }
      : { kind: 'episode' },
  })
  return {
    root,
    filename,
    store,
    service,
    queue,
    book,
    episodes,
    target,
    saved,
    replacement,
    events,
    logs,
    snapshots,
    signals,
    cleanup,
    alignment: () => ({
      ...target(),
      revision: saved().revision,
      requestId: randomUUID(),
      segmentIds: ['s0', 's1'],
      device: 'cpu' as const,
    }),
    groups: () => {
      const db = new DatabaseSync(filename, { readOnly: true })
      try {
        return Number(db.prepare('SELECT count(*) AS n FROM transcript_edit_groups').get()!.n)
      } finally {
        db.close()
      }
    },
    setClock: (value: number) => {
      clock = value
    },
    runnerCalls: () => runnerCalls,
    leaseCalls: () => leaseCalls,
  }
}

test('replacement preview is read-only, paginated, isolated from DTO mutation and bounded by expiry', async (t) => {
  const f = await fixture(t, { segments: 31 }),
    before = f.episodes.map((_e, index) => f.saved(index)),
    preview = await f.service.previewReplacement(f.replacement(true))
  assert.equal(preview.episodes, 2)
  assert.equal(preview.segments, 62)
  assert.equal(preview.occurrences, 62)
  assert.equal(preview.pages, 2)
  assert.equal(preview.changes.length, 50)
  preview.changes[0]!.after = 'renderer mutation'
  assert.notEqual(
    f.service.replacementPage({ token: preview.token, page: 0 }).changes[0]!.after,
    'renderer mutation',
  )
  assert.equal(f.service.replacementPage({ token: preview.token, page: 1 }).changes.length, 12)
  assert.deepEqual(
    f.episodes.map((_e, index) => f.saved(index)),
    before,
  )
  assert.equal(f.groups(), 0)
  assert.deepEqual(f.events, [])
  f.setClock(preview.expiresAt)
  assert.throws(() => f.service.replacementPage({ token: preview.token, page: 0 }), {
    code: 'CONFLICT',
  })
  assert.throws(
    () => f.service.applyReplacement({ token: preview.token, commandId: randomUUID() }),
    { code: 'CONFLICT' },
  )
  assert.deepEqual(
    f.episodes.map((_e, index) => f.saved(index)),
    before,
  )
})

test('canceling pending and completed previews invalidates late tokens; close drains queued preview rejection and refuses new work', async (t) => {
  const f = await fixture(t),
    request = f.replacement(),
    pending = f.service.previewReplacement(request),
    rejected = assert.rejects(pending, (error: Error) => error.name === 'AbortError')
  await f.service.cancelReplacement(request.requestId)
  await rejected
  const readyRequest = f.replacement(),
    ready = await f.service.previewReplacement(readyRequest)
  await f.service.cancelReplacement(readyRequest.requestId)
  assert.throws(() => f.service.applyReplacement({ token: ready.token, commandId: randomUUID() }), {
    code: 'CONFLICT',
  })
  let settled = false
  const closingPreview = f.service
    .previewReplacement(f.replacement())
    .catch((error: Error) => {
      assert.equal(error.name, 'AbortError')
    })
    .finally(() => {
      settled = true
    })
  await f.service.close()
  assert.equal(settled, true)
  await closingPreview
  await assert.rejects(f.service.previewReplacement(f.replacement()), { code: 'BUSY' })
  assert.throws(() => f.service.state(f.target()), { code: 'BUSY' })
  assert.equal(f.groups(), 0)
})

test('a stale member rejects the entire book replacement without publishing any other changed episode', async (t) => {
  const f = await fixture(t),
    preview = await f.service.previewReplacement(f.replacement(true)),
    command = {
      ...f.target(1),
      revision: f.saved(1).revision,
      commandId: randomUUID(),
      operation: { kind: 'text' as const, segmentId: 's0', text: '李晓明春风第0句。' },
    }
  f.service.change(command)
  const before = f.episodes.map((_e, index) => f.saved(index)),
    groups = f.groups(),
    events = f.events.length
  assert.throws(
    () => f.service.applyReplacement({ token: preview.token, commandId: randomUUID() }),
    { code: 'CONFLICT' },
  )
  assert.deepEqual(
    f.episodes.map((_e, index) => f.saved(index)),
    before,
  )
  assert.equal(f.groups(), groups)
  assert.equal(f.events.length, events)
})

test('book replacement command replay, grouped undo and redo preserve IDs, times, coverage and one history group', async (t) => {
  const f = await fixture(t),
    before = f.episodes.map((_e, index) => f.saved(index).document),
    preview = await f.service.previewReplacement(f.replacement(true)),
    command = { token: preview.token, commandId: randomUUID() },
    applied = f.service.applyReplacement(command)
  assert.equal(applied.changed.length, 2)
  assert.equal(applied.history.undo!.episodes, 2)
  const changed = f.episodes.map((_e, index) => f.saved(index))
  const replay = f.service.applyReplacement(command)
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.changed, [])
  assert.deepEqual(
    f.episodes.map((_e, index) => f.saved(index)),
    changed,
  )
  assert.equal(f.events.filter((event) => event.saved).length, 2)
  assert.equal(f.groups(), 1)
  assert.throws(
    () => f.service.applyReplacement({ token: preview.token, commandId: randomUUID() }),
    { code: 'CONFLICT' },
  )
  const undone = f.service.undo({
    ...f.target(),
    revision: f.saved().revision,
    historyId: applied.history.undo!.id,
    commandId: randomUUID(),
  })
  assert.deepEqual(
    f.episodes.map((_e, index) => f.saved(index).document),
    before,
  )
  assert.equal(undone.changed.length, 2)
  assert.ok(f.saved().revision > changed[0]!.revision)
  const redone = f.service.redo({
    ...f.target(),
    revision: f.saved().revision,
    historyId: undone.history.redo!.id,
    commandId: randomUUID(),
  })
  assert.equal(redone.changed.length, 2)
  assert.deepEqual(
    f.episodes.map((_e, index) => f.saved(index).document),
    changed.map((value) => value.document),
  )
  assert.equal(f.groups(), 1)
})

test('individual command replay and no-op edits cannot duplicate revisions or history', async (t) => {
  const f = await fixture(t),
    request = {
      ...f.target(),
      revision: f.saved().revision,
      commandId: randomUUID(),
      operation: { kind: 'split' as const, segmentId: 's0', offset: 2, atMs: 1500 },
    },
    applied = f.service.change(request),
    after = f.saved()
  assert.equal(applied.changed.length, 1)
  assert.equal(f.service.change(request).replayed, true)
  assert.deepEqual(f.saved(), after)
  assert.throws(
    () => f.service.change({ ...request, operation: { ...request.operation, offset: 3 } }),
    { code: 'CONFLICT' },
  )
  const noOp = f.service.change({
    ...f.target(),
    revision: after.revision,
    commandId: randomUUID(),
    operation: {
      kind: 'timing',
      ranges: [{ segmentId: after.document.segments[0]!.id, startMs: 1000, endMs: 1500 }],
    },
  })
  assert.deepEqual(noOp.changed, [])
  assert.equal(f.groups(), 1)
  assert.deepEqual(f.saved(), after)
})

test('acoustic suggestions do not write until explicit adoption; apply replay and undo preserve the formal text and ordinary player state', async (t) => {
  const gate = deferred(),
    f = await fixture(t, {
      runner: async (_r, snapshot) => {
        await gate.promise
        return proposal(snapshot)
      },
    })
  f.cleanup.push(gate.resolve)
  const before = f.saved(),
    player = f.store.getPlayerState(),
    job = f.service.startAlignment(f.alignment()).job!
  assert.equal(job.status, 'running')
  await until(() => f.runnerCalls() === 1)
  assert.equal(Object.hasOwn(f.snapshots[0]!, 'originalId'), false)
  assert.equal(
    f.snapshots[0]!.originalText,
    before.document.segments
      .slice(0, 2)
      .map((value) => value.text)
      .join('\n'),
  )
  assert.deepEqual(f.saved(), before)
  assert.equal(f.groups(), 0)
  assert.throws(() => f.service.startAlignment(f.alignment()), { code: 'BUSY' })
  gate.resolve()
  await until(() => job.status === 'ready')
  assert.deepEqual(f.saved(), before)
  const command = { id: job.id, revision: before.revision, commandId: randomUUID() },
    result = await f.service.applyAlignment(command)
  assert.equal(job.status, 'applied')
  assert.deepEqual(
    f.saved().document.segments.map(({ text }) => text),
    before.document.segments.map(({ text }) => text),
  )
  assert.deepEqual(f.saved().document.coverage, before.document.coverage)
  const applied = f.saved()
  assert.equal((await f.service.applyAlignment(command)).replayed, true)
  assert.deepEqual(f.saved(), applied)
  f.service.undo({
    ...f.target(),
    revision: applied.revision,
    commandId: randomUUID(),
    historyId: result.history.undo!.id,
  })
  assert.deepEqual(f.saved().document, before.document)
  assert.deepEqual(f.store.getPlayerState(), player)
})

test('cancel and close wait for an owned inference cleanup and never publish a late suggestion', async (t) => {
  const gate = deferred(),
    f = await fixture(t, {
      runner: async (_r, snapshot) => {
        await gate.promise
        return proposal(snapshot)
      },
    })
  f.cleanup.push(gate.resolve)
  const before = f.saved(),
    job = f.service.startAlignment(f.alignment()).job!
  await until(() => f.runnerCalls() === 1)
  let canceled = false,
    closed = false
  const cancel = f.service.cancelAlignment(job.id).then(() => {
    canceled = true
  })
  const closing = f.service.close().then(() => {
    closed = true
  })
  await delay(10)
  assert.equal(f.signals[0]!.aborted, true)
  assert.equal(canceled, false)
  assert.equal(closed, false)
  const events = f.events.length
  gate.resolve()
  await Promise.all([cancel, closing])
  assert.equal(job.status, 'canceled')
  assert.equal(f.queue.maintaining, false)
  assert.deepEqual(f.saved(), before)
  assert.equal(f.groups(), 0)
  assert.equal(f.events.length, events)
})

test('cancellation during component preflight drains cleanup and never starts the alignment runner', async (t) => {
  const gate = deferred()
  let entered = false,
    signal: AbortSignal | undefined
  const f = await fixture(t, {
    checkRuntime: async (_r, value) => {
      entered = true
      signal = value
      await gate.promise
    },
  })
  f.cleanup.push(gate.resolve)
  const before = f.saved(),
    job = f.service.startAlignment(f.alignment()).job!
  await until(() => entered)
  let canceled = false
  const cancel = f.service.cancelAlignment(job.id).then(() => {
    canceled = true
  })
  await delay(10)
  assert.equal(signal!.aborted, true)
  assert.equal(canceled, false)
  gate.resolve()
  await cancel
  assert.equal(job.status, 'canceled')
  assert.equal(f.runnerCalls(), 0)
  assert.deepEqual(f.saved(), before)
})

test('low acoustic support and unavailable components preserve the document, history and player clock', async (t) => {
  for (const kind of ['rejected', 'unavailable'] as const)
    await t.test(kind, async (child) => {
      const f = await fixture(child, {
          runner: async (_r, snapshot) => proposal(snapshot, true),
          ...(kind === 'unavailable'
            ? {
                checkRuntime: async () => {
                  throw new AppError('RUNTIME_UNAVAILABLE', 'Controlled unavailable model')
                },
              }
            : {}),
        }),
        before = f.saved(),
        clock = f.store.getPlayerState(),
        job = f.service.startAlignment(f.alignment()).job!
      await until(() => job.status === (kind === 'rejected' ? 'rejected' : 'failed'))
      await assert.rejects(
        f.service.applyAlignment({
          id: job.id,
          revision: before.revision,
          commandId: randomUUID(),
        }),
        { code: 'CONFLICT' },
      )
      assert.deepEqual(f.saved(), before)
      assert.deepEqual(f.store.getPlayerState(), clock)
      assert.equal(f.groups(), 0)
      assert.equal(
        f.events.some((event) => event.saved),
        false,
      )
      if (kind === 'unavailable') assert.equal(f.runnerCalls(), 0)
    })
})

test('a revised transcript or same-stat changed audio invalidates pending and ready acoustic proposals', async (t) => {
  for (const mutation of ['revision', 'audio'] as const)
    for (const phase of ['pending', 'ready'] as const)
      await t.test(`${phase}-${mutation}`, async (child) => {
        const gate = deferred(),
          f = await fixture(child, {
            runner: async (_r, snapshot) => {
              await gate.promise
              return proposal(snapshot)
            },
          })
        f.cleanup.push(gate.resolve)
        const job = f.service.startAlignment(f.alignment()).job!
        await until(() => f.runnerCalls() === 1)
        if (phase === 'ready') {
          gate.resolve()
          await until(() => job.status === 'ready')
        }
        if (mutation === 'revision')
          f.service.change({
            ...f.target(),
            revision: f.saved().revision,
            commandId: randomUUID(),
            operation: { kind: 'text', segmentId: 's0', text: '李萌春风第0句。' },
          })
        else {
          const audio = f.store.getAudio(f.target().episodeId)!,
            bytes = await readFile(audio.path)
          bytes[bytes.length - 1] = 33
          await writeFile(audio.path, bytes)
          await utimes(audio.path, new Date(audio.modifiedAt), new Date(audio.modifiedAt))
          assert.notEqual(createHash('sha256').update(bytes).digest('hex'), audio.contentHash)
        }
        const kept = f.saved(),
          groups = f.groups()
        gate.resolve()
        if (phase === 'pending') await until(() => job.status === 'failed')
        await assert.rejects(
          f.service.applyAlignment({ id: job.id, revision: job.revision, commandId: randomUUID() }),
        )
        assert.deepEqual(f.saved(), kept)
        assert.equal(f.groups(), groups)
      })
})

test('a canceled ready proposal cannot win a simultaneous asynchronous adoption', async (t) => {
  const f = await fixture(t),
    before = f.saved(),
    job = f.service.startAlignment(f.alignment()).job!
  await until(() => job.status === 'ready')
  const adoption = f.service.applyAlignment({
      id: job.id,
      revision: before.revision,
      commandId: randomUUID(),
    }),
    rejected = assert.rejects(adoption, { code: 'CONFLICT' })
  await f.service.cancelAlignment(job.id)
  await rejected
  assert.equal(job.status, 'canceled')
  assert.deepEqual(f.saved(), before)
  assert.equal(f.groups(), 0)
})

test('global pause and runnable/manual jobs block alignment while a parked offline job permits an independent lease', async (t) => {
  const f = await fixture(t),
    resources = f.store.processingResources()
  f.store.setProcessingPaused({ revision: resources.revision, paused: true })
  assert.throws(() => f.service.startAlignment(f.alignment()), { code: 'BUSY' })
  const paused = f.store.processingResources()
  f.store.setProcessingPaused({ revision: paused.revision, paused: false })
  const plan = f.store.createOfflinePlan({
      bookId: f.book.id,
      episodeIds: [f.target().episodeId],
      scope: 'ids',
      profile: { engine: 'paraformer', device: 'cpu' },
      audioBudgetBytes: 0,
    }),
    item = f.store.storedOfflineItems(plan.id)[0]!,
    attached = f.store.createOrAttachOfflineJob(item.id, {
      ...f.target(),
      engine: 'paraformer',
      device: 'cpu',
    })
  assert.throws(() => f.service.startAlignment(f.alignment()), { code: 'BUSY' })
  f.store.updateOfflinePlan({ id: plan.id, revision: plan.revision, action: 'pause' })
  assert.deepEqual(f.store.offlineJobOwnership(attached.job.id), {
    planned: true,
    runnable: false,
    manual: false,
  })
  const job = f.service.startAlignment(f.alignment()).job!
  await until(() => job.status === 'ready')
  assert.equal(f.leaseCalls(), 1)
  assert.equal(f.store.getJob(attached.job.id)!.status, 'queued')
  f.store.claimJobForManual(attached.job.id)
  assert.throws(() => f.service.startAlignment(f.alignment()), { code: 'BUSY' })
  assert.equal(f.leaseCalls(), 1)
})

test('noncontinuous, duplicate, missing or punctuation-only acoustic selections never obtain a model lease', async (t) => {
  const f = await fixture(t)
  for (const segmentIds of [[], ['s0', 's2'], ['s0', 's0'], ['missing']])
    assert.throws(() => f.service.startAlignment({ ...f.alignment(), segmentIds }), {
      code: 'INVALID_REQUEST',
    })
  const document: TranscriptDocument = structuredClone(f.saved().document)
  document.segments[0]!.text = '！？'
  f.store.saveTranscript(f.target().episodeId, document)
  assert.throws(() => f.service.startAlignment({ ...f.alignment(), segmentIds: ['s0'] }), {
    code: 'INVALID_REQUEST',
  })
  assert.equal(f.leaseCalls(), 0)
  assert.equal(f.runnerCalls(), 0)
})

test('acoustic selection limits reject oversized work and separate coverage intervals before creating a lease', async (t) => {
  for (const kind of ['twenty-one', 'sixty-seconds', 'touching-coverage', 'text-limit'] as const)
    await t.test(kind, async (child) => {
      const f = await fixture(child, { segments: kind === 'twenty-one' ? 21 : 3 }),
        document = structuredClone(f.saved().document)
      let segmentIds = ['s0', 's1']
      if (kind === 'twenty-one') segmentIds = document.segments.map((segment) => segment.id)
      else if (kind === 'sixty-seconds') {
        f.store.recordSourceDuration(f.target().episodeId, f.target().audioHash, 80000)
        document.coverage = [{ startMs: 0, endMs: 80000 }]
        document.segments[1] = { ...document.segments[1]!, startMs: 62000, endMs: 63000 }
        document.segments[2] = { ...document.segments[2]!, startMs: 65000, endMs: 66000 }
      } else if (kind === 'touching-coverage')
        document.coverage = [
          { startMs: 0, endMs: 2500 },
          { startMs: 2500, endMs: 10000 },
        ]
      else {
        document.segments[0]!.text = '字'.repeat(1001)
        segmentIds = ['s0']
      }
      f.store.saveTranscript(f.target().episodeId, document)
      const before = f.saved()
      assert.throws(() => f.service.startAlignment({ ...f.alignment(), segmentIds }), {
        code: 'INVALID_REQUEST',
      })
      assert.equal(f.leaseCalls(), 0)
      assert.equal(f.runnerCalls(), 0)
      assert.deepEqual(f.saved(), before)
    })
})
