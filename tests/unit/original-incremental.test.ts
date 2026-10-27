import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { AutomaticOriginals } from '../../src/main/original/automatic'
import { createOriginalMatcher } from '../../src/main/original/match'
import { parseOriginal } from '../../src/main/original/parse'
import type { OriginalIncrementalBatch } from '../../src/main/original/incremental'
import type { OriginalMatch, OriginalTarget, ParsedOriginal } from '../../src/shared/original'
import type { TranscriptDocument, TranscriptSegment } from '../../src/shared/transcript'
import { AppError } from '../../src/shared/validation'

const texts = [
  '少年将整齐的衣服收进旅行用的布袋。',
  '他把旧地图折好，小心放进身后的背包。',
  '山谷中的钟声渐渐远去，路上只剩下清风和明月。',
  '第二天清晨，他们沿着河岸走向远方的村庄。',
  '村口的大树下坐着一位沉默不语的老人。',
]
const parsed = parseOriginal(Buffer.from('第一章 山路\n' + texts.join('\n')), '原文.txt')
async function until(condition: () => boolean) {
  for (let i = 0; i < 400 && !condition(); i++) await delay(5)
  assert.ok(condition(), 'expected incremental state was not reached')
}
class Runner {
  calls: OriginalIncrementalBatch[][] = []
  hook?: () => Promise<void>
  cancel?: () => void
  dispose?: () => Promise<void>
  private cached?: { id: string; match: ReturnType<typeof createOriginalMatcher> }
  attachAutomatic(close: () => Promise<void>) {
    this.dispose = close
  }
  async cancelAutomatic() {
    this.cancel?.()
    this.cancel = undefined
  }
  async runAutomatic(
    id: string,
    original: ParsedOriginal,
    batches: OriginalIncrementalBatch[],
  ): Promise<OriginalMatch[]> {
    this.calls.push(batches)
    await this.hook?.()
    if (this.cached?.id !== id) this.cached = { id, match: createOriginalMatcher(original) }
    return batches.flatMap((batch) =>
      this.cached!.match(batch.transcript, batch.options).filter((match) =>
        batch.targetIds.includes(match.segmentId),
      ),
    )
  }
  blockNext() {
    let entered = false
    let release!: () => void
    this.hook = () => {
      this.hook = undefined
      entered = true
      return new Promise<void>((resolve, reject) => {
        release = resolve
        this.cancel = () => reject(new AppError('BUSY', 'canceled'))
      })
    }
    return {
      entered: () => entered,
      release: () => {
        this.cancel = undefined
        release()
      },
    }
  }
}
async function setup(count = 1) {
  const root = await mkdtemp(join(tmpdir(), 'ralb-original-incremental-'))
  for (let i = 0; i < count; i++)
    await writeFile(join(root, `${i}.mp3`), `real sqlite audio identity ${i}`)
  const filename = join(root, 'library.sqlite3'),
    store = new LibraryStore(filename)
  store.importBook(await scanBook(root, 'folder'))
  const episodes = store.listBooks()[0]!.episodes
  const target = (index = 0): OriginalTarget => ({
    episodeId: episodes[index]!.id,
    audioHash: episodes[index]!.contentHash,
  })
  store.originals.import(target(), parsed)
  const jobs = episodes.map((episode) => {
    const job = store.createJob({
      episodeId: episode.id,
      audioHash: episode.contentHash,
      engine: 'paraformer',
      device: 'cpu',
    })
    store.setJobStatus(job.id, 1, 'running')
    return job
  })
  const publish = (
    segments: TranscriptSegment[],
    coverage: TranscriptDocument['coverage'],
    index = 0,
  ) => {
    const job = jobs[index]!
    store.acceptJobSnapshot(
      job.id,
      1,
      {
        document: { version: 1, audioHash: job.audioHash, kind: 'transcript', coverage, segments },
        processedUntilMs: coverage[0]?.startMs === 0 ? coverage[0].endMs : 0,
        cacheKey: 'a'.repeat(64),
        cacheHits: 0,
        totalChunks: 4,
        issues: [],
      },
      segments.length,
      false,
    )
  }
  const runner = new Runner(),
    notices: OriginalTarget[] = [],
    logs: unknown[] = []
  const automatic = new AutomaticOriginals(
    store.originals,
    runner,
    (target) => notices.push(target),
    (error) => logs.push(error),
  )
  return { root, filename, store, episodes, target, publish, runner, automatic, notices, logs }
}
const segment = (index: number, startMs: number, id = `s${index}`): TranscriptSegment => ({
  id,
  startMs,
  endMs: startMs + 900,
  text: texts[index]!,
})
async function settled(t: Awaited<ReturnType<typeof setup>>, index = 0, count?: number) {
  await until(() => {
    const state = t.store.originals.state(t.target(index))
    return (
      !!state.alignment &&
      !state.stale &&
      !state.alignment.pendingSegments &&
      (count === undefined || state.alignment.sources?.length === count)
    )
  })
  return t.store.originals.state(t.target(index)).alignment!
}

