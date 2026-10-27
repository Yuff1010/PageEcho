// Prepare fixed-position listening excerpts; no model output becomes a reference label.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { OriginalAlignment, ParsedOriginal } from '../src/shared/original'

const args = process.argv.slice(2)
assert.deepEqual([args.length, args[0], args[2]], [4, '--report', '--component'])
const sourceReport = resolve(args[1]!),
  componentPath = resolve(args[3]!)
const source = JSON.parse(await readFile(sourceReport, 'utf8'))
assert.equal(source.status, 'passed')
const episodes: { order: number; target: { episodeId: string; audioHash: string } }[] =
  source.episodes ??
  (source.episode
    ? [
        {
          order: source.episode.order + 1,
          target: { episodeId: source.episode.id, audioHash: source.episode.contentHash },
        },
      ]
    : [])
assert.ok(episodes.length, 'A passed sequence or single-episode report is required')
const component = JSON.parse(await readFile(componentPath, 'utf8'))
const ffmpeg = resolve(dirname(componentPath), component.ffmpeg),
  ffprobe = resolve(dirname(componentPath), component.ffprobe)
const directory = resolve(
  'cache/asr-evaluation/original-review-packs',
  new Date().toISOString().replaceAll(':', '-'),
)
await mkdir(join(directory, 'clips'), { recursive: true })
await copyFile(resolve('scripts/prepare-original-review.ts'), join(directory, 'runner-started.ts'))
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
const databasePath = join(source.userData, 'data/library.sqlite3'),
  databaseHash = await hash(databasePath)
const database = new DatabaseSync(databasePath, { readOnly: true })
const samples = []
try {
  for (const entry of episodes) {
    const audio = database
      .prepare('SELECT locator,title,duration_ms,content_hash FROM episodes WHERE id=?')
      .get(entry.target.episodeId)!
    assert.equal(audio.content_hash, entry.target.audioHash)
    const row = database
      .prepare(
        `SELECT a.document_id,a.alignment_json FROM original_alignments a
         JOIN episodes e ON e.id=a.episode_id
         JOIN book_originals b ON b.book_id=e.book_id AND b.document_id=a.document_id
         WHERE a.episode_id=? AND a.audio_hash=?`,
      )
      .get(entry.target.episodeId, entry.target.audioHash)
    assert.ok(row, 'The active original version must have an alignment for this episode')
    const alignment = JSON.parse(String(row.alignment_json)) as OriginalAlignment
    const original = JSON.parse(
      String(
        database
          .prepare('SELECT document_json FROM original_documents WHERE id=?')
          .get(row.document_id!)!.document_json,
      ),
    ) as ParsedOriginal
    // Predeclare positions, without selecting excerpts according to their apparent quality.
    for (const fraction of [0.15, 0.5, 0.85]) {
      const index = Math.min(
          alignment.matches.length - 1,
          Math.floor(alignment.matches.length * fraction),
        ),
        match = alignment.matches[index]!
      const startMs = Math.max(0, match.startMs - 1500),
        endMs = Math.min(Number(audio.duration_ms), match.endMs + 1500)
      assert.ok(endMs > startMs && endMs - startMs <= 60000)
      samples.push({
        id: `episode-${entry.order}-${index}`,
        episodeOrder: entry.order,
        title: String(audio.title),
        episodeId: entry.target.episodeId,
        audioHash: entry.target.audioHash,
        audioPath: String(audio.locator),
        originalHash: original.hash,
        matcherVersion: alignment.matcherVersion,
        segmentId: match.segmentId,
        clipStartMs: startMs,
        clipEndMs: endMs,
        targetStartMs: match.startMs,
        targetEndMs: match.endMs,
        asrText: match.asrText,
        selected: match.selected,
        mappedText: match.selected
          ? original.sentences
              .slice(match.selected.first, match.selected.last + 1)
              .map((sentence) => sentence.text)
              .join('')
          : null,
      })
    }
  }
} finally {
  database.close()
}
const execute = promisify(execFile),
  files = [],
  markdown = [
    '# 待人工听审摘录',
    '',
    '这些片段来自本次通过流程检查的真实音频，各集按转写片段序号的 15%、50%、85% 固定抽取，未按识别结果筛选。使用书籍当前绑定的原文版本，每段包含目标范围前后约 1.5 秒上下文。以下文字和时间来自机器，尚未人工验收。',
    '',
    '请先试听，再在同目录 review-template.json 的 humanReview 中填写实际听到的目标范围文字、原文映射判断及时间偏差。不能判断的字段保持 null；空白不会计为通过。时间偏差是“机器时间减人工声音边界”的毫秒数，正数表示机器偏晚。上下文不属于待转录目标范围。',
    '',
    '同一本书的原文与声音可能存在删改，听到的文字与出版原文应分别判断；本页不将自动映射数作为准确率。',
    '',
  ]
