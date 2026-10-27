import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { isAbsolute } from 'node:path'
import { constants, getPriority, setPriority } from 'node:os'
import type { ProcessingResources } from '../shared/processing-resources'
import { validateTranscript, type TranscriptDocument } from '../shared/transcript'
import { isId } from '../shared/validation'

export interface AsrRuntime {
  python: string
  script: string
  models: string
  cache: string
  resources?: string
  ffmpeg: string
  ffprobe: string
  engine: 'whisperx' | 'paraformer'
  device: 'cpu' | 'cuda'
  compute: 'int8' | 'int8_float16' | 'float16'
  chunkMs?: number
  overlapMs?: number
  cancelGraceMs?: number
  cpuThreads?: 1 | 2 | 4
  lowPriority?: boolean
}
export interface AsrSubmission {
  jobId: string
  attempt: number
  audioPath: string
  audioHash: string
  range: { startMs: number; endMs: number | null }
  priorityMs?: number
}
export interface AsrSnapshot {
  document: TranscriptDocument
  processedUntilMs: number
  cacheKey: string
  cacheHits: number
  totalChunks: number
  issues: { code: string; atMs: number; units?: number }[]
}
export type AsrEvent =
  | { type: 'progress'; stage: string; processedUntilMs: number }
  | ({ type: 'partial'; completedChunks: number } & AsrSnapshot)
export type AsrOutcome =
  { status: 'canceled' } | ({ status: 'completed'; durationMs: number } & AsrSnapshot)

export class AsrProcessError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

interface ActiveJob {
  submission: AsrSubmission
  canceling: boolean
  processedUntilMs: number
  completedChunks: number
  totalChunks?: number
  resolve: (value: AsrOutcome) => void
  reject: (error: Error) => void
  onEvent: (event: AsrEvent) => void
  timer?: NodeJS.Timeout
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function integer(value: unknown, min = 0, max = 3.6e10): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}
function protocolError(): never {
  throw new AsrProcessError('INVALID_PROTOCOL', '转写进程返回了无效消息，请重试。')
}

/** One owned Python process, one active attempt. No shell or renderer paths. */
export class AsrWorkerProcess {
  readonly ready: Promise<void>
  private readonly child: ChildProcessWithoutNullStreams
  private readonly closed: Promise<void>
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private active?: ActiveJob
  private initialized = false
  private stopped = false
  private closing = false
  private failure?: Error
  private stdout = ''
  private decoder = new StringDecoder('utf8')
  private logTail = ''
  private workerConfiguration?: Record<string, unknown>
  private actualCpuThreads: number | null = null

