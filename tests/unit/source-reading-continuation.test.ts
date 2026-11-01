import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LibraryStore } from '../../src/main/database'
import { parseOriginal } from '../../src/main/original/parse'
import { TextSourceService } from '../../src/main/sources/text-service'
import type { PluginTextSources } from '../../src/main/sources/text-provider'
import type { ParsedSourceChapter } from '../../src/main/source-reading-store'
import type {
  SourceReadingChapter,
  SourceReadingImport,
  TextBookDetail,
} from '../../src/shared/text-sources'
import { SourceError } from '../../src/shared/sources'
import { validateTextSourceArgs } from '../../src/main/sources/text-validation'
import { TEXT_SOURCE_CHANNELS } from '../../src/shared/text-source-api'
import { PluginService, type PluginExecutor } from '../../src/main/plugins/service'
import { pluginPackage } from '../fixtures/source-plugin'

const sourceId = 'plugin:synthetic.books:text'
const sourceKey = createHash('sha256').update('synthetic chapter identity').digest('hex')
const chapter = (
  order: number,
  text = `少年推开第${order}扇门。\n风从远方吹来，这是新的旅程。`,
) => ({
  id: `chapter-${order}`,
  order,
  title: `第${order + 1}篇`,
  text,
})
const parsed = (value: SourceReadingChapter): ParsedSourceChapter => ({
  ...value,
  order: value.order!,
  parsed: parseOriginal(Buffer.from(`第1章 ${value.title}\n\n${value.text}`), 'chapter.txt'),
})
const input = (orders: number[]): SourceReadingImport => ({
  sourceKey,
  sourceId,
  workId: 'work-1',
  title: '合成连载',
  pageUrl: 'https://plugin.example/book',
  chapters: orders.map((order) => chapter(order)),
})

test('chapter append preserves sentence coordinates, reading anchor, manual alignment, bookmark and restart identity', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ralb-source-reading-')), 'library.sqlite3')
  let store = new LibraryStore(path)
  const first = input([0, 1])
  const book = store.reading.appendSource(
    first,
    first.chapters.map((value) => parsed(value)),
  )
  const beforeDocument = structuredClone(store.reading.document(book.id))
  const manualFile = store.reading.import(parsed(chapter(0)).parsed)
  const manualBefore = structuredClone(store.reading.document(manualFile.id))
  assert.notEqual(manualFile.id, book.id)
  store.reading.savePosition(book.id, 1)
  const before = store.reading.get(book.id)
  store.importBook({
    id: 'audio',
    title: '合成音频',
    sourcePath: 'D:/synthetic',
    kind: 'folder',
    episodes: [
      {
        id: 'episode',
        path: 'D:/synthetic/a.wav',
        name: 'a.wav',
        sizeBytes: 10,
        modifiedAt: 1,
        contentHash: 'a'.repeat(64),
      },
    ],
  })
  const target = { episodeId: 'episode', audioHash: 'a'.repeat(64) }
  store.bookLinks.link({ bookId: 'audio', readingBookId: book.id })
  const transcript = store.saveTranscript('episode', {
    version: 1,
    kind: 'manual',
    audioHash: target.audioHash,
    coverage: [{ startMs: 0, endMs: 5000 }],
    segments: [{ id: 's0', startMs: 1000, endMs: 3000, text: beforeDocument.sentences[1]!.text }],
  })
  assert.equal(transcript.status, 'ready')
  if (transcript.status !== 'ready') throw new Error('missing transcript')
  store.originals.saveAlignment(
    target,
    book.id,
    transcript.transcript.id,
    transcript.transcript.revision,
    0,
    [
      {
        reviewed: true,
        segmentId: 's0',
        startMs: 1000,
        endMs: 3000,
        asrText: beforeDocument.sentences[1]!.text,
        candidates: [],
        selected: { first: 1, last: 1, method: 'manual' },
      },
    ],
  )
  const alignment = structuredClone(store.originals.state(target).alignment)
  const bookmark = store.saveBookmark({ ...target, positionMs: 1500, note: '保留手动书签' })
  store.originals.document(target, book.id) // Prime both document caches before changing the source revision.
  const extra = input([1, 2])
  const appended = store.reading.appendSource(
    extra,
    extra.chapters.map((value) => parsed(value)),
  )
  assert.equal(appended.id, book.id)
  assert.equal(appended.position, before.position)
  assert.equal(appended.lastReadAt, before.lastReadAt)
  assert.equal(appended.importedAt, before.importedAt)
  assert.notEqual(appended.hash, before.hash)
  assert.deepEqual(appended.source, { sourceId, workId: 'work-1' })
  assert.deepEqual(
    store.reading.document(book.id).sentences.slice(0, before.sentenceCount),
    beforeDocument.sentences,
  )
  assert.equal(store.originals.document(target, book.id).sentences.length, appended.sentenceCount)
  assert.deepEqual(store.originals.state(target).alignment, alignment)
  assert.deepEqual(store.getTranscript('episode', target.audioHash), transcript)
  assert.deepEqual(store.listBookmarks('audio'), [bookmark])
  assert.deepEqual(store.reading.document(manualFile.id), manualBefore)
  assert.equal(
    store.reading.appendSource(
      extra,
      extra.chapters.map((value) => parsed(value)),
    ).sentenceCount,
    appended.sentenceCount,
  )
  store.close()
  store = new LibraryStore(path)
  try {
    assert.deepEqual(store.reading.get(book.id), appended)
    assert.deepEqual(store.reading.sourceState(sourceKey)?.downloadedChapterIds, [
      'chapter-0',
      'chapter-1',
      'chapter-2',
    ])
    assert.deepEqual(store.originals.state(target).alignment, alignment)
    assert.deepEqual(store.listBookmarks('audio'), [bookmark])
    const again = input([3])
    assert.equal(
      store.reading.appendSource(
        again,
        again.chapters.map((value) => parsed(value)),
      ).id,
      book.id,
    )
  } finally {
    store.close()
  }
})

