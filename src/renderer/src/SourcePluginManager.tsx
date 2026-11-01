import { useEffect, useRef, useState } from 'react'
import type { Result } from '../../shared/contracts'
import type { PluginInfo, PluginPreview, PluginState, PluginTestReport } from '../../shared/plugins'
import { HelpTip } from './HelpTip'
import { Icon } from './Icons'
import { SourceCenterAction, SourceCenterEmpty } from './SourceCenterUI'
import './source-plugins.css'

export function SourcePluginManager() {
  const [state, setState] = useState<PluginState | null>(null)
  const [preview, setPreview] = useState<PluginPreview | null>(null)
  const [previewUpdateUrl, setPreviewUpdateUrl] = useState('')
  const [updateEditor, setUpdateEditor] = useState<{ id: string; url: string } | null>(null)
  const [urlOpen, setUrlOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [cancelable, setCancelable] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [sourceId, setSourceId] = useState('')
  const [query, setQuery] = useState('')
  const [report, setReport] = useState<PluginTestReport | null>(null)
  const active = useRef<string | null>(null)
  const activeCancelable = useRef(false)
  const revision = useRef(0)
  const retry = useRef<(() => void) | null>(null)

  function showPreview(value: PluginPreview) {
    setPreview(value)
    setPreviewUpdateUrl(value.suggestedUpdateUrl ?? '')
    setReport(null)
    setRemoving(null)
    setUpdateEditor(null)
  }

  useEffect(() => {
    let live = true
    const currentRevision = revision.current
    void window.desktop
      .pluginList()
      .then((result) => {
        if (!live || revision.current !== currentRevision) return
        if (result.ok) setState(result.value)
        else setError(result.error.message)
      })
      .catch(() => {
        if (live && revision.current === currentRevision) setError('无法读取插件列表，请重试。')
      })
    return () => {
      live = false
      const requestId = active.current
      active.current = null
      if (requestId && activeCancelable.current)
        void window.desktop.pluginCancel({ requestId }).catch(() => undefined)
    }
  }, [])

  async function run<T>(
    message: string,
    action: (requestId: string) => Promise<Result<T>>,
    apply: (value: T) => void,
    canCancel = false,
  ) {
    const requestId = crypto.randomUUID()
    revision.current++
    active.current = requestId
    activeCancelable.current = canCancel
    setBusy(true)
    setCancelable(canCancel)
    setStatus(message)
    setError('')
    try {
      const result = await action(requestId)
      if (active.current !== requestId) return
      setStatus('')
      if (result.ok) apply(result.value)
      else setError(result.error.message)
    } catch {
      if (active.current === requestId) {
        setStatus('')
        setError('插件操作未完成，请重试。')
      }
    } finally {
      if (active.current === requestId) {
        active.current = null
        activeCancelable.current = false
        setBusy(false)
      }
    }
  }

  function refresh() {
    retry.current = refresh
    void run('正在读取插件…', () => window.desktop.pluginList(), setState)
  }
  function cancel() {
    const requestId = active.current
    active.current = null
    activeCancelable.current = false
    setBusy(false)
    setStatus('已取消。')
    if (requestId) void window.desktop.pluginCancel({ requestId }).catch(() => undefined)
  }
  function choose() {
    retry.current = choose
    setPreview(null)
    void run(
      '正在检查插件包…',
      () => window.desktop.pluginChoose(),
      (value) => {
        if (!value.canceled) {
          showPreview(value.preview)
          setUrlOpen(false)
          setReport(null)
          setRemoving(null)
        }
      },
    )
  }
  function previewUrl() {
    if (!url.trim()) return
    retry.current = previewUrl
    setPreview(null)
    void run(
      '正在下载并检查插件包…',
      (requestId) => window.desktop.pluginPreviewUrl({ requestId, url: url.trim() }),
      (value) => {
        showPreview(value)
        setReport(null)
        setRemoving(null)
      },
      true,
    )
  }
  function install() {
    if (!preview) return
    retry.current = install
    void run(
      '正在验证并安装插件…',
      () =>
        window.desktop.pluginInstall({
          previewId: preview.previewId,
          updateUrl: previewUpdateUrl.trim() || null,
        }),
      (value) => {
        setState(value)
        setStatus(
          preview.action === 'update'
            ? '插件已更新。'
            : '插件已安装，可在有声书或电子书中选择来源。',
        )
        setPreview(null)
        setUrlOpen(false)
        setReport(null)
      },
    )
  }
  function toggle(plugin: PluginInfo) {
    retry.current = () => toggle(plugin)
    void run(
      plugin.enabled ? '正在停用插件…' : '正在启用插件…',
      () => window.desktop.pluginToggle({ id: plugin.id, enabled: !plugin.enabled }),
      (value) => {
        setState(value)
        setReport(null)
        if (plugin.enabled) setTesting(null)
      },
    )
  }
  function rollback(plugin: PluginInfo) {
    retry.current = () => rollback(plugin)
    void run(
      '正在恢复上一版本…',
      () => window.desktop.pluginRollback({ id: plugin.id }),
      (value) => {
        setState(value)
        setReport(null)
        setStatus('已恢复上一版本。')
      },
    )
  }
  function remove(plugin: PluginInfo) {
    retry.current = () => remove(plugin)
    void run(
      '正在卸载插件…',
      () => window.desktop.pluginRemove({ id: plugin.id }),
      (value) => {
        setState(value)
        setRemoving(null)
        setTesting(null)
        setReport(null)
        setStatus('插件已卸载，书架与已有内容保留。')
      },
    )
  }
  function test(plugin: PluginInfo) {
    if (!sourceId) return
    retry.current = () => test(plugin)
    void run(
      '正在测试搜索、目录与内容解析…',
      async (requestId) => {
        const result = await window.desktop.pluginTest({
          requestId,
          id: plugin.id,
          sourceId,
          query: query.trim() || undefined,
        })
        if (!result.ok) return result
        const listed = await window.desktop.pluginList()
        return { ok: true, value: { report: result.value, state: listed.ok ? listed.value : null } }
      },
      (value) => {
        setReport(value.report)
        if (value.state) setState(value.state)
      },
      true,
    )
  }
  function saveUpdateUrl(plugin: PluginInfo) {
    if (updateEditor?.id !== plugin.id) return
    const url = updateEditor.url.trim() || null
    retry.current = () => saveUpdateUrl(plugin)
    void run(
      '正在保存更新地址…',
      () => window.desktop.pluginSetUpdateUrl({ id: plugin.id, url }),
      (value) => {
        setState(value)
        setUpdateEditor(null)
        setStatus(url ? '更新地址已保存，点击检查更新可获取新版本预览。' : '已移除更新地址。')
      },
    )
  }
  function checkUpdate(plugin: PluginInfo) {
    retry.current = () => checkUpdate(plugin)
    setPreview(null)
    void run(
      '正在检查插件更新…',
      (requestId) => window.desktop.pluginCheckUpdate({ requestId, id: plugin.id }),
      (value) => {
        setState(value.state)
        if (value.preview) showPreview(value.preview)
        setStatus(value.status.message)
      },
      true,
    )
  }

  return (
    <div className="source-plugin-manager" aria-busy={busy}>
      <div className="source-center-toolbar" role="group" aria-label="插件导入">
        <SourceCenterAction label="从 ZIP 导入插件" icon="plus" disabled={busy} onClick={choose} />
        <SourceCenterAction
          label="从网址导入插件"
          icon="link"
          disabled={busy}
          aria-expanded={urlOpen}
          onClick={() => setUrlOpen((value) => !value)}
        />
        <SourceCenterAction label="刷新插件列表" icon="refresh" disabled={busy} onClick={refresh} />
        <HelpTip label="来源插件">
          导入本软件的 ZIP
          插件包，一个包可包含多个有声书或正文来源。安装前会列出访问域名；网站首页和其他阅读器的插件格式需要对应适配。
        </HelpTip>
        {busy && cancelable && (
          <SourceCenterAction label="取消插件操作" icon="close" onClick={cancel} />
        )}
      </div>
      {urlOpen && (
        <form
          className="source-plugin-url source-center-search"
          onSubmit={(event) => {
            event.preventDefault()
            previewUrl()
          }}
        >
          <input
            aria-label="插件 ZIP 下载地址"
            type="url"
            placeholder="https://…/source.zip"
            value={url}
            maxLength={4000}
            disabled={busy}
            onChange={(event) => {
              setUrl(event.target.value)
              setPreview(null)
            }}
          />
          <SourceCenterAction
            label="检查插件下载地址"
            icon="arrow"
            type="submit"
            disabled={busy || !url.trim()}
          />
        </form>
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
            label="重试插件操作"
            icon="refresh"
            disabled={busy}
            onClick={() => (retry.current ? retry.current() : refresh())}
          />
        </div>
      )}
      {state?.maintenanceNotice && (
        <p className="source-center-error" role="alert">
          {state.maintenanceNotice}
        </p>
      )}
      {preview && (
        <section
          className="source-center-connection source-plugin-preview"
          aria-label="插件安装预览"
        >
          <div className="source-center-result-heading">
            <h3>{preview.action === 'update' ? '更新插件' : '安装插件'}</h3>
            <SourceCenterAction
              label="取消插件预览"
              icon="close"
              disabled={busy}
              onClick={() => setPreview(null)}
            />
          </div>
          <div className="source-plugin-identity">
            <strong>{preview.name}</strong>
            <span>
              {preview.previousVersion ? `${preview.previousVersion} → ` : ''}
              {preview.version}
            </span>
          </div>
          <ul className="source-plugin-sources">
            {preview.sources.map((source) => (
              <li key={source.id}>
                <Icon name={source.kind === 'audio' ? 'headphones' : 'book'} />
                <span>{source.name}</span>
              </li>
            ))}
          </ul>
          <details className="source-plugin-permissions" open>
            <summary>允许访问的域名</summary>
            <ul>
              {[
                ...new Set(
                  preview.sources.flatMap((source) => [
                    ...source.allowedOrigins,
                    ...source.mediaOrigins,
                    ...(source.coverOrigins ?? source.allowedOrigins),
                  ]),
                ),
              ].map((origin) => (
                <li key={origin}>{origin}</li>
              ))}
            </ul>
          </details>
          {preview.action === 'update' && (
            <section className="source-plugin-permission-changes" aria-label="更新权限变化">
              <h4>权限变化</h4>
              {preview.permissionChanges?.length ? (
                <ul>
                  {preview.permissionChanges.map((change) => (
                    <li key={`${change.sourceId}:${change.kind}:${change.origin}:${change.change}`}>
                      <strong>{change.change === 'added' ? '新增' : '移除'}</strong>
                      {' · '}
                      {change.sourceName}
                      {' · '}
                      {{ request: '网站请求', audio: '音频', cover: '封面' }[change.kind]}
                      {' · '}
                      {change.origin}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>访问权限没有变化。</p>
              )}
            </section>
          )}
          <label className="source-plugin-update-url">
            <span>更新地址（可选）</span>
            <input
              aria-label="安装后的插件更新地址"
              type="url"
              placeholder="https://…/source.zip"
              maxLength={4000}
              value={previewUpdateUrl}
              disabled={busy}
              onChange={(event) => setPreviewUpdateUrl(event.target.value)}
            />
          </label>
          <HelpTip label="插件更新地址">
            仅保存无参数的 HTTPS ZIP 直链。检查更新只下载并预览，不会自动安装；新版本仍需确认。
          </HelpTip>
          <div className="source-center-connection-actions">
            <button type="button" className="primary-button" disabled={busy} onClick={install}>
              {preview.action === 'update' ? '确认更新插件' : '确认安装插件'}
            </button>
          </div>
        </section>
      )}
      {state?.plugins.length ? (
        <ul className="source-plugin-list">
          {state.plugins.map((plugin) => (
            <li key={plugin.id}>
              <article className="source-plugin-card" aria-label={`插件 ${plugin.name}`}>
                <header>
                  <h3>{plugin.name}</h3>
                  <p>
                    {plugin.version} · {plugin.sources.length} 个来源
                    {plugin.enabled ? '' : ' · 已停用'}
                  </p>
                </header>
                <ul className="source-plugin-sources">
                  {plugin.sources.map((source) => (
                    <li key={source.id}>
                      <Icon name={source.kind === 'audio' ? 'headphones' : 'book'} />
                      <div>
                        <span>{source.name}</span>
                        {(() => {
                          const health = plugin.health?.find((row) => row.sourceId === source.id)
                          return health ? (
                            <p
                              className="source-plugin-health"
                              data-result={
                                health.version === plugin.version && health.passed
                                  ? 'passed'
                                  : 'failed'
                              }
                            >
                              {health.version !== plugin.version
                                ? `旧版 ${health.version} 检查`
                                : health.passed
                                  ? '检查通过'
                                  : '检查未通过'}
                              {' · '}
                              <time dateTime={health.checkedAt}>
                                {new Date(health.checkedAt).toLocaleString()}
                              </time>
                              {!health.passed && <span>{health.message}</span>}
                            </p>
                          ) : (
                            <p className="source-plugin-health">尚未检查</p>
                          )
                        })()}
                      </div>
                    </li>
                  ))}
                </ul>
                {plugin.updateCheck && (
                  <p
                    className="source-plugin-update-status"
                    role={plugin.updateCheck.status === 'failed' ? 'alert' : 'status'}
                  >
                    {plugin.updateCheck.message}
                    {' · '}
                    <time dateTime={plugin.updateCheck.checkedAt}>
                      {new Date(plugin.updateCheck.checkedAt).toLocaleString()}
                    </time>
                  </p>
                )}
                <div
                  className="source-plugin-actions"
                  role="group"
                  aria-label={`${plugin.name} 插件操作`}
                >
                  <SourceCenterAction
                    label={`${plugin.enabled ? '停用' : '启用'} ${plugin.name}`}
                    icon={plugin.enabled ? 'stop' : 'check'}
                    disabled={busy}
                    aria-pressed={plugin.enabled}
                    onClick={() => toggle(plugin)}
                  />
                  <SourceCenterAction
                    label={`测试 ${plugin.name}`}
                    icon="globe"
                    disabled={busy || !plugin.enabled}
                    aria-expanded={testing === plugin.id}
                    onClick={() => {
                      setTesting((value) => (value === plugin.id ? null : plugin.id))
                      setSourceId(plugin.sources[0]?.id ?? '')
                      setReport(null)
                      setRemoving(null)
                    }}
                  />
                  {plugin.previousVersion && (
                    <SourceCenterAction
                      label={`将 ${plugin.name} 回滚到 ${plugin.previousVersion}`}
                      icon="undo"
                      disabled={busy}
                      onClick={() => rollback(plugin)}
                    />
                  )}
                  <SourceCenterAction
                    label={`设置 ${plugin.name} 更新地址`}
                    icon="link"
                    disabled={busy}
                    aria-expanded={updateEditor?.id === plugin.id}
                    onClick={() => {
                      setUpdateEditor((value) =>
                        value?.id === plugin.id
                          ? null
                          : { id: plugin.id, url: plugin.updateUrl ?? '' },
                      )
                      setTesting(null)
                      setRemoving(null)
                    }}
                  />
                  <SourceCenterAction
                    label={`检查 ${plugin.name} 更新`}
                    icon="refresh"
                    disabled={busy || !plugin.updateUrl}
                    onClick={() => checkUpdate(plugin)}
                  />
                  <SourceCenterAction
                    label={`卸载 ${plugin.name}`}
                    icon="trash"
                    disabled={busy}
                    aria-expanded={removing === plugin.id}
                    onClick={() => {
                      setRemoving((value) => (value === plugin.id ? null : plugin.id))
                      setTesting(null)
                    }}
                  />
                </div>
                {updateEditor?.id === plugin.id && (
                  <form
                    className="source-plugin-update-editor source-center-search"
                    onSubmit={(event) => {
                      event.preventDefault()
                      saveUpdateUrl(plugin)
                    }}
                  >
                    <input
                      aria-label={`${plugin.name} 更新 ZIP 地址`}
                      type="url"
                      placeholder="https://…/source.zip"
                      maxLength={4000}
                      value={updateEditor.url}
                      disabled={busy}
                      onChange={(event) =>
                        setUpdateEditor({ id: plugin.id, url: event.target.value })
                      }
                    />
                    <SourceCenterAction
                      label={`保存 ${plugin.name} 更新地址`}
                      icon="check"
                      type="submit"
                      disabled={busy}
                    />
                    <HelpTip label="更新直链要求">
                      使用无参数的 HTTPS ZIP 直链，留空后保存可移除地址。不会定期联网或自动安装。
                    </HelpTip>
                  </form>
                )}
                {removing === plugin.id && (
                  <div className="source-plugin-remove">
                    <p>卸载「{plugin.name}」？</p>
                    <p className="source-center-connection-note">
                      已保存的书籍、进度和字幕会保留。
                    </p>
                    <div className="source-center-connection-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => setRemoving(null)}
                        disabled={busy}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => remove(plugin)}
                        disabled={busy}
                      >
                        确认卸载插件
                      </button>
                    </div>
                  </div>
                )}
                {testing === plugin.id && (
                  <section className="source-plugin-test" aria-label={`测试 ${plugin.name} 的来源`}>
                    <form
                      className="source-center-search"
                      onSubmit={(event) => {
                        event.preventDefault()
                        test(plugin)
                      }}
                    >
                      <select
                        aria-label="待测试插件来源"
                        value={sourceId}
                        disabled={busy}
                        onChange={(event) => {
                          setSourceId(event.target.value)
                          setReport(null)
                        }}
                      >
                        {plugin.sources.map((source) => (
                          <option key={source.id} value={source.id}>
                            {source.name}
                          </option>
                        ))}
                      </select>
                      <input
                        aria-label="插件测试关键词"
                        placeholder="已知书名或关键词"
                        value={query}
                        maxLength={200}
                        disabled={busy}
                        onChange={(event) => {
                          setQuery(event.target.value)
                          setReport(null)
                        }}
                      />
                      <SourceCenterAction
                        label="运行插件测试"
                        icon="play"
                        type="submit"
                        disabled={busy || !sourceId}
                      />
                    </form>
                    {report?.id === plugin.id && report.version === plugin.version && (
                      <div className="source-plugin-report" role="status">
                        <p>
                          {report.passed ? '测试通过' : '测试未通过'} · {plugin.version}
                        </p>
                        <ol>
                          {report.steps.map((step, index) => (
                            <li key={`${step.name}:${index}`} data-result={step.status}>
                              <Icon
                                name={
                                  step.status === 'passed'
                                    ? 'check'
                                    : step.status === 'failed'
                                      ? 'close'
                                      : 'info'
                                }
                              />
                              <div>
                                <strong>{step.name}</strong>
                                <p>{step.message}</p>
                              </div>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                  </section>
                )}
              </article>
            </li>
          ))}
        </ul>
      ) : (
        !busy &&
        !preview &&
        !error && (
          <SourceCenterEmpty icon="plugin">
            导入一个插件包，即可添加其中的有声书与正文来源。
          </SourceCenterEmpty>
        )
      )}
    </div>
  )
}
