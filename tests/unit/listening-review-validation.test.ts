import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { emptyListeningReviewEntry } from '../../src/shared/listening-review'
import { validateRequest } from '../../src/shared/validation'

const base = { episodeId: randomUUID(), audioHash: 'a'.repeat(64) }
const save = {
  ...base,
  reviewId: randomUUID(),
  revision: 1,
  action: 'feedback',
  sampleId: randomUUID(),
  entry: emptyListeningReviewEntry(),
}
const invalid = (channel: string, request: unknown, args = [request]) =>
  assert.throws(() => validateRequest(channel, args), { code: 'INVALID_REQUEST' })

test('review IPC accepts only bound snapshots and explicit feedback or added sample actions', () => {
  validateRequest('listening:review-get', [base])
  validateRequest('listening:review-get', [{ ...base, reviewId: randomUUID() }])
  validateRequest('listening:review-prepare', [{ ...base, transcriptRevision: 3 }])
  validateRequest('listening:review-save', [save])
  validateRequest('listening:review-save', [
    {
      ...base,
      reviewId: save.reviewId,
      revision: 2,
      action: 'add-sample',
      segmentId: 'asr:stable-id',
    },
  ])
  invalid('listening:review-get', { ...base, path: 'C:\\arbitrary.wav' })
  invalid('listening:review-get', { ...base, audioHash: 'unbound' })
  invalid('listening:review-get', base, [base, base])
  invalid('listening:review-prepare', { ...base, transcriptRevision: 0 })
  invalid('listening:review-save', { ...save, revision: 1.5 })
  invalid('listening:review-save', { ...save, action: 'delete' })
  invalid('listening:review-save', { ...save, segmentId: 'also-present' })
})

test('review IPC rejects forged quality fields, unbounded text and invalid human boundary values', () => {
  for (const entry of [
    { ...save.entry, acceptance: 'passed' },
    { ...save.entry, listened: 1 },
    { ...save.entry, spokenText: 'x'.repeat(10001) },
    { ...save.entry, notes: 'embedded\0null' },
    { ...save.entry, sync: 'passed' },
    { ...save.entry, humanStartMs: NaN },
    { ...save.entry, humanEndMs: Infinity },
    { ...save.entry, humanStartMs: -1 },
    { ...save.entry, humanEndMs: 1.5 },
  ])
    invalid('listening:review-save', { ...save, entry })
  invalid('listening:review-save', { ...save, acceptance: 'passed' })
  invalid('listening:review-get', base, [])
})