  constructor(private readonly runtime: AsrRuntime) {
    if (runtime.cpuThreads !== undefined && ![1, 2, 4].includes(runtime.cpuThreads))
      throw new Error('CPU 线程数必须为 1、2 或 4。')
    for (const path of [
      runtime.python,
      runtime.script,
      runtime.models,
      runtime.cache,
      runtime.ffmpeg,
      runtime.ffprobe,
      ...(runtime.resources ? [runtime.resources] : []),
    ])
      if (!isAbsolute(path) || path.includes('\0')) throw new Error('转写组件路径必须是绝对路径。')
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    void this.ready.catch(() => undefined)
    const args = [
      '-B',
      '-X',
      'utf8',
      runtime.script,
      '--cache',
      runtime.cache,
      '--models',
      runtime.models,
      '--ffmpeg',
      runtime.ffmpeg,
      '--ffprobe',
      runtime.ffprobe,
      '--engine',
      runtime.engine,
      '--device',
      runtime.device,
      '--compute',
      runtime.compute,
      '--chunk-ms',
      String(runtime.chunkMs ?? 30000),
      '--overlap-ms',
      String(runtime.overlapMs ?? 2000),
      ...(runtime.resources ? ['--resources', runtime.resources] : []),
      ...(runtime.cpuThreads ? ['--cpu-threads', String(runtime.cpuThreads)] : []),
    ]
    const env = { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' }
    if (runtime.cpuThreads && runtime.cpuThreads !== 4)
      Object.assign(
        env,
        Object.fromEntries(
          ['OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS'].map(
            (key) => [key, String(runtime.cpuThreads)],
          ),
        ),
      )
    this.child = spawn(runtime.python, args, {
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    })
    this.closed = new Promise((resolve) => this.child.once('close', () => resolve()))
    this.child.once('spawn', () => {
      try {
        this.setLowPriority(!!runtime.lowPriority)
      } catch (error) {
        this.fail(
          error instanceof AsrProcessError
            ? error
            : new AsrProcessError('RESOURCE_PRIORITY', '无法设置转写进程优先级。'),
        )
      }
    })
    const readyTimer = setTimeout(
      () => this.fail(new AsrProcessError('START_TIMEOUT', '转写组件启动超时，请检查配置。')),
      15000,
    )
    this.child.stdout.on('data', (data: Buffer) => {
      try {
        this.stdout += this.decoder.write(data)
        let index: number
        while ((index = this.stdout.indexOf('\n')) >= 0) {
          const line = this.stdout.slice(0, index)
          this.stdout = this.stdout.slice(index + 1)
          if (Buffer.byteLength(line) > 16 * 1024 * 1024) protocolError()
          this.receive(JSON.parse(line))
        }
        if (Buffer.byteLength(this.stdout) > 16 * 1024 * 1024) protocolError()
      } catch (error) {
        this.fail(
          error instanceof AsrProcessError
            ? error
            : new AsrProcessError('INVALID_PROTOCOL', '转写进程的消息无法读取。'),
        )
      }
    })
    this.child.stderr.on('data', (data: Buffer) => {
      this.logTail = (this.logTail + data.toString('utf8')).slice(-65536)
    })
    this.child.stdin.on('error', () =>
      this.fail(new AsrProcessError('WORKER_EXITED', '转写进程已退出，可以重试。')),
    )
    this.child.once('error', () =>
      this.fail(new AsrProcessError('START_FAILED', '无法启动 Python 转写组件，请检查配置。')),
    )
    this.child.once('close', (code) => {
      clearTimeout(readyTimer)
      this.stopped = true
      if (!this.initialized)
        this.readyReject(this.failure ?? new AsrProcessError('START_FAILED', '转写组件未能启动。'))
      if (this.active?.canceling) this.finish({ status: 'canceled' })
      else if (this.active)
        this.reject(
          new AsrProcessError(
            'WORKER_EXITED',
            `转写进程异常退出（${code ?? 'signal'}），已完成分块可在重试时复用。`,
          ),
        )
    })
    void this.ready.finally(() => clearTimeout(readyTimer)).catch(() => undefined)
  }

  get diagnosticLog(): string {
    return this.logTail
  }

  get configuration(): Record<string, unknown> | undefined {
    return this.workerConfiguration
  }
  setLowPriority(low: boolean): void {
    if (this.stopped || !this.child.pid) return
    try {
      setPriority(
        this.child.pid,
        low ? constants.priority.PRIORITY_BELOW_NORMAL : constants.priority.PRIORITY_NORMAL,
      )
    } catch {
      throw new AsrProcessError(
        'RESOURCE_PRIORITY',
        '无法设置转写进程优先级，请查看资源设置的实际状态。',
      )
    }
  }
  resources(): ProcessingResources['worker'] {
    if (this.stopped || !this.child.pid) return null
    let priority: 'low' | 'normal' | 'unknown' = 'unknown'
    try {
      const actual = getPriority(this.child.pid)
      if (actual === constants.priority.PRIORITY_NORMAL) priority = 'normal'
      else if (actual >= constants.priority.PRIORITY_BELOW_NORMAL) priority = 'low'
    } catch {
      /* A process can finish between sampling and the OS query. */
    }
    return {
      pid: this.child.pid,
      cpuThreads: this.actualCpuThreads,
      priority,
    }
  }

  async submit(
    submission: AsrSubmission,
    onEvent: (event: AsrEvent) => void = () => undefined,
  ): Promise<AsrOutcome> {
    if (
      !isId(submission.jobId) ||
      !integer(submission.attempt, 1, 100000) ||
      !isAbsolute(submission.audioPath) ||
      !/^[0-9a-f]{64}$/.test(submission.audioHash) ||
      !integer(submission.range.startMs) ||
      (submission.range.endMs !== null &&
        !integer(submission.range.endMs, submission.range.startMs + 1)) ||
      (submission.priorityMs !== undefined && !integer(submission.priorityMs))
    )
      throw new AsrProcessError('INVALID_REQUEST', '转写任务参数无效。')
    if (this.closing || this.stopped || this.failure)
      throw this.failure ?? new AsrProcessError('WORKER_EXITED', '转写组件已关闭。')
    if (this.active) throw new AsrProcessError('BUSY', '另一个转写任务正在运行。')
    return new Promise((resolve, reject) => {
      const active: ActiveJob = {
        submission,
        canceling: false,
        processedUntilMs: submission.range.startMs,
        completedChunks: 0,
        resolve,
        reject,
        onEvent,
      }
      this.active = active
      void this.ready
        .then(() => {
          if (this.active === active && !active.canceling && !this.closing)
            this.write({ protocolVersion: 1, type: 'submit', ...submission })
        })
        .catch((error: Error) => {
          if (this.active === active && !active.canceling) this.reject(error)
        })
    })
  }

  cancel(jobId: string, attempt: number): void {
    const active = this.active
    if (
      !active ||
      active.submission.jobId !== jobId ||
      active.submission.attempt !== attempt ||
      active.canceling
    )
      return
    active.canceling = true
    this.write({ protocolVersion: 1, type: 'cancel', jobId, attempt })
    active.timer = setTimeout(() => void this.killTree(), this.runtime.cancelGraceMs ?? 3000)
  }

  prioritize(jobId: string, attempt: number, positionMs: number): void {
    const active = this.active
    if (!integer(positionMs)) throw new AsrProcessError('INVALID_REQUEST', '字幕优先位置无效。')
    if (
      !active ||
      active.canceling ||
      active.submission.jobId !== jobId ||
      active.submission.attempt !== attempt
    )
      return
    active.submission.priorityMs = positionMs
    this.write({ protocolVersion: 1, type: 'prioritize', jobId, attempt, positionMs })
  }

  async close(): Promise<void> {
    if (this.stopped) return
    if (this.closing) {
      await this.closed
      return
    }
    this.closing = true
    if (this.active) this.cancel(this.active.submission.jobId, this.active.submission.attempt)
    this.child.stdin.end()
    const timer = setTimeout(() => void this.killTree(), this.runtime.cancelGraceMs ?? 3000)
    await this.closed
    clearTimeout(timer)
  }

  private write(value: unknown): void {
    if (!this.stopped && !this.child.stdin.destroyed)
      this.child.stdin.write(JSON.stringify(value) + '\n')
  }

  private receive(value: unknown): void {
    if (
      this.failure ||
      !object(value) ||
      value.protocolVersion !== 1 ||
      typeof value.type !== 'string'
    ) {
      if (this.failure) return
      protocolError()
    }
    if (value.executionResources !== undefined) {
      const resources = value.executionResources
      if (
        !object(resources) ||
        resources.requestedCpuThreads !== (this.runtime.cpuThreads ?? 4) ||
        (resources.torchThreads !== null &&
          resources.torchThreads !== resources.requestedCpuThreads) ||
        (resources.torchThreads !== null &&
          (typeof resources.torchInteropThreads !== 'number' ||
            !Number.isSafeInteger(resources.torchInteropThreads) ||
            resources.torchInteropThreads < 1 ||
            (resources.requestedCpuThreads !== 4 && resources.torchInteropThreads !== 1)))
      )
        throw new AsrProcessError(
          'RESOURCE_THREADS',
          '模型未保持请求的 CPU 线程限制，已停止处理并保留此前完成的分块。',
        )
      this.actualCpuThreads = resources.torchThreads as number | null
    }
    if (value.type === 'ready') {
      if (this.initialized || !object(value.configuration)) protocolError()
      this.workerConfiguration = value.configuration
      this.initialized = true
      this.readyResolve()
      return
    }
    if (value.type === 'fatal') {
      if (
        this.initialized ||
        typeof value.code !== 'string' ||
        !/^[A-Z_]{1,64}$/.test(value.code) ||
        typeof value.message !== 'string' ||
        !value.message.length ||
        value.message.length > 2000
      )
        protocolError()
      this.fail(new AsrProcessError(value.code, value.message))
      return
    }
    const active = this.active
    if (
      !active ||
      value.jobId !== active.submission.jobId ||
      value.attempt !== active.submission.attempt
    )
      return
    if (active.canceling) {
      if (['result', 'error', 'canceled'].includes(value.type)) this.finish({ status: 'canceled' })
      return
    }
    switch (value.type) {
      case 'accepted':
        return
      case 'priority-accepted':
        if (!integer(value.positionMs)) protocolError()
        return
      case 'progress': {
        if (
          !['validating', 'decoding', 'loading', 'recognizing', 'punctuation'].includes(
            String(value.stage),
          ) ||
          !integer(value.processedUntilMs, active.processedUntilMs)
        )
          protocolError()
        this.publish(active, {
          type: 'progress',
          stage: value.stage as string,
          processedUntilMs: value.processedUntilMs,
        })
        return
      }
      case 'partial': {
        const snapshot = this.snapshot(value, active)
        if (
          !integer(
            value.completedChunks,
            Math.max(1, active.completedChunks),
            snapshot.totalChunks,
          ) ||
          snapshot.cacheHits > value.completedChunks
        )
          protocolError()
        active.processedUntilMs = snapshot.processedUntilMs
        active.completedChunks = value.completedChunks
        this.publish(active, {
          type: 'partial',
          ...snapshot,
          completedChunks: value.completedChunks,
        })
        return
      }
      case 'result': {
        const snapshot = this.snapshot(value, active)
        if (
          !integer(value.durationMs, snapshot.processedUntilMs) ||
          snapshot.processedUntilMs !== (active.submission.range.endMs ?? value.durationMs)
        )
          protocolError()
        validateTranscript(snapshot.document, active.submission.audioHash, value.durationMs)
        this.finish({ status: 'completed', ...snapshot, durationMs: value.durationMs })
        return
      }
      case 'canceled':
        this.finish({ status: 'canceled' })
        return
      case 'error': {
        if (
          typeof value.code !== 'string' ||
          value.code.length > 64 ||
          typeof value.message !== 'string' ||
          value.message.length > 2000
        )
          protocolError()
        this.reject(new AsrProcessError(value.code, value.message))
        return
      }
      default:
        protocolError()
    }
  }

  private publish(active: ActiveJob, event: AsrEvent): void {
    try {
      active.onEvent(event)
    } catch (error) {
      // A valid model message may fail to persist. Retain that storage error,
      // rather than reporting it as corrupt worker output.
      this.fail(
        error instanceof Error ? error : new Error('生成文稿无法保存，请检查用户数据目录。'),
      )
    }
  }

  private snapshot(value: Record<string, unknown>, active: ActiveJob): AsrSnapshot {
    if (
      !integer(
        value.processedUntilMs,
        active.processedUntilMs,
        active.submission.range.endMs ?? 3.6e10,
      ) ||
      typeof value.cacheKey !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.cacheKey) ||
      !integer(value.totalChunks, 1, 1000000) ||
      (active.totalChunks !== undefined && value.totalChunks !== active.totalChunks) ||
      !integer(value.cacheHits, 0, value.totalChunks) ||
      !Array.isArray(value.issues) ||
      value.issues.length > 100000
    )
      protocolError()
    active.totalChunks = value.totalChunks
    const issues = value.issues.map((issue: unknown) => {
      if (
        !object(issue) ||
        typeof issue.code !== 'string' ||
        issue.code.length > 64 ||
        !integer(issue.atMs) ||
        (issue.units !== undefined && !integer(issue.units, 1, 100))
      )
        protocolError()
      return {
        code: issue.code,
        atMs: issue.atMs,
        ...(issue.units === undefined ? {} : { units: issue.units }),
      }
    })
    const document = validateTranscript(
      value.document,
      active.submission.audioHash,
      active.submission.range.endMs,
    )
    if (
      document.kind !== 'transcript' ||
      document.coverage.some((range) => range.startMs < active.submission.range.startMs) ||
      (value.processedUntilMs > active.submission.range.startMs &&
        (document.coverage[0]!.startMs !== active.submission.range.startMs ||
          document.coverage[0]!.endMs < value.processedUntilMs))
    )
      protocolError()
    return {
      document,
      processedUntilMs: value.processedUntilMs,
      cacheKey: value.cacheKey,
      cacheHits: value.cacheHits,
      totalChunks: value.totalChunks,
      issues,
    }
  }

  private finish(outcome: AsrOutcome): void {
    const active = this.active
    this.active = undefined
    if (active) {
      clearTimeout(active.timer)
      active.resolve(outcome)
    }
  }

  private reject(error: Error): void {
    const active = this.active
    this.active = undefined
    if (active) {
      clearTimeout(active.timer)
      active.reject(error)
    }
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    this.readyReject(error)
    if (!this.active?.canceling) this.reject(error)
    void this.killTree()
  }

  private async killTree(): Promise<void> {
    if (this.stopped || !this.child.pid) return
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) =>
        execFile(
          'taskkill.exe',
          ['/PID', String(this.child.pid), '/T', '/F'],
          { windowsHide: true },
          () => resolve(),
        ),
      )
    } else {
      try {
        process.kill(-this.child.pid, 'SIGKILL')
      } catch {
        /* Already exited. */
      }
    }
  }
}
