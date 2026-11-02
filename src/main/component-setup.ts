import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { AsrComponent } from './asr-component'
import type { AsrRuntime } from './asr-process'
import type { ComponentCandidate, ComponentCheck, ComponentSetupState } from '../shared/component'
import { AppError } from '../shared/validation'

export interface ComponentProbeOptions {
  timeoutMs?: number
  maxBuffer?: number
  signal?: AbortSignal
}
export type ComponentProbe = (
  runtime: AsrRuntime,
  script: string,
  options?: ComponentProbeOptions,
) => Promise<ComponentCheck>
const ENGINES = ['whisperx', 'paraformer'] as const
const DEVICES = ['cpu', 'cuda'] as const
const CHECK_FRESH_MS = 5 * 60_000
const MODEL_NAMES = ['paraformer', 'vad', 'punctuation', 'whisper', 'alignment'] as const
const SENTENCE_FILES = [
  'abbrev_types.txt',
  'collocations.tab',
  'ortho_context.tab',
  'sent_starters.txt',
]
function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  return new Promise<T>((done, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        done(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
    if (signal.aborted) abort()
  })
}
function failedCheck(message: string): ComponentCheck {
  return {
    checkedAt: new Date().toISOString(),
    ready: false,
    pythonVersion: null,
    cudaName: null,
    freeBytes: null,
    issues: [message],
    level: 'imports-and-files',
    capabilities: ENGINES.flatMap((engine) =>
      DEVICES.map((device) => ({ engine, device, available: false, message })),
    ),
  }
}
export function parseComponentCheck(value: unknown): ComponentCheck {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid component check')
  const item = value as Record<string, unknown>
  const text = (v: unknown) => typeof v === 'string' && v.length <= 1000
  if (
    item.level !== 'imports-and-files' ||
    !Array.isArray(item.issues) ||
    item.issues.length > 30 ||
    !item.issues.every(text) ||
    !Array.isArray(item.capabilities) ||
    item.capabilities.length !== 4 ||
    ![item.pythonVersion, item.cudaName].every((v) => v === null || text(v)) ||
    !(
      item.freeBytes === null ||
      (typeof item.freeBytes === 'number' &&
        Number.isSafeInteger(item.freeBytes) &&
        item.freeBytes >= 0)
    )
  )
    throw new Error('Invalid component check')
  const seen = new Set<string>()
  const capabilities = item.capabilities.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Invalid capability')
    const capability = entry as Record<string, unknown>
    const key = `${capability.engine}:${capability.device}`
    if (
      !ENGINES.includes(capability.engine as (typeof ENGINES)[number]) ||
      !DEVICES.includes(capability.device as (typeof DEVICES)[number]) ||
      typeof capability.available !== 'boolean' ||
      !text(capability.message) ||
      seen.has(key)
    )
      throw new Error('Invalid capability')
    seen.add(key)
    return capability as unknown as ComponentCheck['capabilities'][number]
  })
  return {
    checkedAt: new Date().toISOString(),
    ready: capabilities.some((v) => v.available),
    pythonVersion: item.pythonVersion as string | null,
    cudaName: item.cudaName as string | null,
    freeBytes: item.freeBytes as number | null,
    issues: item.issues as string[],
    capabilities,
    level: 'imports-and-files',
  }
}
export async function runComponentProbe(
  runtime: AsrRuntime,
  script: string,
  options: ComponentProbeOptions = {},
): Promise<ComponentCheck> {
  if (options.signal?.aborted) return failedCheck('组件检查已取消，普通播放不受影响。')
  const args = [
    '-B',
    '-X',
    'utf8',
    script,
    '--models',
    runtime.models,
    '--cache',
    runtime.cache,
    '--ffmpeg',
    runtime.ffmpeg,
    '--ffprobe',
    runtime.ffprobe,
    ...(runtime.resources ? ['--resources', runtime.resources] : []),
  ]
  return new Promise((done) => {
    let result: ComponentCheck | undefined
    let closed = false
    const finish = (check: ComponentCheck) => {
      result = check
      if (closed) done(check)
    }
    const child = execFile(
      runtime.python,
      args,
      {
        windowsHide: true,
        signal: options.signal,
        timeout: options.timeoutMs ?? 45_000,
        maxBuffer: options.maxBuffer ?? 128 * 1024,
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONNOUSERSITE: '1',
          PYTHONDONTWRITEBYTECODE: '1',
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          HF_DATASETS_OFFLINE: '1',
        },
      },
      (error, stdout) => {
        if (error) {
          finish(
            failedCheck(
              options.signal?.aborted
                ? '组件检查已取消，普通播放不受影响。'
                : error.killed
                  ? '组件检查超时，普通播放不受影响；请检查 Python 与原生依赖。'
                  : '组件检查进程未完成，请检查 Python、依赖和可用磁盘空间。',
            ),
          )
          return
        }
        try {
          finish(parseComponentCheck(JSON.parse(stdout)))
        } catch {
          finish(failedCheck('组件检查返回了无效结果，请重新选择完整组件。'))
        }
      },
    )
    child.once('close', () => {
      closed = true
      if (result) done(result)
    })
  })
}

