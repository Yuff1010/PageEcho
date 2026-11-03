import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import filesystem, { mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { ProgressiveMedia } from '../../src/main/sources/progressive-media'

const origin = 'readlisten://app'
async function fixture(context: TestContext, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pageecho progressive '))
  const directory = join(root, 'spool')
  await mkdir(directory)
  const path = join(directory, 'source.part'),
    writer = await open(path, 'wx')
  const registry = new ProgressiveMedia(directory, { waitTimeoutMs: 1000, ...options })
  context.after(async () => {
    await registry.close()
    await writer.close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, directory, path, writer, registry }
}
function request(url: string, range?: string, options: RequestInit = {}) {
  return new Request(url, {
    ...options,
    ...(range === undefined ? {} : { headers: { Range: range } }),
  })
}
async function remainsPending<T>(promise: Promise<T>): Promise<void> {
  assert.equal(await Promise.race([promise.then(() => 'settled'), delay(20, 'pending')]), 'pending')
}

test('opaque stream URLs enforce methods and bounded single ranges without leaking file paths', async (context) => {
  const f = await fixture(context),
    session = await f.registry.create(randomUUID(), f.path, 10)
  for (const url of [
    session.url + '/more',
    session.url + '?part=1',
    session.url + '#fragment',
    session.url.replace('readlisten:', 'https:'),
    session.url.replace('//app/', '//other/'),
    'readlisten://app/stream/not-a-uuid',
  ])
    assert.equal((await f.registry.serve(request(url), origin)).status, 403)
  assert.equal(
    (await f.registry.serve(request(session.url, undefined, { method: 'POST' }), origin)).status,
    405,
  )
  assert.equal(
    (await f.registry.serve(request(`readlisten://app/stream/${randomUUID()}`), origin)).status,
    404,
  )
  for (const range of [
    'bytes=10-',
    'bytes=4-3',
    'bytes=-0',
    'bytes=0-1,3-4',
    'items=0-1',
    'bytes=0-9007199254740992',
  ]) {
    const response = await f.registry.serve(request(session.url, range), origin)
    assert.equal(response.status, 416)
    assert.equal(response.headers.get('content-range'), 'bytes */10')
  }
  const head = await f.registry.serve(request(session.url, 'bytes=-4', { method: 'HEAD' }), origin)
  assert.equal(head.status, 206)
  assert.equal(head.headers.get('content-range'), 'bytes 6-9/10')
  assert.equal(head.headers.get('content-length'), '4')
  assert.equal(head.headers.get('access-control-allow-origin'), origin)
  assert.equal(head.headers.get('cache-control'), 'no-store')
  assert.equal(head.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(await head.text(), '')
})

test('range readers wait for committed bytes and use independent explicit file positions', async (context) => {
  const f = await fixture(context),
    session = await f.registry.create(randomUUID(), f.path, 10)
  const response = await f.registry.serve(request(session.url, 'bytes=3-7'), origin)
  assert.equal(response.status, 206)
  const reader = response.body!.getReader(),
    first = reader.read()
  await remainsPending(first)
  await f.writer.writeFile('abcdef')
  session.markWritten(6)
  assert.equal(Buffer.from((await first).value!).toString(), 'def')
  const second = reader.read()
  await remainsPending(second)
  const independent = await f.registry.serve(request(session.url, 'bytes=0-2'), origin)
  assert.equal(await independent.text(), 'abc')
  await f.writer.writeFile('ghij')
  session.markWritten(10)
  await session.complete()
  assert.equal(Buffer.from((await second).value!).toString(), 'gh')
  assert.equal((await reader.read()).done, true)
  assert.equal(await (await f.registry.serve(request(session.url), origin)).text(), 'abcdefghij')
  assert.equal(session.state, 'complete')
})

test('completed streams survive the producer rename and emit bounded chunks', async (context) => {
  const f = await fixture(context),
    bytes = Buffer.alloc(200000, 71)
  const session = await f.registry.create(randomUUID(), f.path, bytes.length)
  await f.writer.writeFile(bytes)
  session.markWritten(bytes.length)
  await f.writer.close()
  await rename(f.path, join(f.directory, 'verified.mp3'))
  await writeFile(f.path, 'a different file now occupies the old name')
  await session.complete()
  const response = await f.registry.serve(request(session.url), origin),
    reader = response.body!.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    assert(chunk.value.byteLength > 0 && chunk.value.byteLength <= 64 * 1024)
    chunks.push(chunk.value)
  }
  assert.deepEqual(Buffer.concat(chunks), bytes)
  await session.close()
  assert.equal((await f.registry.serve(request(session.url), origin)).status, 404)
})

test('a lying or truncated producer fails all readers and cannot declare an incomplete file complete', async (context) => {
  const f = await fixture(context),
    session = await f.registry.create(randomUUID(), f.path, 10)
  const response = await f.registry.serve(request(session.url, 'bytes=5-9'), origin)
  const body = assert.rejects(response.arrayBuffer(), /未完整落盘/)
  await f.writer.writeFile('abc')
  session.markWritten(10)
  await assert.rejects(session.complete(), /未完整落盘/)
  await body
  assert.equal(session.state, 'failed')
  assert.equal((await f.registry.serve(request(session.url), origin)).status, 410)
})

test('truncation after completion is detected by the actual read rather than returning uninitialized bytes', async (context) => {
  const f = await fixture(context),
    session = await f.registry.create(randomUUID(), f.path, 10)
  await f.writer.writeFile('abcdefghij')
  session.markWritten(10)
  await session.complete()
  await f.writer.truncate(4)
  const response = await f.registry.serve(request(session.url, 'bytes=5-9'), origin)
  await assert.rejects(response.arrayBuffer(), /未完整落盘/)
  assert.equal(session.state, 'failed')
})

test('aborting or canceling a single reader releases capacity without stopping another reader', async (context) => {
  const f = await fixture(context, { maxReaders: 2 })
  const session = await f.registry.create(randomUUID(), f.path, 10),
    controller = new AbortController()
  const first = await f.registry.serve(
    request(session.url, undefined, { signal: controller.signal }),
    origin,
  )
  const canceledBody = assert.rejects(first.arrayBuffer(), /取消/)
  const second = await f.registry.serve(request(session.url), origin)
  assert.equal((await f.registry.serve(request(session.url), origin)).status, 503)
  const otherPath = join(f.directory, 'other.part')
  await writeFile(otherPath, '')
  const other = await f.registry.create(randomUUID(), otherPath, 10)
  assert.equal((await f.registry.serve(request(other.url), origin)).status, 503)
  controller.abort()
  await canceledBody
  const third = await f.registry.serve(request(session.url), origin)
  assert.equal(third.status, 200)
  await third.body!.cancel()
  const survivor = second.body!.getReader(),
    next = survivor.read()
  await f.writer.writeFile('abc')
  session.markWritten(3)
  assert.equal(Buffer.from((await next).value!).toString(), 'abc')
  await survivor.cancel()
  assert.equal(session.state, 'open')
  const retry = await f.registry.serve(request(session.url), origin)
  assert.equal(retry.status, 200)
  await retry.body!.cancel()
})

test('a far-away range has a bounded wait despite progress elsewhere and times out only its own reader', async (context) => {
  const f = await fixture(context, { waitTimeoutMs: 35, maxReaders: 1 })
  const session = await f.registry.create(randomUUID(), f.path, 100)
  const response = await f.registry.serve(request(session.url, 'bytes=99-'), origin)
  const timeout = assert.rejects(response.arrayBuffer(), /缓冲超时/)
  for (let count = 1; count <= 3; count++) {
    await delay(8)
    await f.writer.writeFile('a')
    session.markWritten(count)
  }
  await timeout
  assert.equal(session.state, 'open')
  const available = await f.registry.serve(request(session.url, 'bytes=0-2'), origin)
  assert.equal(available.status, 206)
  assert.equal(await available.text(), 'aaa')
})

test('release, explicit failure and registry shutdown settle waiting bodies and close each dedicated handle once', async (context) => {
  const f = await fixture(context),
    nativeOpen = filesystem.open
  const closed: number[] = []
  context.mock.method(filesystem, 'open', async (...args: Parameters<typeof open>) => {
    const file = await nativeOpen(...args),
      nativeClose = file.close.bind(file)
    context.mock.method(file, 'close', () => {
      if (file.fd !== -1) closed.push(file.fd)
      return nativeClose()
    })
    return file
  })
  syncBuiltinESMExports()
  context.after(() => {
    context.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const session = await f.registry.create(randomUUID(), f.path, 10)
  const response = await f.registry.serve(request(session.url), origin)
  const body = assert.rejects(response.arrayBuffer(), /取消/)
  await Promise.all([session.close(), session.close()])
  await body
  assert.equal(closed.length, 1)
  assert.notEqual(closed[0], f.writer.fd)
  const failed = await f.registry.create(randomUUID(), f.path, 10)
  const failedResponse = await f.registry.serve(request(failed.url), origin)
  const failedBody = assert.rejects(
    failedResponse.arrayBuffer(),
    (error) =>
      error instanceof Error &&
      /未完整落盘/.test(error.message) &&
      !error.message.includes('private-network-address'),
  )
  await failed.fail(new Error('private-network-address'))
  await failedBody
  assert.equal(closed.length, 2)
  const last = await f.registry.create(randomUUID(), f.path, 10)
  const lastResponse = await f.registry.serve(request(last.url), origin)
  const lastBody = assert.rejects(lastResponse.arrayBuffer(), /取消/)
  await Promise.all([f.registry.close(), f.registry.close()])
  await lastBody
  assert.equal(closed.length, 3)
  await assert.rejects(f.registry.create(randomUUID(), f.path, 10), /取消/)
})

test('registry shutdown also drains a create that has not opened its handle yet', async (context) => {
  const f = await fixture(context)
  const creation = assert.rejects(f.registry.create(randomUUID(), f.path, 10), /取消/)
  await f.registry.close()
  await creation
})

test('only regular part files in the registry directory and bounded monotonic counters are accepted', async (context) => {
  const f = await fixture(context)
  const outside = join(f.root, 'outside.part')
  await writeFile(outside, 'outside')
  for (const [path, size] of [
    [outside, 10],
    [f.path, 0],
    [f.path, 256 * 1024 * 1024 + 1],
    [f.path, 1.2],
  ] as const)
    await assert.rejects(f.registry.create(randomUUID(), path, size), /无效/)
  await assert.rejects(f.registry.create('bad-id', f.path, 10), /无效/)
  await assert.rejects(f.registry.create(randomUUID(), f.directory, 10), /无效/)
  const folderPart = join(f.directory, 'folder.part')
  await mkdir(folderPart)
  await assert.rejects(f.registry.create(randomUUID(), folderPart, 10), /落盘/)
  const linkedDirectory = join(f.root, 'linked')
  await symlink(f.directory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir')
  const linkedRegistry = new ProgressiveMedia(linkedDirectory)
  context.after(() => linkedRegistry.close())
  await assert.rejects(
    linkedRegistry.create(randomUUID(), join(linkedDirectory, 'source.part'), 10),
    /落盘/,
  )
  const session = await f.registry.create(randomUUID(), f.path, 10)
  session.markWritten(4)
  for (const value of [-1, 3, 11, 4.5, NaN])
    assert.throws(() => session.markWritten(value), /进度无效/)
  assert.equal(session.writtenBytes, 4)
  await assert.rejects(session.complete(), /落盘/)
})