test('changed old chapters, earlier insertion and duplicate directory orders cannot alter an existing source book', () => {
  const store = new LibraryStore(':memory:')
  try {
    const initial = input([1, 3])
    const book = store.reading.appendSource(
      initial,
      initial.chapters.map((value) => parsed(value)),
    )
    const before = structuredClone(store.reading.document(book.id))
    const earlier = input([2])
    assert.throws(
      () =>
        store.reading.appendSource(
          earlier,
          earlier.chapters.map((value) => parsed(value)),
        ),
      /只能/,
    )
    const changed = chapter(3, '网站重写了旧正文，不能替换手动校正内容。')
    assert.throws(() => store.reading.appendSource(input([3]), [parsed(changed)]), /改变/)
    const reordered = { ...chapter(1), order: 4 }
    assert.throws(() => store.reading.appendSource(input([1]), [parsed(reordered)]), /改变/)
    const duplicate = input([4, 4])
    assert.throws(
      () =>
        store.reading.appendSource(
          duplicate,
          duplicate.chapters.map((value) => parsed(value)),
        ),
      /顺序/,
    )
    assert.deepEqual(store.reading.document(book.id), before)
    store.reading.remove(book.id)
    assert.equal(store.reading.sourceState(sourceKey), null)
  } finally {
    store.close()
  }
})

test('appending a chapter invalidates an in-flight incremental matcher snapshot without overwriting the current document', () => {
  const store = new LibraryStore(':memory:')
  try {
    const initial = input([0])
    const book = store.reading.appendSource(initial, initial.chapters.map(parsed))
    store.importBook({
      id: 'audio',
      title: '合成音频',
      sourcePath: 'D:/synthetic',
      kind: 'folder',
      episodes: [
        {
          id: 'episode',
          path: 'D:/synthetic/a.wav',
          name: 'a.wav',
          sizeBytes: 10,
          modifiedAt: 1,
          contentHash: 'a'.repeat(64),
        },
      ],
    })
    const target = { episodeId: 'episode', audioHash: 'a'.repeat(64) }
    store.bookLinks.link({ bookId: 'audio', readingBookId: book.id })
    store.saveTranscript('episode', {
      version: 1,
      kind: 'manual',
      audioHash: target.audioHash,
      coverage: [{ startMs: 0, endMs: 5000 }],
      segments: [
        {
          id: 's0',
          startMs: 0,
          endMs: 3000,
          text: store.reading.document(book.id).sentences[0]!.text,
        },
      ],
    })
    const oldPlan = store.originals.prepareIncremental(target)
    assert.ok(oldPlan)
    assert.equal(oldPlan.originalHash, book.hash)
    const extra = input([1])
    const appended = store.reading.appendSource(extra, extra.chapters.map(parsed))
    assert.notEqual(appended.hash, oldPlan.originalHash)
    assert.throws(() => store.originals.saveIncremental(oldPlan, []), /增量结果已忽略/)
    assert.equal(store.originals.state(target).alignment, null)
    assert.equal(store.originals.prepareIncremental(target)?.originalHash, appended.hash)
  } finally {
    store.close()
  }
})

function serviceFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ralb-source-continuation-'))
  const store = new LibraryStore(join(directory, 'library.sqlite3'))
  let full = true
  let reordered = false
  let hold: ((signal: AbortSignal) => Promise<void>) | null = null
  const fetched: string[] = []
  const detail = (cursor?: string): TextBookDetail => ({
    sourceId,
    workId: 'work-1',
    title: '连载',
    author: null,
    description: null,
    pageUrl: 'https://plugin.example/book',
    acquisitions: [],
    notice: null,
    chapters: (cursor ? [2, 3] : [0, 1]).map((order) => ({
      ...chapter(order),
      ...(reordered && order === 0 ? { order: 5 } : {}),
    })),
    nextCursor: cursor ? null : 'page-two',
    chapterCursor: cursor,
    catalogComplete: !!cursor && full,
  })
  const plugins: PluginTextSources = {
    sources: () => [
      {
        id: sourceId,
        name: '合成来源',
        kind: 'plugin',
        baseUrl: 'https://plugin.example',
        description: '',
      },
    ],
    browse: async () => {
      throw new Error('unused')
    },
    detail: async (request) => detail(request.cursor),
    download: async (request, signal) => {
      if (hold) await hold(signal)
      const catalog = detail(request.chapterCursor).chapters
      const selected = catalog.filter((value) => request.chapterIds?.includes(value.id))
      fetched.push(...selected.map((value) => value.id))
      return {
        bytes: Buffer.from('unused'),
        filename: '连载.txt',
        title: '连载',
        catalog,
        chapters: selected.map((value) => ({ ...value, text: chapter(value.order!).text })),
      }
    },
  }
  const service = new TextSourceService({
    directory,
    plugins,
    importBook: () => {
      throw new Error('incremental imports must not use immutable-file import')
    },
    importChapters: (value, signal) => {
      signal.throwIfAborted()
      return store.reading.appendSource(
        value,
        value.chapters.map((item) => parsed(item)),
      )
    },
    getSourceReading: (key) => store.reading.sourceState(key),
    getSourceReadingByBook: (id) => store.reading.sourceByBook(id),
    getReadingBook: (id) => {
      try {
        return store.reading.get(id)
      } catch {
        return null
      }
    },
  })
  return {
    store,
    service,
    fetched,
    setFull: (value: boolean) => {
      full = value
    },
    setReordered: () => {
      reordered = true
    },
    setHold: (value: typeof hold) => {
      hold = value
    },
  }
}

test('same-source selection reuses one local book; continue crosses directory pages and reports completion truthfully', async () => {
  const { service, store, fetched, setFull, setReordered } = serviceFixture()
  try {
    const first = await service.import({
      requestId: 'initial',
      sourceId,
      workId: 'work-1',
      chapterIds: ['chapter-0'],
    })
    store.reading.savePosition(first.book.id, 1)
    const again = await service.import({
      requestId: 'duplicate',
      sourceId,
      workId: 'work-1',
      chapterIds: ['chapter-0'],
    })
    assert.equal(again.reused, true)
    assert.equal(again.book.id, first.book.id)
    assert.deepEqual(fetched, ['chapter-0'])
    for (let order = 1; order <= 3; order++) {
      const result = await service.continueReading({
        requestId: `next-${order}`,
        readingBookId: first.book.id,
      })
      assert.equal(result.book.id, first.book.id)
      assert.equal(result.book.position, 1)
      assert.deepEqual(result.addedChapterIds, [`chapter-${order}`])
      assert.equal(result.lastDownloadedOrder, order)
    }
    assert.equal(store.reading.list().length, 1)
    const current = await service.detail({ requestId: 'detail', sourceId, workId: 'work-1' })
    assert.equal(current.lastDownloadedOrder, 3)
    assert.equal(current.readingBookId, first.book.id)
    assert.equal(current.downloadedChapterIds.length, 4)
    const done = await service.continueReading({ requestId: 'done', readingBookId: first.book.id })
    assert.equal(done.noMore, true)
    assert.equal(done.lastDownloadedOrder, 3)
    setFull(false)
    await assert.rejects(
      service.continueReading({ requestId: 'incomplete', readingBookId: first.book.id }),
      /尚不能确认/,
    )
    setReordered()
    await assert.rejects(
      service.detail({ requestId: 'changed', sourceId, workId: 'work-1' }),
      /顺序/,
    )
    assert.equal(store.reading.get(first.book.id).position, 1)
  } finally {
    service.close()
    store.close()
  }
})

