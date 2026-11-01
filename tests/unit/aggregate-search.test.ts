import assert from 'node:assert/strict'
import test from 'node:test'
import { aggregateSearch } from '../../src/renderer/src/aggregate-search'
import type { Result } from '../../src/shared/contracts'

test('aggregate discovery publishes partial results, isolates failures and bounds concurrency', async () => {
  const controller = new AbortController()
  const pending: Array<() => void> = []
  let active = 0,
    maximum = 0
  const seen: string[][] = []
  const work = aggregateSearch({
    sources: ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id })),
    signal: controller.signal,
    request: async (source): Promise<Result<string[]>> => {
      active++
      maximum = Math.max(maximum, active)
      await new Promise<void>((done) => pending.push(done))
      active--
      return source === 'b'
        ? { ok: false, error: { code: 'INTERNAL', message: '独立来源失败' } }
        : { ok: true, value: [source, source] }
    },
    cancel: async () => {},
    key: (value) => value,
    onProgress: (progress) => {
      seen.push(progress.items)
    },
  })
  assert.equal(pending.length, 3)
  pending.shift()!()
  await new Promise<void>((done) => setImmediate(done))
  assert.deepEqual(seen.at(-1), ['a'])
  assert.equal(pending.length, 3)
  pending.splice(0).forEach((done) => done())
  const result = await work
  assert.equal(maximum, 3)
  assert.deepEqual(result.items, ['a', 'c', 'd'])
  assert.deepEqual(result.errors, [{ source: 'b', message: '独立来源失败' }])
  assert.equal(result.completed, 4)
})

test('cancel forwards each in-flight request and prevents queued sources and stale publications', async () => {
  const controller = new AbortController(),
    started: string[] = [],
    canceled: string[] = [],
    pending: Array<() => void> = []
  let publications = 0
  const work = aggregateSearch({
    sources: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, name: id })),
    signal: controller.signal,
    request: async (_source, requestId): Promise<Result<string[]>> => {
      started.push(requestId)
      await new Promise<void>((done) => pending.push(done))
      return { ok: true, value: ['late'] }
    },
    cancel: async (requestId) => {
      canceled.push(requestId)
    },
    key: (value) => value,
    onProgress: () => {
      publications++
    },
  })
  controller.abort()
  pending.forEach((done) => done())
  const result = await work
  assert.deepEqual(canceled.sort(), started.sort())
  assert.equal(started.length, 3)
  assert.equal(publications, 1)
  assert.deepEqual(result.items, [])
})

test('discovery enforces its result budget while keeping actual source failures', async () => {
  const result = await aggregateSearch({
    sources: [{ id: 'a', name: 'A' }],
    signal: new AbortController().signal,
    limit: 2,
    request: async () => ({ ok: true, value: ['1', '2', '3'] }),
    cancel: async () => {},
    key: (value) => value,
    onProgress: () => {},
  })
  assert.deepEqual(result.items, ['1', '2'])
  assert.equal(result.truncated, true)
})