test('new ASR chunks only match new IDs plus bounded context while retaining automatic mappings, manual choices, gaps and times', async () => {
  const t = await setup()
  try {
    const first = [segment(0, 1000), segment(1, 5000), segment(2, 10000)]
    t.publish(first, [{ startMs: 0, endMs: 30000 }])
    let alignment = await settled(t, 0, 3)
    const id = alignment.originalId
    t.store.originals.correct({
      ...t.target(),
      originalId: id,
      revision: alignment.revision,
      segmentId: 's0',
      selection: { first: 0, last: 0 },
      startMs: 1100,
      endMs: 1800,
    })
    alignment = t.store.originals.state(t.target()).alignment!
    t.store.originals.correct({
      ...t.target(),
      originalId: id,
      revision: alignment.revision,
      segmentId: 's1',
      selection: null,
      startMs: 5100,
      endMs: 5800,
    })
    const before = t.store.originals.state(t.target()).alignment!.matches
    t.publish([...first, segment(3, 31000)], [{ startMs: 0, endMs: 60000 }])
    alignment = await settled(t, 0, 4)
    assert.deepEqual(alignment.matches.slice(0, 3), before)
    assert.deepEqual(
      t.runner.calls.at(-1)!.flatMap((batch) => batch.targetIds),
      ['s3'],
    )
    assert.equal(alignment.matches[1]!.selected, null)
    assert.equal(alignment.matches[1]!.reviewed, true)
    assert.equal(alignment.matches[3]!.selected?.first, 3)
    const calls = t.runner.calls.length,
      revision = alignment.revision,
      notices = t.notices.length
    for (let i = 0; i < 10; i++) t.automatic.request(t.target())
    await delay(120)
    assert.equal(t.runner.calls.length, calls)
    assert.equal(t.store.originals.state(t.target()).alignment!.revision, revision)
    assert.equal(t.notices.length, notices)
  } finally {
    await t.automatic.close()
    t.store.close()
  }
})

test('target-first discontiguous chunks and backward fill never form context across uncovered audio', async () => {
  const t = await setup()
  try {
    const late = segment(2, 61000)
    t.publish([late], [{ startMs: 60000, endMs: 90000 }])
    const first = await settled(t, 0, 1)
    t.publish(
      [segment(0, 1000), late],
      [
        { startMs: 0, endMs: 30000 },
        { startMs: 60000, endMs: 90000 },
      ],
    )
    const second = await settled(t, 0, 2)
    assert.deepEqual(
      second.matches.find((match) => match.segmentId === late.id),
      first.matches[0],
    )
    assert.equal(t.runner.calls.at(-1)!.length, 1)
    assert.deepEqual(
      t.runner.calls.at(-1)![0]!.transcript.segments.map((value) => value.id),
      ['s0'],
    )
    t.publish([segment(0, 1000), segment(1, 31000), late], [{ startMs: 0, endMs: 90000 }])
    const final = await settled(t, 0, 3)
    assert.deepEqual(
      final.matches.map((match) => match.selected?.first),
      [0, 1, 2],
    )
    assert.deepEqual(
      t.runner.calls.at(-1)!.flatMap((batch) => batch.targetIds),
      ['s1'],
    )
  } finally {
    await t.automatic.close()
    t.store.close()
  }
})

