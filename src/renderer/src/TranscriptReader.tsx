import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react'
import type { Book, Episode } from '../../shared/contracts'
import type { LibraryMutation } from '../../shared/library'
import { OriginalReader } from './OriginalReader'
import { SubtitleExport } from './SubtitleExport'
import { TranscriptionControls, useTranscription } from './TranscriptionControls'
import { ACTIVE_JOB_STATUSES } from '../../shared/transcription'
import { useTranscriptRegions } from './RegionEditor'
import { Icon } from './Icons'
import { ListeningReview } from './ListeningReview'
import { TranscriptEditingPanel } from './TranscriptEditingPanel'
import { SubtitleImportPanel } from './SubtitleImportPanel'
import { ProcessingPauseNotice } from './ProcessingResourcesPanel'
import { ReadingBody, type ReadingSettings } from './CompanionTranscriptBody'
import { player, pendingAudioNotice } from './player'
import { TranscriptionActivity } from './TranscriptionActivity'
import { transcriptionActivityModel } from './transcription-activity'
import {
  READER_FONTS,
  READING_THEMES,
  useReaderPreferences,
  type ReaderSettings,
} from './reader-settings'
import { ReaderPreferences, type SettingsTab } from './ReaderPreferences'
import { ReaderToolbar, ReaderAction } from './ReaderToolbar'
import { useAppAppearance } from './app-appearance'
import { readerPanelAppearance } from './reader-panel'
import { ReaderDockMount, ReaderDockSlot } from './ReaderDock'
import { SubtitleStatus } from './UISubtitleStatus'
import './companion-reader.css'
import './reader-consistency.css'

const SETTINGS_KEY = 'ralb:reader-preferences:v1'
function readOriginalSource(bookId: string) {
  try {
    return localStorage.getItem(`ralb:companion:source:${bookId}`) === 'original'
  } catch {
    return false
  }
}
function readLegacySettings(): Partial<ReaderSettings> | null {
  try {
    const value = JSON.parse(
      localStorage.getItem(SETTINGS_KEY) ?? 'null',
    ) as Partial<ReadingSettings> | null
    if (
      value &&
      [16, 18, 20, 22, 24, 28].includes(value.fontSize ?? 0) &&
      [1.6, 1.9, 2.2].includes(value.lineHeight ?? 0) &&
      ['paper', 'dark'].includes(value.theme ?? '')
    )
      return {
        fontSize: value.fontSize,
        lineHeight: value.lineHeight,
        theme: value.theme,
        ...READING_THEMES[value.theme as 'paper' | 'dark'],
      }
  } catch {
    /* Reading works without local storage. */
  }
  return null
}

type Panel = 'settings' | 'tools' | null
interface ReaderProps {
  episode: Episode | null
  book: Omit<Book, 'episodes'> | undefined
  visible: boolean
  onOpenLibrary: () => void
  onOpenSubtitleSettings: () => void
  onUpdated: (mutation: LibraryMutation) => void
  onLinkBook?: () => void
  onOpenLinkedReading?: () => void
}

export const TranscriptReader = memo(function TranscriptReader(props: ReaderProps) {
  if (!props.episode)
    return (
      <section className="reader-panel companion-page" aria-label="同步伴读" data-theme="paper">
        <header className="companion-toolbar">
          <ReaderAction
            className="reader-button companion-back"
            onClick={props.onOpenLibrary}
            label="返回书架"
            icon="arrow"
          />
          <div className="companion-title">
            <h2>伴读阅读</h2>
          </div>
        </header>
        <div className="companion-empty">
          <Icon name="book" />
          <h2>让文字，跟上故事。</h2>
          <p>选择一本有声书，打开文稿，像读书一样边听边读。</p>
          <button className="primary-button" onClick={props.onOpenLibrary}>
            去书架选择音频
          </button>
        </div>
      </section>
    )
  if (!/^[0-9a-f]{64}$/.test(props.episode.contentHash))
    return <PendingReader {...props} episode={props.episode} />
  return (
    <ReaderForEpisode
      key={`${props.episode.id}:${props.episode.contentHash}`}
      {...props}
      episode={props.episode}
    />
  )
})

