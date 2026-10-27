import { useCallback, useEffect, useRef, useState } from 'react'
import type { Result } from '../../shared/contracts'
import {
  OFFLINE_ITEMS_PAGE_SIZE,
  OFFLINE_PLAN_PAGE_SIZE,
  MAX_OFFLINE_AUDIO_BUDGET_BYTES,
  type OfflinePlan,
  type OfflinePlanDetail,
  type OfflinePlanPage,
  type OfflinePlanStatus,
  type OfflineItemStatus,
  type UpdateOfflinePlanRequest,
} from '../../shared/offline'
import { offlineBytes } from './offline-format'

const PLAN_LABELS: Record<OfflinePlanStatus, string> = {
  queued: '计划排队中',
  running: '正在准备',
  paused: '计划已暂停',
  blocked: '计划等待处理',
  completed: '所选范围已备',
  'completed-with-issues': '计划结束，仍有项目需处理',
  canceled: '计划已取消',
}
const ITEM_LABELS: Record<OfflineItemStatus, string> = {
  queued: '等待准备',
  downloading: '正在缓存音频',
  'waiting-foreground': '等待当前手动集',
  'audio-ready': '音频已备',
  transcribing: '正在生成字幕',
  ready: '音频与整集字幕已备',
  'needs-attention': '需处理，已有稿保留',
  failed: '准备失败',
  canceled: '已取消',
}
const TERMINAL = new Set<OfflinePlanStatus>(['completed', 'completed-with-issues', 'canceled'])
const planLabel = (plan: OfflinePlan) =>
  plan.retentionReleasedAt ? '离线保留已解除' : PLAN_LABELS[plan.status]