test('manual corrections while a new block is matching invalidate the old response and remain authoritative on retry', async () => {
  const t = await setup()
  try {
    t.publish([segment(0, 1000)], [{ startMs: 0, endMs: 30000 }])
    const original = await settled(t, 0, 1)
    const gate = t.runner.blockNext()
    t.publish([segment(0, 1000), segment(1, 31000)], [{ startMs: 0, endMs: 60000 }])
    await until(gate.entered)
    const corrected = t.store.originals.correct({
      ...t.target(),
      originalId: original.originalId,
      revision: original.revision,
      segmentId: 's0',
      selection: null,
      startMs: 1100,
      endMs: 1700,
    })
    assert.equal(corrected.alignment!.matches[0]!.reviewed, true)
    gate.release()
    const result = await settled(t, 0, 2)
    assert.equal(result.matches[0]!.selected, null)
    assert.equal(result.matches[0]!.startMs, 1100)
    assert.equal(result.matches[1]!.selected?.first, 1)
    assert.deepEqual(t.logs, [])
  } finally {
    await t.automatic.close()
    t.store.close()
  }
})

test('late transcript/original revisions cannot overwrite the newer snapshot and switching targets stays isolated', async () => {
  const t = await setup(2)
  try {
    const gate = t.runner.blockNext()
    t.publish([segment(0, 1000)], [{ startMs: 0, endMs: 30000 }])
    await until(gate.entered)
    t.publish([segment(0, 1000), segment(1, 31000)], [{ startMs: 0, endMs: 60000 }])
    t.publish([segment(3, 1000)], [{ startMs: 0, endMs: 30000 }], 1)
    const changed = parseOriginal(
      Buffer.from('新版\n' + texts.join('\n') + '\n新版后记。'),
      '新版.txt',
    )
    const id = t.store.originals.import(t.target(), changed).info!.id
    gate.release()
    const first = await settled(t, 0, 2),
      second = await settled(t, 1, 1)
    assert.equal(first.originalId, id)
    assert.equal(second.originalId, id)
    assert.equal(second.matches[0]!.selected?.first, 4)
    assert.equal(first.matches.length, 2)
  } finally {
    await t.automatic.close()
    t.store.close()
  }
})

test('legacy reviewed sources and removed source IDs retain manual gaps and timing instead of being replaced by recognition regrouping', async () => {
  const t = await setup()
  try {
    t.publish([segment(0, 1000)], [{ startMs: 0, endMs: 30000 }])
    const initial = await settled(t, 0, 1)
    t.store.originals.correct({
      ...t.target(),
      originalId: initial.originalId,
      revision: initial.revision,
      segmentId: 's0',
      selection: null,
      startMs: 1100,
      endMs: 1700,
    })
    const db = new DatabaseSync(t.filename)
    const row = db.prepare('SELECT alignment_json FROM original_alignments').get()!
    const legacy = JSON.parse(String(row.alignment_json))
    delete legacy.sources
    delete legacy.matches[0].source
    db.prepare('UPDATE original_alignments SET alignment_json=?').run(JSON.stringify(legacy))
    db.close()
    t.publish(
      [{ ...segment(0, 1000, 'regrouped'), text: texts[0]!.replace('整齐', '整理') }],
      [{ startMs: 0, endMs: 30000 }],
    )
    const result = await settled(t, 0, 1)
    assert.equal(result.matches.length, 1)
    assert.equal(result.matches[0]!.segmentId, 's0')
    assert.equal(result.matches[0]!.sourceState, 'legacy')
    assert.equal(result.matches[0]!.selected, null)
    assert.equal(result.matches[0]!.reviewed, true)
    assert.equal(result.matches[0]!.startMs, 1100)
  } finally {
    await t.automatic.close()
    t.store.close()
  }
})

test('reviewed anchors bound new candidates instead of accepting an original passage before the confirmed position', async () => {
  const t = await setup()
  try {
    t.publish([segment(3, 1000)], [{ startMs: 0, endMs: 30000 }])
    const first = await settled(t, 0, 1)
    t.store.originals.correct({
      ...t.target(),
      originalId: first.originalId,
      revision: first.revision,
      segmentId: 's3',
      selection: { first: 3, last: 3 },
      startMs: 1000,
      endMs: 1900,
    })
    t.publish([segment(3, 1000), segment(0, 31000)], [{ startMs: 0, endMs: 60000 }])
    const result = await settled(t, 0, 2)
    assert.equal(result.matches[1]!.selected, null)
    assert.equal(result.matches[0]!.selected?.method, 'manual')
  } finally {
    await t.automatic.close()
    t.store.close()
  }
})

