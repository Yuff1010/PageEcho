import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { AsrComponent } from '../asr-component'
import { ComponentSetup, runComponentProbe, type ComponentProbe } from '../component-setup'
import type { TranscriptionQueue } from '../transcription-queue'
import { AppError, isId } from '../../shared/validation'
import type {
  ComponentProfile,
  ComponentInstallationState,
  ComponentInstallationActivity,
} from '../../shared/component-installation'
import type {
  ComponentInstallerCore,
  ComponentInstallPlan,
  ManagedComponentReceipt,
  InstallProgress,
} from './core-types'

interface ExternalSnapshot {
  id: string
  installedAt: string
  sha256: string
}
interface RecordEntry {
  receipt?: ManagedComponentReceipt
  external?: ExternalSnapshot
  componentPath: string
  identity: string | null
}
interface Options {
  root: string
  settingsFile: string
  workerScript: string
  component: AsrComponent
  queue: Pick<TranscriptionQueue, 'withMaintenance'>
  core: ComponentInstallerCore
  notify: () => void
  componentChanged: () => void
  log: (error: unknown) => void
  probe?: ComponentProbe
}
function identity(component: AsrComponent): string | null {
  return pathIdentity(component.describe())
}
function pathIdentity(paths: ReturnType<AsrComponent['describe']>): string | null {
  return paths
    ? JSON.stringify([
        paths.python,
        paths.models,
        paths.resources ?? null,
        paths.ffmpeg,
        paths.ffprobe,
        paths.cache,
      ])
    : null
}
function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
export class ComponentInstallationService {
  private records = new Map<string, RecordEntry>()
  private activity: ComponentInstallationActivity | null = null
  private plan?: ComponentInstallPlan
  private running?: { controller: AbortController; done: Promise<void> }
  private activating: string | null = null
  private activatingDone?: Promise<unknown>
  private lifetime = new AbortController()
  private closed = false
  private root: string
  constructor(private options: Options) {
    this.root = resolve(options.root)
  }
  private notify() {
    if (!this.closed) this.options.notify()
  }
  private assertIdle() {
    if (this.closed || this.running || this.activating)
      throw new AppError('BUSY', '组件操作正在进行或收尾，请稍后重试。')
  }
  private async readIdentity(path: string) {
    try {
      return pathIdentity(await this.options.component.describeConfiguration(path))
    } catch (error) {
      // Listing a broken installation must not prevent ordinary playback or startup.
      this.options.log(error)
      return null
    }
  }
  async load(): Promise<void> {
    await mkdir(join(this.root, 'external'), { recursive: true })
    for (const receipt of await this.options.core.load()) {
      if (!isId(receipt.id)) throw new AppError('INTERNAL', '组件安装记录标识无效。')
      this.records.set(receipt.id, {
        receipt,
        componentPath: receipt.componentPath,
        identity: await this.readIdentity(receipt.componentPath),
      })
    }
    try {
      const raw = await readFile(join(this.root, 'external-index.json'), 'utf8')
      if (raw.length > 65536) throw new Error('Oversized external component history')
      const entries = JSON.parse(raw) as ExternalSnapshot[]
      if (!Array.isArray(entries) || entries.length > 32) throw new Error('Invalid history')
      for (const entry of entries) {
        if (
          !isId(entry.id) ||
          typeof entry.installedAt !== 'string' ||
          typeof entry.sha256 !== 'string' ||
          !/^[0-9a-f]{64}$/.test(entry.sha256)
        )
          throw new Error('Invalid external history entry')
        const path = join(this.root, 'external', `${entry.id}.json`)
        if (digest(await readFile(path, 'utf8')) !== entry.sha256) continue
        this.records.set(entry.id, {
          external: entry,
          componentPath: path,
          identity: await this.readIdentity(path),
        })
      }
    } catch (error) {
      if (!(error instanceof Error && Reflect.get(error, 'code') === 'ENOENT'))
        this.options.log(error)
    }
  }
  state(): ComponentInstallationState {
    const active = identity(this.options.component)
    return {
      onlineSourceConfigured: false,
      activity: this.activity ? { ...this.activity, profile: { ...this.activity.profile } } : null,
      activating: this.activating,
      installations: [...this.records.entries()]
        .map(([id, record]) => ({
          id,
          version: record.receipt?.version ?? '外部组件',
          profile: record.receipt?.profile ?? null,
          bytes: record.receipt?.bytes ?? 0,
          installedAt: record.receipt?.installedAt ?? record.external!.installedAt,
          active: !!active && record.identity === active,
          managed: !!record.receipt,
        }))
        .sort((a, b) => b.installedAt.localeCompare(a.installedAt)),
    }
  }
  select(path: string, profile: ComponentProfile): ComponentInstallationState {
    this.assertIdle()
    this.plan = undefined
    const activity: ComponentInstallationActivity = {
      id: randomUUID(),
      profile: { ...profile },
      sourceName: basename(path),
      version: null,
      status: 'inspecting',
      processedBytes: 0,
      totalBytes: 0,
      requiredBytes: null,
      freeBytes: null,
      error: null,
      installedId: null,
    }
    this.activity = activity
    this.begin(activity, async (signal, progress) => {
      const plan = await this.options.core.inspect(path, profile, signal, progress)
      signal.throwIfAborted()
      this.plan = plan
      Object.assign(activity, {
        version: plan.bundle.version,
        requiredBytes: plan.requiredBytes,
        freeBytes: plan.freeBytes,
        processedBytes: plan.bundle.archiveBytes,
        totalBytes: plan.bundle.archiveBytes,
        status: 'ready',
      })
    })
    return this.state()
  }
  private begin(
    activity: ComponentInstallationActivity,
    action: (signal: AbortSignal, progress: InstallProgress) => Promise<void>,
  ) {
    const controller = new AbortController(),
      signal = AbortSignal.any([controller.signal, this.lifetime.signal])
    const progress: InstallProgress = (stage, processedBytes, totalBytes) => {
      if (signal.aborted) return
      Object.assign(activity, { status: stage, processedBytes, totalBytes })
      this.notify()
    }
    const run = { controller, done: Promise.resolve() }
    this.running = run
    run.done = (async () => {
      try {
        await action(signal, progress)
      } catch (error) {
        if (signal.aborted) activity.status = 'canceled'
        else {
          activity.status = 'failed'
          activity.error = error instanceof Error ? error.message : '组件安装未完成，原组件仍保留。'
          this.options.log(error)
        }
      } finally {
        if (this.running === run) this.running = undefined
        this.notify()
      }
    })()
    this.notify()
  }
  start(id: string): ComponentInstallationState {
    this.assertIdle()
    const activity = this.activity,
      plan = this.plan
    if (activity?.id !== id || activity.status !== 'ready' || !plan)
      throw new AppError('CONFLICT', '安装计划已变化，请重新选择离线包。')
    activity.status = 'installing'
    activity.processedBytes = 0
    activity.totalBytes = plan.requiredBytes
    this.begin(activity, async (signal, progress) => {
      const receipt = await this.options.core.install(plan, signal, progress)
      signal.throwIfAborted()
      if (!isId(receipt.id)) throw new AppError('INTERNAL', '安装结果标识无效。')
      this.records.set(receipt.id, {
        receipt,
        componentPath: receipt.componentPath,
        identity: await this.readIdentity(receipt.componentPath),
      })
      activity.installedId = receipt.id
      activity.status = 'checking'
      this.notify()
      await this.checkCandidate(receipt.componentPath, receipt.profile, signal)
      signal.throwIfAborted()
      activity.status = 'installed'
    })
    return this.state()
  }
  async cancel(id: string): Promise<void> {
    if (this.activity?.id !== id) return
    if (!this.running && this.activity.status !== 'ready') return
    const run = this.running
    run?.controller.abort()
    this.plan = undefined
    this.activity.status = 'canceled'
    this.notify()
    await run?.done
  }
  private async checkCandidate(
    path: string,
    profile: ComponentProfile | null,
    signal: AbortSignal,
  ) {
    const temporary = join(
      dirname(this.options.settingsFile),
      `.component-candidate-${randomUUID()}.json`,
    )
    const candidate = new AsrComponent(temporary, this.options.workerScript)
    const pending = new Set<Promise<unknown>>()
    const probe: ComponentProbe = (...args) => {
      const operation = (this.options.probe ?? runComponentProbe)(...args)
      pending.add(operation)
      void operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation),
      )
      return operation
    }
    const setup = new ComponentSetup(candidate, [], probe)
    const abort = () => setup.close()
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      await candidate.configure(path)
      signal.throwIfAborted()
      if (profile)
        await setup.ensureRuntime(candidate.runtime(profile.engine, profile.device), signal)
      else {
        const check = await setup.check()
        if (!check.capabilities.some((item) => item.available))
          throw new AppError(
            'RUNTIME_UNAVAILABLE',
            '原组件没有通过任何引擎/设备检查，当前配置仍保留。',
          )
      }
      signal.throwIfAborted()
    } finally {
      signal.removeEventListener('abort', abort)
      setup.close()
      await Promise.allSettled([...pending])
      await unlink(temporary).catch(() => {})
    }
  }
  private async rememberExternal(): Promise<void> {
    const current = this.options.component.describe(),
      active = identity(this.options.component)
    if (!current || [...this.records.values()].some((record) => record.identity === active)) return
    const entries = [...this.records.values()].flatMap((record) =>
      record.external ? [record.external] : [],
    )
    if (entries.length >= 32)
      throw new AppError('BUSY', '已保留 32 条外部组件恢复记录，请先整理安装记录。')
    const entry: ExternalSnapshot = {
      id: randomUUID(),
      installedAt: new Date().toISOString(),
      sha256: '',
    }
    const path = join(this.root, 'external', `${entry.id}.json`)
    const value = JSON.stringify(
      current.resources
        ? {
            version: 2,
            python: current.python,
            models: current.models,
            resources: current.resources,
            ffmpeg: current.ffmpeg,
            ffprobe: current.ffprobe,
          }
        : {
            version: 1,
            python: current.python,
            models: current.models,
            cache: current.cache,
            ffmpeg: current.ffmpeg,
            ffprobe: current.ffprobe,
          },
      null,
      2,
    )
    entry.sha256 = digest(value)
    await writeFile(path, value, { flag: 'wx' })
    const target = join(this.root, 'external-index.json'),
      temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify([...entries, entry]), { flag: 'wx' })
    await rename(temporary, target)
    this.records.set(entry.id, { external: entry, componentPath: path, identity: active })
  }
  async activate(id: string): Promise<ComponentInstallationState> {
    this.assertIdle()
    const record = this.records.get(id)
    if (!record) throw new AppError('CONFLICT', '安装记录已失效，请刷新后选择。')
    this.activating = id
    this.notify()
    const done = this.options.queue.withMaintenance(async () => {
      const signal = this.lifetime.signal
      signal.throwIfAborted()
      if (record.receipt) await this.options.core.verify(record.receipt, signal, () => {})
      else if (
        !record.external ||
        digest(await readFile(record.componentPath, 'utf8')) !== record.external.sha256
      )
        throw new AppError('FILE_CHANGED', '旧组件配置记录已变化，未启用。')
      await this.checkCandidate(record.componentPath, record.receipt?.profile ?? null, signal)
      signal.throwIfAborted()
      await this.rememberExternal()
      signal.throwIfAborted()
      await this.options.component.configure(record.componentPath)
      record.identity = identity(this.options.component)
      this.options.componentChanged()
    })
    this.activatingDone = done
    try {
      await done
    } finally {
      this.activating = null
      this.activatingDone = undefined
      this.notify()
    }
    return this.state()
  }
  async close(): Promise<void> {
    this.closed = true
    this.lifetime.abort()
    this.running?.controller.abort()
    await this.running?.done
    await this.activatingDone?.catch(this.options.log)
  }
}
