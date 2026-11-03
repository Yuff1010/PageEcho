import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ComponentInstallationActivity,
  ComponentInstallationState,
  ComponentProfile,
} from '../../shared/component-installation'
import type { Result } from '../../shared/contracts'
import type { ComponentSetupState } from '../../shared/component'
import { HelpTip } from './HelpTip'
import { SettingsDisclosureSummary } from './SettingsDisclosure'
import './component-installation.css'

function size(bytes: number | null) {
  if (bytes === null) return '尚未确定'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${bytes} 字节`
}
function profileLabel(profile: ComponentProfile) {
  return `${profile.engine === 'whisperx' ? 'WhisperX' : 'Paraformer'} · ${profile.device === 'cpu' ? 'CPU' : 'NVIDIA GPU'}`
}
function savedTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '时间未知'
    : date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
}
const STATUS: Record<ComponentInstallationActivity['status'], string> = {
  inspecting: '正在核对离线包摘要与清单，尚未安装。',
  ready: '离线包校验通过，请核对版本与空间后明确安装。',
  installing: '正在安装所选引擎的资源，旧组件继续保留。',
  checking: '正在校验文件、依赖和所选设备，尚未启用。',
  installed: '安装完成。请单独启用此版本；不会自动生成字幕。',
  canceled: '本次安装已取消，原组件继续保留。',
  failed: '本次安装未完成，原组件继续保留。',
}
const IN_PROGRESS = new Set<ComponentInstallationActivity['status']>([
  'inspecting',
  'installing',
  'checking',
])
const CANCELABLE = new Set<ComponentInstallationActivity['status']>([...IN_PROGRESS, 'ready'])

function useComponentInstallations() {
  const [state, setState] = useState<ComponentInstallationState | null>(null)
  const [loadError, setLoadError] = useState('')
  const mounted = useRef(false),
    serial = useRef(Symbol())
  const refresh = useCallback(async () => {
    const request = Symbol()
    serial.current = request
    try {
      const result = await window.desktop.getComponentInstallations()
      if (!mounted.current || request !== serial.current) return
      if (!result.ok) throw new Error(result.error.message)
      setState(result.value)
      setLoadError('')
    } catch (error) {
      if (mounted.current && request === serial.current)
        setLoadError(error instanceof Error ? error.message : '无法读取组件安装状态。')
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const changed = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void refresh(), 100)
    }
    const stop = window.desktop.onComponentInstallationsChanged(changed)
    const stopComponent = window.desktop.onComponentChanged(changed)
    void Promise.resolve().then(refresh)
    return () => {
      mounted.current = false
      serial.current = Symbol()
      clearTimeout(timer)
      stop()
      stopComponent()
    }
  }, [refresh])
  return { state, loadError, refresh }
}

export function ComponentInstallationPanel({
  disabled = false,
  guidance,
}: {
  disabled?: boolean
  guidance?: ComponentSetupState['guidance']
}) {
  const { state, loadError, refresh } = useComponentInstallations()
  const [engine, setEngine] = useState<ComponentProfile['engine'] | ''>('')
  const [device, setDevice] = useState<ComponentProfile['device']>('cpu')
  const [busy, setBusy] = useState<'choose' | 'start' | 'activate' | null>(null)
  const [canceling, setCanceling] = useState(false)
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const mounted = useRef(false),
    operation = useRef(Symbol()),
    interaction = useRef(0)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      operation.current = Symbol()
    }
  }, [])
  async function run<T>(
    kind: NonNullable<typeof busy>,
    action: () => Promise<Result<T>>,
    message: (value: T) => string,
  ) {
    if (busy || canceling) return
    const token = Symbol()
    operation.current = token
    const intent = ++interaction.current
    setBusy(kind)
    setError('')
    setNotice('')
    try {
      const result = await action()
      if (!mounted.current || token !== operation.current) return
      if (!result.ok) throw new Error(result.error.message)
      // Read authoritative state after the operation. A late native chooser
      // result never chains into installation, activation or episode generation.
      await refresh()
      if (mounted.current && token === operation.current && intent === interaction.current)
        setNotice(message(result.value))
    } catch (error) {
      if (mounted.current && token === operation.current && intent === interaction.current) {
        setError(error instanceof Error ? error.message : '组件操作未完成，请重试。')
        await refresh()
      }
    } finally {
      if (mounted.current && token === operation.current) setBusy(null)
    }
  }
  async function cancel(activity: ComponentInstallationActivity) {
    if (canceling) return
    const intent = ++interaction.current
    setCanceling(true)
    setError('')
    setNotice('')
    try {
      const result = await window.desktop.cancelComponentInstallation({ id: activity.id })
      if (!mounted.current || intent !== interaction.current) return
      if (!result.ok) throw new Error(result.error.message)
      await refresh()
      if (mounted.current && intent === interaction.current)
        setNotice('本次安装已取消，原组件继续保留。')
    } catch (error) {
      if (mounted.current && intent === interaction.current)
        setError(error instanceof Error ? error.message : '取消安装未完成，请重试。')
    } finally {
      if (mounted.current) setCanceling(false)
    }
  }
  const activity = state?.activity
  const working = !!activity && IN_PROGRESS.has(activity.status)
  const fixedPackage = !!activity && CANCELABLE.has(activity.status)
  const activating = !!state?.activating || busy === 'activate'
  const locked = disabled || !!busy || canceling || working || activating
  return (
    <details className="component-installation settings-disclosure">
      <SettingsDisclosureSummary title="安装与版本管理" description="离线 ZIP · 安装后单独启用" />
      <section className="settings-disclosure-body" aria-label="离线组件安装">
        <p className="tools-hint">在线组件源尚未配置，可从离线包安装。</p>
        <ol className="component-installation-steps" aria-label="离线安装步骤">
          <li>选包</li>
          <li>核对</li>
          <li>安装</li>
          <li>启用</li>
        </ol>
        {guidance && !guidance.platformSupported && (
          <p className="error-message" role="alert">
            当前组件包仅支持 Windows x64；本机为 {guidance.platform} / {guidance.arch}。
          </p>
        )}
        {guidance && (
          <details className="component-installation-help settings-disclosure">
            <SettingsDisclosureSummary title="离线安装帮助" />
            <div className="settings-disclosure-body">
              <ul className="component-package-guide">
                {guidance.packages.map((item) => (
                  <li key={item.id}>
                    <strong>
                      {item.devices.includes('cuda') ? 'CPU / NVIDIA GPU' : 'CPU'} · {item.version}
                    </strong>
                    <span>{size(item.archiveBytes)} ZIP</span>
                    <code>{item.archiveName}</code>
                  </li>
                ))}
              </ul>
              <p className="tools-hint">
                从发布方取得完整离线包，再核对、安装并单独启用。当前没有下载地址；旧组件和已有文稿保留。
              </p>
              <p className="tools-hint">
                检查失败时：旧依赖需换新版包；CPU 包不支持
                CUDA；摘要不符需重新取得完整包。错误与实际空间会在下方显示。
              </p>
            </div>
          </details>
        )}
        {!!guidance?.checkedDevices.length && (
          <p className="tools-hint" role="status">
            当前组件已检查可用：
            {guidance.checkedDevices
              .map((device) => (device === 'cpu' ? 'CPU' : 'NVIDIA GPU'))
              .join(' / ')}
            。安装目标仍由你选择。
          </p>
        )}
        <fieldset disabled={locked || fixedPackage}>
          <legend>
            本次安装目标{' '}
            <HelpTip label="安装目标">
              只选择必要资源和检查设备，不修改本书字幕方案。CPU 专用包仅支持 CPU；通用包也可在 CPU
              上运行，仍含 CUDA 依赖。检测到路径或显卡不代表 CUDA 可用，须以组件检查为准。
            </HelpTip>
          </legend>
          <div className="tools-form">
            <label>
              安装引擎
              <select
                aria-label="安装目标引擎"
                value={fixedPackage && activity ? activity.profile.engine : engine}
                onChange={(event) => setEngine(event.target.value as ComponentProfile['engine'])}
              >
                <option value="" disabled>
                  请选择引擎
                </option>
                <option value="whisperx">WhisperX</option>
                <option value="paraformer">Paraformer</option>
              </select>
            </label>
            <label>
              安装设备
              <select
                aria-label="安装目标设备"
                value={fixedPackage && activity ? activity.profile.device : device}
                onChange={(event) => setDevice(event.target.value as ComponentProfile['device'])}
              >
                <option value="cpu">CPU</option>
                <option value="cuda">NVIDIA GPU</option>
              </select>
            </label>
            <button
              type="button"
              className="secondary-button"
              disabled={!engine}
              onClick={() => {
                if (!engine) return
                void run(
                  'choose',
                  () => window.desktop.chooseComponentPackage({ engine, device }),
                  (value) =>
                    value.canceled
                      ? '未选择离线包，原组件继续保留。'
                      : value.state.activity?.status === 'ready'
                        ? '离线包已核对，请确认版本与空间后安装。'
                        : '',
                )
              }}
            >
              {busy === 'choose' ? '正在选择或核对离线包…' : '选择本地组件 ZIP'}
            </button>
          </div>
        </fieldset>
        <button
          type="button"
          className="text-button"
          disabled={!!busy || canceling}
          onClick={() => void refresh()}
        >
          刷新安装状态
        </button>
        {!state && !loadError && <p role="status">正在读取组件版本…</p>}
        {loadError && (
          <p className="error-message" role="alert">
            {loadError}
          </p>
        )}
        {activity && (
          <div
            className="component-installation-activity"
            data-installation-status={activity.status}
          >
            <h5>本次离线安装</h5>
            <p className="component-package-name">{activity.sourceName}</p>
            <p>
              {profileLabel(activity.profile)}
              {activity.version
                ? ` · 组件 ${activity.version}`
                : activity.status === 'inspecting'
                  ? ' · 版本核对中'
                  : ' · 版本未确认'}
            </p>
            <p role="status">{STATUS[activity.status]}</p>
            {activity.totalBytes > 0 && working && (
              <div>
                <progress
                  aria-label="组件处理进度"
                  value={Math.min(activity.processedBytes, activity.totalBytes)}
                  max={activity.totalBytes}
                />
                <p className="tools-hint">
                  {size(activity.processedBytes)} / {size(activity.totalBytes)}
                </p>
              </div>
            )}
            <dl className="component-installation-space">
              <div>
                <dt>预计新增占用</dt>
                <dd>{size(activity.requiredBytes)}</dd>
              </div>
              <div>
                <dt>目标盘剩余空间</dt>
                <dd>{size(activity.freeBytes)}</dd>
              </div>
            </dl>
            {activity.error && (
              <p className="error-message" role="alert">
                {activity.error}
              </p>
            )}
            <div className="tools-form">
              {activity.status === 'ready' && (
                <button
                  type="button"
                  className="primary-button"
                  disabled={
                    locked ||
                    !activity.version ||
                    activity.requiredBytes === null ||
                    activity.freeBytes === null ||
                    activity.freeBytes < activity.requiredBytes
                  }
                  onClick={() =>
                    void run(
                      'start',
                      () => window.desktop.startComponentInstallation({ id: activity.id }),
                      () => '安装已开始。完成后仍需单独启用此版本。',
                    )
                  }
                >
                  安装所选组件
                </button>
              )}
              {CANCELABLE.has(activity.status) && (
                <button
                  type="button"
                  className="text-button"
                  disabled={canceling || activating}
                  onClick={() => void cancel(activity)}
                >
                  {canceling ? '正在取消安装…' : '取消本次安装'}
                </button>
              )}
            </div>
          </div>
        )}
        {!!state?.installations.length && (
          <section aria-label="已保留的组件版本">
            <h5>已保留的组件版本</h5>
            <ul className="component-installation-list">
              {state.installations.map((item) => (
                <li key={item.id} data-component-active={item.active}>
                  <div>
                    <strong>{item.managed ? `组件 ${item.version}` : '之前的外部组件'}</strong>
                    <p>{item.profile ? profileLabel(item.profile) : '保留原有配置与路径'}</p>
                    <p className="tools-hint">
                      <time dateTime={item.installedAt}>
                        {item.managed ? '安装于' : '保存于'} {savedTime(item.installedAt)}
                      </time>
                    </p>
                    {item.managed && (
                      <p className="tools-hint">此安装资源体积：{size(item.bytes)}</p>
                    )}
                    <p className="tools-hint">
                      {item.active ? '当前正在使用此配置' : '已保留，可启用或恢复'}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={locked || item.active || !!state.activating}
                    onClick={() =>
                      void run(
                        'activate',
                        () => window.desktop.activateComponentInstallation({ id: item.id }),
                        () => '已启用所选版本；本书的字幕方案保持原有选择。',
                      )
                    }
                  >
                    {state.activating === item.id
                      ? '正在校验并启用…'
                      : item.active
                        ? '正在使用'
                        : item.managed
                          ? '启用此版本'
                          : '恢复此版本'}
                  </button>
                </li>
              ))}
            </ul>
            <p className="tools-hint">
              启用时会重新校验文件、依赖和所选设备。若有字幕生成或声音对齐任务，请先完成或取消任务，再启用；安装过程中旧组件继续可用。
            </p>
          </section>
        )}
        {activating && (
          <p role="status">正在校验并切换组件。成功前继续保留原配置，请等待检查完成。</p>
        )}
        {error && error !== activity?.error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="tools-notice" role="status">
            {notice}
          </p>
        )}
        {activity?.status === 'failed' && (
          <p className="tools-hint">
            可重新选择受支持的完整离线包，或使用上方“选择组件文件夹 / 选择组件配置”导入已有组件。
          </p>
        )}
      </section>
    </details>
  )
}
