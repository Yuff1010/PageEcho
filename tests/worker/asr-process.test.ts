import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { execFileSync } from 'node:child_process'
import { AsrWorkerProcess, type AsrEvent } from '../../src/main/asr-process'

// Only stdlib Python is required. Real models are covered by the opt-in worker test.
const python = execFileSync('python', ['-c', 'import sys; print(sys.executable)'], {
  encoding: 'utf8',
  windowsHide: true,
}).trim()
async function launch(mode: string, waitReady = true, cpuThreads?: 1 | 2 | 4) {
  const root = await mkdtemp(join(tmpdir(), '听读 process '))
  const configuration = join(root, 'configuration.json')
  const pidFile = join(root, 'child.pid')
  await writeFile(configuration, JSON.stringify({ mode, pidFile }))
  const worker = new AsrWorkerProcess({
    python,
    script: resolve('tests/fixtures/asr-protocol-worker.py'),
    models: configuration,
    cache: root,
    ffmpeg: python,
    ffprobe: python,
    engine: 'whisperx',
    device: 'cpu',
    compute: 'int8',
    cancelGraceMs: 300,
    cpuThreads,
  })
  if (waitReady) await worker.ready
  return { worker, pidFile }
}
function submission(attempt = 1, jobId = randomUUID()) {
  return {
    jobId,
    attempt,
    audioPath: resolve('tests/fixtures/tone.mp3'),
    audioHash: 'a'.repeat(64),
    range: { startMs: 30000, endMs: 40000 },
  }
}

test('worker process preserves real UTF-8 messages and validates the transcript at its boundary', async () => {
  const { worker } = await launch('valid')
  const events: AsrEvent[] = []
  try {
    const result = await worker.submit(submission(), (event) => events.push(event))
    assert.equal(result.status, 'completed')
    if (result.status === 'completed') {
      assert.equal(result.document.segments[0]!.text, '中文片段。')
      assert.equal(result.document.segments[0]!.startMs, 30000)
    }
    assert.equal(events.filter((event) => event.type === 'partial').length, 1)
  } finally {
    await worker.close()
  }
})

test('cancel suppresses late output and retry ignores the old attempt even with the same job ID', async () => {
  const { worker } = await launch('late')
  const first = submission()
  let partials = 0
  try {
    const result = await worker.submit(first, (event) => {
      if (event.type === 'progress') worker.cancel(first.jobId, first.attempt)
      if (event.type === 'partial') partials++
    })
    assert.deepEqual(result, { status: 'canceled' })
    const retried = await worker.submit(submission(2, first.jobId), (event) => {
      if (event.type === 'partial') partials++
    })
    assert.equal(retried.status, 'completed')
    assert.equal(partials, 1)
  } finally {
    await worker.close()
  }
})

test('malformed worker output and a different audio hash never become a successful transcript', async () => {
  for (const mode of ['corrupt', 'wrong-hash', 'false-prefix']) {
    const { worker } = await launch(mode)
    try {
      await assert.rejects(worker.submit(submission()), { code: 'INVALID_PROTOCOL' })
    } finally {
      await worker.close()
    }
  }
})

test('out-of-order coverage retains an honest prefix and live priority uses the current attempt', async () => {
  const { worker } = await launch('priority-gaps')
  const value = { ...submission(), priorityMs: 36000 }
  const prefixes: number[] = []
  try {
    const result = await worker.submit(value, (event) => {
      if (event.type !== 'partial') return
      prefixes.push(event.processedUntilMs)
      if (event.completedChunks === 1) {
        assert.equal(event.document.coverage[0]!.startMs, 35000)
        worker.prioritize(value.jobId, value.attempt - 1, 30000)
        worker.prioritize(value.jobId, value.attempt, 30000)
      }
    })
    assert.equal(result.status, 'completed')
    assert.deepEqual(prefixes, [30000, 40000])
    if (result.status === 'completed')
      assert.deepEqual(result.document.coverage, [{ startMs: 30000, endMs: 40000 }])
  } finally {
    await worker.close()
  }
})