test('restart automatically catches up persisted partial text and shutdown cancels a blocked match without saving late output', async () => {
  const t = await setup()
  t.publish([segment(0, 1000)], [{ startMs: 0, endMs: 30000 }])
  await settled(t, 0, 1)
  await t.automatic.close()
  t.publish([segment(0, 1000), segment(1, 31000)], [{ startMs: 0, endMs: 60000 }])
  t.store.close()
  const restored = new LibraryStore(t.filename),
    runner = new Runner()
  const automatic = new AutomaticOriginals(restored.originals, runner, () => {})
  try {
    await until(() => restored.originals.state(t.target()).alignment?.sources?.length === 2)
    assert.deepEqual(
      runner.calls[0]!.flatMap((batch) => batch.targetIds),
      ['s1'],
    )
    const gate = runner.blockNext()
    restored.saveTranscript(t.target().episodeId, {
      version: 1,
      audioHash: t.target().audioHash,
      kind: 'transcript',
      coverage: [{ startMs: 0, endMs: 90000 }],
      segments: [segment(0, 1000), segment(1, 31000), segment(2, 61000)],
    })
    await until(gate.entered)
    const before = restored.originals.state(t.target()).alignment!.revision
    await automatic.close()
    assert.equal(restored.originals.state(t.target()).alignment!.revision, before)
  } finally {
    await automatic.close()
    restored.close()
  }
})

test('large initial transcripts are processed in bounded delta batches rather than rematching the already completed prefix', async () => {
  const t = await setup()
  try {
    const values = Array.from({ length: 260 }, (_, i) => ({
      id: `long-${i}`,
      startMs: i * 1000 + 10,
      endMs: i * 1000 + 900,
      text: `编号${i}的旅人把行李放在村口的老树旁。`,
    }))
    t.store.originals.import(
      t.target(),
      parseOriginal(
        Buffer.from('第一章\n' + values.map((value) => value.text).join('\n')),
        '长原文.txt',
      ),
    )
    t.publish(values, [{ startMs: 0, endMs: 260000 }])
    await settled(t, 0, 260)
    const targets = t.runner.calls.flatMap((batches) => batches.flatMap((batch) => batch.targetIds))
    assert.equal(new Set(targets).size, 260)
    assert.equal(targets.length, 260)
    assert.equal(t.runner.calls.length, 3)
    for (const batches of t.runner.calls) {
      assert.ok(batches.flatMap((batch) => batch.targetIds).length <= 128)
      assert.ok(batches.flatMap((batch) => batch.transcript.segments).length <= 134)
    }
  } finally {
    await t.automatic.close()
    t.store.close()
  }
})

test('repeated concurrent revisions have a bounded retry budget and a later explicit request can catch up', async () => {
  const t = await setup()
  try {
    let revision = 0
    t.runner.hook = async () => {
      revision++
      t.store.saveTranscript(t.target().episodeId, {
        version: 1,
        audioHash: t.target().audioHash,
        kind: 'transcript',
        coverage: [{ startMs: 0, endMs: 30000 }],
        segments: [{ ...segment(0, 1000), id: `changed-${revision}` }],
      })
    }
    t.publish([segment(0, 1000)], [{ startMs: 0, endMs: 30000 }])
    await until(() => t.runner.calls.length === 3)
    await delay(150)
    assert.equal(t.runner.calls.length, 3)
    assert.equal(t.store.originals.state(t.target()).alignment, null)
    t.runner.hook = undefined
    t.automatic.request(t.target())
    const result = await settled(t, 0, 1)
    assert.equal(result.matches[0]!.segmentId, 'changed-3')
  } finally {
    await t.automatic.close()
    t.store.close()
  }
})

test('more than sixteen delta batches finish automatically across yielded rounds without any state reads', async () => {
  const t = await setup()
  try {
    const values = Array.from({ length: 2050 }, (_, i) => ({
      ...segment(0, i * 1000 + 10),
      id: `many-${i}`,
    }))
    t.runner.runAutomatic = async (_id, _original, batches) => {
      t.runner.calls.push(batches)
      return []
    }
    let completed = false
    await t.automatic.close()
    const automatic = new AutomaticOriginals(t.store.originals, t.runner, () => {
      const alignment = t.store.originals.state(t.target()).alignment
      if (alignment?.pendingSegments === 0) completed = true
    })
    try {
      t.publish(values, [{ startMs: 0, endMs: 2051000 }])
      await until(() => completed)
      assert.equal(t.runner.calls.length, 17)
      assert.equal(t.store.originals.state(t.target()).alignment!.sources!.length, 2050)
    } finally {
      await automatic.close()
    }
  } finally {
    await t.automatic.close()
    t.store.close()
  }
})

