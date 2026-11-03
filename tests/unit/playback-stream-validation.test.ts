import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { validateRequest } from '../../src/shared/validation'

test('playback open and cancellation accept an optional request UUID but no media identities or paths', () => {
  const id = randomUUID(),
    requestId = randomUUID()
  for (const channel of ['player:open-episode', 'player:cancel-open']) {
    for (const request of [{ id }, { id, requestId }])
      assert.doesNotThrow(() => validateRequest(channel, [request]))
    for (const request of [
      { id, requestId: 'old' },
      { id, requestId: undefined },
      { id, path: 'C:/untrusted.part' },
      { id, url: 'https://untrusted.example/' },
      { id, proof: { bytes: 32, sha256: 'a'.repeat(64) } },
    ])
      assert.throws(() => validateRequest(channel, [request]), { code: 'INVALID_REQUEST' })
  }
})

test('provisional source queries and release are scoped to one opaque session and events cannot be invoked', () => {
  const sessionId = randomUUID()
  for (const channel of ['player:source-state', 'player:release-source']) {
    assert.doesNotThrow(() => validateRequest(channel, [{ sessionId }]))
    for (const args of [
      [],
      [{ id: sessionId }],
      [{ sessionId: 'invalid' }],
      [{ sessionId, episodeId: randomUUID() }],
      [{ sessionId, totalBytes: 100 }],
    ])
      assert.throws(() => validateRequest(channel, args), { code: 'INVALID_REQUEST' })
  }
  assert.throws(() => validateRequest('player:source-changed', [{ sessionId, status: 'ready' }]), {
    code: 'INVALID_REQUEST',
  })
})
