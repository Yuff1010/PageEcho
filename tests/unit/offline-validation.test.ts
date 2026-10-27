import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { validateRequest } from '../../src/shared/validation'

const id = randomUUID(),
  profile = { engine: 'paraformer', device: 'cpu' }
const preview = {
  requestId: randomUUID(),
  bookId: id,
  selection: { kind: 'all' },
  profile,
  audioBudgetBytes: 5 * 1024 ** 3,
}
const invalid = (channel: string, request: unknown) =>
  assert.throws(() => validateRequest(channel, [request]), { code: 'INVALID_REQUEST' })

test('offline IPC accepts bounded selections and control generations without renderer paths', () => {
  validateRequest('offline:preview', [preview])
  validateRequest('offline:preview', [
    { ...preview, selection: { kind: 'range', from: 101, to: 1100 } },
  ])
  validateRequest('offline:preview', [
    {
      ...preview,
      selection: { kind: 'ids', episodeIds: Array.from({ length: 1000 }, () => randomUUID()) },
    },
  ])
  validateRequest('offline:preview-cancel', [{ requestId: preview.requestId }])
  validateRequest('offline:create', [{ token: id }])
  validateRequest('offline:list', [{ page: 0, activeOnly: true }])
  validateRequest('offline:get', [{ id, itemPage: 9 }])
  validateRequest('offline:release', [{ id, revision: 1 }])
  for (const action of ['pause', 'resume', 'cancel', 'retry-failed'])
    validateRequest('offline:update', [{ id, revision: 2, action }])
  validateRequest('offline:update', [
    { id, revision: 2, action: 'set-budget', audioBudgetBytes: 1024 ** 4 },
  ])
})

test('offline IPC rejects unbounded lists, duplicate identities, coercion and unsolicited filesystem fields', () => {
  for (const selection of [
    { kind: 'all', path: 'C:/book' },
    { kind: 'range', from: 1, to: 1001 },
    { kind: 'range', from: 3, to: 2 },
    { kind: 'range', from: '1', to: 3 },
    { kind: 'ids', episodeIds: [id, id] },
    { kind: 'ids', episodeIds: [] },
    { kind: 'ids', episodeIds: Array.from({ length: 1001 }, () => randomUUID()) },
    { kind: 'ids', episodeIds: ['https://provider.invalid/episode'] },
  ])
    invalid('offline:preview', { ...preview, selection })
  for (const audioBudgetBytes of [-1, Infinity, NaN, '1024', 1024 ** 4 + 1])
    invalid('offline:preview', { ...preview, audioBudgetBytes })
  for (const field of ['path', 'url', 'audioHash', 'workerScript'])
    invalid('offline:preview', { ...preview, [field]: 'untrusted' })
  invalid('offline:preview', { ...preview, profile: { ...profile, device: ['cpu'] } })
  invalid('offline:create', { token: id, episodeIds: [id] })
  invalid('offline:release', { id, revision: 1, deleteFiles: true })
  invalid('offline:list', { page: 0, activeOnly: 'true' })
  invalid('offline:get', { id, itemPage: 11 })
  for (const revision of [0, 1.5, '2', 1e10])
    invalid('offline:update', { id, revision, action: 'cancel' })
  invalid('offline:update', { id, revision: 1, action: 'resume', audioBudgetBytes: 100 })
  invalid('offline:update', { id, revision: 1, action: 'delete' })
  invalid('offline:arbitrary', { id })
  assert.throws(() => validateRequest('offline:list', [{ page: 0, activeOnly: true }, {}]), {
    code: 'INVALID_REQUEST',
  })
})
