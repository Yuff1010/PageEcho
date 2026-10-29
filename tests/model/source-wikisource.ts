// Optional live contract probe; not part of offline unit or desktop regressions.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { WikisourceTextSource } from '../../src/main/sources/text-wikisource'
import { parseOriginal } from '../../src/main/original/parse'

const source = new WikisourceTextSource()
const signal = AbortSignal.timeout(90_000)
const page = await source.browse(
  { requestId: 'live-search', sourceId: 'wikisource', query: '呐喊' },
  signal,
)
const work = page.books.find((book) => ['吶喊', '呐喊'].includes(book.title))
assert.ok(work, 'Official search must return the selected public work')
const detail = await source.detail(work.workId, signal)
assert.ok(detail.chapters.length > 1, 'The live catalog must contain selectable chapter links')
const chapter =
  detail.chapters.find((item) => /狂人日[記记]/.test(item.title)) ?? detail.chapters[1]!
const download = await source.download(
  {
    requestId: 'live-import',
    sourceId: 'wikisource',
    workId: work.workId,
    chapterIds: [chapter.id],
  },
  signal,
)
const parsed = parseOriginal(download.bytes, download.filename)
assert.ok(parsed.sentences.length > 10, 'Selected text must parse into a readable document')
assert.match(download.bytes.toString('utf8'), /来源：中文维基文库/)
console.log(
  JSON.stringify(
    {
      source: 'wikisource',
      work: detail.title,
      workId: work.workId,
      catalogItems: detail.chapters.length,
      selected: chapter.title,
      bytes: download.bytes.length,
      sha256: createHash('sha256').update(download.bytes).digest('hex'),
      sentences: parsed.sentences.length,
      checkedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
)
