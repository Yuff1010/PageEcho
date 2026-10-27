import { useEffect, useId, useRef, useState } from 'react'
import type { AppState, Book } from '../../shared/contracts'
import { effectiveSubtitleProfile } from './subtitle-profile'
import {
  MAX_OFFLINE_ITEMS,
  MAX_ACTIVE_OFFLINE_PLANS,
  MAX_OFFLINE_AUDIO_BUDGET_BYTES,
  OFFLINE_ITEMS_PAGE_SIZE,
  type OfflinePlanPreview,
  type OfflineSelection,
} from '../../shared/offline'
import { OfflinePlanList } from './OfflinePlanList'
import { ProcessingPauseNotice } from './ProcessingResourcesPanel'
import { offlineBytes } from './offline-format'
import { settingsTabIndex } from './tab-keyboard'
import './offline-preparation.css'

export function OfflinePreparationPanel({
  books,
  initialBookId,
  onUpdated,
  onClose,
}: {
  books: Book[]
  initialBookId?: string | null
  onUpdated: (state: AppState) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const tabsId = useId()
  const tabButtons = useRef<Partial<Record<'new' | 'plans', HTMLButtonElement | null>>>({})
  const [view, setView] = useState<'new' | 'plans'>(initialBookId ? 'new' : 'plans')
  const [bookId, setBookId] = useState(initialBookId ?? books[0]?.id ?? '')
  const book = books.find((item) => item.id === bookId)
  const [selection, setSelection] = useState<'all' | 'range' | 'selected'>('all')
  const [first, setFirst] = useState('1'),
    [last, setLast] = useState(String(book?.episodes.length ?? 1))
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(0)
  const [engine, setEngine] = useState<'whisperx' | 'paraformer' | ''>(() =>
    book ? (effectiveSubtitleProfile(book)?.engine ?? '') : '',
  )
  const [device, setDevice] = useState<'cpu' | 'cuda'>(() =>
    book ? (effectiveSubtitleProfile(book)?.device ?? 'cpu') : 'cpu',
  )
  const [budget, setBudget] = useState('5')
  const [preview, setPreview] = useState<OfflinePlanPreview | null>(null)
  const [previewPage, setPreviewPage] = useState(0)
  const [busy, setBusy] = useState<'preview' | 'catalog' | 'cancel-preview' | 'create' | null>(null)
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const [createdId, setCreatedId] = useState<string | null>(null)
  const mounted = useRef(false),
    request = useRef<{ id: string; token: symbol } | null>(null),
    operation = useRef(Symbol())
  useEffect(() => {
    mounted.current = true
    const element = dialog.current!
    element.showModal()
    return () => {
      mounted.current = false
      operation.current = Symbol()
      const pending = request.current
      request.current = null
      if (pending)
        void window.desktop.cancelOfflinePreview({ requestId: pending.id }).catch(() => undefined)
      element.close()
    }
  }, [])
  function invalidatePreview() {
    setPreview(null)
    setError('')
    setNotice('')
    const pending = request.current
    if (!pending) return
    request.current = null
    const token = Symbol()
    operation.current = token
    setBusy('cancel-preview')
    void window.desktop
      .cancelOfflinePreview({ requestId: pending.id })
      .then((result) => {
        if (mounted.current && operation.current === token && !result.ok)
          setError(result.error.message)
      })
      .catch(() => {
        if (mounted.current && operation.current === token)
          setError('取消预览未完成，请重试或关闭面板。')
      })
      .finally(() => {
        if (mounted.current && operation.current === token) setBusy(null)
      })
  }
  async function preparePreview(catalogOnly = false) {
    if (busy || !book || (!engine && !catalogOnly)) return
    setError('')
    setNotice('')
    setPreview(null)
    setPreviewPage(0)
    const audioBudgetBytes = Math.round(Number(budget) * 1024 ** 3)
    if (
      !budget.trim() ||
      !Number.isFinite(audioBudgetBytes) ||
      audioBudgetBytes < 0 ||
      audioBudgetBytes > MAX_OFFLINE_AUDIO_BUDGET_BYTES
    ) {
      setError('请填写 0–1,024 GiB 的在线音频预算；仅本地音频可设为零。')
      return
    }
    let chosen: OfflineSelection
    if (catalogOnly || selection === 'all') chosen = { kind: 'all' }
    else if (selection === 'selected') {
      if (!selected.size || selected.size > MAX_OFFLINE_ITEMS) {
        setError(`请选择 1–${MAX_OFFLINE_ITEMS} 集。`)
        return
      }
      chosen = { kind: 'ids', episodeIds: [...selected] }
    } else {
      const from = Number(first),
        to = Number(last)
      if (
        !Number.isSafeInteger(from) ||
        !Number.isSafeInteger(to) ||
        from < 1 ||
        to < from ||
        to > 100000 ||
        to - from + 1 > MAX_OFFLINE_ITEMS ||
        (!book.online && to > book.episodes.length)
      ) {
        setError('请填写有效的起止集数，单次最多 1,000 集。')
        return
      }
      chosen = { kind: 'range', from, to }
    }
    const pending = { id: crypto.randomUUID(), token: Symbol() }
    request.current = pending
    setBusy(catalogOnly ? 'catalog' : 'preview')
    try {
      const result = await window.desktop.previewOfflinePreparation({
        requestId: pending.id,
        bookId: book.id,
        selection: chosen,
        // Catalog-only requests never save a profile, create a plan, or run a model.
        profile: { engine: engine || 'whisperx', device },
        audioBudgetBytes,
      })
      if (!mounted.current || request.current?.token !== pending.token) return
      if (!result.ok) throw new Error(result.error.message)
      if (catalogOnly) setNotice('目录已补全，请选集或范围后重新预览；尚未创建计划。')
      else {
        setPreview(result.value)
        setNotice('预览已就绪，请核对范围、未知大小和已有稿，再明确创建。')
      }
    } catch (error) {
      if (mounted.current && request.current?.token === pending.token)
        setError(error instanceof Error ? error.message : '离线准备预览未完成，请重试。')
    } finally {
      if (mounted.current && request.current?.token === pending.token) {
        if (catalogOnly) {
          // Even a >1,000-item rejection can have safely completed the catalog.
          // Read the persisted library; never infer completeness from an error.
          try {
            const library = await window.desktop.getState()
            if (mounted.current && request.current?.token === pending.token && library.ok)
              onUpdated(library.value)
          } catch {
            // The sourceChanged event also refreshes the app library.
          }
        }
      }
      if (mounted.current && request.current?.token === pending.token) {
        request.current = null
        setBusy(null)
      }
    }
  }
  async function createPlan() {
    if (!preview || busy) return
    if (preview.expiresAt <= Date.now()) {
      setPreview(null)
      setError('预览已过期，请重新预览范围与空间。')
      return
    }
    const token = Symbol()
    operation.current = token
    setBusy('create')
    setError('')
    try {
      const result = await window.desktop.createOfflinePreparation({ token: preview.token })
      if (!mounted.current || operation.current !== token) return
      if (!result.ok) throw new Error(result.error.message)
      setCreatedId(result.value.id)
      setPreview(null)
      setView('plans')
      setNotice('离线计划已创建，可关闭面板；当前手动集仍优先处理。')
    } catch (error) {
      if (mounted.current && operation.current === token) {
        setPreview(null)
        setError(error instanceof Error ? error.message : '计划未创建，请重新预览后重试。')
      }
    } finally {
      if (mounted.current && operation.current === token) setBusy(null)
    }
  }
  function changeBook(id: string) {
    invalidatePreview()
    const target = books.find((item) => item.id === id)
    const profile = target ? effectiveSubtitleProfile(target) : undefined
    setBookId(id)
    setFirst('1')
    setLast(String(target?.episodes.length ?? 1))
    setSelected(new Set())
    setPage(0)
    setEngine(profile?.engine ?? '')
    setDevice(profile?.device ?? 'cpu')
  }
  return (
    <dialog
      ref={dialog}
      className="listening-dialog offline-preparation-dialog"
      aria-label="离线准备计划"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="section-heading">
        <h2>离线准备计划</h2>
        <button className="text-button" aria-label="关闭离线准备计划" onClick={onClose}>
          关闭
        </button>
      </div>
      <nav className="maintenance-tabs" role="tablist" aria-label="离线准备页面">
        {(
          [
            { id: 'new', label: '新建计划' },
            { id: 'plans', label: '已有计划' },
          ] as const
        ).map((item, index, tabs) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`${tabsId}-${item.id}-tab`}
            aria-controls={`${tabsId}-${item.id}-panel`}
            aria-selected={view === item.id}
            tabIndex={view === item.id ? 0 : -1}
            ref={(element) => {
              tabButtons.current[item.id] = element
            }}
            onClick={() => setView(item.id)}
            onKeyDown={(event) => {
              const next = settingsTabIndex(event, index, tabs.length)
              if (next === null) return
              setView(tabs[next]!.id)
              tabButtons.current[tabs[next]!.id]?.focus()
            }}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <p className="tools-hint">
        离开面板后，已创建的计划仍会后台继续；关闭应用后将在下次启动恢复。不会自动播放或更改本书字幕方案。
      </p>
      <ProcessingPauseNotice includeIdlePolicy />
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
        hidden={view !== 'new'}
        role="tabpanel"
        id={`${tabsId}-new-panel`}
        aria-labelledby={`${tabsId}-new-tab`}
        tabIndex={0}
      >
        <fieldset disabled={busy === 'create'} className="offline-plan-fields">
          <div className="tools-form">
            <label>
              书籍
              <select
                aria-label="离线准备书籍"
                value={bookId}
                onChange={(event) => changeBook(event.target.value)}
              >
                <option value="" disabled>
                  请选择书籍
                </option>
                {books.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                    {item.online ? '（在线）' : '（本地）'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              范围
              <select
                aria-label="离线准备范围"
                value={selection}
                onChange={(event) => {
                  invalidatePreview()
                  setSelection(event.target.value as typeof selection)
                }}
              >
                <option value="all">整书</option>
                <option value="range">连续范围</option>
                <option value="selected">选定集</option>
              </select>
            </label>
          </div>
          {book && (
            <p className="tools-hint">
              当前目录 {book.episodes.length} 集
              {book.online && !book.online.catalogComplete
                ? '，目录尚未完整，整书预览需先联网补全。'
                : '。'}
              每个计划最多 {MAX_OFFLINE_ITEMS.toLocaleString()} 集，同时最多{' '}
              {MAX_ACTIVE_OFFLINE_PLANS} 个未结束计划；超出时请分批。
            </p>
          )}
          {selection === 'range' && (
            <div className="tools-form">
              <label>
                起始集
                <input
                  aria-label="离线范围起始集"
                  type="number"
                  min={1}
                  max={100000}
                  step={1}
                  value={first}
                  onChange={(event) => {
                    invalidatePreview()
                    setFirst(event.target.value)
                  }}
                />
              </label>
              <label>
                结束集
                <input
                  aria-label="离线范围结束集"
                  type="number"
                  min={1}
                  max={100000}
                  step={1}
                  value={last}
                  onChange={(event) => {
                    invalidatePreview()
                    setLast(event.target.value)
                  }}
                />
              </label>
            </div>
          )}
          {selection === 'selected' && book && (
            <div>
              <p className="tools-hint">已选择 {selected.size} 集；选择跨目录分页保留。</p>
              {book.online && !book.online.catalogComplete && (
                <div className="tools-form">
                  <button
                    className="secondary-button"
                    disabled={!!busy}
                    onClick={() => void preparePreview(true)}
                  >
                    {busy === 'catalog' ? '正在补全选集目录…' : '补全选集目录'}
                  </button>
                  <p className="tools-hint">
                    当前只显示已保存的目录。补全可取消；超出 1,000
                    集时仍可分批选择，不会自动创建计划。
                  </p>
                </div>
              )}
              <ul className="offline-episode-choices">
                {book.episodes.slice(page * 100, (page + 1) * 100).map((episode, index) => (
                  <li key={episode.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selected.has(episode.id)}
                        disabled={!selected.has(episode.id) && selected.size >= MAX_OFFLINE_ITEMS}
                        onChange={(event) => {
                          invalidatePreview()
                          setSelected((current) => {
                            const next = new Set(current)
                            if (event.target.checked) next.add(episode.id)
                            else next.delete(episode.id)
                            return next
                          })
                        }}
                      />
                      第 {page * 100 + index + 1} 集 · {episode.title}
                    </label>
                  </li>
                ))}
              </ul>
              {book.episodes.length > 100 && (
                <nav className="tools-form" aria-label="离线选集分页">
                  <button
                    className="text-button"
                    disabled={page === 0}
                    onClick={() => setPage(page - 1)}
                  >
                    上一页选集
                  </button>
                  <span>
                    {page + 1} / {Math.ceil(book.episodes.length / 100)}
                  </span>
                  <button
                    className="text-button"
                    disabled={(page + 1) * 100 >= book.episodes.length}
                    onClick={() => setPage(page + 1)}
                  >
                    下一页选集
                  </button>
                </nav>
              )}
            </div>
          )}
          <div className="tools-form">
            <label>
              引擎
              <select
                aria-label="离线计划引擎"
                value={engine}
                onChange={(event) => {
                  invalidatePreview()
                  setEngine(event.target.value as typeof engine)
                }}
              >
                <option value="" disabled>
                  请选择引擎
                </option>
                <option value="whisperx">WhisperX</option>
                <option value="paraformer">Paraformer</option>
              </select>
            </label>
            <label>
              设备
              <select
                aria-label="离线计划设备"
                value={device}
                onChange={(event) => {
                  invalidatePreview()
                  setDevice(event.target.value as typeof device)
                }}
              >
                <option value="cpu">CPU</option>
                <option value="cuda">NVIDIA GPU</option>
              </select>
            </label>
            <label>
              在线音频预算（GiB）
              <input
                aria-label="离线音频预算 GiB"
                type="number"
                min={0}
                max={1024}
                step={0.1}
                value={budget}
                onChange={(event) => {
                  invalidatePreview()
                  setBudget(event.target.value)
                }}
              />
            </label>
          </div>
        </fieldset>
        <p className="tools-hint">
          在线音频将作为离线保留，与 512 MiB
          临时缓存分开计量。未知大小会在预览中列出；音频预算不包括模型、字幕与分块缓存。仅本地音频可设为零，本地原音频保持原处。
        </p>
        <div className="tools-form">
          <button
            className="primary-button"
            disabled={!!busy || !book || !engine}
            onClick={() => void preparePreview()}
          >
            {busy === 'preview' ? '正在读取目录与预览…' : '预览离线准备'}
          </button>
          {(busy === 'preview' || busy === 'catalog') && (
            <button className="text-button" onClick={invalidatePreview}>
              取消本次预览
            </button>
          )}
          {busy === 'cancel-preview' && <span role="status">正在取消预览并等待收尾…</span>}
        </div>
        {preview && (
          <section aria-label="离线准备预览">
            <h3>
              {preview.bookTitle} · 预览 {preview.totalItems} 集
            </h3>
            <p>
              {preview.profile.engine === 'whisperx' ? 'WhisperX' : 'Paraformer'} ·{' '}
              {preview.profile.device === 'cpu' ? 'CPU' : 'NVIDIA GPU'} · 在线音频预算{' '}
              {offlineBytes(preview.audioBudgetBytes)}
            </p>
            <dl className="offline-preview-counts">
              <div>
                <dt>已知音频体积</dt>
                <dd>{offlineBytes(preview.knownAudioBytes)}</dd>
              </div>
              <div>
                <dt>大小未知</dt>
                <dd>{preview.unknownAudioItems} 集</dd>
              </div>
              <div>
                <dt>已有音频</dt>
                <dd>{preview.existingAudioItems} 集</dd>
              </div>
              <div>
                <dt>整集字幕已备</dt>
                <dd>{preview.completeSubtitleItems} 集</dd>
              </div>
              <div>
                <dt>已有部分稿</dt>
                <dd>{preview.partialSubtitleItems} 集</dd>
              </div>
              <div>
                <dt>磁盘可用</dt>
                <dd>{offlineBytes(preview.freeBytes)}</dd>
              </div>
            </dl>
            {!!preview.unknownAudioItems && (
              <p className="tools-hint">
                未知项不会按零字节估算；每集下载上限 256
                MiB。预算或实际磁盘不足时计划会等待处理，不保证全部装入当前预算。
              </p>
            )}
            <p className="tools-hint">
              保留已有人工和纠错稿，只补安全可生成的缺失字幕。部分稿或新稿待采用不会冒充整集可听字幕已备；准备前会再次检查文件与实际空间。
            </p>
            {!!preview.conflicts.length && (
              <div className="offline-preview-conflicts" role="status">
                <strong>需留意的项目</strong>
                <ul>
                  {preview.conflicts.map((conflict, index) => (
                    <li key={index}>{conflict}</li>
                  ))}
                </ul>
              </div>
            )}
            <ol className="offline-preview-items">
              {preview.items
                .slice(
                  previewPage * OFFLINE_ITEMS_PAGE_SIZE,
                  (previewPage + 1) * OFFLINE_ITEMS_PAGE_SIZE,
                )
                .map((item) => (
                  <li key={item.episodeId}>
                    第 {item.order} 集 · {item.title} ·{' '}
                    {item.cached ? '音频已有' : item.online ? '音频待缓存' : '本地音频'} ·{' '}
                    {offlineBytes(item.mediaBytes)} ·{' '}
                    {item.subtitle === 'complete'
                      ? '整集字幕已有'
                      : item.subtitle === 'partial'
                        ? '部分稿保留'
                        : item.subtitle === 'unknown-duration'
                          ? '时长未知，待核对覆盖'
                          : '字幕缺失'}
                    {item.conflict && <p className="error-message">{item.conflict}</p>}
                  </li>
                ))}
            </ol>
            {preview.items.length > OFFLINE_ITEMS_PAGE_SIZE && (
              <nav className="tools-form" aria-label="离线预览分页">
                <button
                  className="text-button"
                  disabled={previewPage === 0}
                  onClick={() => setPreviewPage(previewPage - 1)}
                >
                  上一页预览
                </button>
                <span>
                  {previewPage + 1} / {Math.ceil(preview.items.length / OFFLINE_ITEMS_PAGE_SIZE)}
                </span>
                <button
                  className="text-button"
                  disabled={(previewPage + 1) * OFFLINE_ITEMS_PAGE_SIZE >= preview.items.length}
                  onClick={() => setPreviewPage(previewPage + 1)}
                >
                  下一页预览
                </button>
              </nav>
            )}
            <button className="primary-button" disabled={!!busy} onClick={() => void createPlan()}>
              {busy === 'create' ? '正在创建离线计划…' : '确认创建离线计划'}
            </button>
          </section>
        )}
      </section>
      <div
        hidden={view !== 'plans'}
        role="tabpanel"
        id={`${tabsId}-plans-panel`}
        aria-labelledby={`${tabsId}-plans-tab`}
        tabIndex={0}
      >
        {view === 'plans' && <OfflinePlanList initialFocusId={createdId} />}
      </div>
    </dialog>
  )
}
