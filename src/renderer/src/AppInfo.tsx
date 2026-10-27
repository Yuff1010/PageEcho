import { useEffect, useRef, useState } from 'react'
import type { AppState } from '../../shared/contracts'
import { Icon } from './Icons'
import { useAppAppearance, type AppTheme } from './app-appearance'
import { Tooltip } from './Tooltip'
import './app-info.css'

export type AppInfoPanel = 'appearance' | 'about'

function runtimeDescription() {
  const agent = navigator.userAgent
  const electron = /\bElectron\/([\d.]+)/.exec(agent)?.[1]
  const chromium = /\bChrome\/([\d.]+)/.exec(agent)?.[1]
  return [electron && `Electron ${electron}`, chromium && `Chromium ${chromium}`]
    .filter(Boolean)
    .join(' · ')
}

export function AppInfo({
  state,
  panel,
  busy,
  error,
  onImport,
  onRetry,
  onClose,
}: {
  state: AppState | null
  panel: AppInfoPanel
  busy: boolean
  error?: string
  onImport: (id: string) => void
  onRetry: () => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const { theme, setTheme } = useAppAppearance()
  const [themeError, setThemeError] = useState('')
  const appearance = panel === 'appearance'
  const title = appearance ? '外观设置' : '应用信息'
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    element.querySelector<HTMLElement>('h2')?.focus()
    return () => element.close()
  }, [])
  return (
    <dialog
      ref={dialog}
      className={`listening-dialog app-info-dialog app-info-dialog--${panel}`}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="section-heading">
        <div>
          <h2 tabIndex={-1}>{title}</h2>
          {!appearance && <p>听读 · Read & Listen</p>}
        </div>
        <Tooltip content={`关闭${title}`}>
          <button className="icon-button" aria-label={`关闭${title}`} onClick={onClose}>
            <Icon name="close" />
          </button>
        </Tooltip>
      </div>
      {appearance ? (
        <>
          <label className="app-theme-setting">
            <span>
              <strong>界面主题</strong>
              <small>阅读纸色在阅读设置中单独选择。</small>
            </span>
            <select
              aria-label="应用界面主题"
              value={theme}
              onChange={(event) =>
                setThemeError(
                  setTheme(event.target.value as AppTheme) ? '' : '应用主题保存失败，请重试。',
                )
              }
            >
              <option value="light">浅色</option>
              <option value="dark">深色</option>
              <option value="system">跟随系统</option>
            </select>
          </label>
          {themeError && (
            <p className="error-message" role="alert">
              {themeError}
            </p>
          )}
        </>
      ) : (
        <>
          <dl className="app-info-facts">
            <div>
              <dt>版本</dt>
              <dd data-app-version>{state ? `v${state.version}` : '读取中…'}</dd>
            </div>
            <div>
              <dt>运行环境</dt>
              <dd data-app-runtime>{runtimeDescription() || '桌面运行环境'}</dd>
            </div>
          </dl>
          {!state && !error && (
            <p className="tools-hint" role="status">
              正在读取应用信息…
            </p>
          )}
          {error && (
            <div className="app-info-error" role="alert">
              <p className="error-message">{error}</p>
              {!state && (
                <button className="secondary-button" onClick={onRetry}>
                  重试读取应用信息
                </button>
              )}
            </div>
          )}
          <details className="app-info-storage">
            <summary>数据与存储位置</summary>
            <p className="tools-hint">数据目录：{state?.dataLocation ?? '读取中'}</p>
          </details>
          <p className="tools-hint">移除书架记录不会删除原音频。</p>
          {!!state?.files.length && (
            <details className="legacy-history">
              <summary>此前选择的音频 · {state.files.length}</summary>
              <ul className="chapter-preview">
                {state.files.map((file) => (
                  <li key={file.id}>
                    <span title={file.name}>{file.name}</span>
                    <button
                      disabled={busy}
                      aria-label={`加入书架 ${file.name}`}
                      onClick={() => onImport(file.id)}
                    >
                      加入书架
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </dialog>
  )
}
