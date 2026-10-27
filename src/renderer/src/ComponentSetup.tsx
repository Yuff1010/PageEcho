import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComponentSetupState } from '../../shared/component'
import type { Result } from '../../shared/contracts'
import { ComponentInstallationPanel } from './ComponentInstallationPanel'
import './settings-disclosure.css'

export function useComponentSetup() {
  const [state, setState] = useState<ComponentSetupState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const mounted = useRef(false)
  const sequence = useRef(0)
  const refresh = useCallback(async () => {
    const serial = ++sequence.current
    try {
      const result = await window.desktop.detectTranscriptionComponents()
      if (!mounted.current || serial !== sequence.current) return
      if (result.ok) setState(result.value)
      else setError(result.error.message)
    } catch {
      if (mounted.current && serial === sequence.current) setError('无法检测字幕组件，请重试。')
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    void Promise.resolve().then(refresh)
    const stop = window.desktop.onComponentChanged(() => void refresh())
    return () => {
      mounted.current = false
      stop()
    }
  }, [refresh])
  async function run<T>(action: () => Promise<Result<T>>, message = '') {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await action()
      if (!mounted.current) return
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      await refresh()
      const value = result.value
      const canceled =
        typeof value === 'object' &&
        value !== null &&
        'canceled' in value &&
        value.canceled === true
      if (mounted.current && message && !canceled) setNotice(message)
      return result.value
    } catch {
      if (mounted.current) setError('组件操作未完成，请重试。')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  return { state, busy, error, notice, run, refresh }
}

export function componentCapability(
  state: ComponentSetupState | null,
  engine: 'whisperx' | 'paraformer',
  device: 'cpu' | 'cuda',
) {
  return state?.check?.capabilities.find((item) => item.engine === engine && item.device === device)
}

export function ComponentSetup({
  control,
  disabled = false,
}: {
  control: ReturnType<typeof useComponentSetup>
  disabled?: boolean
}) {
  const { state, busy, error, notice, run } = control
  const locked = disabled || busy
  return (
    <section className="component-setup settings-select-scope" aria-label="本地字幕组件">
      <h4>
        本地字幕组件
        <span className="settings-section-status">
          {busy
            ? '正在检查'
            : state?.check
              ? state.check.ready
                ? '可用'
                : '需要处理'
              : state?.configured
                ? '已选择'
                : '未配置'}
        </span>
      </h4>
      {!state?.configured && (
        <p className="tools-hint">
          首次使用：选择离线组件 ZIP 或已解压文件夹，检查可用性，然后开始生成。已有 SRT / WebVTT
          字幕可直接导入，无需模型。
        </p>
      )}
      <p className="tools-hint">
        {state?.configured
          ? `已选择组件：${state.currentDirectory ?? '本地组件目录'}`
          : '首次生成字幕需要本地组件。可使用检测到的组件，或选择已解压的组件文件夹。'}
      </p>
      {!!state?.candidates.length && (
        <ul className="component-candidates">
          {state.candidates.map((candidate) => (
            <li key={candidate.id}>
              <div>
                <strong>{candidate.label}</strong>
                <p className="tools-hint">{candidate.directory}</p>
                {candidate.problem && <p className="tools-hint">{candidate.problem}</p>}
              </div>
              <button
                className="secondary-button"
                disabled={locked || !candidate.available}
                onClick={() =>
                  void run(
                    () => window.desktop.useDetectedTranscriptionComponent({ id: candidate.id }),
                    '已选择检测到的组件，可检查可用性后生成字幕。',
                  )
                }
              >
                使用 {candidate.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="tools-form">
        <button
          className="secondary-button"
          disabled={locked}
          onClick={() =>
            void run(
              () => window.desktop.chooseTranscriptionComponentFolder(),
              '已选择组件文件夹。',
            )
          }
        >
          选择组件文件夹
        </button>
        <button
          className="text-button"
          disabled={locked}
          onClick={() =>
            void run(() => window.desktop.configureTranscription(), '本地组件配置已更新。')
          }
        >
          选择组件配置
        </button>
        <button
          className="text-button"
          disabled={locked}
          onClick={() =>
            void run(() => window.desktop.detectTranscriptionComponents(), '组件位置已重新检测。')
          }
        >
          重新检测组件
        </button>
        <button
          className="secondary-button"
          disabled={locked || !state?.configured}
          onClick={() => void run(() => window.desktop.checkTranscriptionComponent())}
        >
          {busy ? '正在处理组件…' : '检查组件'}
        </button>
      </div>
      <p className="tools-hint">
        组件文件夹中应有 component.json。已有配置文件也可通过“选择组件配置”导入。
      </p>
      {state?.check && (
        <div className="component-check" role="status">
          <p>{state.check.ready ? '组件检查通过' : '组件检查发现问题'}</p>
          <p className="tools-hint">已检查文件、依赖和设备；实际识别会在生成字幕时运行。</p>
          <ul>
            {state.check.capabilities.map((item) => (
              <li key={`${item.engine}:${item.device}`}>
                {item.engine === 'whisperx' ? 'WhisperX' : 'Paraformer'} ·{' '}
                {item.device === 'cpu' ? 'CPU' : 'NVIDIA GPU'}：
                {item.available ? '可用' : item.message || '不可用'}
              </li>
            ))}
            {state.check.issues.map((issue, index) => (
              <li key={index}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
      <ComponentInstallationPanel disabled={busy} />
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
