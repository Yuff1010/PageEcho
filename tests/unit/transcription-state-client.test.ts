import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TranscriptionStateClient } from '../../src/renderer/src/transcription-state-client'
import type { Result } from '../../src/shared/contracts'
import type {
  TranscriptionSyncRequest,
  TranscriptionSyncState,
} from '../../src/shared/transcription'
import { validateRequest } from '../../src/shared/validation'

const target = { episodeId: 'c2365fb3-ec5a-42c7-97f6-53fdc30d3400', audioHash: 'a'.repeat(64) }
const id = '27d8c405-46ab-450d-bab3-778fbf859893'
function reply(revision = 1): Result<TranscriptionSyncState> {
  return {
    ok: true,
    value: {
      configured: true,
      job: null,
      transcript: {
        status: 'ready',
        transcript: {
          id,
          episodeId: target.episodeId,
          revision,
          importedAt: '2026-10-24T00:00:00Z',
          document: {
            version: 1,
            audioHash: target.audioHash,
            kind: 'manual',
            coverage: [{ startMs: 0, endMs: 2000 }],
            segments: [{ id: 's1', startMs: 0, endMs: 1000, text: `修订${revision}` }],
          },
        },
      },
    },
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('concurrent subscribers share the complete read and same-revision refresh retains document identity', async () => {
  const gate = deferred<Result<TranscriptionSyncState>>()
  const requests: TranscriptionSyncRequest[] = []
  const client = new TranscriptionStateClient(async (request) => {
    requests.push(request)
    if (requests.length === 1) return gate.promise
    return {
      ok: true,
      value: {
        configured: true,
        job: null,
        transcript: {
          status: 'unchanged',
          version: { id, revision: 1 },
        },
      },
    }
  })
  const a = client.read(target),
    b = client.read(target)
  assert.equal(a, b)
  assert.equal(requests.length, 1)
  gate.resolve(reply())
  const first = await a
  const second = await client.read(target)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  if (first.ok && second.ok) assert.equal(first.value, second.value)
  assert.deepEqual(requests[1], { ...target, knownTranscript: { id, revision: 1 } })
})

test('a notification arriving during a read forces a follow-up and returns the latest revision', async () => {
  const gate = deferred<Result<TranscriptionSyncState>>()
  const requests: TranscriptionSyncRequest[] = []
  const client = new TranscriptionStateClient(async (request) => {
    requests.push(request)
    return requests.length === 1 ? gate.promise : reply(2)
  })
  const pending = client.read(target)
  client.invalidate(target)
  assert.equal(client.read(target), pending)
  gate.resolve(reply(1))
  const result = await pending
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[1]?.knownTranscript, { id, revision: 1 })
  assert.ok(result.ok && result.value.transcript.status === 'ready')
  assert.equal(result.value.transcript.transcript.revision, 2)
})

test('a newer notification is checked after an in-flight failure, with bounded error retry', async () => {
  const gate = deferred<Result<TranscriptionSyncState>>()
  let calls = 0
  const client = new TranscriptionStateClient(async () => {
    calls++
    return calls === 1 ? gate.promise : reply(2)
  })
  const pending = client.read(target)
  client.invalidate(target)
  gate.resolve({ ok: false, error: { code: 'FILE_CHANGED', message: 'old read failed' } })
  const result = await pending
  assert.equal(calls, 2)
  assert.ok(result.ok && result.value.transcript.status === 'ready')
  assert.equal(result.value.transcript.transcript.revision, 2)
  let failures = 0
  const failed = new TranscriptionStateClient(async () => {
    failures++
    return { ok: false, error: { code: 'FILE_CHANGED', message: 'stable failure' } }
  })
  assert.equal((await failed.read(target)).ok, false)
  assert.equal(failures, 1)
})

test('missing local content cannot be replaced with an unchanged marker', async () => {
  let calls = 0
  const client = new TranscriptionStateClient(async () => {
    calls++
    return calls === 1
      ? {
          ok: true,
          value: {
            configured: true,
            job: null,
            transcript: { status: 'unchanged', version: { id, revision: 1 } },
          },
        }
      : reply()
  })
  const result = await client.read(target)
  assert.equal(calls, 2)
  assert.ok(result.ok && result.value.transcript.status === 'ready')
})

test('component invalidation during a shared read refreshes configured status', async () => {
  const gate = deferred<Result<TranscriptionSyncState>>()
  let calls = 0
  const client = new TranscriptionStateClient(async () => {
    calls++
    return calls === 1 ? gate.promise : reply(1)
  })
  const pending = client.read(target)
  client.invalidate(target)
  const next = client.read(target)
  const old = reply(1)
  assert.ok(old.ok)
  old.value.configured = false
  gate.resolve(old)
  const result = await next
  assert.equal(next, pending)
  assert.equal(calls, 2)
  assert.ok(result.ok)
  assert.equal(result.value.configured, true)
})

test('a transport rejection does not swallow an invalidation received in flight', async () => {
  const gate = deferred<Result<TranscriptionSyncState>>()
  let calls = 0
  const client = new TranscriptionStateClient(async () => {
    calls++
    if (calls === 1) {
      await gate.promise
      throw new Error('old transport request failed')
    }
    return reply(2)
  })
  const pending = client.read(target)
  client.invalidate(target)
  gate.resolve(reply(1))
  const result = await pending
  assert.equal(calls, 2)
  assert.ok(result.ok && result.value.transcript.status === 'ready')
  assert.equal(result.value.transcript.transcript.revision, 2)
})

test('a failed refresh is reported and a later retry keeps the known transcript version', async () => {
  const requests: TranscriptionSyncRequest[] = []
  const client = new TranscriptionStateClient(async (request) => {
    requests.push(request)
    if (requests.length === 2)
      return { ok: false, error: { code: 'FILE_CHANGED', message: 'changed' } }
    return reply()
  })
  await client.read(target)
  assert.equal((await client.read(target)).ok, false)
  assert.equal((await client.read(target)).ok, true)
  assert.deepEqual(requests[2]?.knownTranscript, { id, revision: 1 })
})

test('bounded cache evicts idle documents and audio versions remain independent', async () => {
  const requests: TranscriptionSyncRequest[] = []
  const client = new TranscriptionStateClient(async (request) => {
    requests.push(request)
    return reply()
  }, 1)
  await client.read(target)
  await client.read({ ...target, audioHash: 'b'.repeat(64) })
  await client.read(target)
  assert.equal(requests[2]?.knownTranscript, undefined)
})

test('conditional sync IPC validates identity, revision and the complete request shape', () => {
  validateRequest('transcription:sync', [target])
  validateRequest('transcription:summary', [target])
  validateRequest('transcription:sync', [{ ...target, knownTranscript: { id, revision: 1 } }])
  for (const request of [
    { ...target, knownTranscript: { id, revision: 0 } },
    { ...target, knownTranscript: { id, revision: 1.5 } },
    { ...target, knownTranscript: { id: 'arbitrary-path', revision: 1 } },
    { ...target, knownTranscript: { id, revision: 1, path: 'C:/private' } },
    { ...target, knownTranscript: undefined },
    { ...target, path: 'C:/private' },
  ])
    assert.throws(() => validateRequest('transcription:sync', [request]), {
      code: 'INVALID_REQUEST',
    })
})
