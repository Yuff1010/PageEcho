import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { Result } from '../../shared/contracts'
import type {
  MaintenanceState,
  TaskPage,
  CacheClearPreview,
  MaintenanceLocation,
  AppLog,
} from '../../shared/maintenance'
import { ACTIVE_JOB_STATUSES } from '../../shared/transcription'
import { SourceCachePanel } from './SourceCachePanel'
import { ProcessingResourcesPanel } from './ProcessingResourcesPanel'
import { Icon } from './Icons'
import { settingsTabIndex, useSettingsTabOrientation } from './tab-keyboard'
import './settings.css'

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MiB`
  return `${(bytes / 1073741824).toFixed(2)} GiB`
}
async function value<T>(request: Promise<Result<T>>): Promise<T> {
  const result = await request
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
const labels: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  canceling: '取消中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
}

export function MaintenancePanel({
  onClose,
  onOpenOffline,
}: {
  onClose: () => void
  onOpenOffline?: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const tabsId = useId()
  const tabButtons = useRef<Partial<Record<'storage' | 'tasks' | 'log', HTMLButtonElement | null>>>(
    {},
  )
  const tabOrientation = useSettingsTabOrientation()
  const [tab, setTab] = useState<'storage' | 'tasks' | 'log'>('storage')
  const [state, setState] = useState<MaintenanceState | null>(null)
  const [tasks, setTasks] = useState<TaskPage | null>(null)
  const [log, setLog] = useState<AppLog | null>(null)
  const [preview, setPreview] = useState<CacheClearPreview | null>(null)
  const [page, setPage] = useState(0)
  const [activeOnly, setActiveOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const requestId = useRef(0)
  const invalidateTasks = useCallback(() => {
    requestId.current++
  }, [])
  const refreshTasks = useCallback(async () => {
    const serial = ++requestId.current
    const response = await value(window.desktop.getTranscriptionJobs({ page, activeOnly }))
    if (serial === requestId.current) {
      setTasks(response)
      if (page > 0 && page * 25 >= response.total)
        setPage(Math.max(0, Math.ceil(response.total / 25) - 1))
    }
  }, [page, activeOnly])
  const refreshStorage = useCallback(async () => {
    setScanning(true)
    try {
      setState(await value(window.desktop.getMaintenanceState()))
    } finally {
      setScanning(false)
    }
  }, [])
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    const stop = window.desktop.onComponentChanged(() => {
      setPreview(null)
      void refreshStorage().catch((error) =>
        setError(error instanceof Error ? error.message : '组件状态读取失败。'),
      )
    })
    void Promise.resolve()
      .then(refreshStorage)
      .catch((error) => setError(error instanceof Error ? error.message : '无法读取组件状态。'))
    return () => {
      stop()
      element.close()
    }
  }, [refreshStorage])
  useEffect(() => {
    const fail = (error: unknown) =>
      setError(error instanceof Error ? error.message : '无法读取转写任务。')
    void Promise.resolve().then(refreshTasks).catch(fail)
    let timer: number | undefined
    const stop = window.desktop.onTranscriptionChanged(() => {
      setPreview(null)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void refreshTasks().catch(fail), 150)
    })
    return () => {
      stop()
      window.clearTimeout(timer)
      invalidateTasks()
    }
  }, [refreshTasks, invalidateTasks])
  async function perform(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (error) {
      setError(error instanceof Error ? error.message : '操作未完成，请重试。')
    } finally {
      setBusy(false)
    }
  }
  const show = (target: MaintenanceLocation) =>
    void perform(async () => {
      await value(window.desktop.showMaintenanceLocation({ target }))
    })
  function selectTab(target: 'storage' | 'tasks' | 'log') {
    setTab(target)
    if (target === 'log') void perform(async () => setLog(await value(window.desktop.readAppLog())))
  }
  return (
    <dialog
      ref={dialog}
      className="maintenance-dialog listening-dialog"
      aria-label="缓存与任务"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="section-heading maintenance-heading">
        <div>
          <h2>缓存与任务</h2>
          <p>管理本地存储、字幕处理和运行记录</p>
        </div>
        <button className="icon-button" aria-label="关闭缓存与任务" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="maintenance-workspace">
        <nav
          className="maintenance-tabs"
          role="tablist"
          aria-label="管理页面"
          aria-orientation={tabOrientation}
        >
          {(
            [
              { id: 'storage', label: '存储与组件', icon: 'folder' },
              {
                id: 'tasks',
                label: `转写任务${tasks ? ` · ${tasks.active} 活动` : ''}`,
                icon: 'clock',
              },
              { id: 'log', label: '应用日志', icon: 'list' },
            ] as const
          ).map((item, index, tabs) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`${tabsId}-${item.id}-tab`}
              aria-controls={`${tabsId}-${item.id}-panel`}
              aria-selected={tab === item.id}
              tabIndex={tab === item.id ? 0 : -1}
              ref={(element) => {
                tabButtons.current[item.id] = element
              }}
              onClick={() => selectTab(item.id)}
              onKeyDown={(event) => {
                const next = settingsTabIndex(event, index, tabs.length)
                if (next === null) return
                selectTab(tabs[next]!.id)
                tabButtons.current[tabs[next]!.id]?.focus()
              }}
            >
              <Icon name={item.icon} />
              {item.label}
            </button>
          ))}
          <p className="maintenance-nav-hint">清理前可预览范围，处理中的文件会自动保留。</p>
        </nav>
        <div className="maintenance-content">
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="tools-notice" role="status">
              {notice}
            </p>
          )}
          <section
            hidden={tab !== 'storage'}
            role="tabpanel"
            id={`${tabsId}-storage-panel`}
            aria-labelledby={`${tabsId}-storage-tab`}
            tabIndex={0}
          >
            <div className="maintenance-page-heading">
              <h3>存储与组件</h3>
              <p>先查看占用，再按需清理缓存或调整本地组件。</p>
            </div>
            <div className="settings-card">
              <SourceCachePanel />
            </div>
            <div className="settings-card">
              <div className="section-heading">
                <h3>转写分块缓存</h3>
                <button
                  className="text-button"
                  disabled={busy || scanning}
                  onClick={() => void perform(refreshStorage)}
                >
                  刷新占用
                </button>
              </div>
              {scanning && <p role="status">正在统计文件大小…</p>}
              {state && (
                <>
                  <p data-testid="checkpoint-usage">
                    可清理：{size(state.cache.bytes)} · {state.cache.groups} 组 ·{' '}
                    {state.cache.files} 个文件
                  </p>
                  {state.usage && (
                    <p className="tools-hint">
                      缓存目录文件合计{state.usage.complete ? '' : '（未全部统计）'}：
                      {size(state.usage.bytes)} · {state.usage.files} 个文件
                      {state.usage.skipped ? ` · ${state.usage.skipped} 项未展开` : ''}
                    </p>
                  )}
                  {!!state.cache.retained && (
                    <p className="tools-hint">{state.cache.retained} 项无法确认归属，将保留。</p>
                  )}
                  <p className="tools-hint">
                    只清理已识别的转写分块。模型、原音频、文稿、书签和进度保留；再次生成可能需要重新计算。先取消或完成所有转写任务。
                  </p>
                  <button
                    className="secondary-button"
                    disabled={
                      busy ||
                      scanning ||
                      !state.configured ||
                      !state.cache.groups ||
                      !tasks ||
                      tasks.active > 0
                    }
                    onClick={() =>
                      void perform(async () =>
                        setPreview(await value(window.desktop.prepareCacheClear())),
                      )
                    }
                  >
                    预览清理分块缓存
                  </button>
                  {preview && (
                    <div className="cache-confirm" role="group" aria-label="确认清理预览">
                      <p>
                        将清理 {preview.groups} 组、{preview.files} 个分块文件，文件大小合计{' '}
                        {size(preview.bytes)}。
                      </p>
                      <button
                        className="secondary-button"
                        disabled={busy || !!tasks?.active}
                        onClick={() =>
                          void perform(async () => {
                            try {
                              const result = await value(
                                window.desktop.clearTranscriptionCache({ token: preview.token }),
                              )
                              setNotice(`已清理 ${result.groups} 组缓存，${size(result.bytes)}。`)
                            } finally {
                              setPreview(null)
                              await refreshStorage()
                            }
                          })
                        }
                      >
                        确认清理分块缓存
                      </button>
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => setPreview(null)}
                      >
                        保留缓存
                      </button>
                    </div>
                  )}
                  {state.warnings.map((warning, index) => (
                    <p className="tools-hint" key={index}>
                      {warning}
                    </p>
                  ))}
                </>
              )}
            </div>
            <div className="settings-card">
              {state && (
                <>
                  <h3 className="maintenance-subheading">本地转写组件</h3>
                  <p>
                    {state.configured
                      ? '已选择组件路径，模型和设备在任务启动时检查。'
                      : '尚未配置转写组件，普通播放可以继续使用。'}
                  </p>
                  <button
                    className="secondary-button"
                    disabled={busy || !!tasks?.running}
                    onClick={() =>
                      void perform(async () => {
                        const result = await value(window.desktop.configureTranscription())
                        if (!result.canceled) {
                          setPreview(null)
                          await refreshStorage()
                          await refreshTasks()
                          setNotice('本地组件配置已更新。')
                        }
                      })
                    }
                  >
                    选择组件配置
                  </button>
                  {state.component && (
                    <details className="settings-advanced">
                      <summary>组件路径与诊断</summary>
                      <dl className="maintenance-paths">
                        <dt>Python</dt>
                        <dd>{state.component.python}</dd>
                        <dt>模型清单</dt>
                        <dd>{state.component.models}</dd>
                        <dt>缓存目录</dt>
                        <dd>{state.component.cache}</dd>
                        {state.component.resources && (
                          <>
                            <dt>只读资源</dt>
                            <dd>{state.component.resources}</dd>
                          </>
                        )}
                        <dt>FFmpeg</dt>
                        <dd>{state.component.ffmpeg}</dd>
                        <dt>ffprobe</dt>
                        <dd>{state.component.ffprobe}</dd>
                      </dl>
                    </details>
                  )}
                  {!!state.models.length && (
                    <ul className="model-locations">
                      {state.models.map((model) => (
                        <li key={model.name}>
                          <strong>{model.name}</strong> ·{' '}
                          {model.available ? '路径存在' : '路径缺失'}
                          <p>
                            {model.repository} · {model.revision}
                          </p>
                          <details className="settings-advanced">
                            <summary>查看模型位置</summary>
                            <p>{model.path}</p>
                          </details>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="tools-form">
                    <button
                      className="text-button"
                      disabled={busy || !state.component}
                      onClick={() => show('cache')}
                    >
                      打开资源目录
                    </button>
                    <button
                      className="text-button"
                      disabled={busy || !state.component}
                      onClick={() => show('models')}
                    >
                      定位模型清单
                    </button>
                    <button className="text-button" disabled={busy} onClick={() => show('data')}>
                      打开数据目录
                    </button>
                  </div>
                  <p className="tools-hint maintenance-path">数据目录：{state.dataPath}</p>
                </>
              )}
            </div>
          </section>
          <section
            hidden={tab !== 'tasks'}
            role="tabpanel"
            id={`${tabsId}-tasks-panel`}
            aria-labelledby={`${tabsId}-tasks-tab`}
            tabIndex={0}
          >
            <div className="maintenance-page-heading">
              <h3>转写任务</h3>
              <p>查看生成进度、暂停后台处理，或重试未完成的任务。</p>
            </div>
            {onOpenOffline && (
              <div className="tools-form">
                <button className="secondary-button" onClick={onOpenOffline}>
                  管理离线计划
                </button>
                <span className="tools-hint">多集准备的进度、暂停与恢复</span>
              </div>
            )}
            <ProcessingResourcesPanel />
            <div className="tools-form">
              <label>
                <input
                  type="checkbox"
                  checked={activeOnly}
                  onChange={(event) => {
                    setPage(0)
                    setActiveOnly(event.target.checked)
                  }}
                />
                只看活动任务
              </label>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void perform(refreshTasks)}
              >
                刷新任务
              </button>
            </div>
            {!tasks?.jobs.length && <p className="tools-hint">暂无符合条件的任务。</p>}
            <ol className="maintenance-tasks">
              {tasks?.jobs.map((job) => (
                <li key={job.id} data-job-status={job.status}>
                  <div className="section-heading">
                    <strong>{job.episodeTitle}</strong>
                    <span>{labels[job.status]}</span>
                  </div>
                  <p className="tools-hint">
                    {job.bookTitle} · {job.engine === 'whisperx' ? 'WhisperX' : 'Paraformer'} ·{' '}
                    {job.device === 'cuda' ? 'GPU' : 'CPU'} · 第 {job.attempt} 次处理
                  </p>
                  <p>
                    {job.completedChunks}/{job.totalChunks || '…'} 块 · 复用 {job.cacheHits} 块
                    {job.issueCount ? ` · ${job.issueCount} 项需检查` : ''}
                    {job.stale ? ' · 音频版本已变化' : ''}
                  </p>
                  {job.error && <p className="task-error">{job.error}</p>}
                  <div className="tools-form">
                    {ACTIVE_JOB_STATUSES.includes(job.status) && (
                      <button
                        className="text-button"
                        disabled={busy || job.status === 'canceling'}
                        onClick={() =>
                          void perform(async () => {
                            await value(window.desktop.cancelTranscription({ id: job.id }))
                            await refreshTasks()
                          })
                        }
                      >
                        取消任务
                      </button>
                    )}
                    {['failed', 'canceled'].includes(job.status) && (
                      <button
                        className="text-button"
                        disabled={busy || job.stale || !state?.configured}
                        onClick={() =>
                          void perform(async () => {
                            await value(window.desktop.retryTranscription({ id: job.id }))
                            await refreshTasks()
                          })
                        }
                      >
                        重试任务
                      </button>
                    )}
                    <time>{new Date(job.updatedAt).toLocaleString()}</time>
                  </div>
                </li>
              ))}
            </ol>
            {!!tasks?.total && (
              <div className="tools-form">
                <button
                  className="text-button"
                  disabled={busy || page === 0}
                  onClick={() => setPage(page - 1)}
                >
                  上一页任务
                </button>
                <span>
                  {page + 1}/{Math.ceil(tasks.total / 25)} 页 · {tasks.total} 项
                </span>
                <button
                  className="text-button"
                  disabled={busy || (page + 1) * 25 >= tasks.total}
                  onClick={() => setPage(page + 1)}
                >
                  下一页任务
                </button>
              </div>
            )}
          </section>
          <section
            hidden={tab !== 'log'}
            role="tabpanel"
            id={`${tabsId}-log-panel`}
            aria-labelledby={`${tabsId}-log-tab`}
            tabIndex={0}
          >
            <div className="maintenance-page-heading">
              <h3>应用日志</h3>
              <p>遇到问题时，在这里查看最近的运行记录。</p>
            </div>
            <div className="tools-form">
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void perform(async () => setLog(await value(window.desktop.readAppLog())))
                }
              >
                刷新日志
              </button>
              <button className="text-button" disabled={busy} onClick={() => show('logs')}>
                打开日志目录
              </button>
            </div>
            <p className="tools-hint">
              仅在本机显示最新日志，可能含音频路径和模型诊断。
              {log?.truncated ? '已截取最后 64 KiB。' : ''}
            </p>
            <pre className="app-log" tabIndex={0}>
              {log?.text || '暂无日志。'}
            </pre>
          </section>
        </div>
      </div>
    </dialog>
  )
}
