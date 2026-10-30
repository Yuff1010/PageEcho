// Optional public-network probe of the shipped source-plugin example and actual runtime.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PluginRuntime } from '../../src/main/plugins/runtime'
import { PluginService } from '../../src/main/plugins/service'
import { parseOriginal } from '../../src/main/original/parse'

const path = resolve(process.argv[2] ?? 'cache/plugin-examples/wikisource-1.0.0.zip')
const runtime = new PluginRuntime()
const service = new PluginService({
  directory: await mkdtemp(join(tmpdir(), 'ralb-plugin-public-')),
  runtime,
})
try {
  const preview = service.previewFile(await readFile(path))
  const installed = await service.install(preview.previewId)
  const sourceId = installed.sources.find((source) => source.kind === 'text')!.id
  const signal = AbortSignal.timeout(90_000)
  const result = await service.textBrowse(
    { requestId: 'live-search', sourceId, query: '呐喊' },
    signal,
  )
  const work = result.books.find((book) => ['呐喊', '吶喊'].includes(book.title))
  assert.ok(work)
  const detail = await service.textDetail(
    { requestId: 'live-detail', sourceId, workId: work.workId },
    signal,
  )
  assert.ok(detail.chapters.length > 1)
  const chapter =
    detail.chapters.find((item) => /狂人日[記记]/.test(item.title)) ?? detail.chapters[1]!
  const download = await service.textDownload(
    { requestId: 'live-download', sourceId, workId: work.workId, chapterIds: [chapter.id] },
    signal,
  )
  const parsed = parseOriginal(download.bytes, download.filename)
  assert.ok(parsed.sentences.length > 10)
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        plugin: preview.id,
        pluginVersion: preview.version,
        pluginSha256: preview.sha256,
        sourceId,
        work: work.title,
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
} finally {
  service.close()
  await runtime.close()
}
