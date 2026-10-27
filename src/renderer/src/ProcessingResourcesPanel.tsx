import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ProcessingPolicy, ProcessingResources } from '../../shared/processing-resources'
import type { Result } from '../../shared/contracts'
import './processing-resources.css'

type Operation = 'policy' | 'pause' | null
interface ResourceSnapshot {
  resources: ProcessingResources | null
  busy: Operation
  error: string
}
let snapshot: ResourceSnapshot = { resources: null, busy: null, error: '' }
const listeners = new Set<() => void>()
let stop: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined
let request = Symbol(),
  pending = false

function publish(change: Partial<ResourceSnapshot>) {
  snapshot = { ...snapshot, ...change }
  listeners.forEach((listener) => listener())
}
function update(resources: ProcessingResources) {
  if (!snapshot.resources || resources.revision >= snapshot.resources.revision)
    publish({ resources, error: '' })
}
async function refreshResources() {
  if (snapshot.busy) {
    pending = true
    return null
  }
  const serial = Symbol()
  request = serial
  try {
    const result = await window.desktop.getProcessingResources()
    if (serial !== request) return null
    if (!result.ok) throw new Error(result.error.message)
    update(result.value)
    return result.value
  } catch (error) {
    if (serial === request)
      publish({ error: error instanceof Error ? error.message : '无法读取处理资源，请刷新重试。' })
    return null
  }
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) {
    stop = window.desktop.onProcessingResourcesChanged(() => {
      clearTimeout(timer)
      timer = setTimeout(() => void refreshResources(), 75)
    })
    void refreshResources()
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size) {
      stop?.()
      stop = undefined
      clearTimeout(timer)
      request = Symbol()
    }
  }
}
export function useProcessingResources() {
  return useSyncExternalStore(subscribe, () => snapshot)
}
class ResourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
async function perform(
  operation: Exclude<Operation, null>,
  action: () => Promise<Result<ProcessingResources>>,
) {
  if (snapshot.busy) throw new ResourceError('BUSY', '资源设置正在保存，请稍后重试。')
  request = Symbol()
  publish({ busy: operation })
  try {
    const result = await action()
    if (!result.ok) throw new ResourceError(result.error.code, result.error.message)
    update(result.value)
    return result.value
  } finally {
    publish({ busy: null })
    if (pending) {
      pending = false
      void refreshResources()
    }
  }
}
async function pauseProcessing(paused: boolean) {
  return perform('pause', async () => {
    const latest = await window.desktop.getProcessingResources()
    if (!latest.ok) return latest
    return window.desktop.setProcessingPaused({ revision: latest.value.revision, paused })
  })
}
function samePolicy(a: ProcessingPolicy, b: ProcessingPolicy) {
  return (
    a.cpuThreads === b.cpuThreads &&
    a.lowPriority === b.lowPriority &&
    a.backgroundIdleOnly === b.backgroundIdleOnly
  )
}
const STATUS: Record<ProcessingResources['status'], string> = {
  ready: '处理已允许，当前没有运行任务。',
  running: '正在处理字幕。',
  paused: '字幕生成与原文声音对齐已暂停，音频播放继续。',
  'waiting-idle': '后台预取正在等待电脑空闲满 1 分钟；当前集手动生成优先处理。',
  releasing: '正在停止重活并释放模型资源，已完成分块与人工同步时间保留。',
  'model-lease': '原文声音对齐正在使用模型，字幕生成等待资源。',
}