for (const sample of samples) {
  assert.equal(await hash(sample.audioPath), sample.audioHash)
  const before = await stat(sample.audioPath),
    path = join(directory, 'clips', sample.id + '.wav')
  await execute(
    ffmpeg,
    [
      '-nostdin',
      '-v',
      'error',
      '-n',
      '-ss',
      (sample.clipStartMs / 1000).toFixed(3),
      '-i',
      sample.audioPath,
      '-t',
      ((sample.clipEndMs - sample.clipStartMs) / 1000).toFixed(3),
      '-map',
      '0:a:0',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      path,
    ],
    { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 },
  )
  const result = await execute(
    ffprobe,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_name,sample_rate,channels',
      '-of',
      'json',
      path,
    ],
    { windowsHide: true, timeout: 10000 },
  )
  const probe = JSON.parse(result.stdout)
  assert.equal(probe.streams[0].codec_name, 'pcm_s16le')
  assert.equal(probe.streams[0].channels, 1)
  assert.ok(
    Math.abs(Number(probe.format.duration) * 1000 - (sample.clipEndMs - sample.clipStartMs)) <= 2,
  )
  const after = await stat(sample.audioPath)
  assert.deepEqual(
    [after.size, after.mtimeMs, await hash(sample.audioPath)],
    [before.size, before.mtimeMs, sample.audioHash],
  )
  files.push({
    ...sample,
    clipPath: path,
    clipHash: await hash(path),
    measuredDurationSeconds: Number(probe.format.duration),
    humanReview: {
      listened: false,
      spokenText: null,
      mappingCorrect: null,
      startErrorMs: null,
      endErrorMs: null,
      notes: null,
    },
  })
  markdown.push(
    `## ${sample.title} · 片段 ${sample.segmentId}`,
    '',
    `原媒体目标：${(sample.targetStartMs / 1000).toFixed(3)}–${(sample.targetEndMs / 1000).toFixed(3)} 秒；在本试听文件内为 ${((sample.targetStartMs - sample.clipStartMs) / 1000).toFixed(3)}–${((sample.targetEndMs - sample.clipStartMs) / 1000).toFixed(3)} 秒。`,
    '',
    `![试听 ${sample.id}](${path.replaceAll('\\', '/')})`,
    '',
    '**机器转写（未验收）**',
    '',
    sample.asrText,
    '',
    '**自动映射原文（未验收）**',
    '',
    sample.mappedText ?? '保持空缺。',
    '',
  )
}
assert.equal(await hash(databasePath), databaseHash)
const manifest = {
  status: 'prepared-unreviewed',
  preparedAt: new Date().toISOString(),
  directory,
  sourceReport,
  sourceReportHash: await hash(sourceReport),
  databaseHash,
  sourceDatabaseUnchanged: true,
  runnerHash: await hash(join(directory, 'runner-started.ts')),
  selectionPolicy:
    'Per episode: floor(segmentCount * [0.15,0.5,0.85]), with 1500ms decoding context. No selection based on apparent correctness.',
  samples: files,
}
await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
await writeFile(
  join(directory, 'review-template.json'),
  JSON.stringify(
    {
      status: 'unreviewed',
      sourceManifestHash: await hash(join(directory, 'manifest.json')),
      samples: files.map(
        ({
          id,
          episodeId,
          audioHash,
          originalHash,
          clipHash,
          targetStartMs,
          targetEndMs,
          humanReview,
        }) => ({
          id,
          episodeId,
          audioHash,
          originalHash,
          clipHash,
          targetStartMs,
          targetEndMs,
          humanReview,
        }),
      ),
    },
    null,
    2,
  ) + '\n',
)
await writeFile(join(directory, 'review.md'), markdown.join('\n') + '\n')
console.log(
  JSON.stringify({
    status: manifest.status,
    samples: samples.length,
    review: join(directory, 'review.md'),
    template: join(directory, 'review-template.json'),
  }),
)