async function value<T>(response: Promise<Result<T>>) {
  const result = await response
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

export function OfflinePlanList({ initialFocusId }: { initialFocusId?: string | null }) {
  const [page, setPage] = useState(0),
    [activeOnly, setActiveOnly] = useState(false)
  const [plans, setPlans] = useState<OfflinePlanPage | null>(null)
  const [selectedId, setSelectedId] = useState(initialFocusId ?? '')
  const [itemPage, setItemPage] = useState(0),
    [detail, setDetail] = useState<OfflinePlanDetail | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const [releaseConfirm, setReleaseConfirm] = useState<string | null>(null)
  const [budget, setBudget] = useState(''),
    budgetDirty = useRef(false)
  const mounted = useRef(false),
    listRequest = useRef(Symbol()),
    detailRequest = useRef(Symbol())
  const refreshPlans = useCallback(async () => {
    const serial = Symbol()
    listRequest.current = serial
    try {
      const response = await value(window.desktop.listOfflinePreparations({ page, activeOnly }))
      if (mounted.current && serial === listRequest.current) setPlans(response)
    } catch (error) {
      if (mounted.current && serial === listRequest.current)
        setError(error instanceof Error ? error.message : '无法读取离线计划。')
    }
  }, [page, activeOnly])
  const refreshDetail = useCallback(async () => {
    if (!selectedId) return
    const serial = Symbol()
    detailRequest.current = serial
    try {
      const response = await value(
        window.desktop.getOfflinePreparation({ id: selectedId, itemPage }),
      )
      if (!mounted.current || serial !== detailRequest.current) return
      setDetail(response)
      if (!budgetDirty.current) setBudget(String(response.plan.audioBudgetBytes / 1024 ** 3))
    } catch (error) {
      if (mounted.current && serial === detailRequest.current)
        setError(error instanceof Error ? error.message : '无法读取计划详情。')
    }
  }, [selectedId, itemPage])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      listRequest.current = Symbol()
      detailRequest.current = Symbol()
    }
  }, [])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      void refreshPlans()
      void refreshDetail()
    }
    const stop = window.desktop.onOfflinePreparationChanged(() => {
      clearTimeout(timer)
      timer = setTimeout(refresh, 150)
    })
    void Promise.resolve().then(refresh)
    return () => {
      stop()
      clearTimeout(timer)
      listRequest.current = Symbol()
      detailRequest.current = Symbol()
    }
  }, [refreshPlans, refreshDetail])
  function choose(plan: OfflinePlan) {
    detailRequest.current = Symbol()
    setSelectedId(plan.id)
    setItemPage(0)
    setDetail(null)
    setReleaseConfirm(null)
    budgetDirty.current = false
    setBudget(String(plan.audioBudgetBytes / 1024 ** 3))
    setError('')
    setNotice('')
  }
  async function perform(
    request: UpdateOfflinePlanRequest | { id: string; revision: number; action: 'release' },
  ) {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const plan =
        request.action === 'release'
          ? await value(
              window.desktop.releaseOfflineMedia({ id: request.id, revision: request.revision }),
            )
          : await value(window.desktop.updateOfflinePreparation(request))
      if (!mounted.current) return
      setReleaseConfirm(null)
      if (request.action === 'set-budget') budgetDirty.current = false
      setDetail((current) => (current?.plan.id === plan.id ? { ...current, plan } : current))
      setNotice(
        request.action === 'release'
          ? '本计划的离线保留已解除；未立即删除音频，其他计划和正在使用的文件继续保留。'
          : request.action === 'cancel'
            ? '计划已取消，已完成的音频和字幕保留；不会自动重启已取消项目。'
            : request.action === 'pause'
              ? '计划已暂停，播放器继续；已完成的分块保留。'
              : request.action === 'set-budget'
                ? '音频预算已更新，可明确恢复计划或重试失败项。'
                : request.action === 'resume'
                  ? '已请求恢复计划，当前手动集仍优先处理。'
                  : '已请求重试失败项，已取消的项目保持取消。',
      )
    } catch (error) {
      if (mounted.current)
        setError(error instanceof Error ? error.message : '计划操作未完成，请重试。')
    } finally {
      if (mounted.current) {
        setBusy(false)
        await Promise.allSettled([refreshPlans(), refreshDetail()])
      }
    }
  }
  const plan = detail?.plan
  return (
    <section aria-label="已有离线计划">
      <div className="tools-form">
        <label>
          <input
            type="checkbox"
            checked={activeOnly}
            disabled={busy}
            onChange={(event) => {
              setActiveOnly(event.target.checked)
              setPage(0)
            }}
          />
          只看未结束计划
        </label>
        <button
          className="text-button"
          disabled={busy}
          onClick={() => {
            void refreshPlans()
            void refreshDetail()
          }}
        >
          刷新离线计划
        </button>
      </div>
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
      {busy && <p role="status">正在提交计划操作并等待处理收尾…</p>}
      {!plans && !error && <p role="status">正在读取持久计划…</p>}
      {plans?.total === 0 && (
        <p className="tools-hint">暂无符合条件的离线计划。可在“新建计划”选择书籍与集范围。</p>
      )}
      <ul className="offline-plan-list">
        {plans?.plans.map((item) => (
          <li key={item.id} data-offline-plan-id={item.id} data-offline-plan-status={item.status}>
            <div className="section-heading">
              <strong>{item.bookTitle}</strong>
              <span>{planLabel(item)}</span>
            </div>
            <p>
              {item.profile.engine === 'whisperx' ? 'WhisperX' : 'Paraformer'} ·{' '}
              {item.profile.device === 'cpu' ? 'CPU' : 'NVIDIA GPU'} ·{' '}
              {item.scope === 'all' ? '整书' : item.scope === 'range' ? '连续范围' : '选定集'} ·{' '}
              {item.counts.total} 集
            </p>
            <p>
              {item.retentionReleasedAt ? '当前核对：' : ''}音频已备 {item.counts.audioReady}/
              {item.counts.total} · 整集字幕已备 {item.counts.subtitleReady}/{item.counts.total}
            </p>
            <p className="tools-hint">
              需处理 {item.counts.needsAttention} · 失败 {item.counts.failed} · 已取消{' '}
              {item.counts.canceled}
            </p>
            {item.error && <p className="error-message">{item.error}</p>}
            <button
              className="secondary-button"
              onClick={() => choose(item)}
              disabled={busy}
              aria-pressed={item.id === selectedId}
            >
              查看详情
            </button>
          </li>
        ))}
      </ul>
      {plans && plans.total > OFFLINE_PLAN_PAGE_SIZE && (
        <nav className="tools-form" aria-label="离线计划分页">
          <button
            className="text-button"
            disabled={busy || page === 0}
            onClick={() => setPage(page - 1)}
          >
            上一页计划
          </button>
          <span>
            {page + 1} / {Math.ceil(plans.total / OFFLINE_PLAN_PAGE_SIZE)}
          </span>
          <button
            className="text-button"
            disabled={busy || (page + 1) * OFFLINE_PLAN_PAGE_SIZE >= plans.total}
            onClick={() => setPage(page + 1)}
          >
            下一页计划
          </button>
        </nav>
      )}
      {selectedId && !detail && !error && <p role="status">正在读取分集详情…</p>}
      {plan && (
        <section aria-label="离线计划详情" data-offline-detail-id={plan.id}>
          <h3>
            {plan.bookTitle} · {planLabel(plan)}
          </h3>
          <p>音频预算：{offlineBytes(plan.audioBudgetBytes)}；字幕与分块另占空间。</p>
          {plan.retentionReleasedAt && (
            <p role="status">
              已解除此计划的离线保留；分集显示上次处理状态。在线音频可能按临时缓存规则淘汰，本地原文件保留。
            </p>
          )}
          <div className="tools-form">
            {!TERMINAL.has(plan.status) && plan.status !== 'paused' && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  void perform({ id: plan.id, revision: plan.revision, action: 'pause' })
                }
              >
                暂停计划
              </button>
            )}
            {['paused', 'blocked'].includes(plan.status) && (
              <button
                className="primary-button"
                disabled={busy}
                onClick={() =>
                  void perform({ id: plan.id, revision: plan.revision, action: 'resume' })
                }
              >
                恢复计划
              </button>
            )}
            {plan.status !== 'canceled' &&
              (plan.counts.failed > 0 || plan.counts.needsAttention > 0) && (
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() =>
                    void perform({ id: plan.id, revision: plan.revision, action: 'retry-failed' })
                  }
                >
                  重试失败项
                </button>
              )}
            {!TERMINAL.has(plan.status) && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void perform({ id: plan.id, revision: plan.revision, action: 'cancel' })
                }
              >
                取消计划
              </button>
            )}
          </div>
          {!TERMINAL.has(plan.status) && (
            <div className="tools-form offline-budget-change">
              <label>
                调整在线音频预算（GiB）
                <input
                  aria-label="调整在线音频预算 GiB"
                  type="number"
                  min={0}
                  max={1024}
                  step={0.1}
                  value={budget}
                  disabled={busy}
                  onChange={(event) => {
                    budgetDirty.current = true
                    setBudget(event.target.value)
                  }}
                />
              </label>
              <button
                className="secondary-button"
                disabled={
                  busy ||
                  !budget.trim() ||
                  !Number.isFinite(Number(budget)) ||
                  Number(budget) < 0 ||
                  Number(budget) * 1024 ** 3 > MAX_OFFLINE_AUDIO_BUDGET_BYTES
                }
                onClick={() =>
                  void perform({
                    id: plan.id,
                    revision: plan.revision,
                    action: 'set-budget',
                    audioBudgetBytes: Math.round(Number(budget) * 1024 ** 3),
                  })
                }
              >
                保存音频预算
              </button>
            </div>
          )}
          {TERMINAL.has(plan.status) &&
            !plan.retentionReleasedAt &&
            (releaseConfirm !== plan.id ? (
              <button
                className="text-button"
                disabled={busy}
                onClick={() => setReleaseConfirm(plan.id)}
              >
                解除本计划离线保留…
              </button>
            ) : (
              <fieldset
                className="offline-release-confirm"
                aria-label="确认解除离线保留"
                disabled={busy}
              >
                <legend>确认解除离线保留</legend>
                <p>
                  解除后不立即删除音频，但不再为本计划保留；随后可能按临时缓存规则淘汰。其他计划、正在收听或转写的文件继续保留。字幕、书签、进度和本地原文件不删除。
                </p>
                <button
                  className="secondary-button"
                  onClick={() =>
                    void perform({ id: plan.id, revision: plan.revision, action: 'release' })
                  }
                >
                  确认解除离线保留
                </button>
                <button className="text-button" onClick={() => setReleaseConfirm(null)}>
                  返回，保留离线音频
                </button>
              </fieldset>
            ))}
          <ol className="offline-item-list">
            {detail.items.items.map((item) => (
              <li key={item.id} data-offline-item-status={item.status}>
                <strong>
                  第 {item.source ? item.episodeOrder : item.episodeOrder + 1} 集 ·{' '}
                  {item.episodeTitle}
                </strong>
                <span>
                  {plan.retentionReleasedAt
                    ? `上次记录：${ITEM_LABELS[item.status]}`
                    : ITEM_LABELS[item.status]}
                </span>
                <p className="tools-hint">
                  {item.audioReady
                    ? plan.retentionReleasedAt
                      ? '曾备音频'
                      : '音频已备'
                    : item.source
                      ? '在线音频未备'
                      : '本地音频待核对'}{' '}
                  · {offlineBytes(item.mediaBytes)}
                  {item.subtitleSource
                    ? ` · ${item.subtitleSource === 'manual' ? '人工稿' : item.subtitleSource === 'original' ? '原文稿' : '生成稿'}已保留`
                    : ''}
                  {item.jobId ? ' · 已关联字幕任务' : ''}
                </p>
                {item.error && <p className="error-message">{item.error}</p>}
              </li>
            ))}
          </ol>
          {detail.items.total > OFFLINE_ITEMS_PAGE_SIZE && (
            <nav className="tools-form" aria-label="离线分集详情分页">
              <button
                className="text-button"
                disabled={busy || itemPage === 0}
                onClick={() => setItemPage(itemPage - 1)}
              >
                上一页分集
              </button>
              <span>
                {itemPage + 1} / {Math.ceil(detail.items.total / OFFLINE_ITEMS_PAGE_SIZE)}
              </span>
              <button
                className="text-button"
                disabled={busy || (itemPage + 1) * OFFLINE_ITEMS_PAGE_SIZE >= detail.items.total}
                onClick={() => setItemPage(itemPage + 1)}
              >
                下一页分集
              </button>
            </nav>
          )}
        </section>
      )}
    </section>
  )
}