/** A provisional stream has no transcript target. Reuse the shared reading chrome. */
function PendingReader({
  episode,
  book,
  visible,
  onOpenLibrary,
  onOpenLinkedReading,
}: ReaderProps & { episode: Episode }) {
  const playback = useSyncExternalStore(player.subscribe, player.getSnapshot)
  const notice = pendingAudioNotice(playback.audioPending) ?? '完整缓存后即可准备字幕。'
  return (
    <section className="reader-panel companion-page" aria-label="同步伴读" data-theme="paper">
      <ReaderToolbar className="companion-toolbar" aria-label="阅读工具栏" data-visible="true">
        <nav className="reader-library-navigation" aria-label="书架切换">
          <ReaderAction
            className="reader-button companion-back"
            label="返回书架"
            icon="arrow"
            onClick={onOpenLibrary}
          />
          {onOpenLinkedReading && (
            <ReaderAction
              className="reader-button companion-open-ebook"
              label="从当前进度阅读"
              icon="book"
              onClick={onOpenLinkedReading}
            />
          )}
        </nav>
        <div
          className="companion-title reader-toolbar-title"
          title={`${book?.title ?? ''} · ${episode.title}`}
        >
          <h2>{book?.title ?? '伴读阅读'}</h2>
          <span>{episode.title}</span>
        </div>
        <div className="companion-toolbar-actions reader-toolbar-actions" />
      </ReaderToolbar>
      <div className="companion-empty" role="status">
        <span className="transcription-spinner" aria-hidden="true" />
        <h2>{playback.error ? '音频获取未完成' : '音频正在获取'}</h2>
        <p>
          {playback.error ||
            (book?.subtitlePreparation?.mode === 'manual'
              ? '可以继续收听，缓存完成后可导入或生成字幕。'
              : '可以继续收听，缓存完成后自动准备字幕。')}
        </p>
      </div>
      <ReaderDockSlot name="activity" active={visible}>
        <SubtitleStatus
          snapshot={null}
          variant="icon"
          checkingNotice={playback.error ? undefined : notice}
        />
      </ReaderDockSlot>
      {visible && <ReaderDockMount />}
    </section>
  )
}

