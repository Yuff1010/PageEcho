import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { validateRequest } from '../../src/shared/validation'

test('component installation IPC permits profiles and opaque IDs without renderer file paths', () => {
  validateRequest('component-install:state', [])
  for (const engine of ['paraformer', 'whisperx'])
    for (const device of ['cpu', 'cuda'])
      validateRequest('component-install:choose', [{ engine, device }])
  for (const action of ['start', 'cancel', 'activate']) {
    const channel = `component-install:${action}`
    validateRequest(channel, [{ id: randomUUID() }])
    for (const request of [
      { id: '../../component.json' },
      { id: randomUUID(), path: 'C:/untrusted.zip' },
      {},
      null,
    ])
      assert.throws(() => validateRequest(channel, [request]), { code: 'INVALID_REQUEST' })
    assert.throws(() => validateRequest(channel, [{ id: randomUUID() }, {}]), {
      code: 'INVALID_REQUEST',
    })
  }
})

test('component installation IPC rejects extra fields, coercion and unknown commands', () => {
  for (const request of [
    { engine: 'paraformer', device: 'cpu', url: 'https://untrusted.invalid/package.zip' },
    { engine: ['paraformer'], device: 'cpu' },
    { engine: 'paraformer', device: ['cpu'] },
    { engine: 'other', device: 'cpu' },
    { engine: 'whisperx', device: 'auto' },
    { engine: 'paraformer' },
    null,
  ])
    assert.throws(() => validateRequest('component-install:choose', [request]), {
      code: 'INVALID_REQUEST',
    })
  for (const [channel, args] of [
    ['component-install:state', [{}]],
    ['component-install:choose', []],
    ['component-install:arbitrary', []],
  ] as const)
    assert.throws(() => validateRequest(channel, [...args]), { code: 'INVALID_REQUEST' })
})
