import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { SourceBrowser } from '../../src/main/sources/source-browser'
import { SourceError, type SourceAdapter } from '../../src/shared/sources'
import { validateRequest } from '../../src/shared/validation'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('a replaced source task waits for cleanup and never publishes an obsolete response', async () => {
  const browser = new SourceBrowser({} as SourceAdapter, () => {})
  const started = deferred(),
    release = deferred()
  let active = 0,
    maximum = 0
  const first = browser
    .run('a', async (signal) => {
      active++
      maximum = Math.max(maximum, active)
      started.resolve()
      await release.promise
      assert.equal(signal.aborted, true)
      active--
      return 'obsolete'
    })
    .catch((error) => error.code)
  await started.promise
  const skipped = browser
    .run('b', async () => {
      assert.fail('Superseded queued task started')
    })
    .catch((error) => error.code)
  const latest = browser.run('c', async () => {
    active++
    maximum = Math.max(maximum, active)
    active--
    return 'current'
  })
  release.resolve()
  assert.equal(await first, 'SOURCE_CANCELED')
  assert.equal(await skipped, 'SOURCE_CANCELED')
  assert.equal(await latest, 'current')
  assert.equal(maximum, 1)
  await browser.close()
})

test('late cancellation cannot stop a newer source request and shutdown rejects new work', async () => {
  let closed = 0
  const browser = new SourceBrowser({} as SourceAdapter, () => {
    closed++
  })
  const started = deferred(),
    release = deferred()
  const task = browser.run('current', async (signal) => {
    started.resolve()
    await release.promise
    assert.equal(signal.aborted, false)
    return 42
  })
  await started.promise
  browser.cancel('old')
  release.resolve()
  assert.equal(await task, 42)
  await browser.close()
  await browser.close()
  assert.equal(closed, 1)
  await assert.rejects(
    browser.run('new', async () => 1),
    { code: 'SOURCE_CANCELED' },
  )
})

test('a failed or canceled source operation permits retry without a stuck busy owner', async () => {
  const release = deferred(),
    started = deferred()
  const browser = new SourceBrowser({} as SourceAdapter, () => release.resolve())
  await assert.rejects(
    browser.run('failed', async () => {
      throw new SourceError('SOURCE_UNAVAILABLE', 'offline')
    }),
    { code: 'SOURCE_UNAVAILABLE' },
  )
  assert.equal(await browser.run('retry', async () => 'ok'), 'ok')
  const pending = browser
    .run('cancel', async (signal) => {
      started.resolve()
      await release.promise
      assert.equal(signal.aborted, true)
    })
    .catch((error) => error.code)
  await started.promise
  await assert.rejects(
    browser.run('cancel', async () => 1),
    { code: 'INVALID_SOURCE_REQUEST' },
  )
  await browser.close()
  assert.equal(await pending, 'SOURCE_CANCELED')
})

test('source IPC accepts only the selected source, bounded text, IDs and owned cursor shape', () => {
  const id = randomUUID(),
    common = { id, sourceId: 'ting13', bookId: '39941' }
  validateRequest('source:search', [{ id, sourceId: 'ting13', query: '书名', cursor: null }])
  validateRequest('source:book', [common])
  validateRequest('source:episodes', [{ ...common, cursor: randomUUID() }])
  validateRequest('source:cancel', [{ id }])
  for (const [channel, request] of [
    ['source:book', { ...common, url: 'https://attacker.invalid' }],
    ['source:book', { ...common, sourceId: 'arbitrary' }],
    ['source:book', { ...common, bookId: '../etc' }],
    ['source:search', { id, sourceId: 'ting13', query: ' ', cursor: null }],
    ['source:search', { id, sourceId: 'ting13', query: '书'.repeat(21), cursor: null }],
    ['source:episodes', { ...common, cursor: 'https://www.ting13.cc/' }],
    ['source:cancel', { id, cookie: 'secret' }],
    ['source:resolve-arbitrary-url', { id }],
  ] as [string, unknown][])
    assert.throws(() => validateRequest(channel, [request]), { code: 'INVALID_REQUEST' })
})