/** Metadata only: never hash/read model weights while deciding whether to reuse a check. */
async function runtimeFileSignature(runtime: AsrRuntime, script: string): Promise<string | null> {
  try {
    const paths = new Set([
      runtime.python,
      runtime.models,
      runtime.ffmpeg,
      runtime.ffprobe,
      runtime.script,
      script,
      join(dirname(script), 'evaluation-models.json'),
      join(dirname(script), 'asr-model-integrity.json'),
      join(dirname(script), 'asr_security.py'),
      join(dirname(script), 'asr_model_integrity.py'),
      ...SENTENCE_FILES.map((name) =>
        join(
          runtime.resources ?? runtime.cache,
          'nltk',
          'tokenizers',
          'punkt_tab',
          'english',
          name,
        ),
      ),
    ])
    if ((await stat(runtime.models)).size > 65_536) return null
    const manifest = JSON.parse(await readFile(runtime.models, 'utf8')) as {
      models?: Record<string, { path?: unknown }>
    }
    if (!manifest.models || typeof manifest.models !== 'object' || Array.isArray(manifest.models))
      return null
    for (const name of MODEL_NAMES) {
      const model = manifest.models[name]?.path
      if (typeof model !== 'string' || !model || model.includes('\0')) continue
      const directory = isAbsolute(model) ? model : resolve(dirname(runtime.models), model)
      paths.add(directory)
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch {
        continue
      }
      if (entries.length > 256) return null
      for (const entry of entries)
        if (entry.isFile() || entry.isSymbolicLink()) paths.add(join(directory, entry.name))
    }
    const signature = await Promise.all(
      [...paths].sort().map(async (path) => {
        try {
          const info = await stat(path, { bigint: true })
          return [
            path,
            info.size.toString(),
            info.mtimeNs.toString(),
            info.ctimeNs.toString(),
            info.ino.toString(),
          ]
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [path, 'missing']
          throw error
        }
      }),
    )
    return JSON.stringify(signature)
  } catch {
    return null
  }
}