test('canceled append is atomic and clears busy state; continuation IPC accepts only a local book identity', async () => {
  const { service, store, setHold } = serviceFixture()
  try {
    const first = await service.import({
      requestId: 'initial',
      sourceId,
      workId: 'work-1',
      chapterIds: ['chapter-0'],
    })
    const before = structuredClone(store.reading.document(first.book.id))
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    setHold(
      (signal) =>
        new Promise((_resolve, reject) => {
          started()
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    const pending = service.continueReading({
      requestId: 'cancel-next',
      readingBookId: first.book.id,
    })
    await ready
    assert.equal(service.busy, true)
    service.cancel('cancel-next')
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof SourceError && error.code === 'SOURCE_CANCELED',
    )
    assert.equal(service.busy, false)
    assert.deepEqual(store.reading.document(first.book.id), before)
    validateTextSourceArgs(TEXT_SOURCE_CHANNELS.continue, [
      { requestId: 'next', readingBookId: randomUUID() },
    ])
    for (const value of [
      { requestId: 'next', readingBookId: '../outside' },
      { requestId: 'next', readingBookId: first.book.id, sourceId },
      { requestId: 'next', readingBookId: first.book.id, path: 'D:/external.txt' },
    ])
      assert.throws(() => validateTextSourceArgs(TEXT_SOURCE_CHANNELS.continue, [value]), /无效/)
  } finally {
    service.close()
    store.close()
  }
})

test('plugin directory tokens continue beyond 1000 chapters, bind book and package revision and reject changed prefixes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ralb-source-directory-'))
  let changed = false
  let duplicate = false
  const executor: PluginExecutor = {
    inspect: async () => [
      { id: 'audio', methods: ['search', 'getBook', 'getEpisodes', 'resolveAudio'] },
      { id: 'text', methods: ['search', 'getBook', 'getChapters', 'getChapterText'] },
    ],
    execute: async (request) => {
      if (request.method === 'getBook') return { id: request.args[0], title: '长篇合成小说' }
      if (request.method === 'getChapterText') return '只获取明确选中章节的正文。这里还有第二句。'
      assert.equal(request.method, 'getChapters')
      const start = request.args[1] ? 1000 : 0
      return {
        items: Array.from({ length: start ? 2 : 1000 }, (_, i) => ({
          id: duplicate && start && i === 0 ? 'chapter-0' : `chapter-${start + i}`,
          title: `第${start + i + 1}章${changed && !start && !i ? '目录已重排' : ''}`,
        })),
        nextCursor: start ? null : 'site-next',
      }
    },
  }
  const service = new PluginService({ directory, runtime: executor })
  try {
    await service.install(service.previewFile(pluginPackage('https://plugin.example')).previewId)
    const request = { requestId: 'directory', sourceId, workId: 'work-1' }
    const first = await service.textDetail(request, new AbortController().signal)
    assert.equal(first.chapters.length, 1000)
    assert.equal(first.catalogComplete, false)
    assert.ok(first.nextCursor)
    assert.notEqual(first.nextCursor, 'site-next')
    const second = await service.textDetail(
      { ...request, cursor: first.nextCursor },
      new AbortController().signal,
    )
    assert.deepEqual(
      second.chapters.map((item) => item.order),
      [1000, 1001],
    )
    assert.equal(second.nextCursor, null)
    assert.equal(second.catalogComplete, true)
    const selected = await service.textDownload(
      { ...request, chapterCursor: first.nextCursor, chapterIds: ['chapter-1001'] },
      new AbortController().signal,
    )
    assert.deepEqual(
      selected.chapters?.map((item) => [item.id, item.order]),
      [['chapter-1001', 1001]],
    )
    await assert.rejects(
      service.textDetail(
        { ...request, workId: 'other-work', cursor: first.nextCursor },
        new AbortController().signal,
      ),
      /失效或属于/,
    )
    await assert.rejects(
      service.textDetail({ ...request, cursor: 'site-next' }, new AbortController().signal),
      /失效或属于/,
    )
    duplicate = true
    await assert.rejects(
      service.textDetail({ ...request, cursor: first.nextCursor }, new AbortController().signal),
      /重复章节/,
    )
    duplicate = false
    changed = true
    await assert.rejects(
      service.textDetail({ ...request, cursor: first.nextCursor }, new AbortController().signal),
      /目录顺序已变化/,
    )
    changed = false
    await service.install(
      service.previewFile(pluginPackage('https://plugin.example', { version: '1.1.0' })).previewId,
    )
    await assert.rejects(
      service.textDetail({ ...request, cursor: first.nextCursor }, new AbortController().signal),
      /失效或属于/,
    )
  } finally {
    service.close()
  }
})
