import { useEffect, useRef } from 'react'
import type { AppState } from '../../shared/contracts'
import { Icon } from './Icons'
import { useAppAppearance, type AppTheme } from './app-appearance'

export function AppInfo({
  state,
  busy,
  onImport,
  onClose,
}: {
  state: AppState | null
  busy: boolean
  onImport: (id: string) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const { theme, setTheme } = useAppAppearance()
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="listening-dialog app-info-dialog"
      aria-label="应用信息"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="section-heading">
        <div>
          <h2>外观与应用信息</h2>
          <p>听读 · Read & Listen · v{state?.version ?? '—'}</p>
        </div>
        <button className="icon-button" aria-label="关闭应用信息" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <label className="app-theme-setting">
        <span>
          <strong>界面主题</strong>
          <small>应用界面统一切换，阅读纸色可单独选择。</small>
        </span>
        <select
          aria-label="应用界面主题"
          value={theme}
          onChange={(event) => setTheme(event.target.value as AppTheme)}
        >
          <option value="light">浅色</option>
          <option value="dark">深色</option>
          <option value="system">跟随系统</option>
        </select>
      </label>
      <details className="app-info-storage">
        <summary>数据与存储位置</summary>
        <p className="tools-hint">数据目录：{state?.dataLocation ?? '读取中'}</p>
      </details>
      <p className="tools-hint">音频保留在原位置，移除书架记录不会删除原文件。</p>
      {!!state?.files.length && (
        <details className="legacy-history">
          <summary>此前选择的音频 · {state.files.length}</summary>
          <p className="legacy-note">旧记录会保留，加入书架时不会复制或移动原文件。</p>
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
    </dialog>
  )
}
