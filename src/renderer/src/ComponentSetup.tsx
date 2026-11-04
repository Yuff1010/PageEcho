import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ComponentSetupState } from '../../shared/component'
import type { Result } from '../../shared/contracts'
import { ComponentInstallationPanel } from './ComponentInstallationPanel'
import { HelpTip } from './HelpTip'
import { Icon } from './Icons'
import { ReaderAction } from './ReaderToolbar'
import './settings-disclosure.css'
import './component-setup.css'

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
  compact = false,
}: {
  control: ReturnType<typeof useComponentSetup>
  disabled?: boolean
  compact?: boolean
}) {
  const { state, busy, error, notice, run } = control
  const locked = disabled || busy
  const [managing, setManaging] = useState(false)
  const [visited, setVisited] = useState(false)
  const managementId = useId()
  const status = busy
    ? '正在处理'
    : !state
      ? '正在读取'
      : state.check
        ? state.check.ready
          ? '可用'
          : '需要处理'
        : state.configured
          ? '已选择'
          : '未配置'
  return (
    <section
      className="component-setup settings-select-scope"
      aria-label="本地字幕组件"
      data-compact={compact}
    >
      {compact ? (
        <div className="component-setup-summary">
          <Icon name={state?.check?.ready ? 'check' : 'plugin'} />
          <div className="component-setup-summary-text">
            <strong>字幕组件</strong>
            <span role="status">{status}</span>
          </div>
          <HelpTip label="字幕组件详情">
            {state?.currentDirectory ?? '安装离线 ZIP，或选择已解压的可信组件。'}
            {state?.configured && '。选择路径后仍需检查文件、依赖和设备。'}
          </HelpTip>
          <ReaderAction
            label={managing ? '收起组件管理' : '管理字幕组件'}
            icon="settings"
            aria-expanded={managing}
            aria-controls={managementId}
            onClick={() => {
              setVisited(true)
              setManaging(!managing)
            }}
          />
        </div>
      ) : (
        <h4>
          本地字幕组件
          <HelpTip label="本地字幕组件">
            普通播放、电子书朗读及导入已有字幕无需模型。自动字幕需要可信的本地组件；路径可选不等于文件、依赖和设备检查通过。
          </HelpTip>
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
      )}
      {(!compact || visited) && (
        <div id={managementId} className="component-setup-management" hidden={compact && !managing}>
          {!state?.configured && (
            <p className="tools-hint">安装离线 ZIP，或选择已解压组件。不会自动启用或生成字幕。</p>
          )}
          {state?.configured && !compact && (
            <p className="tools-hint">已选择组件：{state.currentDirectory ?? '本地组件目录'}</p>
          )}
          <ComponentInstallationPanel disabled={locked} guidance={state?.guidance} />
          {!!state?.candidates.length && (
            <ul className="component-candidates">
              {state.candidates.map((candidate) => (
                <li key={candidate.id}>
                  <div>
                    <strong>{candidate.label}</strong>
                    <HelpTip label={`${candidate.label}位置`}>{candidate.directory}</HelpTip>
                    {candidate.available && (
                      <span className="settings-section-status">
                        {candidate.directory === state.currentDirectory && state.check
                          ? state.check.ready
                            ? '已检查'
                            : '需处理'
                          : '未检查'}
                      </span>
                    )}
                    {candidate.problem && <p className="tools-hint">{candidate.problem}</p>}
                  </div>
                  <button
                    className="secondary-button"
                    disabled={locked || !candidate.available}
                    onClick={() =>
                      void run(
                        () =>
                          window.desktop.useDetectedTranscriptionComponent({ id: candidate.id }),
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
                void run(
                  () => window.desktop.detectTranscriptionComponents(),
                  '组件位置已重新检测。',
                )
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
            文件夹需含 component.json。
            <HelpTip label="组件文件夹">
              已有 JSON
              可用“选择组件配置”导入。重新检测只查看附近组件，不扫描整盘；选择路径后仍需检查，旧目录和人工文稿会保留。
            </HelpTip>
          </p>
          {state?.check && (
            <div className="component-check" role="status">
              <p>{state.check.ready ? '组件检查通过' : '组件检查发现问题'}</p>
              <p className="tools-hint">文件、依赖与设备检查；不代表识别质量验收。</p>
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
        </div>
      )}
      {compact && !managing && state?.check && !state.check.ready && (
        <div className="component-setup-problems" role="status">
          {state.check.issues.length ? (
            <ul>
              {state.check.issues.map((issue, index) => (
                <li key={index}>{issue}</li>
              ))}
            </ul>
          ) : (
            <p>组件尚不可用，请打开组件管理检查。</p>
          )}
        </div>
      )}
      {notice && !compact && <p role="status">{notice}</p>}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
