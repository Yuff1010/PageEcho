import { useId, useState } from 'react'
import { useAppAppearance, type AppTheme } from './app-appearance'
import { useSystemReducedMotion } from './motion'
import { HelpTip } from './HelpTip'
import {
  colorContrast,
  densityPreset,
  DENSITY_PRESETS,
  PALETTE_KEY,
  readReaderPalettes,
  READER_FONTS,
  READING_THEMES,
  writeReaderPreference,
  type ReaderPalette,
  type ReaderSettings,
} from './reader-settings'

export type SettingsTab = 'layout' | 'appearance' | 'turning'
const tabs = [
  { id: 'layout', label: '排版' },
  { id: 'appearance', label: '外观' },
  { id: 'turning', label: '翻页' },
] as const
function RangeControl({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  change,
  disabled = false,
  help,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit: string
  change: (value: number) => void
  disabled?: boolean
  help?: string
}) {
  const id = useId()
  return (
    <div className="reader-range-setting">
      <div className="reader-setting-caption">
        <label htmlFor={id}>{label}</label>
        {help && <HelpTip label={label}>{help}</HelpTip>}
      </div>
      <input
        id={id}
        type="range"
        aria-label={`电子书${label}`}
        aria-valuetext={`${value} ${unit}`}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => change(Number(event.target.value))}
      />
      <output htmlFor={id}>
        {Number(value.toFixed(2))} {unit}
      </output>
    </div>
  )
}
export function ReaderPreferences({
  settings,
  change,
  scope,
  selectScope,
  reset,
  tab,
  setTab,
  storageError,
  listening = false,
}: {
  settings: ReaderSettings
  change: (patch: Partial<ReaderSettings>) => void
  scope: 'global' | 'book'
  selectScope: (scope: 'global' | 'book') => void
  reset: () => void
  tab: SettingsTab
  setTab: (tab: SettingsTab) => void
  storageError: string
  listening?: boolean
}) {
  const { theme: appTheme, setTheme: setAppTheme } = useAppAppearance()
  const systemReducedMotion = useSystemReducedMotion()
  const [palettes, setPalettes] = useState(readReaderPalettes)
  const [paletteName, setPaletteName] = useState('')
  const [error, setError] = useState('')
  const prefix = useId()
  const savePalettes = (next: ReaderPalette[]) => {
    setPalettes(next)
    setError(writeReaderPreference(PALETTE_KEY, next) ? '' : '个人配色未能保存，请检查本地存储。')
  }
  const density = densityPreset(settings)
  const scrollMode = settings.mode === 'scroll'
  const availableTabs = tabs
  return (
    <div className="reader-preferences-shell">
      <div className="reader-scope-setting">
        <label htmlFor={`${prefix}-scope`}>范围</label>
        <select
          id={`${prefix}-scope`}
          aria-label="阅读设置应用范围"
          value={scope}
          onChange={(event) => selectScope(event.target.value as 'global' | 'book')}
        >
          <option value="global">全局</option>
          <option value="book">本书</option>
        </select>
        <HelpTip label="应用范围">
          {scope === 'book'
            ? '本书调整优先于全局默认；未调整的项目继续跟随全局。'
            : '修改所有书籍的默认值。本书原有专属设置会保留，切回“本书”可恢复。'}
        </HelpTip>
      </div>
      <div
        className="reader-settings-tabs"
        role="tablist"
        aria-label="阅读设置分类"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const index = availableTabs.findIndex((item) => item.id === tab)
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? availableTabs.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + availableTabs.length) %
                  availableTabs.length
          setTab(availableTabs[next]!.id)
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
        }}
      >
        {availableTabs.map((item) => (
          <button
            key={item.id}
            id={`${prefix}-${item.id}`}
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`${prefix}-panel`}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        className="reader-preferences"
        id={`${prefix}-panel`}
        role="tabpanel"
        aria-labelledby={`${prefix}-${tab}`}
      >
        {tab === 'layout' && (
          <>
            <div className="reader-setting-row">
              <label className="reader-select-setting">
                字体
                <select
                  aria-label="电子书字体"
                  value={settings.fontFamily}
                  onChange={(event) => {
                    const fontFamily = event.target.value as ReaderSettings['fontFamily']
                    change({
                      fontFamily,
                      ...(settings.fontWeight === 500 &&
                      (fontFamily === 'serif' || fontFamily === 'kai')
                        ? { fontWeight: 400 as const }
                        : {}),
                    })
                  }}
                >
                  {Object.entries(READER_FONTS).map(([value, font]) => (
                    <option key={value} value={value}>
                      {font.label}
                    </option>
                  ))}
                </select>
              </label>
              <HelpTip label="字体">
                字体不可用时使用系统回退字体。Ctrl + 鼠标滚轮可调整正文字号。
                {listening && '设置同时适用于字幕与小说原文。'}
              </HelpTip>
            </div>
            <label className="reader-select-setting">
              字重
              <select
                aria-label="电子书字重"
                value={settings.fontWeight}
                onChange={(event) =>
                  change({ fontWeight: Number(event.target.value) as ReaderSettings['fontWeight'] })
                }
              >
                <option value="400">常规</option>
                {(settings.fontFamily === 'sans' || settings.fontFamily === 'system') && (
                  <option value="500">中等</option>
                )}
                <option value="700">加粗</option>
              </select>
            </label>
            <RangeControl
              label="字号"
              value={settings.fontSize}
              min={14}
              max={36}
              unit="px"
              change={(fontSize) => change({ fontSize })}
            />
            <div className="reader-density" role="group" aria-label="紧凑程度">
              <div className="reader-density-caption">
                紧凑程度{' '}
                <span>
                  {density === 'custom'
                    ? '自定义'
                    : DENSITY_PRESETS[density as keyof typeof DENSITY_PRESETS].label}
                </span>
              </div>
              <div className="reader-segmented">
                {Object.entries(DENSITY_PRESETS).map(([id, value]) => (
                  <button
                    key={id}
                    aria-pressed={density === id}
                    onClick={() =>
                      change({
                        lineHeight: value.lineHeight,
                        letterSpacing: value.letterSpacing,
                        paragraphSpacing: value.paragraphSpacing,
                      })
                    }
                  >
                    {value.label}
                  </button>
                ))}
              </div>
            </div>
            <RangeControl
              label="行距"
              value={settings.lineHeight}
              min={1.3}
              max={2.4}
              step={0.05}
              unit="倍"
              change={(lineHeight) => change({ lineHeight })}
            />
            <RangeControl
              label="字距"
              value={settings.letterSpacing}
              min={0}
              max={3}
              step={0.1}
              unit="px"
              change={(letterSpacing) => change({ letterSpacing })}
            />
            <RangeControl
              label="段间距"
              value={settings.paragraphSpacing}
              min={0}
              max={1.8}
              step={0.1}
              unit="倍字号"
              change={(paragraphSpacing) => change({ paragraphSpacing })}
            />
            <RangeControl
              label="正文宽度"
              value={settings.contentWidth}
              min={360}
              max={900}
              step={10}
              unit="px"
              change={(contentWidth) => change({ contentWidth })}
            />
            <label className="reader-check-setting">
              <input
                type="checkbox"
                aria-label="首行缩进两个汉字"
                checked={settings.indent}
                onChange={(event) => change({ indent: event.target.checked })}
              />
              首行缩进两个汉字
            </label>
          </>
        )}
        {tab === 'appearance' && (
          <>
            <RangeControl
              label="面板透明度"
              value={settings.panelTransparency}
              min={0}
              max={100}
              unit="%"
              help="0% 为不透明。文字与控件随底色自动调整，菜单保持清晰。"
              change={(panelTransparency) => change({ panelTransparency })}
            />
            <fieldset>
              <legend>阅读配色</legend>
              <div className="reader-theme-options">
                {Object.entries(READING_THEMES).map(([theme, value]) => (
                  <button
                    key={theme}
                    className={`reader-theme-${theme}`}
                    aria-label={`主题：${value.label}`}
                    aria-pressed={settings.theme === theme}
                    onClick={() =>
                      change({
                        theme: theme as keyof typeof READING_THEMES,
                        backgroundColor: value.backgroundColor,
                        textColor: value.textColor,
                      })
                    }
                  >
                    {value.label}
                  </button>
                ))}
              </div>
            </fieldset>
            <details className="reader-advanced-settings">
              <summary>自定义配色</summary>
              <div className="reader-advanced-content">
                <label className="reader-color-setting">
                  阅读背景{' '}
                  <input
                    type="color"
                    aria-label="电子书背景色"
                    value={settings.backgroundColor}
                    onChange={(event) =>
                      change({ theme: 'custom', backgroundColor: event.target.value.toUpperCase() })
                    }
                  />
                  <span>{settings.backgroundColor}</span>
                </label>
                <label className="reader-color-setting">
                  正文文字{' '}
                  <input
                    type="color"
                    aria-label="电子书文字色"
                    value={settings.textColor}
                    onChange={(event) =>
                      change({ theme: 'custom', textColor: event.target.value.toUpperCase() })
                    }
                  />
                  <span>{settings.textColor}</span>
                </label>
              </div>
            </details>
            {colorContrast(settings.backgroundColor, settings.textColor) < 4.5 && (
              <p className="reader-contrast-hint" role="status">
                当前配色对比度较低，长时间阅读可能费力。
              </p>
            )}
            <details className="reader-advanced-settings reader-palettes">
              <summary>个人配色{palettes.length > 0 && <span>{palettes.length} / 8</span>}</summary>
              <div className="reader-advanced-content">
                <div className="reader-save-palette">
                  <input
                    aria-label="个人配色名称"
                    placeholder="配色名称（可选）"
                    maxLength={30}
                    value={paletteName}
                    onChange={(event) => setPaletteName(event.target.value)}
                  />
                  <button
                    className="reader-button"
                    disabled={palettes.length >= 8}
                    onClick={() => {
                      savePalettes([
                        ...palettes,
                        {
                          id: crypto.randomUUID(),
                          name: paletteName.trim() || `配色 ${palettes.length + 1}`,
                          backgroundColor: settings.backgroundColor,
                          textColor: settings.textColor,
                        },
                      ])
                      setPaletteName('')
                    }}
                  >
                    保存配色
                  </button>
                </div>
                {palettes.length >= 8 && (
                  <p className="reader-hint">最多保存 8 组；删除一组后可继续添加。</p>
                )}
                <ul>
                  {palettes.map((item) => (
                    <li key={item.id}>
                      <button
                        className="reader-button"
                        aria-label={`应用配色 ${item.name}`}
                        onClick={() =>
                          change({
                            theme: 'custom',
                            backgroundColor: item.backgroundColor,
                            textColor: item.textColor,
                          })
                        }
                      >
                        {item.name}
                      </button>
                      <button
                        className="reader-button"
                        aria-label={`删除配色 ${item.name}`}
                        onClick={() =>
                          savePalettes(palettes.filter((value) => value.id !== item.id))
                        }
                      >
                        删除
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
            <div className="reader-setting-row">
              <label className="reader-select-setting">
                应用界面
                <select
                  aria-label="应用界面主题"
                  value={appTheme}
                  onChange={(event) =>
                    setError(
                      setAppTheme(event.target.value as AppTheme) ? '' : '应用主题保存失败。',
                    )
                  }
                >
                  <option value="light">浅色</option>
                  <option value="dark">深色</option>
                  <option value="system">跟随系统</option>
                </select>
              </label>
              <HelpTip label="应用界面">
                只改变应用的工具栏、菜单和设置面板，阅读配色独立保留。
              </HelpTip>
            </div>
          </>
        )}
        {tab === 'turning' && (
          <>
            <div className="reader-setting-row">
              <label className="reader-select-setting">
                阅读方式
                <select
                  aria-label="电子书翻页方式"
                  value={settings.mode}
                  onChange={(event) =>
                    change({ mode: event.target.value as ReaderSettings['mode'] })
                  }
                >
                  <option value="pages">分页</option>
                  <option value="scroll">滚动</option>
                </select>
              </label>
              <HelpTip label="阅读方式">
                选择分页或连续滚动，切换时保留当前文字位置。
                {listening && '听书时自动跟随声音；手动翻页或滚动后可回到当前播放位置。'}
              </HelpTip>
            </div>
            <div className="reader-setting-row">
              <label className="reader-select-setting">
                页面布局
                <select
                  aria-label="电子书页面布局"
                  value={settings.pageLayout}
                  disabled={scrollMode}
                  onChange={(event) =>
                    change({ pageLayout: event.target.value as ReaderSettings['pageLayout'] })
                  }
                >
                  <option value="single">单栏</option>
                  <option value="book">双栏</option>
                </select>
              </label>
              <HelpTip label="页面布局">
                {scrollMode
                  ? '页面布局仅用于横向分页；切回分页后恢复。'
                  : settings.pageLayout === 'book'
                    ? '左右两栏融入整页背景，每次翻动整组内容。窄窗口自动显示单栏；翻页动效可单独选择。'
                    : listening
                      ? '用方向键、滚轮、下方按钮或横向手势翻页；点击已映射句子定位声音，拖选文字不改变播放位置。'
                      : '点击阅读区域左半屏返回，右半屏继续；拖选文字时不翻页。'}
              </HelpTip>
            </div>
            <div className="reader-setting-row">
              <label className="reader-check-setting">
                <input
                  type="checkbox"
                  aria-label="平滑滚动"
                  checked={settings.smoothScroll}
                  disabled={!scrollMode}
                  onChange={(event) => change({ smoothScroll: event.target.checked })}
                />
                平滑滚动
              </label>
              <HelpTip label="平滑滚动">
                {scrollMode
                  ? '空格、PageUp / PageDown 按屏平滑移动；滚轮保持系统滚动手感。'
                  : '切换到连续滚动后可使用平滑滚动。'}
              </HelpTip>
            </div>
            <div className="reader-setting-row">
              <label className="reader-select-setting">
                分页动画
                <select
                  aria-label="分页动画"
                  value={settings.pageAnimation}
                  disabled={scrollMode}
                  onChange={(event) =>
                    change({ pageAnimation: event.target.value as ReaderSettings['pageAnimation'] })
                  }
                >
                  <option value="none">无动画</option>
                  <option value="slide">平移</option>
                  <option value="fade">淡入</option>
                  <option value="rise">纵向推进</option>
                  <option value="zoom">轻缩放</option>
                  <option value="flip">纸页翻转</option>
                  <option value="book">仿真翻书</option>
                  <option value="wipe">擦除</option>
                </select>
              </label>
              <HelpTip label="分页动画">
                {scrollMode
                  ? '连续滚动不使用分页动画；已保留动画设置，切回分页后生效。'
                  : '选择翻页时的过渡效果；无动画会立即显示下一页。'}
              </HelpTip>
            </div>
            <RangeControl
              label="动画时长"
              value={settings.animationDuration}
              min={100}
              max={400}
              step={10}
              unit="ms"
              disabled={scrollMode || settings.pageAnimation === 'none'}
              change={(animationDuration) => change({ animationDuration })}
            />
            <div className="reader-setting-row">
              <label className="reader-check-setting">
                <input
                  type="checkbox"
                  aria-label="减少动态效果"
                  checked={settings.reduceMotion}
                  onChange={(event) => change({ reduceMotion: event.target.checked })}
                />
                减少动态效果
              </label>
              <HelpTip label="减少动态效果">
                开启后立即翻页、滚动；也会尊重系统的减少动态效果偏好。
              </HelpTip>
            </div>
            {systemReducedMotion && (
              <p className="reader-hint" role="status">
                系统已开启减少动态效果，分页动画和平滑滚动暂不播放。
              </p>
            )}
          </>
        )}
      </div>
      <div className="reader-settings-reset">
        <button className="reader-button" onClick={reset}>
          {scope === 'book' ? '恢复全局默认' : '恢复初始默认'}
        </button>
      </div>
      {(storageError || error) && (
        <p className="reader-contrast-hint" role="status">
          {storageError || error}
        </p>
      )}
    </div>
  )
}
