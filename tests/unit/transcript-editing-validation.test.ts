import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { validateRequest } from '../../src/shared/validation'

const target = { episodeId: randomUUID(), audioHash: 'a'.repeat(64) },
  revision = { ...target, revision: 1 },
  commandId = randomUUID()
const edit = {
  ...revision,
  commandId,
  operation: { kind: 'split', segmentId: '旧句-😀', offset: 2, atMs: 1500 },
}
const replacement = {
  ...revision,
  requestId: randomUUID(),
  scope: { kind: 'book', bookId: randomUUID(), episodeIds: [target.episodeId, randomUUID()] },
  find: '肖炎',
  replacement: '萧炎',
}
test('editing commands admit bounded identities and explicit times, including literal book selections', () => {
  for (const [channel, request] of [
    ['state', target],
    ['alignment-state', target],
    ['change', edit],
    [
      'change',
      {
        ...edit,
        operation: { kind: 'timing', ranges: [{ segmentId: 's1', startMs: 0, endMs: 1000 }] },
      },
    ],
    [
      'change',
      { ...edit, operation: { kind: 'merge', firstId: 's1', secondId: 's2', separator: ' ' } },
    ],
    ['change', { ...edit, operation: { kind: 'text', segmentId: 's1', text: '已确认的文字' } }],
    ['undo', { ...revision, commandId, historyId: randomUUID() }],
    ['redo', { ...revision, commandId, historyId: randomUUID() }],
    ['replacement-preview', replacement],
    ['replacement-preview', { ...replacement, find: '😀'.repeat(100) }],
    ['replacement-page', { token: randomUUID(), page: 199 }],
    ['replacement-apply', { token: randomUUID(), commandId }],
    ['replacement-cancel', { requestId: randomUUID() }],
    [
      'alignment-start',
      { ...revision, requestId: randomUUID(), segmentIds: ['s1', 's2'], device: 'cuda' },
    ],
    ['alignment-cancel', { id: randomUUID() }],
    ['alignment-apply', { id: randomUUID(), revision: 1, commandId }],
  ] as const)
    assert.doesNotThrow(() => validateRequest(`transcript-edit:${channel}`, [request]))
})
test('editing IPC rejects file paths, whole-document writes, coercion, duplicate targets and unbounded work', () => {
  const invalid = (channel: string, value: unknown, args?: unknown[]) =>
    assert.throws(() => validateRequest(`transcript-edit:${channel}`, args ?? [value]), {
      code: 'INVALID_REQUEST',
    })
  invalid('change', { ...edit, audioPath: 'C:/private/audio.mp3' })
  invalid('change', { ...edit, document: { segments: [] } })
  invalid('change', { ...edit, revision: '1' })
  invalid('change', { ...edit, commandId: 'file:///C:/private' })
  invalid('change', { ...edit, operation: { ...edit.operation, offset: 1.5 } })
  invalid('change', { ...edit, operation: { ...edit.operation, atMs: -1 } })
  invalid('change', { ...edit, operation: { ...edit.operation, atMs: Number.MAX_SAFE_INTEGER } })
  invalid('change', {
    ...edit,
    operation: { kind: 'merge', firstId: 's1', secondId: 's1', separator: '' },
  })
  invalid('change', {
    ...edit,
    operation: {
      kind: 'timing',
      ranges: [
        { segmentId: 's1', startMs: 0, endMs: 1 },
        { segmentId: 's1', startMs: 1, endMs: 2 },
      ],
    },
  })
  invalid('change', {
    ...edit,
    operation: {
      kind: 'timing',
      ranges: Array.from({ length: 21 }, (_, i) => ({
        segmentId: `s${i}`,
        startMs: i,
        endMs: i + 1,
      })),
    },
  })
  invalid('change', { ...edit, operation: { kind: 'timing', ranges: [null] } })
  invalid('replacement-preview', { ...replacement, find: '' })
  invalid('replacement-preview', { ...replacement, find: 'a'.repeat(101) })
  invalid('replacement-preview', { ...replacement, find: '😀'.repeat(101) })
  invalid('replacement-preview', { ...replacement, find: '名称\u001f' })
  invalid('replacement-preview', { ...replacement, find: '名称\u007f' })
  invalid('replacement-preview', { ...replacement, find: '名称\ud800' })
  invalid('replacement-preview', { ...replacement, replacement: '\n' })
  invalid('replacement-preview', {
    ...replacement,
    scope: { ...replacement.scope, episodeIds: [target.episodeId, target.episodeId] },
  })
  invalid('replacement-preview', {
    ...replacement,
    scope: { ...replacement.scope, episodeIds: Array.from({ length: 1001 }, () => randomUUID()) },
  })
  invalid('replacement-preview', {
    ...replacement,
    scope: {
      kind: 'book',
      bookId: randomUUID(),
      episodeIds: [target.episodeId],
      url: 'https://example.com',
    },
  })
  invalid('alignment-start', {
    ...revision,
    requestId: randomUUID(),
    segmentIds: ['s1'],
    device: 'auto',
  })
  invalid('alignment-start', {
    ...revision,
    requestId: randomUUID(),
    segmentIds: ['s1'],
    device: 'cpu',
    text: '由客户端偷换已确认文字',
  })
  invalid('state', target, [target, {}])
  invalid('unknown', {})
})