test('a progressing target survives queue pressure during the yielded round without needing another state request', async () => {
  const t = await setup(12)
  try {
    const values = Array.from({ length: 2050 }, (_, i) => ({
      ...segment(0, i * 1000 + 10),
      id: `pressure-${i}`,
    }))
    t.runner.runAutomatic = async (_id, _original, batches) => {
      t.runner.calls.push(batches)
      return []
    }
    let completed = false,
      pressured = false
    await t.automatic.close()
    const automatic = new AutomaticOriginals(t.store.originals, t.runner, () => {
      const alignment = t.store.originals.state(t.target()).alignment
      if (alignment?.pendingSegments === 0) completed = true
      if (t.runner.calls.length === 16 && !pressured) {
        pressured = true
        // Run after this drain yields, when no worker is active to protect its target.
        setTimeout(() => {
          for (let i = 1; i < t.episodes.length; i++) automatic.request(t.target(i))
        }, 0)
      }
    })
    try {
      t.publish(values, [{ startMs: 0, endMs: 2051000 }])
      await until(() => completed)
      assert.equal(pressured, true)
      assert.equal(t.runner.calls.length, 17)
      assert.equal(t.store.originals.state(t.target()).alignment!.sources!.length, 2050)
      assert.deepEqual(t.logs, [])
    } finally {
      await automatic.close()
    }
  } finally {
    await t.automatic.close()
    t.store.close()
  }
})

test('an explicitly linked book prepares every existing transcript beyond the foreground window and yielded round', async () => {
  const t = await setup(24)
  try {
    const targets = t.episodes.map((_episode, index) => t.target(index))
    for (let index = 0; index < targets.length; index++)
      t.publish([segment(0, 1000, `book-${index}`)], [{ startMs: 0, endMs: 30000 }], index)
    t.automatic.requestBook([...targets, ...targets])
    await until(() => new Set(t.notices.map((value) => value.episodeId)).size === targets.length)
    assert.equal(t.runner.calls.length, targets.length)
    for (const target of targets) {
      const state = t.store.originals.state(target)
      assert.equal(state.stale, false)
      assert.equal(state.alignment?.pendingSegments, 0)
      assert.equal(state.alignment?.matches[0]?.selected?.first, 0)
    }
    assert.deepEqual(t.logs, [])
  } finally {
    await t.automatic.close()
    t.store.close()
  }
})

test('foreground pressure returns promised book targets to the backlog and a current-page request takes priority', async () => {
  const t = await setup(20)
  try {
    const gate = t.runner.blockNext()
    const promised = Array.from({ length: 12 }, (_, index) => t.target(index))
    for (let index = 0; index < promised.length; index++)
      t.publish([segment(0, 1000, `promised-${index}`)], [{ startMs: 0, endMs: 30000 }], index)
    t.automatic.requestBook(promised)
    await until(gate.entered)
    assert.equal(t.runner.calls[0]![0]!.targetIds[0], 'promised-11')
    for (let index = 12; index < t.episodes.length; index++)
      t.publish([segment(1, 1000, `foreground-${index}`)], [{ startMs: 0, endMs: 30000 }], index)
    t.automatic.request(t.target(0))
    gate.release()
    await until(() =>
      promised.every((target) => t.store.originals.state(target).alignment?.pendingSegments === 0),
    )
    assert.equal(t.runner.calls[1]![0]!.targetIds[0], 'promised-0')
    assert.deepEqual(t.logs, [])
  } finally {
    await t.automatic.close()
    t.store.close()
  }
})

test('restart can reconstruct an unfinished linked book from lightweight headers without opening its middle episodes', async () => {
  const t = await setup(24)
  t.store.reading.import(parsed)
  for (let index = 0; index < t.episodes.length; index++)
    t.publish([segment(0, 1000, `restart-${index}`)], [{ startMs: 0, endMs: 30000 }], index)
  await t.automatic.close()
  t.store.close()
  const restored = new LibraryStore(t.filename)
  const runner = new Runner()
  const completed = new Set<string>()
  const automatic = new AutomaticOriginals(restored.originals, runner, (target) => {
    completed.add(target.episodeId)
  })
  try {
    const linked = new Set(restored.bookLinks.list().map((link) => link.audioBookId))
    const resume = restored
      .listBooks()
      .filter((book) => linked.has(book.id))
      .flatMap((book) =>
        book.episodes
          .filter(
            (episode) =>
              restored.getTranscriptHeader(episode.id, episode.contentHash).status === 'ready',
          )
          .map((episode) => ({ episodeId: episode.id, audioHash: episode.contentHash })),
      )
    automatic.requestBook(resume)
    await until(() => completed.size === 24)
    assert.equal(runner.calls.length, 24)
    assert.equal(restored.originals.state(t.target(12)).alignment?.pendingSegments, 0)
  } finally {
    await automatic.close()
    restored.close()
  }
})