test('an application storage failure during a valid partial retains its original error and stops the worker', async () => {
  const { worker } = await launch('valid')
  const full = Object.assign(new Error('database or disk is full'), { errcode: 13 })
  try {
    await assert.rejects(
      worker.submit(submission(), (event) => {
        if (event.type === 'partial') throw full
      }),
      (error: unknown) => error === full,
    )
    await assert.rejects(worker.submit(submission()), (error: unknown) => error === full)
  } finally {
    await worker.close()
  }
})

test('an unexpected worker exit reports failure while leaving the last valid partial available', async () => {
  const { worker } = await launch('crash')
  let partials = 0
  try {
    await assert.rejects(
      worker.submit(submission(), (event) => {
        if (event.type === 'partial') partials++
      }),
      { code: 'WORKER_EXITED' },
    )
    assert.equal(partials, 1)
  } finally {
    await worker.close()
  }
})

test('unresponsive cancellation stops the owned worker and its decoding descendants', async () => {
  const { worker, pidFile } = await launch('hang')
  const value = submission()
  try {
    const running = worker.submit(value)
    let childPid: number | undefined
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        childPid = Number(await readFile(pidFile, 'utf8'))
        break
      } catch {
        await delay(50)
      }
    }
    assert.ok(childPid)
    worker.cancel(value.jobId, value.attempt)
    assert.deepEqual(await running, { status: 'canceled' })
    let alive = true
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        process.kill(childPid, 0)
        await delay(50)
      } catch {
        alive = false
        break
      }
    }
    assert.equal(alive, false, 'the owned descendant must not survive cancellation')
  } finally {
    await worker.close()
  }
})

test(
  'Windows worker crash closes its job object and stops an owned descendant after emitting a prefix',
  {
    skip: process.platform !== 'win32',
  },
  async () => {
    const { worker, pidFile } = await launch('crash-with-child')
    let partials = 0
    try {
      await assert.rejects(
        worker.submit(submission(), (event) => {
          if (event.type === 'partial') partials++
        }),
        { code: 'WORKER_EXITED' },
      )
      assert.equal(partials, 1)
      const childPid = Number(await readFile(pidFile, 'utf8'))
      assert.ok(Number.isSafeInteger(childPid) && childPid > 0)
      let alive = true
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          process.kill(childPid, 0)
          await delay(50)
        } catch {
          alive = false
          break
        }
      }
      assert.equal(alive, false, 'the decoding descendant must not outlive its crashed worker')
    } finally {
      await worker.close()
    }
  },
)

test('a task can be canceled while its worker is still starting', async () => {
  const { worker } = await launch('slow-start', false)
  const value = submission()
  try {
    const running = worker.submit(value)
    worker.cancel(value.jobId, value.attempt)
    assert.deepEqual(await running, { status: 'canceled' })
  } finally {
    await worker.close()
  }
})

test('startup storage errors retain actionable details and malformed fatal messages are rejected', async () => {
  for (const mode of ['fatal-cache', 'fatal-invalid']) {
    const { worker } = await launch(mode, false)
    try {
      await assert.rejects(
        worker.ready,
        mode === 'fatal-cache'
          ? {
              code: 'CACHE_UNWRITABLE',
              message: /用户数据目录的写入权限/,
            }
          : { code: 'INVALID_PROTOCOL' },
      )
    } finally {
      await worker.close()
    }
  }
})

test('resource diagnostics stay unknown before model work and report verified threads and native priority afterwards', async () => {
  const { worker } = await launch('resources', true, 1)
  try {
    assert.equal(worker.resources()?.cpuThreads, null)
    worker.setLowPriority(true)
    assert.equal(worker.resources()?.priority, 'low')
    const result = await worker.submit(submission(), () => {})
    assert.equal(result.status, 'completed')
    assert.equal(worker.resources()?.cpuThreads, 1)
    if (process.platform === 'win32') {
      worker.setLowPriority(false)
      assert.equal(worker.resources()?.priority, 'normal')
    }
  } finally {
    await worker.close()
  }
})

test('a worker that reports a thread-budget reset is stopped before accepting a transcript snapshot', async () => {
  const { worker } = await launch('bad-resources', true, 1)
  let partials = 0
  try {
    await assert.rejects(
      worker.submit(submission(), (event) => {
        if (event.type === 'partial') partials++
      }),
      { code: 'RESOURCE_THREADS' },
    )
    assert.equal(partials, 0)
  } finally {
    await worker.close()
  }
})
