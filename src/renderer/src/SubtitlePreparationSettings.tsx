import { useEffect, useId, useRef, useState } from 'react'
import type { Book } from '../../shared/contracts'
import type { LibraryMutation } from '../../shared/library'
import { DEFAULT_SUBTITLE_PREPARATION, type SubtitlePreparation } from '../../shared/transcription'
import { ComponentSetup, componentCapability, useComponentSetup } from './ComponentSetup'
import { effectiveSubtitleProfile, subtitleProfileLabel } from './subtitle-profile'
import { EngineReference } from './EngineReference'
import { SettingsDisclosureSummary } from './SettingsDisclosure'
import { HelpTip } from './HelpTip'
import './subtitle-preferences.css'

export function SubtitlePreparationSettings({
  book,
  onUpdated,
}: {
  book: Omit<Book, 'episodes'>
  onUpdated: (mutation: LibraryMutation) => void
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
  compact = false,
}: {
  book: Omit<Book, 'episodes'>
  component: ReturnType<typeof useComponentSetup>
  onSubmit: (settings: SubtitlePreparation) => Promise<string | void>
  disabled?: boolean
  componentDisabled?: boolean
  submitLabel?: string
  pendingLabel?: string
  requireComponent?: boolean
  onCancel?: () => void
  compact?: boolean
}) {
  const prefix = useId()
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
  const form = (
    <form
      className="subtitle-preference-form"
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
              setError(error instanceof Error ? error.message : '字幕准备设置未保存，请重试。')
          })
          .finally(() => {
            if (mounted.current) setBusy(false)
          })
      }}
    >
      <div className="subtitle-preference-row">
        <div className="subtitle-preference-caption">
          <label htmlFor={`${prefix}-mode`}>生成方式</label>
          <HelpTip label="字幕生成方式">
            边听边生成会先播放音频，再在后台准备缺少的字幕；先准备再播放会等待首段；手动生成不随播放启动任务。
          </HelpTip>
        </div>
        <select
          id={`${prefix}-mode`}
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
          <option value="auto">边听边生成</option>
          <option value="ahead">先准备再播放</option>
          <option value="manual">手动生成</option>
        </select>
      </div>
      <div className="subtitle-preference-row">
        <div className="subtitle-preference-caption">
          <label htmlFor={`${prefix}-engine`}>引擎</label>
          <HelpTip label="字幕引擎">
            手动生成和自动准备共用此引擎。请按当前组件的可用检查选择，实际文字仍需回听校对。
          </HelpTip>
        </div>
        <select
          id={`${prefix}-engine`}
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
      </div>
      <div className="subtitle-preference-row">
        <div className="subtitle-preference-caption">
          <label htmlFor={`${prefix}-device`}>设备</label>
          <HelpTip label="字幕处理设备">
            CPU 和 NVIDIA GPU 使用相同字幕方案。GPU 需要兼容组件和设备；不可用的选项会禁用。
          </HelpTip>
        </div>
        <select
          id={`${prefix}-device`}
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
            NVIDIA GPU
          </option>
        </select>
      </div>
      <label className="subtitle-preference-check">
        <input
          type="checkbox"
          aria-label="本集完成后准备下一集字幕"
          checked={settings.prepareNext}
          disabled={locked || !automatic}
          onChange={(event) => setSettings({ ...settings, prepareNext: event.target.checked })}
        />
        自动准备下一集
      </label>
      <div className="subtitle-preference-actions">
        <button
          className={requireComponent ? 'primary-button' : 'secondary-button'}
          disabled={
            locked ||
            !engineChoice ||
            capability?.available === false ||
            (requireComponent && !component.state?.configured)
          }
          type="submit"
          aria-label={busy ? pendingLabel : submitLabel}
        >
          {busy ? pendingLabel : submitLabel === '保存字幕准备设置' ? '保存' : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="text-button" onClick={onCancel}>
            取消本次生成
          </button>
        )}
      </div>
    </form>
  )
  return (
    <section
      className="subtitle-preferences settings-select-scope"
      aria-label="字幕准备"
      data-compact={compact}
    >
      {!compact && (
        <>
          <h3>
            字幕与伴读
            <HelpTip label="字幕设置">
              本书方案用于当前集和后续集。手动生成与自动准备共用引擎和设备，已有文稿会保留。音频缓存独立设置。
            </HelpTip>
          </h3>
          <p className="tools-hint" aria-label="当前字幕配置">
            {profile
              ? `${book.subtitlePreparation ? '当前生效' : '当前沿用在线设置'}：${subtitleProfileLabel(profile)}`
              : '播放时自动检查并准备字幕。'}
          </p>
        </>
      )}
      {requireComponent && (
        <ComponentSetup compact control={component} disabled={componentDisabled || busy} />
      )}
      {compact ? (
        form
      ) : (
        <details className="subtitle-advanced-settings settings-disclosure" open={requireComponent}>
          <SettingsDisclosureSummary
            title="高级字幕设置"
            status={profile ? '本书方案' : '默认方案'}
          />
          <div className="settings-disclosure-body">
            {form}
            <EngineReference device={settings.device} />
          </div>
        </details>
      )}
      {capability?.available === false && (
        <p className="tools-hint" role="status">
          {capability.message} 请选择可用的引擎或设备，或重新配置组件。
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {!requireComponent && (
        <ComponentSetup compact control={component} disabled={componentDisabled || busy} />
      )}
    </section>
  )
}
