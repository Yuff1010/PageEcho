import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { AutomaticSubtitles, automaticSubtitleProfile } from '../../src/main/automatic-subtitles'
import { EPISODE_SWITCHED } from '../../src/main/transcription-queue'
import type { ComponentCheck } from '../../src/shared/component'
import type { SourcePreparation } from '../../src/shared/sources'
import type {
  StartAutomaticSubtitles,
  StartTranscription,
  SubtitlePreparation,
  TranscriptionJob,
  TranscriptionState,
} from '../../src/shared/transcription'
import { validateRequest } from '../../src/shared/validation'

function checked(): ComponentCheck {
  return {
    checkedAt: new Date().toISOString(),
    ready: true,
    pythonVersion: '3.12',
    cudaName: null,
    freeBytes: null,
    issues: [],
    level: 'imports-and-files',
    capabilities: ['whisperx', 'paraformer'].flatMap((engine) =>
      ['cpu', 'cuda'].map((device) => ({
        engine: engine as SubtitlePreparation['engine'],
        device: device as SubtitlePreparation['device'],
        available: device === 'cpu',
        message: device === 'cpu' ? 'ready' : 'unavailable',
      })),
    ),
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture(settings?: SubtitlePreparation, legacy?: SourcePreparation) {
  const request: StartAutomaticSubtitles = {
    episodeId: randomUUID(),
    audioHash: 'a'.repeat(64),
    sessionId: randomUUID(),
    positionMs: 42_000,
  }
  const bookId = randomUUID()
  let saved = settings,
    current = true,
    probes = 0,
    componentNotifies = 0,
    pauses = 0,
    stops = 0
  const stopped = new Set<string>()
  const key = (target: { episodeId: string; audioHash: string }) =>
    `${target.episodeId}:${target.audioHash}`
  let state: TranscriptionState = {
    configured: true,
    job: null,
    transcript: { status: 'missing' },
  }
  let probe: (signal: AbortSignal) => Promise<ComponentCheck | null> = async () => checked()
  const prepared: StartTranscription[] = [],
    positions: number[] = [],
    matched: string[] = [],
    opened: [string, boolean | undefined][] = []
  const job = (patch: Partial<TranscriptionJob> = {}): TranscriptionJob => ({
    ...request,
    id: randomUUID(),
    engine: 'paraformer',
    device: 'cpu',
    background: false,
    status: 'queued',
    attempt: 1,
    stage: '',
    processedUntilMs: 0,
    totalChunks: 0,
    completedChunks: 0,
    cacheHits: 0,
    issueCount: 0,
    autoApply: true,
    appliedRevision: 0,
    previewRevision: 0,
    hasPreview: false,
    createdAt: '',
    updatedAt: '',
    error: null,
    ...patch,
  })
  const service = new AutomaticSubtitles(
    {
      getEpisode: () => ({ bookId, contentHash: request.audioHash }) as never,
      getBookMetadata: (id) => {
        assert.equal(id, bookId)
        return { id: bookId, online: { preparation: legacy } } as never
      },
      getSubtitlePreparation: () => saved,
      setSubtitlePreparation: (_id, value) => {
        saved = value
      },
      latestJob: () => state.job as never,
    },
    {
      state: () => state,
      prepare: (value) => {
        prepared.push(value)
        state = { ...state, job: job({ ...value, status: 'queued' }) }
        return state
      },
      prioritize: (_id, _hash, position) => {
        positions.push(position)
      },
      preparationStopped: (target) => stopped.has(key(target)),
      resumePreparation: (target) => {
        stopped.delete(key(target))
      },
      stopPreparation: (target) => {
        stopped.add(key(target))
        stops++
        if (state.job && ['queued', 'running', 'canceling'].includes(state.job.status))
          state = { ...state, job: { ...state.job, status: 'canceled', error: null } }
        return state
      },
    },
    {
      checkAutomatic: async (signal) => {
        probes++
        return probe(signal)
      },
    },
    {
      opened: (id, activated) => opened.push([id, activated]),
      pause: () => {
        pauses++
      },
    },
    () => current,
    (target) => matched.push(target.episodeId),
    () => {
      componentNotifies++
    },
  )
  return {
    service,
    request,
    job,
    prepared,
    positions,
    matched,
    opened,
    saved: () => saved,
    probes: () => probes,
    componentNotifies: () => componentNotifies,
    pauses: () => pauses,
    stops: () => stops,
    state: () => state,
    setState: (value: TranscriptionState) => {
      state = value
    },
    setSettings: (value: SubtitlePreparation) => {
      saved = value
    },
    setLegacy: (value: SourcePreparation) => {
      legacy = value
    },
    setCurrent: (value: boolean) => {
      current = value
    },
    setProbe: (value: typeof probe) => {
      probe = value
    },
  }
}
function ready(t: ReturnType<typeof fixture>): TranscriptionState {
  return {
    ...t.state(),
    transcript: {
      status: 'ready',
      transcript: {
        id: randomUUID(),
        episodeId: t.request.episodeId,
        importedAt: '',
        revision: 7,
        document: {
          version: 1,
          audioHash: t.request.audioHash,
          kind: 'manual',
          coverage: [{ startMs: 0, endMs: 60_000 }],
          segments: [{ id: '1', startMs: 0, endMs: 60_000, text: '保留人工修订。' }],
        },
      },
    },
  }
}

test('playback entry probes actual capabilities, saves auto, and prioritizes the current media position', async () => {
  const t = fixture()
  const pending = deferred<ComponentCheck>()
  t.setProbe(async () => pending.promise)
  assert.equal(t.probes(), 0, 'construction/restoration must not open a model')
  const first = t.service.start(t.request)
  assert.equal(t.probes(), 1)
  assert.equal(t.prepared.length, 0, 'ASR waits for its check independently of audio playback')
  const second = t.service.start({ ...t.request, positionMs: 65_000 })
  assert.equal(first, second, 'repeated Play shares a pending check')
  pending.resolve(checked())
  const result = await first
  assert.equal(result.status, 'started')
  assert.deepEqual(t.saved(), {
    mode: 'auto',
    engine: 'paraformer',
    device: 'cpu',
    prepareNext: false,
  })
  assert.equal(t.prepared.length, 1)
  assert.deepEqual(t.positions, [42_000, 65_000])
  assert.deepEqual(t.opened, [[t.request.episodeId, true]])
  assert.deepEqual(t.matched, [t.request.episodeId])
})

test('saved manual is authoritative for Play; an explicit preparation uses it once', async () => {
  const settings: SubtitlePreparation = {
    mode: 'manual',
    engine: 'whisperx',
    device: 'cpu',
    prepareNext: false,
  }
  const t = fixture(settings)
  assert.equal((await t.service.start(t.request)).status, 'disabled')
  assert.equal(t.probes(), 0)
  assert.equal((await t.service.start({ ...t.request, explicit: true })).status, 'started')
  assert.deepEqual(t.saved(), settings)
  assert.equal(t.prepared[0]!.engine, 'whisperx')
})

test('enabled legacy online preparation preserves its checked engine and ahead semantics on first Play', async () => {
  const legacy: SourcePreparation = {
    cacheNext: false,
    transcribeNext: true,
    engine: 'whisperx',
    device: 'cpu',
  }
  const t = fixture(undefined, legacy)
  assert.equal((await t.service.start(t.request)).status, 'started')
  assert.deepEqual(t.saved(), {
    mode: 'ahead',
    engine: 'whisperx',
    device: 'cpu',
    prepareNext: true,
  })
  assert.equal(t.prepared[0]!.engine, 'whisperx')
  const fresh = fixture(undefined, { ...legacy, transcribeNext: false })
  assert.equal((await fresh.service.start(fresh.request)).status, 'started')
  assert.equal(fresh.saved()!.mode, 'auto', 'the legacy false default is not explicit manual')
})

test('changing legacy online preparation during its capability check cannot commit the old profile', async () => {
  const legacy: SourcePreparation = {
    cacheNext: false,
    transcribeNext: true,
    engine: 'whisperx',
    device: 'cpu',
  }
  const t = fixture(undefined, legacy)
  const pending = deferred<ComponentCheck>()
  t.setProbe(async () => pending.promise)
  const result = t.service.start(t.request)
  t.setLegacy({ ...legacy, transcribeNext: false })
  pending.resolve(checked())
  assert.equal((await result).status, 'stale')
  assert.equal(t.saved(), undefined)
  assert.deepEqual(t.prepared, [])
})

test('formal imports/manual corrections are reused without any probe or replacement job', async () => {
  const t = fixture()
  const document = ready(t)
  document.job = t.job({ status: 'completed', autoApply: false })
  t.setState(document)
  assert.equal((await t.service.start({ ...t.request, explicit: true })).status, 'reused')
  assert.equal(t.state(), document)
  assert.equal(t.probes(), 0)
  assert.deepEqual(t.prepared, [])
  assert.deepEqual(t.matched, [t.request.episodeId])
  assert.equal(t.saved(), undefined)
})

test('canceled and failed jobs never restart from automatic or explicit convenience actions', async () => {
  for (const status of ['canceled', 'canceling', 'failed'] as const) {
    const t = fixture()
    t.setState({ ...t.state(), job: t.job({ status }) })
    for (const explicit of [false, true])
      assert.equal((await t.service.start({ ...t.request, explicit })).status, 'stopped')
    assert.equal(t.probes(), 0)
    assert.deepEqual(t.prepared, [])
  }
})

test('recovered queued jobs with missing component show setup and resume only after a component is selected', async () => {
  for (const status of ['queued', 'running'] as const) {
    const t = fixture()
    const state = { ...t.state(), configured: false, job: t.job({ status }) }
    t.setState(state)
    const result = await t.service.start(t.request)
    assert.equal(result.status, 'missing-component')
    assert.equal(result.transcription, state)
    assert.equal(t.probes(), 0)
    assert.deepEqual(t.prepared, [])
    assert.deepEqual(t.opened, [])
    assert.equal(t.saved(), undefined)
    t.setState({ ...state, configured: true })
    assert.equal((await t.service.start(t.request)).status, 'started')
    assert.deepEqual(t.opened, [[t.request.episodeId, true]])
  }
})

test('partial generated documents resume the episode-switch task instead of pretending it is complete', async () => {
  const t = fixture()
  const partial = ready(t)
  partial.job = t.job({ status: 'canceled', error: EPISODE_SWITCHED, engine: 'whisperx' })
  t.setState(partial)
  assert.equal((await t.service.start(t.request)).status, 'started')
  assert.equal(t.prepared[0]!.engine, 'whisperx', 'resume retains its original engine')
  assert.equal(t.probes(), 1)
})

test('a component check cannot outlive a chapter switch, shutdown, or manual settings change', async () => {
  for (const action of ['switch', 'close', 'manual'] as const) {
    const t = fixture()
    const pending = deferred<ComponentCheck>()
    let signal: AbortSignal | undefined
    t.setProbe(async (value) => {
      signal = value
      return pending.promise
    })
    const result = t.service.start(t.request)
    if (action === 'switch') {
      t.setCurrent(false)
      t.service.cancel()
    } else if (action === 'close') t.service.close()
    else t.setSettings({ mode: 'manual', engine: 'whisperx', device: 'cpu', prepareNext: false })
    pending.resolve(checked())
    assert.equal((await result).status, 'stale')
    if (action !== 'manual') assert.equal(signal?.aborted, true)
    assert.deepEqual(t.prepared, [])
    assert.deepEqual(t.opened, [])
    assert.deepEqual(t.matched, [])
  }
})

test('a manual cancellation or imported document during a probe wins the final commit', async () => {
  for (const action of ['cancel', 'import'] as const) {
    const t = fixture()
    const pending = deferred<ComponentCheck>()
    t.setProbe(async () => pending.promise)
    const result = t.service.start(t.request)
    t.setState(
      action === 'cancel' ? { ...t.state(), job: t.job({ status: 'canceled' }) } : ready(t),
    )
    pending.resolve(checked())
    assert.equal((await result).status, action === 'cancel' ? 'stopped' : 'reused')
    assert.deepEqual(t.prepared, [])
    assert.equal(t.saved(), undefined)
  }
})

test('session cancellation aborts a check without a job and ordinary playback never restarts it', async () => {
  const t = fixture()
  const pending = deferred<ComponentCheck>()
  let signal: AbortSignal | undefined
  t.setProbe(async (value) => {
    signal = value
    return pending.promise
  })
  const preparing = t.service.start(t.request)
  const target = {
    episodeId: t.request.episodeId,
    audioHash: t.request.audioHash,
    sessionId: t.request.sessionId,
  }
  const stopped = t.service.stop(target)
  assert.equal(stopped.job, null)
  assert.equal(signal?.aborted, true)
  assert.equal(t.pauses(), 1)
  pending.resolve(checked())
  assert.equal((await preparing).status, 'stale')
  assert.equal((await t.service.start(t.request)).status, 'stopped')
  assert.equal(
    (await t.service.start({ ...t.request, sessionId: randomUUID() })).status,
    'stopped',
    'reopening the same episode does not undo user cancellation',
  )
  assert.equal(t.probes(), 1)
  assert.deepEqual(t.prepared, [])
  assert.equal(t.saved(), undefined)
  t.setProbe(async () => checked())
  assert.equal((await t.service.start({ ...t.request, explicit: true })).status, 'started')
  assert.equal(t.prepared.length, 1)
})

test('stale session cancellation cannot abort the current check or stop a different episode', async () => {
  const t = fixture()
  const pending = deferred<ComponentCheck>()
  let signal: AbortSignal | undefined
  t.setProbe(async (value) => {
    signal = value
    return pending.promise
  })
  const preparing = t.service.start(t.request)
  t.setCurrent(false)
  assert.throws(() => t.service.stop(t.request), { code: 'CONFLICT' })
  assert.equal(signal?.aborted, false)
  assert.equal(t.pauses(), 0)
  assert.equal(t.stops(), 0)
  t.setCurrent(true)
  pending.resolve(checked())
  assert.equal((await preparing).status, 'started')
})

test('a delayed automatic start from an old player cannot abort the current component check', async () => {
  const t = fixture()
  const pending = deferred<ComponentCheck>()
  let signal: AbortSignal | undefined
  t.setProbe(async (value) => {
    signal = value
    return pending.promise
  })
  const preparing = t.service.start(t.request)
  t.setCurrent(false)
  assert.equal((await t.service.start({ ...t.request, sessionId: randomUUID() })).status, 'stale')
  assert.equal(signal?.aborted, false)
  assert.equal(t.probes(), 1)
  t.setCurrent(true)
  pending.resolve(checked())
  assert.equal((await preparing).status, 'started')
})

test('canceling a running partial job retains formal text and requires the explicit task retry controls', async () => {
  const t = fixture()
  const partial = ready(t)
  partial.job = t.job({ status: 'running' })
  t.setState(partial)
  const result = t.service.stop(t.request)
  assert.equal(result.job?.status, 'canceled')
  assert.equal(result.transcript, partial.transcript)
  assert.equal((await t.service.start(t.request)).status, 'stopped')
  assert.equal((await t.service.start({ ...t.request, explicit: true })).status, 'stopped')
  assert.equal(t.probes(), 0)
  assert.deepEqual(t.prepared, [])
})

test('missing/unusable components do not save an assumed engine or admit a job', async () => {
  for (const check of [null, { ...checked(), capabilities: [] }]) {
    const t = fixture()
    t.setProbe(async () => check)
    assert.equal(
      (await t.service.start(t.request)).status,
      check === null ? 'missing-component' : 'unavailable',
    )
    assert.deepEqual(t.prepared, [])
    assert.equal(t.saved(), undefined)
  }
  const check = checked()
  assert.deepEqual(automaticSubtitleProfile(check), {
    mode: 'auto',
    engine: 'paraformer',
    device: 'cpu',
    prepareNext: false,
  })
})

test('automatic subtitle IPC requires an exact live session target and bounded integer position', () => {
  const { request } = fixture()
  validateRequest('transcription:start-automatic-subtitles', [request])
  validateRequest('transcription:start-automatic-subtitles', [{ ...request, explicit: true }])
  for (const patch of [
    { episodeId: 'path.wav' },
    { audioHash: 'A'.repeat(64) },
    { sessionId: '' },
    { explicit: undefined },
    { explicit: 1 },
    { positionMs: -1 },
    { positionMs: 1.5 },
    { positionMs: 3.6e10 + 1 },
    { positionMs: Number.NaN },
    { positionMs: undefined },
    { engine: 'paraformer' },
    { audioPath: 'C:/arbitrary.wav' },
  ])
    assert.throws(
      () => validateRequest('transcription:start-automatic-subtitles', [{ ...request, ...patch }]),
      { code: 'INVALID_REQUEST' },
    )
  assert.throws(() =>
    validateRequest('transcription:start-automatic-subtitles', [request, request]),
  )
  for (const channel of ['transcription:preparation', 'transcription:prepare-and-start']) {
    const settings = { mode: 'auto', engine: 'whisperx', device: 'cpu', prepareNext: false }
    validateRequest(channel, [
      channel === 'transcription:preparation'
        ? { id: request.episodeId, settings }
        : {
            episodeId: request.episodeId,
            audioHash: request.audioHash,
            sessionId: request.sessionId,
            settings,
          },
    ])
  }
})

test('cancel automatic subtitle IPC rejects old identities, paths, optional start flags and extra arguments', () => {
  const { request } = fixture()
  const target = {
    episodeId: request.episodeId,
    audioHash: request.audioHash,
    sessionId: request.sessionId,
  }
  validateRequest('transcription:cancel-automatic-subtitles', [target])
  for (const patch of [
    { episodeId: 'audio.mp3' },
    { audioHash: 'A'.repeat(64) },
    { sessionId: '' },
    { sessionId: undefined },
    { explicit: true },
    { positionMs: 0 },
    { jobId: randomUUID() },
    { path: 'C:/arbitrary.mp3' },
  ])
    assert.throws(
      () => validateRequest('transcription:cancel-automatic-subtitles', [{ ...target, ...patch }]),
      { code: 'INVALID_REQUEST' },
    )
  for (const args of [[], [target, target], [null], [undefined]])
    assert.throws(() => validateRequest('transcription:cancel-automatic-subtitles', args), {
      code: 'INVALID_REQUEST',
    })
})
