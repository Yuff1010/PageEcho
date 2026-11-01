import { useEffect, useId, useRef, useState } from 'react'
import type {
  BackupPreview,
  GeneratedStoragePolicy,
  GeneratedStoragePreview,
  GeneratedStorageState,
  RestoredPreferences,
} from '../../shared/backup-storage'
import { SourceCenterAction } from './SourceCenterUI'
import { HelpTip } from './HelpTip'
import { collectBackupPreferences } from './backup-preferences'
import { player } from './player'
import './backup-storage.css'

const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`
type Tab = 'backup' | 'storage'
export function BackupStoragePanel({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const id = useId()
  const [tab, setTab] = useState<Tab>('backup')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [preview, setPreview] = useState<BackupPreview | null>(null)
  const [restored, setRestored] = useState<RestoredPreferences | null>(null)
  const [storage, setStorage] = useState<GeneratedStorageState | null>(null)
  const [policy, setPolicy] = useState<GeneratedStoragePolicy | null>(null)
  const [clear, setClear] = useState<GeneratedStoragePreview | null>(null)
  const policyDirty =
    !!storage && !!policy && JSON.stringify(policy) !== JSON.stringify(storage.policy)
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    element.querySelector<HTMLElement>('h2')?.focus()
    let live = true
    void Promise.all([
      window.desktop.getGeneratedStorage(),
      window.desktop.getRestoredPreferences(),
    ])
      .then(([current, preferences]) => {
        if (!live) return
        if (current.ok) {
          setStorage(current.value)
          setPolicy(current.value.policy)
        } else setError(current.error.message)
        if (preferences.ok) setRestored(preferences.value)
        else setError(preferences.error.message)
      })
      .catch(() => {
        if (live) setError('无法读取备份与存储信息，请关闭后重试。')
      })
    return () => {
      live = false
      element.close()
    }
  }, [])
  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作未完成，请重试。')
    } finally {
      setBusy(false)
    }
  }
  function changePolicy(next: Partial<GeneratedStoragePolicy>) {
    setPolicy((current) => current && { ...current, ...next })
    setClear(null)
  }
  async function exportBackup() {
    player.pause()
    await player.save()
    const result = await window.desktop.exportLibraryBackup({
      settings: collectBackupPreferences(localStorage),
    })
    if (!result.ok) throw new Error(result.error.message)
    if (!result.value.canceled)
      setNotice(`备份已保存 · ${size(result.value.backup.bytes)} · ${result.value.backup.path}`)
  }
  async function chooseBackup() {
    const result = await window.desktop.chooseLibraryBackup()
    if (!result.ok) throw new Error(result.error.message)
    if (!result.value.canceled) setPreview(result.value.preview)
  }
  async function restoreBackup() {
    if (!preview) return
    player.pause()
    await player.save()
    const result = await window.desktop.restoreLibraryBackup({ previewId: preview.previewId })
    if (!result.ok) throw new Error(result.error.message)
    setNotice('备份已校验，正在重启并恢复…')
  }
  async function savePolicy() {
    if (!policy) return
    const result = await window.desktop.saveGeneratedStoragePolicy({ policy })
    if (!result.ok) throw new Error(result.error.message)
    setStorage(result.value)
    setPolicy(result.value.policy)
    setClear(null)
    setNotice('保留策略已保存。')
  }
  return (
    <dialog
      ref={dialog}
      className="listening-dialog backup-storage-dialog"
      aria-label="备份与存储"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <div className="section-heading">
        <h2 tabIndex={-1}>备份与存储</h2>
        <SourceCenterAction label="关闭备份与存储" icon="close" disabled={busy} onClick={onClose} />
      </div>
      <div
        className="backup-storage-tabs"
        role="tablist"
        aria-label="备份与存储分类"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const next =
            event.key === 'Home'
              ? 'backup'
              : event.key === 'End'
                ? 'storage'
                : tab === 'backup'
                  ? 'storage'
                  : 'backup'
          setTab(next)
          dialog.current
            ?.querySelector<HTMLButtonElement>(`#${CSS.escape(id + '-' + next)}`)
            ?.focus()
        }}
      >
        {(['backup', 'storage'] as const).map((value) => (
          <button
            key={value}
            id={`${id}-${value}`}
            role="tab"
            aria-selected={tab === value}
            aria-controls={`${id}-panel`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
          >
            {value === 'backup' ? '备份恢复' : '生成物存储'}
          </button>
        ))}
      </div>
      <section id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} aria-busy={busy}>
        {tab === 'backup' ? (
          <>
            <div className="backup-storage-actions">
              <SourceCenterAction
                label="导出书架备份"
                icon="upload"
                disabled={busy}
                onClick={() => void run(exportBackup)}
              />
              <SourceCenterAction
                label="选择备份恢复"
                icon="folder"
                disabled={busy}
                onClick={() => void run(chooseBackup)}
              />
              <HelpTip label="备份内容">
                书架、正文、进度、书签、字幕和阅读设置；不包含原音频、模型、缓存、凭据或插件执行包。恢复前保留原书库作为回滚副本。
              </HelpTip>
            </div>
            <p className="tools-hint">导出会暂停播放。字幕、导入等活动任务结束后可操作。</p>
            {preview && (
              <div className="backup-storage-preview" aria-label="备份恢复预览">
                <strong>
                  {new Date(preview.createdAt).toLocaleString()} · v{preview.version}
                </strong>
                <p>
                  {preview.books} 本有声书 · {preview.readingBooks} 本电子书 · {preview.bookmarks}{' '}
                  个书签 · {preview.transcripts} 份字幕
                </p>
                <p className="tools-hint">
                  {size(preview.bytes)} · 恢复将替换当前书库并重启应用，原书库保留在本机回滚目录。
                </p>
                {!!preview.plugins.length && (
                  <p>涉及 {preview.plugins.length} 个插件；迁移到其他电脑后需重新安装。</p>
                )}
                <details>
                  <summary>不包含的内容</summary>
                  <ul>
                    {preview.excluded.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </details>
                <div className="backup-storage-actions">
                  <button
                    className="primary-button"
                    disabled={busy}
                    onClick={() => void run(restoreBackup)}
                  >
                    恢复并重启
                  </button>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => setPreview(null)}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
            {restored && (
              <details>
                <summary>最近恢复 · {new Date(restored.restoredAt).toLocaleString()}</summary>
                <p>
                  {restored.acknowledged ? '阅读设置已应用。' : '阅读设置尚未应用，请重启后重试。'}
                </p>
                {!!restored.plugins.length && (
                  <>
                    <p>备份所用插件：</p>
                    <ul>
                      {restored.plugins.map((plugin) => (
                        <li key={plugin.id}>
                          {plugin.name} · {plugin.version}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </details>
            )}
          </>
        ) : (
          <>
            {storage && policy && (
              <>
                <p>
                  {size(storage.bytes)} · {storage.items} 项 · {storage.protectedItems} 项受保护
                </p>
                <fieldset className="backup-storage-policy" disabled={busy}>
                  <label>
                    每类至少保留
                    <input
                      aria-label="每类至少保留份数"
                      type="number"
                      min="2"
                      max="20"
                      value={policy.keepLatest}
                      onChange={(event) => changePolicy({ keepLatest: Number(event.target.value) })}
                    />
                  </label>
                  <label>
                    空间上限（MiB）
                    <input
                      aria-label="生成物空间上限 MiB"
                      type="number"
                      min="64"
                      max="102400"
                      value={policy.maxBytes / 1024 / 1024}
                      onChange={(event) =>
                        changePolicy({ maxBytes: Number(event.target.value) * 1024 * 1024 })
                      }
                    />
                  </label>
                  <label>
                    保留天数
                    <input
                      aria-label="生成物保留天数"
                      type="number"
                      min="1"
                      max="365"
                      value={policy.maxAgeDays}
                      onChange={(event) => changePolicy({ maxAgeDays: Number(event.target.value) })}
                    />
                  </label>
                </fieldset>
                <div className="backup-storage-actions">
                  <label>
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={policy.automatic}
                      onChange={(event) => changePolicy({ automatic: event.target.checked })}
                    />{' '}
                    自动执行保留策略
                  </label>
                  <SourceCenterAction
                    label="保存存储策略"
                    icon="check"
                    disabled={busy}
                    onClick={() => void run(savePolicy)}
                  />
                  <SourceCenterAction
                    label="预览生成物清理"
                    icon="trash"
                    disabled={busy || policyDirty}
                    onClick={() =>
                      void run(async () => {
                        const result = await window.desktop.previewGeneratedStorageClear()
                        if (!result.ok) throw new Error(result.error.message)
                        setClear(result.value)
                      })
                    }
                  />
                  <HelpTip label="存储策略范围">
                    只管理本功能生成并登记的临时目录。保留最新项和正在使用的目录；原书籍、音频、模型及历史未知目录不会纳入清理。预览按已保存策略计算。
                  </HelpTip>
                </div>
                {policyDirty && (
                  <p className="tools-hint" role="status">
                    请先保存策略，再预览清理。
                  </p>
                )}
                {clear && (
                  <div className="backup-storage-preview" aria-label="生成物清理预览">
                    <p>
                      可清理 {clear.items} 项 · {size(clear.bytes)}，保留 {clear.retained} 项。
                    </p>
                    <button
                      className="secondary-button"
                      disabled={busy || clear.items === 0}
                      onClick={() =>
                        void run(async () => {
                          const result = await window.desktop.clearGeneratedStorage({
                            token: clear.token,
                          })
                          if (!result.ok) throw new Error(result.error.message)
                          setNotice(
                            `已清理 ${result.value.items} 项 · ${size(result.value.bytes)}，跳过 ${result.value.skipped} 项。`,
                          )
                          setClear(null)
                          const current = await window.desktop.getGeneratedStorage()
                          if (current.ok) setStorage(current.value)
                        })
                      }
                    >
                      清理预览中的生成物
                    </button>
                  </div>
                )}
                <details>
                  <summary>管理范围</summary>
                  <p className="tools-hint">{storage.directory}</p>
                  <p>
                    这里只统计本功能登记的目录。开发工作区的构建目录通过 workspace:storage 管理。
                  </p>
                </details>
                {storage.warnings.map((warning) => (
                  <p key={warning} role="alert">
                    {warning}
                  </p>
                ))}
              </>
            )}
          </>
        )}
      </section>
      {busy && <p role="status">正在处理…</p>}
      {notice && (
        <p className="backup-storage-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </dialog>
  )
}
