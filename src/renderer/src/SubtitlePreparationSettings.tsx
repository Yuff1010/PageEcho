import { useEffect, useRef, useState } from 'react'
import type { AppState, Book } from '../../shared/contracts'
import { DEFAULT_SUBTITLE_PREPARATION, type SubtitlePreparation } from '../../shared/transcription'
import { ComponentSetup, componentCapability, useComponentSetup } from './ComponentSetup'
import { effectiveSubtitleProfile, subtitleProfileLabel } from './subtitle-profile'
import { EngineReference } from './EngineReference'
import { SettingsDisclosureSummary } from './SettingsDisclosure'

export function SubtitlePreparationSettings({
  book,
  onUpdated,
}: {
  book: Book
  onUpdated: (state: AppState) => void
}) {
  const component = useComponentSetup()
  return (
    <SubtitlePreparationForm
      book={book}
      component={component}
      onSubmit={async (settings) => {
        const result = await window.desktop.setSubtitlePreparation({ id: book.id, settings })
        if (!result.ok) throw new Error(result.error.message)
        onUpdated(result.value)
        return '本书字幕准备设置已保存。'
      }}
    />
  )
}

export function SubtitlePreparationForm({
  book,
  component,
  onSubmit,
  disabled = false,
  componentDisabled = disabled,
  submitLabel = '保存字幕准备设置',
  pendingLabel = '正在保存…',
  requireComponent = false,
  onCancel,
}: {
  book: Book
  component: ReturnType<typeof useComponentSetup>
  onSubmit: (settings: SubtitlePreparation) => Promise<string | void>
  disabled?: boolean
  componentDisabled?: boolean
  submitLabel?: string
  pendingLabel?: string
  requireComponent?: boolean
  onCancel?: () => void
}) {
  const profile = effectiveSubtitleProfile(book)
  const [settings, setSettings] = useState<SubtitlePreparation>(
    profile ?? DEFAULT_SUBTITLE_PREPARATION,
  )
  const [engineChoice, setEngineChoice] = useState<SubtitlePreparation['engine'] | ''>(
    profile?.engine ?? '',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const locked = busy || disabled || component.busy
  const automatic = settings.mode !== 'manual'
  const capability = engineChoice
    ? componentCapability(component.state, engineChoice, settings.device)
    : null
  return (
    <section className="settings-select-scope" aria-label="字幕准备">
      <h3>字幕与伴读</h3>
      <p className="tools-hint" aria-label="当前字幕配置">
        {profile
          ? `${book.subtitlePreparation ? '当前生效' : '当前沿用在线设置'}：${subtitleProfileLabel(profile)}`
          : '首次播放会自动检查本机组件，在后台准备字幕。下面可以调整本书的高级选项。'}
      </p>
      {requireComponent && (
        <ComponentSetup control={component} disabled={componentDisabled || busy} />
      )}
      <details className="subtitle-advanced-settings settings-disclosure" open={requireComponent}>
        <SettingsDisclosureSummary
          title="高级字幕设置"
          description="调整生成时机、字幕引擎和处理设备"
          status={profile ? '已设本书方案' : '使用默认方案'}
        />
        <div className="settings-disclosure-body">
          <EngineReference device={settings.device} />
          <form
            className="source-preparation-form"
            onSubmit={(event) => {
              event.preventDefault()
              setBusy(true)
              setError('')
              setNotice('')
              void onSubmit(settings)
                .then((message) => {
                  if (mounted.current && message) setNotice(message)
                })
                .catch((error) => {
                  if (mounted.current)
                    setError(
                      error instanceof Error ? error.message : '字幕准备设置未保存，请重试。',
                    )
                })
                .finally(() => {
                  if (mounted.current) setBusy(false)
                })
            }}
          >
            <label>
              准备方案{' '}
              <select
                aria-label="字幕准备方案"
                value={settings.mode}
                disabled={locked}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    mode: event.target.value as SubtitlePreparation['mode'],
                  })
                }
              >
                <option value="auto">边播放边生成（推荐）</option>
                <option value="ahead">先准备字幕再播放</option>
                <option value="manual">仅手动生成</option>
              </select>
            </label>
            <label>
              字幕引擎{' '}
              <select
                aria-label="字幕引擎"
                value={engineChoice}
                disabled={locked}
                required
                onChange={(event) => {
                  const engine = event.target.value as SubtitlePreparation['engine']
                  setEngineChoice(engine)
                  setSettings({ ...settings, engine })
                }}
              >
                <option value="" disabled>
                  请选择引擎
                </option>
                {(['whisperx', 'paraformer'] as const).map((engine) => {
                  const checks = component.state?.check?.capabilities.filter(
                    (item) => item.engine === engine,
                  )
                  return (
                    <option
                      key={engine}
                      value={engine}
                      disabled={!!checks?.length && checks.every((item) => !item.available)}
                    >
                      {engine === 'whisperx' ? 'WhisperX' : 'Paraformer'}
                    </option>
                  )
                })}
              </select>
            </label>
            <label>
              处理设备{' '}
              <select
                aria-label="字幕设备"
                value={settings.device}
                disabled={locked}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    device: event.target.value as SubtitlePreparation['device'],
                  })
                }
              >
                <option
                  value="cpu"
                  disabled={
                    !!engineChoice &&
                    componentCapability(component.state, engineChoice, 'cpu')?.available === false
                  }
                >
                  CPU
                </option>
                <option
                  value="cuda"
                  disabled={
                    !!engineChoice &&
                    componentCapability(component.state, engineChoice, 'cuda')?.available === false
                  }
                >
                  NVIDIA GPU（CUDA）
                </option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={settings.prepareNext}
                disabled={locked || !automatic}
                onChange={(event) =>
                  setSettings({ ...settings, prepareNext: event.target.checked })
                }
              />
              本集完成后准备下一集字幕
            </label>
            <button
              className={requireComponent ? 'primary-button' : 'secondary-button'}
              disabled={
                locked ||
                !engineChoice ||
                capability?.available === false ||
                (requireComponent && !component.state?.configured)
              }
              type="submit"
            >
              {busy ? pendingLabel : submitLabel}
            </button>
            {onCancel && (
              <button type="button" className="text-button" onClick={onCancel}>
                取消本次生成
              </button>
            )}
          </form>
        </div>
      </details>
      {capability?.available === false && (
        <p className="tools-hint" role="status">
          {capability.message} 请选择可用的引擎或设备，或重新配置组件。
        </p>
      )}
      <p className="tools-hint">
        {settings.mode === 'auto'
          ? '点击播放立即开始收听，缺少的字幕在后台生成；已有字幕直接使用，有关联原文时会自动匹配。'
          : settings.mode === 'ahead'
            ? '点击播放后先准备一段字幕，也可选择立即播放；其余字幕在后台继续生成。'
            : '播放时不会自动启动字幕生成。可在听书页手动生成或导入字幕。'}
      </p>
      <p className="tools-hint">
        手动生成与自动准备共用以上引擎和设备。已有文稿会保留；识别结果可用于匹配已导入的小说原文。
      </p>
      {book.online && (
        <p className="tools-hint">
          {book.subtitlePreparation
            ? '本集及下一集的自动字幕由这里控制；下方的音频缓存设置独立生效。可在上方进度卡或听书字幕页取消任务。'
            : '本书尚未保存新方案，当前仍沿用已保存的在线字幕设置。选择并保存后将统一使用这里的方案；音频缓存设置独立生效。'}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {!requireComponent && (
        <ComponentSetup control={component} disabled={componentDisabled || busy} />
      )}
    </section>
  )
}
