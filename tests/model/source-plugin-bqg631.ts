// Optional public-network compatibility probe. Reads one selected chapter into memory only.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PluginRuntime } from '../../src/main/plugins/runtime'
import { PluginService } from '../../src/main/plugins/service'
import { parseOriginal } from '../../src/main/original/parse'

const path = resolve(process.argv[2] ?? 'cache/plugin-examples/bqg631-1.0.0.zip')
const runtime = new PluginRuntime()
const service = new PluginService({
  directory: mkdtempSync(join(tmpdir(), 'ralb-bqg631-public-')),
  runtime,
})
try {
  const preview = service.previewFile(readFileSync(path))
  const state = await service.install(preview.previewId)
  const sourceId = state.sources[0]!.id
  const signal = AbortSignal.timeout(90_000)
  const result = await service.textBrowse(
    { requestId: 'live-search', sourceId, query: '反三国演义' },
    signal,
  )
  const work = result.books.find((book) => book.workId === '139464')
  assert.ok(work, 'The selected public work must still be present in search results.')
  const detail = await service.textDetail(
    { requestId: 'live-detail', sourceId, workId: work.workId },
    signal,
  )
  assert.ok(detail.chapters.length > 0)
  const chapter = detail.chapters[0]!
  const download = await service.textDownload(
    { requestId: 'live-one-chapter', sourceId, workId: work.workId, chapterIds: [chapter.id] },
    signal,
  )
  const parsed = parseOriginal(download.bytes, download.filename)
  assert.ok(parsed.sentences.length > 10)
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        plugin: preview.id,
        version: preview.version,
        pluginSha256: preview.sha256,
        sourceId,
        work: work.title,
        workId: work.workId,
        coverUrl: work.coverUrl,
        chapterCount: detail.chapters.length,
        selected: chapter.title,
        bytes: download.bytes.length,
        sentences: parsed.sentences.length,
        sha256: createHash('sha256').update(download.bytes).digest('hex'),
        checkedAt: new Date().toISOString(),
        scope:
          'Public website client protocol; one chapter only; text discarded after parsing; no login, verification or paid access bypass.',
      },
      null,
      2,
    ),
  )
} finally {
  service.close()
  await runtime.close()
}
