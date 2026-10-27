import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { validateRequest } from '../../src/shared/validation'

const target = { episodeId: randomUUID(), audioHash: 'a'.repeat(64) }
const prepared = {
  ...target,
  sessionId: randomUUID(),
  settings: {
    mode: 'ahead',
    engine: 'paraformer',
    device: 'cuda',
    prepareNext: true,
  },
}
const acoustic = {
  ...target,
  originalId: randomUUID(),
  revision: 1,
  segmentId: 's1',
  device: 'cpu',
}

test('prepare-and-start accepts only an explicit current session and exact subtitle profile', () => {
  validateRequest('transcription:prepare-and-start', [prepared])
  for (const input of [
    { ...prepared, sessionId: '' },
    { ...prepared, sessionId: undefined },
    { ...prepared, sessionId: 3 },
    { ...prepared, audioHash: 'A'.repeat(64) },
    { ...prepared, settings: { ...prepared.settings, deferCurrent: true } },
    { ...prepared, settings: { ...prepared.settings, mode: 'live' } },
    { ...prepared, settings: { ...prepared.settings, engine: 'auto' } },
    { ...prepared, settings: { ...prepared.settings, device: 'auto' } },
    { ...prepared, settings: { ...prepared.settings, prepareNext: 1 } },
    { ...prepared, audioPath: 'C:/arbitrary.mp3' },
  ])
    assert.throws(() => validateRequest('transcription:prepare-and-start', [input]), {
      code: 'INVALID_REQUEST',
    })
})

test('acoustic IPC accepts registered identities only and never accepts renderer text or file paths', () => {
  validateRequest('acoustic:state', [target])
  validateRequest('acoustic:start', [acoustic])
  validateRequest('acoustic:cancel', [{ id: randomUUID() }])
  validateRequest('acoustic:apply', [{ id: randomUUID(), revision: 1 }])
  const restore = { ...target, originalId: acoustic.originalId, revision: 1, segmentId: 's1' }
  validateRequest('acoustic:restore', [{ ...restore, historyId: randomUUID() }])
  for (const patch of [
    { originalId: 'missing' },
    { revision: 0 },
    { revision: 1.5 },
    { revision: 1e10 },
    { audioHash: 'wrong' },
    { segmentId: '' },
    { segmentId: 's'.repeat(129) },
    { device: 'auto' },
    { text: '未经确认的正文' },
    { audioPath: 'C:/other.mp3' },
    { range: { startMs: 0, endMs: 99999999 } },
  ])
    assert.throws(() => validateRequest('acoustic:start', [{ ...acoustic, ...patch }]), {
      code: 'INVALID_REQUEST',
    })
  assert.throws(() =>
    validateRequest('acoustic:apply', [{ id: randomUUID(), revision: 1, accepted: true }]),
  )
  assert.throws(() =>
    validateRequest('acoustic:restore', [{ ...acoustic, historyId: randomUUID() }]),
  )
  assert.throws(() => validateRequest('acoustic:start', [acoustic, acoustic]))
})
