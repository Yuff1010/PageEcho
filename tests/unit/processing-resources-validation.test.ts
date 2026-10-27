import assert from 'node:assert/strict'
import test from 'node:test'
import { validateRequest } from '../../src/shared/validation'

const policy = { cpuThreads: 4, lowPriority: false, backgroundIdleOnly: false }
const invalid = (channel: string, args: unknown[]) =>
  assert.throws(() => validateRequest(channel, args), { code: 'INVALID_REQUEST' })
test('resource IPC bounds CPU choices and keeps pause independent of the processing policy', () => {
  validateRequest('resources:state', [])
  for (const cpuThreads of [1, 2, 4])
    validateRequest('resources:policy', [{ revision: 1, policy: { ...policy, cpuThreads } }])
  validateRequest('resources:policy', [
    { revision: 2, policy: { cpuThreads: 1, lowPriority: true, backgroundIdleOnly: true } },
  ])
  for (const paused of [true, false]) validateRequest('resources:paused', [{ revision: 3, paused }])
  invalid('resources:state', [{}])
  invalid('resources:policy', [])
  invalid('resources:paused', [{ revision: 1, paused: false, policy }])
})
test('resource IPC rejects invalid revisions, limits, foreign fields and implicit coercion', () => {
  for (const revision of [0, -1, 1.5, NaN, Infinity, '1', 1e10]) {
    invalid('resources:policy', [{ revision, policy }])
    invalid('resources:paused', [{ revision, paused: true }])
  }
  for (const cpuThreads of [0, 3, 8, 1.5, '2', null])
    invalid('resources:policy', [{ revision: 1, policy: { ...policy, cpuThreads } }])
  for (const bad of [
    { ...policy, lowPriority: 1 },
    { ...policy, backgroundIdleOnly: 'true' },
    { ...policy, device: 'cpu' },
    { ...policy, engine: 'paraformer' },
    { ...policy, cpuPercent: 25 },
    { cpuThreads: 2, lowPriority: false },
  ])
    invalid('resources:policy', [{ revision: 1, policy: bad }])
  invalid('resources:policy', [
    { revision: 1, policy },
    { revision: 2, policy },
  ])
  invalid('resources:paused', [{ revision: 1, paused: 'true' }])
  invalid('resources:paused', [{ revision: 1, paused: true, pid: 123 }])
  invalid('resources:arbitrary', [{ revision: 1, paused: true }])
})