interface Draft {
  policy: ProcessingPolicy
  baseline: ProcessingPolicy
  revision: number
}
export function ProcessingResourcesPanel() {
  const { resources, busy, error: loadError } = useProcessingResources()
  const [draft, setDraft] = useState<Draft | null>(null)
  const draftRef = useRef<Draft | null>(null),
    mounted = useRef(false)
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const writeDraft = useCallback((value: Draft) => {
    draftRef.current = value
    setDraft(value)
  }, [])
  const adopt = useCallback(
    (value: ProcessingResources, mode: 'normal' | 'saved' | 'rebase' = 'normal') => {
      const current = draftRef.current
      if (!current || mode === 'saved' || samePolicy(current.policy, current.baseline))
        writeDraft({
          policy: { ...value.policy },
          baseline: { ...value.policy },
          revision: value.revision,
        })
      else if (mode === 'rebase')
        writeDraft({ ...current, baseline: { ...value.policy }, revision: value.revision })
      else if (samePolicy(value.policy, current.baseline))
        writeDraft({ ...current, revision: value.revision })
    },
    [writeDraft],
  )
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    let canceled = false
    void Promise.resolve().then(() => {
      if (!canceled && resources) adopt(resources)
    })
    return () => {
      canceled = true
    }
  }, [resources, adopt])
  function change(policy: ProcessingPolicy) {
    const current = draftRef.current
    if (!current) return
    writeDraft({ ...current, policy })
    setNotice('有未保存改动。')
  }
  async function save() {
    const current = draftRef.current
    if (!current || busy) return
    const revision =
      snapshot.resources && samePolicy(current.baseline, snapshot.resources.policy)
        ? snapshot.resources.revision
        : current.revision
    setError('')
    setNotice('')
    try {
      const value = await perform('policy', () =>
        window.desktop.setProcessingResources({
          revision,
          policy: current.policy,
        }),
      )
      if (!mounted.current) return
      adopt(value, 'saved')
      setNotice('资源设置已保存；CPU 线程设置用于新建任务。')
    } catch (error) {
      if (!mounted.current) return
      setError(error instanceof Error ? error.message : '资源设置未保存。')
      if (error instanceof ResourceError && error.code === 'CONFLICT') {
        const latest = (await refreshResources()) ?? snapshot.resources
        if (!mounted.current || !latest) return
        adopt(latest, 'rebase')
        setNotice('草稿已保留，已读取当前生效设置。检查后可再次保存你的草稿。')
      }
    }
  }
  async function togglePause() {
    if (!resources || busy) return
    setError('')
    setNotice('')
    try {
      await pauseProcessing(!resources.paused)
      if (mounted.current)
        setNotice(
          resources.paused
            ? '已恢复处理，已取消的任务保持取消。'
            : '已暂停重活，音频播放继续；重启后保持暂停。',
        )
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : '暂停状态未更新。')
      await refreshResources()
    }
  }
  const dirty = draft && !samePolicy(draft.policy, draft.baseline)
  const conflict = draft && resources && !samePolicy(draft.baseline, resources.policy)
  return (
    <section className="processing-resources" aria-label="处理资源与暂停">
      <div className="section-heading">
        <h3>处理资源与暂停</h3>
        <button className="text-button" disabled={!!busy} onClick={() => void refreshResources()}>
          刷新处理状态
        </button>
      </div>
      {loadError && (
        <p className="error-message" role="alert">
          {loadError}
        </p>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {!resources && !loadError && <p role="status">正在读取处理资源…</p>}
      {resources && (
        <>
          <p className="processing-state" role="status" data-processing-status={resources.status}>
            {STATUS[resources.status]}
          </p>
          <div className="tools-form">
            <button
              className="secondary-button"
              disabled={!!busy}
              onClick={() => void togglePause()}
            >
              {resources.paused ? '恢复处理' : '暂停处理'}
            </button>
            <span>{resources.paused ? '暂停选择已保存。' : '处理已允许。'}</span>
          </div>
          <p className="tools-hint">
            暂停只控制字幕生成与原文声音对齐，音频播放继续。已完成分块和人工时间保留；重启后保持暂停，恢复不会重启已取消的任务。
          </p>
          <p className="processing-effective" aria-label="当前生效资源">
            新建任务：{resources.policy.cpuThreads} 线程 ·{' '}
            {resources.policy.lowPriority ? '低优先级' : '普通优先级'} ·{' '}
            {resources.policy.backgroundIdleOnly ? '后台预取仅空闲时处理' : '允许后台预取'}
          </p>
          {resources.active && (
            <p aria-label="当前任务资源">
              当前任务保留创建时的 {resources.active.cpuThreads} 线程，以复用已完成分块。
            </p>
          )}
          <p className="tools-hint" aria-label="实际工作进程资源">
            {resources.worker
              ? `工作进程回报 CPU 线程：${resources.worker.cpuThreads === null ? '未知' : resources.worker.cpuThreads}；实际优先级：${{ low: '低', normal: '普通', unknown: '未知' }[resources.worker.priority]}。`
              : '当前没有已报告的工作进程。'}
          </p>
        </>
      )}
      {draft && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <fieldset disabled={!!busy}>
            <legend>新任务的资源设置</legend>
            <div className="tools-form">
              <button
                type="button"
                className="secondary-button"
                onClick={() => change({ ...draft.policy, cpuThreads: 1, lowPriority: true })}
              >
                低占用预设
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => change({ ...draft.policy, cpuThreads: 4, lowPriority: false })}
              >
                普通预设
              </button>
              <label>
                CPU 数学线程
                <select
                  aria-label="CPU 处理线程"
                  value={draft.policy.cpuThreads}
                  onChange={(event) =>
                    change({
                      ...draft.policy,
                      cpuThreads: Number(event.target.value) as ProcessingPolicy['cpuThreads'],
                    })
                  }
                >
                  {([1, 2, 4] as const).map((threads) => (
                    <option key={threads} value={threads}>
                      {threads} 线程
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="processing-check">
              <input
                type="checkbox"
                checked={draft.policy.lowPriority}
                onChange={(event) => change({ ...draft.policy, lowPriority: event.target.checked })}
              />
              降低处理进程优先级
            </label>
            <label className="processing-check">
              <input
                type="checkbox"
                checked={draft.policy.backgroundIdleOnly}
                onChange={(event) =>
                  change({ ...draft.policy, backgroundIdleOnly: event.target.checked })
                }
              />
              后台预取仅在电脑空闲满 1 分钟后处理
            </label>
            <p className="tools-hint">
              CPU
              线程只对新建任务生效，现有和恢复中的任务保留原线程配置。低优先级会作用于新进程及当前字幕进程；实际回报未知时保持未知。
            </p>
            <p className="tools-hint">
              空闲条件只限制后台预取，当前集手动生成优先。资源设置保留所选引擎与 CPU / GPU
              设备；线程数不等于整机 CPU 使用率或显存上限。
            </p>
            <button className="primary-button" type="submit" disabled={!dirty}>
              {busy === 'policy' ? '正在保存资源设置…' : '保存资源设置'}
            </button>
            {dirty && <span className="tools-hint"> 有未保存改动</span>}
          </fieldset>
          {conflict && (
            <p className="processing-conflict" role="status">
              当前生效设置已在其他入口更新，草稿仍保留；保存时会检查版本。
            </p>
          )}
          {dirty && (
            <button
              type="button"
              className="text-button"
              disabled={!!busy || !resources}
              onClick={() => {
                if (resources) {
                  adopt(resources, 'saved')
                  setNotice('已采用当前生效设置。')
                  setError('')
                }
              }}
            >
              使用当前生效设置
            </button>
          )}
        </form>
      )}
      {notice && (
        <p className="tools-notice" role="status">
          {notice}
        </p>
      )}
    </section>
  )
}

export function ProcessingPauseNotice({
  includeIdlePolicy = false,
  compact = false,
}: { includeIdlePolicy?: boolean; compact?: boolean } = {}) {
  const { resources, busy } = useProcessingResources()
  const [error, setError] = useState('')
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const idlePolicy = includeIdlePolicy && resources?.policy.backgroundIdleOnly
  const showStatus =
    resources && (resources.paused || !['ready', 'running'].includes(resources.status))
  if (!resources || (!showStatus && !idlePolicy)) return null
  return (
    <aside className="processing-pause-notice" data-compact={compact} aria-label="全局处理状态">
      {showStatus && (
        <p role="status" title={STATUS[resources.status]}>
          {compact
            ? resources.paused
              ? '处理暂停'
              : resources.status === 'waiting-idle'
                ? '等待空闲'
                : '等待处理'
            : STATUS[resources.status]}
        </p>
      )}
      {idlePolicy && !compact && (
        <p className="tools-hint">
          已启用后台空闲条件：电脑连续空闲满 1 分钟后才处理离线计划；当前集手动生成仍优先。
        </p>
      )}
      {resources.paused && (
        <button
          className="secondary-button"
          disabled={!!busy}
          onClick={() => {
            setError('')
            void pauseProcessing(false).catch((error) => {
              if (mounted.current)
                setError(
                  error instanceof Error ? error.message : '恢复处理失败，请在缓存与任务中重试。',
                )
            })
          }}
        >
          恢复处理
        </button>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </aside>
  )
}
