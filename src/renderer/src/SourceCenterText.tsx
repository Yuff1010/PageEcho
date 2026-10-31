import { useEffect, useRef, useState } from 'react'
import type { Result } from '../../shared/contracts'
import type {
  RemoteLibraryConfig,
  RemoteLibraryInfo,
  RemoteManifestPreview,
  TextBookDetail,
  TextBookSummary,
  TextBrowsePage,
  TextSourceState,
} from '../../shared/text-sources'
import { HelpTip } from './HelpTip'
import { SourceCenterAction, SourceCenterEmpty } from './SourceCenterUI'
import { SourceBookImage, SourceBookResult } from './SourceBookResult'

const libraryKinds = [
  { id: 'opds', name: 'OPDS' },
  { id: 'webdav', name: 'WebDAV' },
  { id: 'audiobookshelf', name: 'Audiobookshelf' },
] as const
const emptyConnection = (): RemoteLibraryConfig => ({
  kind: 'opds',
  label: '',
  baseUrl: '',
  enabled: true,
})
const identity = (book: TextBookSummary) => `${book.sourceId}:${book.workId}`

export function SourceCenterText({
  personal,
  onReadBook,
}: {
  personal: boolean
  onReadBook?: (id: string) => void
}) {
  const [sources, setSources] = useState<TextSourceState | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [query, setQuery] = useState('')
  const [resultsFor, setResultsFor] = useState('')
  const [page, setPage] = useState<TextBrowsePage | null>(null)
  const [currentCursor, setCurrentCursor] = useState<string | undefined>(undefined)
  const [detail, setDetail] = useState<TextBookDetail | null>(null)
  const [selectedChapters, setSelectedChapters] = useState<string[]>([])
  const [acquisitionId, setAcquisitionId] = useState('')
  const [busy, setBusy] = useState(false)
  const [cancelable, setCancelable] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<RemoteLibraryConfig | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [managementOpen, setManagementOpen] = useState(false)
  const [manifestOpen, setManifestOpen] = useState(false)
  const [manifest, setManifest] = useState('')
  const [manifestPreview, setManifestPreview] = useState<RemoteManifestPreview | null>(null)
  const active = useRef<string | null>(null)
  const retry = useRef<(() => void) | null>(null)
  const choices = personal
    ? (sources?.libraries.map((library) => ({
        id: library.id,
        name: library.label,
        enabled: library.enabled,
      })) ?? [])
    : (sources?.sources
        .filter((source) => source.kind === 'wikisource' || source.kind === 'plugin')
        .map((source) => ({ id: source.id, name: source.name, enabled: true })) ?? [])
  const sourceId = choices.some((source) => source.id === selectedId)
    ? selectedId
    : (choices[0]?.id ?? '')
  const library = sources?.libraries.find((item) => item.id === sourceId)
  const enabled = choices.find((source) => source.id === sourceId)?.enabled ?? false

  useEffect(() => {
    let live = true
    void window.desktop
      .textSources()
      .then((result) => {
        if (!live) return
        if (result.ok) setSources(result.value)
        else setError(result.error.message)
      })
      .catch(() => {
        if (live) setError('无法读取来源列表，请重试。')
      })
    return () => {
      live = false
      const requestId = active.current
      active.current = null
      if (requestId) void window.desktop.textCancel({ requestId }).catch(() => undefined)
    }
  }, [])

  async function run<T>(
    message: string,
    action: (requestId: string) => Promise<Result<T>>,
    apply: (value: T) => void,
    canCancel = true,
  ) {
    const previous = active.current
    if (previous) void window.desktop.textCancel({ requestId: previous }).catch(() => undefined)
    const requestId = crypto.randomUUID()
    active.current = requestId
    setBusy(true)
    setCancelable(canCancel)
    setError('')
    setStatus(message)
    try {
      const result = await action(requestId)
      if (active.current !== requestId) return
      setStatus('')
      if (result.ok) apply(result.value)
      else setError(result.error.message)
    } catch {
      if (active.current === requestId) {
        setStatus('')
        setError('来源请求未完成，请检查连接后重试。')
      }
    } finally {
      if (active.current === requestId) {
        active.current = null
        setBusy(false)
      }
    }
  }
  function cancel(showMessage = true) {
    const requestId = active.current
    active.current = null
    setBusy(false)
    setStatus(showMessage ? '已取消读取，书架中已保存的内容仍可阅读。' : '')
    if (requestId) void window.desktop.textCancel({ requestId }).catch(() => undefined)
  }
  function refresh() {
    retry.current = refresh
    void run(
      '正在读取来源列表…',
      () => window.desktop.textSources(),
      (value) => {
        setSources(value)
        setPage(null)
        setDetail(null)
        setCurrentCursor(undefined)
      },
    )
  }
  function switchSource(id: string) {
    cancel(false)
    setSelectedId(id)
    setQuery('')
    setResultsFor('')
    setPage(null)
    setCurrentCursor(undefined)
    setDetail(null)
    setError('')
    setEditing(null)
    setDeleting(false)
    setManagementOpen(false)
    retry.current = null
  }
  function browse(cursor?: string, append = false) {
    if (!sourceId || !enabled) return
    const navigating = !!cursor && !append
    const text = append ? resultsFor : navigating ? '' : query.trim()
    const targetCursor = cursor ?? (library?.kind !== 'opds' ? currentCursor : undefined)
    retry.current = () => browse(cursor, append)
    void run(
      text ? `正在搜索「${text}」…` : '正在读取书库…',
      (requestId) =>
        window.desktop.textBrowse({
          requestId,
          sourceId,
          query: text || undefined,
          cursor: targetCursor,
        }),
      (value) => {
        if (navigating) {
          setCurrentCursor(cursor)
          setQuery('')
        }
        setResultsFor(text)
        setDetail(null)
        setPage(
          append && page?.sourceId === value.sourceId
            ? {
                ...value,
                books: [
                  ...new Map(
                    [...page.books, ...value.books].map((book) => [identity(book), book]),
                  ).values(),
                ],
              }
            : value,
        )
      },
    )
  }
  function open(book: TextBookSummary) {
    retry.current = () => open(book)
    void run(
      `正在读取《${book.title}》…`,
      (requestId) =>
        window.desktop.textDetail({ requestId, sourceId: book.sourceId, workId: book.workId }),
      (value) => {
        setDetail(value)
        setSelectedChapters([])
        setAcquisitionId(value.acquisitions[0]?.id ?? '')
      },
    )
  }
  function importBook() {
    if (!detail) return
    retry.current = importBook
    void run(
      '正在保存所选正文，可随时取消…',
      (requestId) =>
        window.desktop.textImport({
          requestId,
          sourceId: detail.sourceId,
          workId: detail.workId,
          chapterIds: selectedChapters.length ? selectedChapters : undefined,
          acquisitionId: acquisitionId || undefined,
        }),
      (value) => {
        setStatus(value.reused ? '已打开书架中的同一来源版本。' : '已保存到电子书架。')
        onReadBook?.(value.book.id)
      },
    )
  }
  function saveConnection(config: RemoteLibraryConfig) {
    const redacted = { ...config, password: undefined, token: undefined }
    retry.current = () => setEditing(redacted)
    void run(
      '正在保存书库连接…',
      async () => {
        const result = await window.desktop.remoteLibrarySave(config)
        if (!result.ok) return result
        const loaded = await window.desktop.textSources()
        if (!loaded.ok) return loaded
        return { ok: true as const, value: { state: loaded.value, library: result.value } }
      },
      (value) => {
        setSources(value.state)
        setSelectedId(value.library.id)
        setEditing(null)
        setPage(null)
        setCurrentCursor(undefined)
        setQuery('')
        setResultsFor('')
        setDetail(null)
        setStatus(value.library.enabled ? '连接已保存，点击浏览读取书库。' : '书库已停用。')
      },
      false,
    )
    // A secret belongs only to this request; it is never retained in the editor state.
    setEditing((current) =>
      current ? { ...current, password: undefined, token: undefined } : current,
    )
  }
  function editConnection(info: RemoteLibraryInfo) {
    cancel(false)
    setEditing({
      id: info.id,
      kind: info.kind,
      label: info.label,
      baseUrl: info.baseUrl,
      enabled: info.enabled,
    })
    setDeleting(false)
    setManifestOpen(false)
  }
  function checkConnection() {
    if (!sourceId) return
    retry.current = checkConnection
    void run(
      '正在检测书库连接…',
      (requestId) => window.desktop.remoteLibraryCheck({ requestId, sourceId }),
      (value) => {
        setSources((current) =>
          current
            ? {
                ...current,
                libraries: current.libraries.map((item) => (item.id === value.id ? value : item)),
              }
            : current,
        )
        if (value.lastCheckError) setError(value.lastCheckError)
        else setStatus('连接可用。')
      },
    )
  }
  function removeConnection() {
    if (!library) return
    retry.current = removeConnection
    void run(
      '正在移除书库连接…',
      async () => {
        const result = await window.desktop.remoteLibraryRemove({ id: library.id })
        return result.ok ? window.desktop.textSources() : result
      },
      (value) => {
        setSources(value)
        switchSource('')
        setStatus('连接已移除，已导入的电子书仍保留在书架。')
      },
      false,
    )
  }
  function previewManifest() {
    retry.current = previewManifest
    void run(
      '正在检查来源清单…',
      () => window.desktop.remoteManifestPreview({ rawJson: manifest }),
      setManifestPreview,
    )
  }
  function applyManifest() {
    if (!manifestPreview?.applicable) return
    retry.current = applyManifest
    void run(
      '正在应用来源清单…',
      () => window.desktop.remoteManifestApply({ rawJson: manifest }),
      (value) => {
        setSources(value)
        setManifestPreview(null)
        setManifestOpen(false)
        setPage(null)
        setCurrentCursor(undefined)
        setDetail(null)
        setStatus('来源清单已更新。')
      },
      false,
    )
  }
  const canImport =
    !!detail &&
    (detail.chapters.length
      ? selectedChapters.length > 0 && selectedChapters.length <= 20
      : !!acquisitionId)
  return (
    <div className="source-center-panel" aria-busy={busy}>
      <form
        className="source-center-search"
        onSubmit={(event) => {
          event.preventDefault()
          browse()
        }}
      >
        <select
          aria-label={personal ? '个人书库' : '电子书来源'}
          value={sourceId}
          disabled={!choices.length}
          onChange={(event) => switchSource(event.target.value)}
        >
          {!choices.length && (
            <option value="">{personal ? '尚未连接书库' : '正在读取来源'}</option>
          )}
          {choices.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
              {!item.enabled ? '（已停用）' : ''}
            </option>
          ))}
        </select>
        <input
          aria-label="搜索电子书"
          type="search"
          value={query}
          placeholder={personal ? '搜索书库（来源支持时）' : '搜索书名或作者'}
          maxLength={100}
          disabled={!sourceId || !enabled || page?.searchable === false}
          onChange={(event) => setQuery(event.target.value)}
        />
        <SourceCenterAction
          label={personal && !query.trim() ? '浏览书库' : '搜索电子书'}
          icon={personal && !query.trim() ? 'folder' : 'search'}
          type="submit"
          disabled={busy || !sourceId || !enabled || (!personal && !query.trim())}
        />
        {busy && cancelable && (
          <SourceCenterAction label="取消读取" icon="close" onClick={() => cancel()} />
        )}
        {personal && (
          <>
            <SourceCenterAction
              label="连接书库"
              icon="plus"
              aria-expanded={!!editing}
              onClick={() => {
                cancel(false)
                setEditing((current) => (current ? null : emptyConnection()))
                setManifestOpen(false)
                setDeleting(false)
              }}
            />
            <SourceCenterAction
              label="书库管理"
              icon="more"
              aria-expanded={managementOpen}
              onClick={() => setManagementOpen((current) => !current)}
            />
          </>
        )}
        {!personal && (
          <SourceCenterAction
            label="刷新来源列表"
            icon="refresh"
            disabled={busy}
            onClick={refresh}
          />
        )}
      </form>
      {personal && managementOpen && (
        <div
          className="source-center-toolbar source-center-management"
          role="group"
          aria-label="书库管理选项"
        >
          {!!library && (
            <>
              <SourceCenterAction
                label="编辑书库连接"
                icon="settings"
                disabled={busy}
                onClick={() => editConnection(library)}
              />
              <SourceCenterAction
                label={library.enabled ? '停用此书库' : '启用此书库'}
                icon={library.enabled ? 'stop' : 'check'}
                disabled={busy}
                aria-pressed={library.enabled}
                onClick={() =>
                  saveConnection({
                    id: library.id,
                    kind: library.kind,
                    label: library.label,
                    baseUrl: library.baseUrl,
                    enabled: !library.enabled,
                  })
                }
              />
              <SourceCenterAction
                label="检测书库连接"
                icon="globe"
                disabled={busy || !enabled}
                onClick={checkConnection}
              />
              <SourceCenterAction
                label="移除书库连接"
                icon="logout"
                disabled={busy}
                onClick={() => setDeleting((current) => !current)}
              />
            </>
          )}
          <SourceCenterAction
            label="导入或更新来源清单"
            icon="upload"
            aria-expanded={manifestOpen}
            onClick={() => {
              setManifestOpen((current) => !current)
              setEditing(null)
              setDeleting(false)
            }}
          />
          <SourceCenterAction
            label="刷新来源列表"
            icon="refresh"
            disabled={busy}
            onClick={refresh}
          />
        </div>
      )}
      {status && (
        <p className="source-center-status" role="status">
          {busy && <span className="source-center-spinner" aria-hidden="true" />}
          {status}
        </p>
      )}
      {error && (
        <div className="source-center-error" role="alert">
          <p>{error}</p>
          <SourceCenterAction
            label="重试来源请求"
            icon="refresh"
            onClick={() => (retry.current ? retry.current() : refresh())}
          />
        </div>
      )}
      {deleting && library && (
        <div className="source-center-connection">
          <h3>移除「{library.label}」的连接？</h3>
          <p className="source-center-connection-note">书架中的电子书和阅读位置会保留。</p>
          <div className="source-center-connection-actions">
            <button className="secondary-button" onClick={() => setDeleting(false)}>
              取消
            </button>
            <button className="primary-button" disabled={busy} onClick={removeConnection}>
              移除连接
            </button>
          </div>
        </div>
      )}
      {editing && (
        <ConnectionEditor
          value={editing}
          busy={busy}
          savedCredentials={!!library?.hasCredentials && editing.id === library.id}
          onChange={setEditing}
          onSave={saveConnection}
          onClose={() => setEditing(null)}
        />
      )}
      {manifestOpen && (
        <section className="source-center-connection source-center-manifest" aria-label="来源清单">
          <div className="source-center-result-heading">
            <h3>来源清单</h3>
            <HelpTip label="来源清单">
              JSON
              清单只保存连接地址与启停状态，不包含密码、令牌或可执行脚本。导入前会预览新增和更新；凭据请在各书库单独填写。
            </HelpTip>
          </div>
          <textarea
            aria-label="来源清单 JSON"
            value={manifest}
            disabled={busy}
            onChange={(event) => {
              setManifest(event.target.value)
              setManifestPreview(null)
            }}
            placeholder='{"schemaVersion":1,...}'
          />
          {manifestPreview && (
            <>
              <p className="source-center-connection-note">
                {manifestPreview.manifest.id} · 版本 {manifestPreview.manifest.version}
                {manifestPreview.currentVersion !== null
                  ? `（当前 ${manifestPreview.currentVersion}）`
                  : ''}
              </p>
              <ul>
                <li>新增 {manifestPreview.additions.length} 个连接</li>
                <li>更新 {manifestPreview.updates.length} 个连接</li>
              </ul>
              {!manifestPreview.applicable && (
                <p className="source-center-connection-note">
                  此清单版本未高于已保存版本，不能覆盖。
                </p>
              )}
            </>
          )}
          <div className="source-center-connection-actions">
            <SourceCenterAction
              label="导出无凭据的来源清单"
              icon="folder"
              disabled={busy}
              onClick={() => {
                void run(
                  '正在导出来源清单…',
                  () => window.desktop.remoteManifestExport(),
                  (value) => {
                    setManifest(value)
                    setManifestPreview(null)
                    setStatus('清单已显示，可选中复制保存。')
                  },
                )
              }}
            />
            <button
              className="secondary-button"
              disabled={busy || !manifest.trim()}
              onClick={previewManifest}
            >
              检查清单
            </button>
            <button
              className="primary-button"
              disabled={busy || !manifestPreview?.applicable}
              onClick={applyManifest}
            >
              确认应用
            </button>
          </div>
        </section>
      )}
      {detail ? (
        <div className="source-detail source-center-detail">
          <div className="source-center-detail-heading">
            <SourceCenterAction
              label="返回电子书结果"
              icon="arrow"
              className="source-center-back"
              onClick={() => {
                cancel(false)
                setDetail(null)
                setError('')
              }}
            />
            <SourceBookImage
              id={identity(detail)}
              title={detail.title}
              coverUrl={detail.coverUrl}
            />
            <div>
              <h2>{detail.title}</h2>
              <p className="source-credit">
                {detail.author || choices.find((item) => item.id === detail.sourceId)?.name}
              </p>
            </div>
            <SourceCenterAction
              label="导入并阅读所选正文"
              icon="book"
              disabled={busy || !canImport}
              onClick={importBook}
            />
          </div>
          {!!detail.description && <p className="source-description">{detail.description}</p>}
          {!!detail.notice && <p className="source-center-connection-note">{detail.notice}</p>}
          {!!detail.chapters.length && (
            <>
              <div className="source-center-list-heading">
                <h3>选择正文</h3>
                <span>{selectedChapters.length} / 20</span>
                <HelpTip label="正文选择">
                  仅下载勾选的正文，每次最多 20
                  项。此处是来源当前页面提供的目录，可能不包含整本书；导入后可离线阅读。
                </HelpTip>
              </div>
              <ul className="source-center-chapters">
                {detail.chapters.map((chapter) => (
                  <li key={chapter.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selectedChapters.includes(chapter.id)}
                        disabled={
                          busy ||
                          (!selectedChapters.includes(chapter.id) && selectedChapters.length >= 20)
                        }
                        onChange={(event) =>
                          setSelectedChapters((current) =>
                            event.target.checked
                              ? [...current, chapter.id]
                              : current.filter((id) => id !== chapter.id),
                          )
                        }
                      />
                      {chapter.title}
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          {!!detail.acquisitions.length && (
            <>
              <div className="source-center-list-heading">
                <h3>电子书文件</h3>
              </div>
              <div className="source-center-acquisitions">
                {detail.acquisitions.map((item) => (
                  <label key={item.id}>
                    <input
                      type="radio"
                      name="text-source-acquisition"
                      value={item.id}
                      checked={acquisitionId === item.id}
                      disabled={busy}
                      onChange={() => setAcquisitionId(item.id)}
                    />
                    {item.label} · {item.format.toUpperCase()}
                  </label>
                ))}
              </div>
            </>
          )}
          {!detail.chapters.length && !detail.acquisitions.length && (
            <SourceCenterEmpty icon="book">
              此条目没有可直接导入的 TXT / EPUB 正文。
            </SourceCenterEmpty>
          )}
        </div>
      ) : page ? (
        <div className="source-results">
          <div className="source-center-list-heading">
            <h3>{resultsFor ? `「${resultsFor}」的搜索结果` : '书库内容'}</h3>
          </div>
          {!!page.navigation.length && (
            <nav className="source-center-navigation" aria-label="书库分类">
              {page.navigation.map((item) => (
                <button
                  key={item.cursor}
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => browse(item.cursor)}
                >
                  {item.title}
                </button>
              ))}
            </nav>
          )}
          {page.books.length ? (
            <ul className="source-book-grid">
              {page.books.map((book) => (
                <SourceBookResult
                  key={identity(book)}
                  id={identity(book)}
                  title={book.title}
                  coverUrl={book.coverUrl}
                  credit={book.author}
                  description={book.description}
                  label={`查看 ${book.title} 的电子书详情`}
                  disabled={busy}
                  onOpen={() => open(book)}
                />
              ))}
            </ul>
          ) : (
            !page.navigation.length && (
              <SourceCenterEmpty icon="book">
                没有找到可读取的电子书，试试其他关键词或分类。
              </SourceCenterEmpty>
            )
          )}
          {page.nextCursor && (
            <button
              className="secondary-button source-center-more"
              disabled={busy}
              onClick={() => browse(page.nextCursor!, true)}
            >
              加载更多电子书
            </button>
          )}
        </div>
      ) : (
        !busy &&
        !editing &&
        !manifestOpen && (
          <SourceCenterEmpty icon={personal ? 'folder' : 'book'}>
            {personal
              ? choices.length
                ? enabled
                  ? '选择分类或浏览自己的电子书库。'
                  : '此书库已停用，可在上方启用。'
                : '连接 OPDS、WebDAV 或 Audiobookshelf，导入自己的 TXT / EPUB。'
              : '从维基文库搜索正文，选择章节后加入电子书架。'}
          </SourceCenterEmpty>
        )
      )}
    </div>
  )
}

function ConnectionEditor({
  value,
  busy,
  savedCredentials,
  onChange,
  onSave,
  onClose,
}: {
  value: RemoteLibraryConfig
  busy: boolean
  savedCredentials: boolean
  onChange: (value: RemoteLibraryConfig) => void
  onSave: (value: RemoteLibraryConfig) => void
  onClose: () => void
}) {
  return (
    <form
      className="source-center-connection"
      onSubmit={(event) => {
        event.preventDefault()
        onSave(value)
      }}
    >
      <div className="source-center-result-heading">
        <h3>{value.id ? '编辑书库连接' : '连接个人书库'}</h3>
        <SourceCenterAction label="关闭连接设置" icon="close" onClick={onClose} />
      </div>
      <label>
        类型
        <select
          value={value.kind}
          disabled={!!value.id || busy}
          onChange={(event) =>
            onChange({
              ...value,
              kind: event.target.value as RemoteLibraryConfig['kind'],
              password: undefined,
              token: undefined,
            })
          }
        >
          {libraryKinds.map((kind) => (
            <option key={kind.id} value={kind.id}>
              {kind.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        名称
        <input
          required
          maxLength={100}
          value={value.label}
          placeholder="我的电子书库"
          disabled={busy}
          onChange={(event) => onChange({ ...value, label: event.target.value })}
        />
      </label>
      <label>
        地址
        <input
          required
          type="url"
          value={value.baseUrl}
          placeholder={value.kind === 'opds' ? 'https://example.com/opds' : 'https://example.com/'}
          disabled={busy}
          onChange={(event) => onChange({ ...value, baseUrl: event.target.value })}
        />
      </label>
      {value.kind === 'audiobookshelf' ? (
        <label>
          访问令牌
          <input
            type="password"
            autoComplete="new-password"
            value={value.token ?? ''}
            placeholder={savedCredentials ? '已保存；留空保留' : 'Audiobookshelf API 令牌'}
            disabled={busy}
            onChange={(event) => onChange({ ...value, token: event.target.value || undefined })}
          />
        </label>
      ) : (
        <>
          <label>
            用户名
            <input
              autoComplete="off"
              value={value.username ?? ''}
              placeholder={savedCredentials ? '留空保留已保存的用户名' : '可选'}
              disabled={busy}
              onChange={(event) =>
                onChange({ ...value, username: event.target.value || undefined })
              }
            />
          </label>
          <label>
            密码
            <input
              type="password"
              autoComplete="new-password"
              value={value.password ?? ''}
              placeholder={savedCredentials ? '已保存；留空保留' : '可选'}
              disabled={busy}
              onChange={(event) =>
                onChange({ ...value, password: event.target.value || undefined })
              }
            />
          </label>
        </>
      )}
      <div className="source-center-toolbar">
        <label className="source-center-checkbox">
          <input
            type="checkbox"
            checked={value.enabled}
            disabled={busy}
            onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
          />
          启用
        </label>
        <HelpTip label="个人书库连接">
          只接入你提供的书库，当前支持导入 TXT / EPUB。Audiobookshelf
          此入口读取电子书文件，音频播放尚未接入。密码与令牌仅在本次保存时发送，编辑时不会回填；留空保留已有凭据。
        </HelpTip>
      </div>
      <div className="source-center-connection-actions">
        <SourceCenterAction
          label="保存书库连接"
          icon="check"
          type="submit"
          disabled={busy || !value.label.trim() || !value.baseUrl.trim()}
        />
      </div>
    </form>
  )
}