function ReaderForEpisode({
  episode,
  book,
  visible,
  onOpenLibrary,
  onOpenSubtitleSettings,
  onUpdated,
  onLinkBook,
  onOpenLinkedReading,
}: ReaderProps & { episode: Episode }) {
  const [originalMode, setOriginalMode] = useState(() => readOriginalSource(episode.bookId))
  const [originalMounted, setOriginalMounted] = useState(originalMode)
  const [originalSearchRequest, setOriginalSearchRequest] = useState(0)
  const [originalToolsRequest, setOriginalToolsRequest] = useState(0)
  const [originalContentsRequest, setOriginalContentsRequest] = useState(0)
  const preferences = useReaderPreferences(`audio:${episode.bookId}`, readLegacySettings)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('layout')
  const [foldRegions, setFoldRegions] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null')?.foldRegions === true
    } catch {
      return false
    }
  })
  const settings = { ...preferences.settings, foldRegions }
  const { resolvedTheme } = useAppAppearance()
  const panelAppearance = readerPanelAppearance(
    settings.backgroundColor,
    resolvedTheme,
    settings.panelTransparency,
  )
  const panelStyle = {
    ...panelAppearance.variables,
    '--reader-surface': 'var(--reader-panel-solid)',
    '--reader-text': 'var(--ui-text)',
    '--reader-muted': 'var(--ui-muted)',
    '--reader-field': 'var(--ui-field)',
    '--reader-border': 'var(--ui-line)',
    '--reader-current': 'var(--ui-hover)',
    colorScheme: panelAppearance.tone,
  } as CSSProperties
  const [panel, setPanel] = useState<Panel>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [proofreading, setProofreading] = useState(false)
  const [focused, setFocused] = useState(false)
  const [fullscreen, setFullscreen] = useState(!!document.fullscreenElement)
  const [generationRequest, setGenerationRequest] = useState(0)
  const [startingSubtitles, setStartingSubtitles] = useState(false)
  const generationAttempt = useRef(0)
  const [editorSegmentId, setEditorSegmentId] = useState<string | null | undefined>(undefined)
  const [subtitleImport, setSubtitleImport] = useState(false)
  const importOptions = useRef<HTMLDetailsElement>(null)
  const root = useRef<HTMLElement>(null)
  const panelTrigger = useRef<HTMLButtonElement | null>(null)
  const target = useMemo(
    () => ({ episodeId: episode.id, audioHash: episode.contentHash }),
    [episode.id, episode.contentHash],
  )
  const control = useTranscription(target)
  const regions = useTranscriptRegions(target)
  const { resource, error, busy } = control
  const stored = resource?.status === 'ready' ? resource.transcript : null
  const formal =
    control.state?.transcript.status === 'ready' ? control.state.transcript.transcript : null
  const generating = !!control.state?.job && ACTIVE_JOB_STATUSES.includes(control.state.job.status)
  const playback = useSyncExternalStore(player.subscribe, player.getSnapshot)
  const current =
    playback.episode?.id === episode.id && playback.episode.contentHash === episode.contentHash
  const activity = transcriptionActivityModel(
    control.state,
    current ? playback.subtitlePreparationPhase : 'idle',
    current ? playback.subtitleNotice : '',
  )
  const showActivity = !!activity && !activity.completed
  const canEdit = !control.preview && !(control.state?.job?.autoApply && generating)

  const focusText = useCallback(
    (original = originalMode) => {
      requestAnimationFrame(() =>
        root.current
          ?.querySelector<HTMLElement>(
            original
              ? '.companion-original-body:not([hidden]) .original-viewport'
              : '.companion-transcript-body .transcript-viewport',
          )
          ?.focus({ preventScroll: true }),
      )
    },
    [originalMode],
  )
  function closePanel() {
    setPanel(null)
    panelTrigger.current?.focus({ preventScroll: true })
  }
  function openPanel(value: Exclude<Panel, null>, trigger?: HTMLButtonElement) {
    if (trigger) panelTrigger.current = trigger
    setFocused(false)
    setSearchOpen(false)
    setPanel((current) => (current === value ? null : value))
  }
  function openGenerationSettings() {
    setFocused(false)
    setPanel('tools')
    setGenerationRequest((value) => value + 1)
  }
  async function openGeneration() {
    if (generating || stored) {
      openGenerationSettings()
      return
    }
    const attempt = ++generationAttempt.current
    setStartingSubtitles(true)
    try {
      const result = await player.prepareSubtitles(true)
      if (attempt !== generationAttempt.current) return
      if (result && ['started', 'reused'].includes(result.status)) {
        onUpdated(result.mutation)
        await control.refresh()
        setPanel(null)
      } else openGenerationSettings()
    } finally {
      if (attempt === generationAttempt.current) setStartingSubtitles(false)
    }
  }
  useEffect(
    () => () => {
      generationAttempt.current++
    },
    [],
  )
  function selectSource(original: boolean) {
    setOriginalMode(original)
    if (original) setOriginalMounted(true)
    setProofreading(false)
    setFocused(false)
    setPanel(null)
    setSearchOpen(false)
    setEditorSegmentId(undefined)
    setSubtitleImport(false)
    try {
      localStorage.setItem(
        `ralb:companion:source:${episode.bookId}`,
        original ? 'original' : 'transcript',
      )
    } catch {
      // The chosen source remains usable when local storage is unavailable.
    }
    focusText(original)
  }
  async function importDocument() {
    const result = await control.run(() => window.desktop.importTranscript(target))
    if (result && !result.canceled) {
      if (importOptions.current) importOptions.current.open = false
      setPanel(null)
      focusText()
    }
  }
  function changeFoldRegions(value: boolean) {
    setFoldRegions(value)
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({ ...readLegacySettings(), foldRegions: value }),
      )
    } catch {
      /* Keep reading. */
    }
  }
  useEffect(() => {
    const changed = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [])
  useEffect(() => {
    if (!panel || !visible) return
    root.current
      ?.querySelector<HTMLElement>(`.companion-drawer[data-panel="${panel}"] button`)
      ?.focus({ preventScroll: true })
  }, [panel, visible])
  useEffect(() => {
    if (visible && stored?.id && !originalMode)
      requestAnimationFrame(() =>
        root.current
          ?.querySelector<HTMLElement>('.companion-transcript-body .transcript-viewport')
          ?.focus({ preventScroll: true }),
      )
  }, [visible, stored?.id, originalMode])
  useEffect(() => {
    if (!visible) return
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        document.querySelector('dialog[open]') ||
        document.querySelector('select:open')
      )
        return
      if (panel) {
        event.preventDefault()
        setPanel(null)
        panelTrigger.current?.focus({ preventScroll: true })
      } else if (searchOpen) {
        event.preventDefault()
        setSearchOpen(false)
        focusText()
      } else if (focused) {
        event.preventDefault()
        setFocused(false)
      }
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [visible, panel, searchOpen, focused, focusText])
  const sample = JSON.stringify(
    {
      version: 1,
      audioHash: episode.contentHash,
      kind: 'manual',
      coverage: [{ startMs: 0, endMs: 10000 }],
      segments: [{ id: 's1', startMs: 1000, endMs: 3000, text: '把这里替换为音频中对应的文字。' }],
    },
    null,
    2,
  )

  return (
    <section
      ref={root}
      className="reader-panel companion-page"
      data-reader-design="book"
      aria-label="同步伴读"
      data-theme={settings.theme}
      data-font={settings.fontSize}
      data-leading={settings.lineHeight}
      data-has-document={!!stored}
      data-proofreading={proofreading && !originalMode}
      data-source={originalMode ? 'original' : 'transcript'}
      data-focus={focused}
      style={
        {
          '--reader-size': `${settings.fontSize}px`,
          '--reader-leading': settings.lineHeight,
          '--reader-surface': settings.backgroundColor,
          '--reader-text': settings.textColor,
          '--reader-book-font': READER_FONTS[settings.fontFamily].family,
          '--reading-width': `${settings.contentWidth}px`,
          '--reading-weight': settings.fontWeight,
          '--reading-tracking': `${settings.letterSpacing}px`,
          '--reading-paragraph-gap': `${settings.paragraphSpacing}em`,
          '--reading-indent': settings.indent ? '2em' : '0',
          '--reader-panel-opacity': `${100 - settings.panelTransparency}%`,
        } as CSSProperties
      }
    >
      <ReaderToolbar className="companion-toolbar" aria-label="阅读工具栏" data-visible="true">
        <nav className="reader-library-navigation" aria-label="书架切换">
          <ReaderAction
            className="reader-button companion-back"
            onClick={onOpenLibrary}
            label="返回书架"
            icon="arrow"
          />
          {onOpenLinkedReading && (
            <ReaderAction
              className="reader-button companion-open-ebook"
              onClick={onOpenLinkedReading}
              label="从当前进度阅读"
              icon="book"
              tooltip="从当前进度阅读"
            />
          )}
        </nav>
        <div
          className="companion-title reader-toolbar-title"
          title={`${book?.title ?? ''} · ${episode.title}`}
        >
          <h2>{book?.title ?? '伴读阅读'}</h2>
          <span>{episode.title}</span>
        </div>
        <div className="companion-toolbar-actions reader-toolbar-actions">
          {originalMode && (
            <ReaderAction
              className="reader-icon-button"
              onClick={() => {
                setPanel(null)
                setFocused(false)
                setOriginalContentsRequest((value) => value + 1)
              }}
              label="原文目录"
              icon="list"
              tooltip="目录"
            />
          )}
          <ReaderAction
            className="reader-icon-button"
            aria-expanded={originalMode ? undefined : searchOpen}
            disabled={!originalMode && !stored}
            onClick={() => {
              setPanel(null)
              setFocused(false)
              if (originalMode) setOriginalSearchRequest((value) => value + 1)
              else setSearchOpen((value) => !value)
            }}
            label={originalMode ? '搜索小说原文' : '搜索伴读文稿'}
            icon="search"
            tooltip={originalMode ? '搜索小说原文' : '搜索文稿'}
          />
          <ReaderAction
            className="reader-icon-button"
            aria-expanded={panel === 'settings'}
            onClick={(event) => openPanel('settings', event.currentTarget)}
            label="伴读阅读设置"
            icon="settings"
            tooltip="阅读设置"
          />
          <ReaderAction
            className="reader-icon-button companion-tools-trigger"
            aria-expanded={originalMode ? undefined : panel === 'tools'}
            onClick={(event) => {
              if (originalMode) {
                setPanel(null)
                setSearchOpen(false)
                setFocused(false)
                setOriginalToolsRequest((value) => value + 1)
              } else openPanel('tools', event.currentTarget)
            }}
            label={originalMode ? '原文工具' : '伴读工具'}
            icon="more"
            tooltip={originalMode ? '原文来源、匹配与校正' : '字幕与文稿工具'}
          />
          <ReaderAction
            className="reader-icon-button"
            aria-pressed={focused}
            onClick={() => {
              setPanel(null)
              setSearchOpen(false)
              setFocused(true)
            }}
            label="专注伴读"
            icon="focus"
            tooltip="专注阅读"
          />
          <ReaderAction
            className="reader-icon-button"
            onClick={() =>
              void (document.fullscreenElement
                ? document.exitFullscreen()
                : root.current?.requestFullscreen())
            }
            label={fullscreen ? '退出全屏' : '全屏阅读'}
            icon="fullscreen"
            tooltip={fullscreen ? '退出全屏' : '全屏阅读'}
          />
        </div>
      </ReaderToolbar>
      <ReaderDockSlot name="source" active={visible}>
        <div className="companion-source-tabs" role="group" aria-label="伴读文字来源">
          <ReaderAction
            aria-pressed={!originalMode}
            onClick={() => selectSource(false)}
            label="转写字幕"
            icon="transcript"
          />
          <ReaderAction
            aria-pressed={originalMode}
            onClick={() => selectSource(true)}
            label="小说原文"
            icon="book"
          />
        </div>
      </ReaderDockSlot>
      <ReaderDockSlot name="activity" active={visible}>
        {showActivity ? (
          <TranscriptionActivity
            target={target}
            control={control}
            inline
            onConfigure={openGenerationSettings}
          />
        ) : (
          <SubtitleStatus
            snapshot={playback.subtitleStatus}
            rate={playback.rate}
            variant="player"
          />
        )}
        <ProcessingPauseNotice compact />
      </ReaderDockSlot>
      {visible && <ReaderDockMount />}
      {focused && (
        <ReaderAction
          className="reader-button companion-focus-exit"
          onClick={() => setFocused(false)}
          label="退出专注伴读"
          icon="focus"
          tooltip="退出专注 · Esc"
        />
      )}
      <div
        className="companion-reading-stage"
        inert={!!panel}
        aria-hidden={panel ? true : undefined}
      >
        {error && !originalMode && panel !== 'tools' && (
          <div className="error-message" role="alert">
            {error}
          </div>
        )}
        {originalMounted && (
          <div className="companion-original-body" hidden={!originalMode}>
            <OriginalReader
              settings={settings}
              episode={episode}
              visible={visible && originalMode && panel === null}
              transcriptRevision={formal?.revision ?? 0}
              hasTranscript={!!formal}
              searchRequest={originalSearchRequest}
              toolsRequest={originalToolsRequest}
              contentsRequest={originalContentsRequest}
              focused={focused}
              onLinkBook={onLinkBook}
              fallbackTranscript={formal}
              onShowTranscript={() => selectSource(false)}
            />
          </div>
        )}
        {!originalMode &&
          (showActivity && !stored ? (
            <div className="companion-empty">
              {resource?.status === 'stale' && (
                <div role="status">
                  <h2>音频版本已变化</h2>
                  <p>旧文稿不能用于当前音频，请重新生成或导入与当前音频对应的文稿。</p>
                </div>
              )}
              {resource?.status !== 'stale' && (
                <>
                  <Icon name="headphones" />
                  <h2>{activity?.active ? '正在准备字幕' : '本集暂无字幕'}</h2>
                  <p>
                    {activity?.active
                      ? '首段完成后自动显示，生成进度与取消操作在下方。'
                      : '可在下方配置字幕，或导入已有文稿。'}
                  </p>
                </>
              )}
            </div>
          ) : !resource ? (
            <div className="companion-empty" role="status">
              <span className="transcription-spinner" aria-hidden="true" />
              <p>正在打开文稿…</p>
            </div>
          ) : stored ? (
            <ReadingBody
              key={stored.id}
              stored={stored}
              visible={visible}
              settings={settings}
              regions={regions}
              durationMs={episode.durationMs}
              editable={canEdit}
              editStructure={setEditorSegmentId}
              proofreading={proofreading}
              searchOpen={searchOpen}
              onSearchClose={() => {
                setSearchOpen(false)
                focusText()
              }}
              episodeTitle={episode.title}
              saveEdit={async (segmentId, text, revision) =>
                !!(await control.run(() =>
                  window.desktop.editTranscript({ ...target, segmentId, text, revision }),
                ))
              }
            />
          ) : (
            <div className="companion-empty" role="status">
              <Icon name={generating ? 'headphones' : 'book'} />
              <h2>
                {resource.status === 'stale'
                  ? '音频版本已变化'
                  : generating
                    ? '文稿正在准备中'
                    : '这一集还没有文稿'}
              </h2>
              <p>
                {resource.status === 'stale'
                  ? '重新生成或导入与当前音频对应的文稿，即可开始伴读。'
                  : generating
                    ? '首段完成后就会显示在这里，其余内容会在后台继续生成。'
                    : '生成这一集的文稿，或导入已有字幕，开始边听边读。'}
              </p>
              <div className="companion-empty-actions" hidden={!!panel}>
                <button
                  className="primary-button"
                  disabled={busy || startingSubtitles}
                  onClick={() => void openGeneration()}
                >
                  {startingSubtitles
                    ? '正在准备字幕…'
                    : generating
                      ? '查看字幕生成'
                      : '生成本集字幕'}
                </button>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => setSubtitleImport(true)}
                >
                  导入 SRT/WebVTT
                </button>
              </div>
              <p className="tools-hint">听书可以继续，文稿准备好后会自动出现。</p>
            </div>
          ))}
      </div>
      {panel && (
        <button
          className="companion-drawer-scrim"
          aria-label="收起伴读侧栏"
          tabIndex={-1}
          onClick={closePanel}
        />
      )}
      <aside
        className="companion-drawer companion-drawer--settings"
        style={panelStyle}
        data-panel-tone={panelAppearance.tone}
        data-panel="settings"
        role="dialog"
        aria-label="伴读阅读设置"
        hidden={panel !== 'settings'}
      >
        <div className="companion-drawer-heading">
          <h2>阅读设置</h2>
          <ReaderAction
            className="reader-icon-button"
            onClick={closePanel}
            label="关闭伴读面板"
            icon="close"
          />
        </div>
        <ReaderPreferences
          settings={settings}
          change={preferences.change}
          scope={preferences.scope}
          selectScope={preferences.selectScope}
          reset={preferences.reset}
          storageError={preferences.storageError}
          tab={settingsTab}
          setTab={setSettingsTab}
          listening
        />
        {!originalMode && (
          <label className="fold-regions">
            <input
              type="checkbox"
              checked={settings.foldRegions}
              onChange={(event) => changeFoldRegions(event.target.checked)}
            />
            折叠已标注片段
          </label>
        )}
        <p className="tools-hint">
          {originalMode
            ? '字号、行距与主题同样适用于小说原文。只有已匹配的文字可以跳转声音，其他文字可自由阅读。'
            : '点击正文可以跳转播放。手动滚动后进入自由阅读，点击“回到当前播放位置”恢复跟随。'}
        </p>
      </aside>
      <aside
        className="companion-drawer companion-drawer--tools"
        style={panelStyle}
        data-panel-tone={panelAppearance.tone}
        data-panel="tools"
        role="dialog"
        aria-label="伴读工具"
        hidden={panel !== 'tools'}
      >
        <div className="companion-drawer-heading">
          <h2>字幕与文稿</h2>
          <ReaderAction
            className="reader-icon-button"
            onClick={closePanel}
            label="关闭伴读面板"
            icon="close"
          />
        </div>
        {error && panel === 'tools' && (
          <div className="error-message" role="alert">
            {error}
          </div>
        )}
        <section className="companion-tool-section">
          <h3>文稿</h3>
          <p className="tools-hint">
            {stored
              ? `${control.preview ? '生成稿预览 · ' : ''}${stored.document.segments.length.toLocaleString()} 句 · 版本 ${stored.revision}`
              : '生成或导入与本集音频同步的文稿。'}
          </p>
          <div className="reader-primary-actions">
            {!activity?.active && (
              <button
                className="primary-button"
                disabled={busy || startingSubtitles}
                onClick={() => void openGeneration()}
              >
                {startingSubtitles
                  ? '正在准备字幕…'
                  : generating
                    ? '查看字幕生成'
                    : stored
                      ? '字幕生成设置'
                      : '生成本集字幕'}
              </button>
            )}
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => setSubtitleImport(true)}
            >
              导入 SRT/WebVTT
            </button>
          </div>
        </section>
        <TranscriptionControls
          target={target}
          control={control}
          book={book}
          openRequest={generationRequest}
          onOpenSettings={onOpenSubtitleSettings}
          onUpdated={onUpdated}
          showPauseNotice={false}
        />
        {stored && !originalMode && (
          <section className="companion-tool-section reader-document-actions" aria-label="文稿工具">
            <h3>校对与导出</h3>
            <label className="companion-proofreading-toggle">
              <input
                type="checkbox"
                aria-label="校对与标注模式"
                checked={proofreading}
                onChange={(event) => {
                  setProofreading(event.target.checked)
                  setPanel(null)
                  focusText()
                }}
              />
              校对与标注模式
            </label>
            <p className="tools-hint">按需显示句子编号、标注和纠错工具，关闭后恢复正常阅读。</p>
            <SubtitleExport
              key={`export:${stored.id}`}
              compact
              source={{
                ...target,
                source: 'transcript',
                transcriptId: stored.id,
                transcriptRevision: stored.revision,
              }}
              disabled={busy || !!control.preview || !stored.document.segments.length}
            />
            {!control.preview && (
              <ListeningReview key={`review:${stored.id}`} episode={episode} transcript={stored} />
            )}
            {!control.preview && (
              <button className="secondary-button" onClick={() => setEditorSegmentId(null)}>
                字幕编辑与撤销
              </button>
            )}
          </section>
        )}
        <details className="transcript-import" ref={importOptions}>
          <summary>高级：导入时间戳文稿</summary>
          <p className="tools-hint">
            适用于已准备好的句级 JSON 文稿。重新导入会替换当前显示的文稿。
          </p>
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => void importDocument()}
          >
            {busy ? '正在导入文稿…' : stored ? '重新导入文稿' : '导入 JSON 文稿'}
          </button>
          {!stored && (
            <details className="transcript-format">
              <summary>如何准备时间戳文稿</summary>
              <p>
                保存为 UTF-8 JSON。audioHash 必须对应当前音频；时间使用原始音频的整数毫秒。coverage
                表示已标注的区间。请按实际音频修改示例中的文字和时间。
              </p>
              <pre>{sample}</pre>
            </details>
          )}
        </details>
      </aside>
      {editorSegmentId !== undefined && formal && (
        <TranscriptEditingPanel
          episode={episode}
          book={book}
          transcript={formal}
          initialSegmentId={editorSegmentId}
          editable={canEdit}
          onSaved={control.refresh}
          onClose={() => setEditorSegmentId(undefined)}
        />
      )}
      {subtitleImport && (
        <SubtitleImportPanel
          target={target}
          episodeTitle={episode.title}
          onSaved={async () => {
            control.hidePreview()
            await control.refresh()
            setPanel(null)
            focusText()
          }}
          onClose={() => setSubtitleImport(false)}
        />
      )}
    </section>
  )
}
