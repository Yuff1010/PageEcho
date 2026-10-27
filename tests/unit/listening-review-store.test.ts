import assert from 'node:assert/strict'
import { copyFile, mkdtemp, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { LibraryStore } from '../../src/main/database'
import { scanBook } from '../../src/main/files'
import { ListeningReviewStore } from '../../src/main/listening-review-store'
import {
  emptyListeningReviewEntry,
  type ListeningReviewEntry,
  type ListeningReviewSave,
} from '../../src/shared/listening-review'
import type { TranscriptDocument } from '../../src/shared/transcript'

async function fixture(saveDocument = true, durationMs = 16_360) {
  const root = await mkdtemp(join(tmpdir(), 'ralb-review-store-'))
  const audio = join(root, '试听夹具.wav')
  await copyFile(resolve('tests/fixtures/第32集-伴读样本.wav'), audio)
  const library = new LibraryStore(join(root, 'library.sqlite3'))
  library.importBook(await scanBook(audio, 'file'))
  const episode = library.listBooks()[0]!.episodes[0]!
  const target = { episodeId: episode.id, audioHash: episode.contentHash }
  library.recordSourceDuration(episode.id, episode.contentHash, durationMs)
  const document: TranscriptDocument = {
    version: 1,
    audioHash: episode.contentHash,
    kind: 'manual',
    coverage: [{ startMs: 0, endMs: 16_360 }],
    segments: Array.from({ length: 6 }, (_, i) => ({
      id: `test-${i}`,
      startMs: 500 + i * 2000,
      endMs: 1500 + i * 2000,
      text: `合成测试第${i + 1}句。`,
    })),
  }
  if (saveDocument) library.saveTranscript(episode.id, document)
  const reviewPath = join(root, 'listening-reviews.sqlite3')
  let reviews = new ListeningReviewStore(reviewPath, library)
  return {
    library,
    document,
    audio,
    target,
    reviewPath,
    get reviews() {
      return reviews
    },
    async prepare() {
      return (await reviews.prepare({ ...target, transcriptRevision: 1 })).review!
    },
    reopen() {
      reviews.close()
      reviews = new ListeningReviewStore(reviewPath, library)
    },
    close() {
      reviews.close()
      library.close()
    },
  }
}

test('review freezes fixed positions without automatic labels, adds samples without shrinking the denominator and survives restart', async () => {
  const f = await fixture()
  try {
    const review = await f.prepare()
    assert.deepEqual(
      review.samples.map((item) => item.segmentId),
      ['test-0', 'test-3', 'test-5'],
    )
    assert.ok(
      review.samples.every(
        (item) =>
          item.kind === 'fixed' &&
          !item.entry.listened &&
          item.entry.spokenText === null &&
          item.entry.humanStartMs === null,
      ),
    )
    assert.equal(review.sourceProfile, null)
    assert.equal((await f.prepare()).id, review.id)
    const added = await f.reviews.save({
      ...f.target,
      reviewId: review.id,
      revision: 1,
      action: 'add-sample',
      segmentId: 'test-1',
    })
    assert.equal(added.review!.samples.length, 4)
    assert.equal(added.summary!.fixedSamples, 3)
    assert.equal(added.summary!.unknownReferenceSamples, 4)
    assert.equal(added.summary!.acceptance, 'not-evaluated')
    assert.deepEqual(
      added.review!.samples.slice(0, 3).map((item) => item.id),
      review.samples.map((item) => item.id),
    )
    f.reopen()
    assert.deepEqual((await f.reviews.get(f.target)).review, added.review)
  } finally {
    f.close()
  }
})

test('saved human feedback uses revision CAS and incomplete samples remain in quality counts', async () => {
  const f = await fixture()
  try {
    const review = await f.prepare(),
      selected = review.samples[0]!
    const entry: ListeningReviewEntry = {
      ...emptyListeningReviewEntry(),
      listened: true,
      speech: 'speech',
      spokenText: '这是测试中明确提供的人工标签。',
      namesChecked: true,
      properNames: '',
      sync: 'aligned',
    }
    const request: ListeningReviewSave = {
      ...f.target,
      reviewId: review.id,
      revision: 1,
      action: 'feedback',
      sampleId: selected.id,
      entry,
    }
    const saved = await f.reviews.save(request)
    assert.equal(saved.summary!.referenceSamples, 1)
    assert.equal(saved.summary!.completeSamples, 1)
    assert.equal(saved.summary!.unknownReferenceSamples, 2)
    assert.equal(saved.summary!.reviewStatus, 'partial-review')
    assert.equal(saved.summary!.pairedBoundaries, 0)
    assert.equal(saved.summary!.acceptance, 'not-evaluated')
    await assert.rejects(f.reviews.save(request), { code: 'CONFLICT' })
    f.reopen()
    assert.deepEqual((await f.reviews.get(f.target)).review!.samples[0]!.entry, entry)
  } finally {
    f.close()
  }
})

test('invalid labels, unknown references and impossible human boundaries never mutate a frozen review', async () => {
  const f = await fixture()
  try {
    const review = await f.prepare(),
      selected = review.samples[0]!
    const known: ListeningReviewEntry = {
      ...emptyListeningReviewEntry(),
      listened: true,
      speech: 'speech',
      spokenText: '明确的合成测试参考。',
    }
    const variants = [
      { ...known, listened: false },
      { ...known, spokenText: '' },
      { ...known, spokenText: '……！？' },
      { ...known, namesChecked: true, properNames: null },
      { ...known, sync: 'not-applicable' },
      { ...known, humanStartMs: selected.clipStartMs - 1 },
      { ...known, humanStartMs: selected.clipStartMs + 100, humanEndMs: selected.clipStartMs },
      {
        ...known,
        speech: 'silence',
        spokenText: '',
        sync: 'not-applicable',
        humanStartMs: selected.targetStartMs,
      },
    ] as ListeningReviewEntry[]
    for (const entry of variants)
      await assert.rejects(
        f.reviews.save({
          ...f.target,
          reviewId: review.id,
          revision: 1,
          action: 'feedback',
          sampleId: selected.id,
          entry,
        }),
        { code: 'INVALID_REQUEST' },
      )
    assert.equal((await f.reviews.get(f.target)).review!.revision, 1)
    assert.equal((await f.reviews.get(f.target)).summary!.listenedSamples, 0)
  } finally {
    f.close()
  }
})

test('new transcript revisions retain read-only history and reject edits against the earlier frozen document', async () => {
  const f = await fixture()
  try {
    const old = await f.prepare()
    f.library.saveTranscript(f.target.episodeId, {
      ...f.document,
      segments: f.document.segments.map((item, i) =>
        i ? item : { ...item, text: '更新后的测试文字。' },
      ),
    })
    const stale = await f.reviews.get(f.target)
    assert.equal(stale.status, 'stale')
    assert.equal(stale.review!.id, old.id)
    await assert.rejects(
      f.reviews.save({
        ...f.target,
        reviewId: old.id,
        revision: 1,
        action: 'feedback',
        sampleId: old.samples[0]!.id,
        entry: emptyListeningReviewEntry(),
      }),
      { code: 'CONFLICT' },
    )
    const current = await f.reviews.prepare({ ...f.target, transcriptRevision: 2 })
    assert.notEqual(current.review!.id, old.id)
    assert.equal(current.history.length, 2)
    const historical = await f.reviews.get({ ...f.target, reviewId: old.id })
    assert.equal(historical.status, 'stale')
    assert.equal(historical.review!.samples[0]!.machineText, old.samples[0]!.machineText)
    assert.equal(historical.summary!.acceptance, 'not-evaluated')
  } finally {
    f.close()
  }
})

test('partial coverage, changing automatic jobs and changed files cannot establish or update a quality snapshot', async () => {
  const f = await fixture()
  try {
    f.library.saveTranscript(f.target.episodeId, {
      ...f.document,
      coverage: [{ startMs: 0, endMs: 7000 }],
      segments: f.document.segments.slice(0, 3),
    })
    await assert.rejects(f.reviews.prepare({ ...f.target, transcriptRevision: 2 }), {
      code: 'CONFLICT',
    })
    const job = f.library.createJob({ ...f.target, engine: 'paraformer', device: 'cpu' })
    f.library.setJobStatus(job.id, job.attempt, 'running')
    // A job with a protected manual document is allowed to run without changing
    // that saved snapshot; partial coverage still prevents a false full review.
    await assert.rejects(f.reviews.prepare({ ...f.target, transcriptRevision: 2 }), {
      code: 'CONFLICT',
    })
    f.library.setJobStatus(job.id, job.attempt, 'canceled')
    f.library.saveTranscript(f.target.episodeId, f.document)
    const ready = await f.reviews.prepare({ ...f.target, transcriptRevision: 3 })
    await appendFile(f.audio, 'injected change only in isolated copy')
    const stale = await f.reviews.get(f.target)
    assert.equal(stale.status, 'stale')
    await assert.rejects(
      f.reviews.save({
        ...f.target,
        reviewId: ready.review!.id,
        revision: 1,
        action: 'add-sample',
        segmentId: 'test-1',
      }),
      { code: 'FILE_CHANGED' },
    )
    assert.equal((await f.reviews.get(f.target)).review!.revision, 1)
  } finally {
    f.close()
  }
})

test('changing automatic output must settle before review; an edited document loses the earlier engine attribution', async () => {
  const f = await fixture(false)
  try {
    const job = f.library.createJob({ ...f.target, engine: 'paraformer', device: 'cpu' })
    f.library.setJobStatus(job.id, job.attempt, 'running')
    f.library.acceptJobSnapshot(
      job.id,
      job.attempt,
      {
        document: { ...f.document, kind: 'transcript' },
        processedUntilMs: 16_360,
        cacheKey: 'a'.repeat(64),
        totalChunks: 1,
        cacheHits: 0,
        issues: [],
      },
      1,
      false,
    )
    await assert.rejects(f.prepare(), { code: 'BUSY' })
    f.library.setJobStatus(job.id, job.attempt, 'completed')
    const settled = await f.prepare()
    assert.deepEqual(settled.sourceProfile, {
      engine: 'paraformer',
      device: 'cpu',
      jobId: job.id,
      attempt: 1,
    })
    f.library.saveTranscript(f.target.episodeId, f.document)
    const edited = await f.reviews.prepare({ ...f.target, transcriptRevision: 2 })
    assert.equal(edited.review!.sourceProfile, null)
    let current = edited
    for (const sample of edited.review!.samples) {
      current = await f.reviews.save({
        ...f.target,
        reviewId: current.review!.id,
        revision: current.review!.revision,
        action: 'feedback',
        sampleId: sample.id,
        entry: {
          ...emptyListeningReviewEntry(),
          listened: true,
          speech: 'speech',
          spokenText: '合成的测试参考。',
          namesChecked: true,
          properNames: '',
          sync: 'aligned',
        },
      })
    }
    assert.equal(current.summary!.reviewStatus, 'review-data-complete')
    assert.equal(current.summary!.completeSamples, 3)
    assert.equal(current.summary!.acceptance, 'not-evaluated')
  } finally {
    f.close()
  }
})

test('damaged persisted review data cannot shrink fixed samples or manufacture a quality summary', async () => {
  const f = await fixture()
  let editing: DatabaseSync | undefined
  try {
    const review = await f.prepare()
    editing = new DatabaseSync(f.reviewPath)
    for (const corrupt of [
      { ...review, samples: review.samples.slice(1), sampleCount: 2 },
      {
        ...review,
        samples: review.samples.map((sample, i) =>
          i ? sample : { ...sample, fixedFractions: [0.5] },
        ),
      },
      {
        ...review,
        samples: review.samples.map((sample, i) =>
          i ? sample : { ...sample, entry: { ...sample.entry, acceptance: 'passed' } },
        ),
      },
      { ...review, mediaUrl: 'https://unbound.example/audio' },
      { ...review, transcriptRevision: review.transcriptRevision + 1 },
    ]) {
      editing
        .prepare('UPDATE listening_reviews SET document_json=? WHERE id=?')
        .run(JSON.stringify(corrupt), review.id)
      await assert.rejects(f.reviews.get(f.target), { code: 'CONFLICT' })
    }
    editing
      .prepare('UPDATE listening_reviews SET document_json=? WHERE id=?')
      .run(JSON.stringify(review), review.id)
    assert.equal((await f.reviews.get(f.target)).summary!.acceptance, 'not-evaluated')
  } finally {
    editing?.close()
    f.close()
  }
})

test('fractional container duration keeps original metadata and integer clip endpoints through saving and restart', async () => {
  const f = await fixture(true, 16_360.25)
  try {
    f.library.saveTranscript(f.target.episodeId, {
      ...f.document,
      segments: f.document.segments.map((segment, i) =>
        i === 5 ? { ...segment, startMs: 15_000, endMs: 16_360 } : segment,
      ),
    })
    const prepared = await f.reviews.prepare({ ...f.target, transcriptRevision: 2 })
    const review = prepared.review!,
      sample = review.samples.at(-1)!
    assert.equal(prepared.status, 'ready')
    assert.equal(review.durationMs, 16_360.25)
    assert.equal(sample.clipEndMs, 16_361)
    assert.ok(Number.isSafeInteger(sample.clipEndMs))
    assert.ok(sample.clipEndMs <= review.durationMs + 1)
    const saved = await f.reviews.save({
      ...f.target,
      reviewId: review.id,
      revision: review.revision,
      action: 'feedback',
      sampleId: sample.id,
      entry: { ...emptyListeningReviewEntry(), listened: true },
    })
    f.reopen()
    assert.deepEqual((await f.reviews.get(f.target)).review, saved.review)
  } finally {
    f.close()
  }
})