/** Bounded discovery near the app and its ancestors, never a recursive disk scan. */
export function componentDiscoveryRoots(...locations: string[]): string[] {
  const roots = new Set<string>()
  for (const location of locations) {
    let current = resolve(location)
    for (let depth = 0; depth < 6; depth++) {
      roots.add(current)
      const parent = dirname(current)
      if (current === parent) break
      current = parent
    }
  }
  return [...roots].slice(0, 24)
}
export class ComponentSetup {
  private candidates: ComponentCandidate[] = []
  private ids = new Map<string, string>()
  private selected = new Map<string, string>()
  private lastCheck:
    | { fingerprint: string; signature: string | null; completedAt: number; value: ComponentCheck }
    | undefined
  private detecting: Promise<ComponentSetupState> | undefined
  private checking: Promise<ComponentCheck> | undefined
  private readonly lifetime = new AbortController()
  constructor(
    private readonly component: AsrComponent,
    private readonly roots: readonly string[],
    private readonly probe: ComponentProbe = runComponentProbe,
  ) {}
  private fingerprint() {
    return JSON.stringify(this.component.describe())
  }
  private assertRuntime(runtime: AsrRuntime, fingerprint: string) {
    const current = this.component.runtime(runtime.engine, runtime.device)
    const keys = [
      'python',
      'models',
      'cache',
      'resources',
      'ffmpeg',
      'ffprobe',
      'script',
      'engine',
      'device',
      'compute',
    ] as const
    if (fingerprint !== this.fingerprint() || keys.some((key) => runtime[key] !== current[key]))
      throw new AppError('CONFLICT', '组件配置已变化，请重新检查。')
  }
  private async probeRuntime(
    runtime: AsrRuntime,
    fingerprint: string,
    signature: string | null,
    signal?: AbortSignal,
  ): Promise<ComponentCheck> {
    signal?.throwIfAborted()
    const value = await withAbort(
      this.probe(runtime, this.component.probeScript, { signal }),
      signal,
    )
    signal?.throwIfAborted()
    this.assertRuntime(runtime, fingerprint)
    const after = await withAbort(runtimeFileSignature(runtime, this.component.probeScript), signal)
    signal?.throwIfAborted()
    this.assertRuntime(runtime, fingerprint)
    if (signature !== after) throw new AppError('CONFLICT', '组件文件已变化，请重新检查。')
    const checked = parseComponentCheck(value)
    this.lastCheck = { fingerprint, signature, completedAt: Date.now(), value: checked }
    return checked
  }
  private state(): ComponentSetupState {
    const current = this.component.describe()
    return {
      configured: !!current,
      currentDirectory: current ? dirname(current.models) : null,
      candidates: this.candidates.map((candidate) => ({ ...candidate })),
      check: this.lastCheck?.fingerprint === this.fingerprint() ? this.lastCheck.value : null,
    }
  }
  async detect(): Promise<ComponentSetupState> {
    if (this.detecting) return this.detecting
    this.detecting = this.scan()
    try {
      return await this.detecting
    } finally {
      this.detecting = undefined
    }
  }
  private async scan(): Promise<ComponentSetupState> {
    const found = new Map<string, ComponentCandidate>()
    const inspect = async (path: string) => {
      if (found.size >= 16) return
      let canonical: string
      try {
        if (!(await stat(path)).isFile()) return
        canonical = await realpath(path)
      } catch {
        return
      }
      const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical
      if (found.has(key)) return
      const id = this.ids.get(key) ?? randomUUID()
      this.ids.set(key, id)
      let problem: string | null = null
      try {
        await this.component.validateConfiguration(canonical)
      } catch (error) {
        problem = error instanceof Error ? error.message : '组件缺少必要文件。'
      }
      found.set(key, {
        id,
        label: basename(dirname(canonical)),
        directory: dirname(canonical),
        configPath: canonical,
        available: problem === null,
        problem,
      })
    }
    const current = this.component.describe()
    const roots = [
      ...new Set([...(current ? [dirname(current.models)] : []), ...this.roots]),
    ].slice(0, 25)
    for (const root of roots) {
      await inspect(join(root, 'component.json'))
      await inspect(join(root, 'asr-component', 'component.json'))
      for (const container of ['components', 'release']) {
        let entries
        try {
          entries = await readdir(join(root, container), { withFileTypes: true })
        } catch {
          continue
        }
        for (const entry of entries.slice(0, 40))
          if (
            (entry.isDirectory() || entry.isSymbolicLink()) &&
            (container === 'components' || /^asr-component-/i.test(entry.name))
          )
            await inspect(join(root, container, entry.name, 'component.json'))
      }
      if (found.size >= 16) break
    }
    this.candidates = [...found.values()]
    this.selected = new Map(
      this.candidates.map((candidate) => [candidate.id, candidate.configPath]),
    )
    return this.state()
  }
  async useCandidate(id: string): Promise<ComponentSetupState> {
    const path = this.selected.get(id)
    if (!path) throw new AppError('INVALID_REQUEST', '组件选择已失效，请重新检测。')
    await this.component.configure(path)
    return this.state()
  }
  /** Playback checks only the component explicitly selected by the user. */
  async checkAutomatic(signal: AbortSignal): Promise<ComponentCheck | null> {
    signal = AbortSignal.any([signal, this.lifetime.signal])
    signal.throwIfAborted()
    if (!this.component.configured) return null
    const fingerprint = this.fingerprint()
    const runtime = this.component.runtime('whisperx', 'cpu')
    const signature = await withAbort(
      runtimeFileSignature(runtime, this.component.probeScript),
      signal,
    )
    signal.throwIfAborted()
    this.assertRuntime(runtime, fingerprint)
    const cached = this.lastCheck
    if (
      signature !== null &&
      cached?.fingerprint === fingerprint &&
      cached.signature === signature &&
      Date.now() - cached.completedAt >= 0 &&
      Date.now() - cached.completedAt < CHECK_FRESH_MS
    )
      return cached.value
    return this.probeRuntime(runtime, fingerprint, signature, signal)
  }
  async check(): Promise<ComponentCheck> {
    const signal = this.lifetime.signal
    signal.throwIfAborted()
    if (this.checking) return this.checking
    const fingerprint = this.fingerprint()
    const runtime = this.component.runtime('whisperx', 'cpu')
    this.checking = withAbort(
      runtimeFileSignature(runtime, this.component.probeScript),
      signal,
    ).then((signature) => {
      signal.throwIfAborted()
      this.assertRuntime(runtime, fingerprint)
      return this.probeRuntime(runtime, fingerprint, signature, signal)
    })
    try {
      return await this.checking
    } finally {
      this.checking = undefined
    }
  }
  async ensureRuntime(runtime: AsrRuntime, signal: AbortSignal): Promise<void> {
    signal = AbortSignal.any([signal, this.lifetime.signal])
    signal.throwIfAborted()
    const fingerprint = this.fingerprint()
    this.assertRuntime(runtime, fingerprint)
    const signature = await withAbort(
      runtimeFileSignature(runtime, this.component.probeScript),
      signal,
    )
    signal.throwIfAborted()
    this.assertRuntime(runtime, fingerprint)
    const cached = this.lastCheck
    const available = (check: ComponentCheck) =>
      check.capabilities.find(
        (item) => item.engine === runtime.engine && item.device === runtime.device,
      )
    const checked =
      signature !== null &&
      cached?.fingerprint === fingerprint &&
      cached.signature === signature &&
      Date.now() - cached.completedAt >= 0 &&
      Date.now() - cached.completedAt < CHECK_FRESH_MS &&
      available(cached.value)?.available
        ? cached.value
        : await this.probeRuntime(runtime, fingerprint, signature, signal)
    signal.throwIfAborted()
    this.assertRuntime(runtime, fingerprint)
    const capability = available(checked)
    if (!capability?.available)
      throw new AppError(
        'RUNTIME_UNAVAILABLE',
        capability?.message || '所选字幕引擎或设备不可用，请检查组件。',
      )
  }
  close(): void {
    this.lifetime.abort()
    this.lastCheck = undefined
  }
}