test('manual work suspends a promised book target while other batches continue and resumes it afterwards', async () => {
  const t = await setup(12)
  let releaseManual: (() => void) | undefined
  try {
    const gate = t.runner.blockNext()
    const targets = t.episodes.map((_episode, index) => t.target(index))
    for (let index = 0; index < targets.length; index++)
      t.publish([segment(0, 1000, `manual-${index}`)], [{ startMs: 0, endMs: 30000 }], index)
    t.automatic.requestBook(targets)
    await until(gate.entered)
    const manual = t.automatic.manual(
      t.target(0),
      () =>
        new Promise<string>((resolve) => {
          releaseManual = () => resolve('manual completed')
        }),
    )
    gate.release()
    await until(() => new Set(t.notices.map((value) => value.episodeId)).size === 11)
    assert.equal(t.store.originals.state(t.target(0)).alignment, null)
    releaseManual!()
    assert.equal(await manual, 'manual completed')
    await settled(t, 0, 1)
    assert.equal(t.runner.calls.length, 12)
    assert.deepEqual(t.logs, [])
  } finally {
    releaseManual?.()
    await t.automatic.close()
    t.store.close()
  }
})

test('a foreground request can preempt eight progressing book targets without losing their remaining batches', async () => {
  const t = await setup(9)
  await t.automatic.close()
  t.runner.runAutomatic = async (_id, _original, batches) => {
    t.runner.calls.push(batches)
    return []
  }
  let pressured = false
  const automatic = new AutomaticOriginals(t.store.originals, t.runner, () => {
    if (t.runner.calls.length === 16 && !pressured) {
      pressured = true
      setTimeout(() => {
        t.publish([segment(0, 1000, 'foreground-now')], [{ startMs: 0, endMs: 30000 }], 8)
      }, 0)
    }
  })
  try {
    const values = Array.from({ length: 260 }, (_, index) => ({
      ...segment(0, index * 1000 + 10),
      id: `progressing-${index}`,
    }))
    for (let index = 0; index < 8; index++)
      t.publish(values, [{ startMs: 0, endMs: 261000 }], index)
    automatic.requestBook(Array.from({ length: 8 }, (_, index) => t.target(index)))
    await until(() =>
      t.episodes.every(
        (_episode, index) =>
          t.store.originals.state(t.target(index)).alignment?.pendingSegments === 0,
      ),
    )
    assert.equal(pressured, true)
    assert.equal(t.runner.calls[16]![0]!.targetIds[0], 'foreground-now')
    assert.equal(t.runner.calls.length, 25)
  } finally {
    await automatic.close()
    t.store.close()
  }
})

test('book preparation is bounded and unlinking or closing cannot commit its old in-flight results', async () => {
  const t = await setup(12)
  try {
    const targets = t.episodes.map((_episode, index) => t.target(index))
    assert.throws(
      () =>
        t.automatic.checkBookRequest(
          Array.from({ length: 10001 }, (_, index) => ({
            episodeId: `bounded-${index}`,
            audioHash: 'a'.repeat(64),
          })),
        ),
      /10,000/,
    )
    const gate = t.runner.blockNext()
    for (let index = 0; index < targets.length; index++)
      t.publish([segment(0, 1000, `unlink-${index}`)], [{ startMs: 0, endMs: 30000 }], index)
    t.automatic.requestBook(targets)
    await until(gate.entered)
    t.store.bookLinks.unlink(t.episodes[0]!.bookId)
    t.automatic.forgetBook(targets)
    gate.release()
    await delay(200)
    await t.automatic.close()
    assert.equal(t.runner.calls.length, 1)
    assert.deepEqual(t.notices, [])
    const db = new DatabaseSync(t.filename)
    assert.equal(db.prepare('SELECT count(*) AS count FROM original_alignments').get()!.count, 0)
    db.close()
    assert.throws(() => t.automatic.requestBook(targets), /正在退出/)
  } finally {
    await t.automatic.close()
    t.store.close()
  }
})
