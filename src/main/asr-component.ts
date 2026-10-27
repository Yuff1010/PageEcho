import { readFile, realpath, stat, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, resolve, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AsrRuntime } from './asr-process'
import { AppError } from '../shared/validation'

type ComponentPaths = Pick<
  AsrRuntime,
  'python' | 'models' | 'cache' | 'ffmpeg' | 'ffprobe' | 'resources'
>

export class AsrComponent {
  private paths?: ComponentPaths
  private revision = 0
  constructor(
    private readonly settingsFile: string,
    private readonly script: string,
  ) {}
  get configured(): boolean {
    return !!this.paths
  }
  describe(): ComponentPaths | null {
    return this.paths ? { ...this.paths } : null
  }
  async validateConfiguration(path: string): Promise<void> {
    await this.read(path)
  }
  async describeConfiguration(path: string): Promise<ComponentPaths> {
    return this.read(path)
  }
  get probeScript(): string {
    return resolve(dirname(this.script), 'asr_component_probe.py')
  }
  async load(): Promise<void> {
    const revision = this.revision
    try {
      const paths = await this.read(this.settingsFile)
      if (revision === this.revision) this.paths = paths
    } catch {
      if (revision === this.revision) this.paths = undefined
    }
  }
  private async read(path: string): Promise<ComponentPaths> {
    try {
      if ((await stat(path)).size > 65536) throw new Error('Oversized settings')
      const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      const keys =
        value.version === 2
          ? (['python', 'models', 'resources', 'ffmpeg', 'ffprobe'] as const)
          : (['python', 'models', 'cache', 'ffmpeg', 'ffprobe'] as const)
      if (
        ![1, 2].includes(Number(value.version)) ||
        typeof value.version !== 'number' ||
        Object.keys(value).length !== 6
      )
        throw new Error('Invalid component')
      const paths = {} as ComponentPaths
      for (const key of keys) {
        if (typeof value[key] !== 'string' || !value[key] || value[key].includes('\0'))
          throw new Error('Invalid path')
        const target = await realpath(
          isAbsolute(value[key]) ? value[key] : resolve(dirname(path), value[key]),
        )
        const info = await stat(target)
        if (key === 'cache' || key === 'resources' ? !info.isDirectory() : !info.isFile())
          throw new Error('Missing component')
        paths[key] = target
      }
      if (!(await stat(this.script)).isFile()) throw new Error('Missing worker')
      if (value.version === 2) {
        paths.cache = resolve(dirname(this.settingsFile), 'cache', 'asr')
        await mkdir(paths.cache, { recursive: true })
      }
      return paths
    } catch {
      throw new AppError(
        'RUNTIME_UNAVAILABLE',
        '组件配置无效。请选择包含 Python、模型清单、资源目录和 FFmpeg 路径的组件 JSON。',
      )
    }
  }
  async configure(path: string): Promise<void> {
    const paths = await this.read(path)
    const temporary = `${this.settingsFile}.${randomUUID()}.tmp`
    const configuration = paths.resources
      ? {
          version: 2,
          python: paths.python,
          models: paths.models,
          resources: paths.resources,
          ffmpeg: paths.ffmpeg,
          ffprobe: paths.ffprobe,
        }
      : { version: 1, ...paths }
    await writeFile(temporary, JSON.stringify(configuration, null, 2), 'utf8')
    await rename(temporary, this.settingsFile)
    this.revision++
    this.paths = paths
  }
  runtime(engine: AsrRuntime['engine'], device: AsrRuntime['device']): AsrRuntime {
    if (!this.paths)
      throw new AppError('RUNTIME_UNAVAILABLE', '请先选择本地转写组件配置，普通播放可以继续使用。')
    return {
      ...this.paths,
      script: this.script,
      engine,
      device,
      compute: device === 'cpu' ? 'int8' : 'int8_float16',
    }
  }
}
