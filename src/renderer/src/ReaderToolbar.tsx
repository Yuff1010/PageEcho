import type { CSSProperties, HTMLAttributes, ComponentPropsWithRef } from 'react'
import { useAppAppearance } from './app-appearance'
import './reader-chrome.css'
import './reader-icon-actions.css'
import { Icon, type IconName } from './Icons'
import { Tooltip } from './Tooltip'

/** Shared navigation chrome; text paper keeps its own reading palette. */
export function ReaderToolbar({ className = '', style, ...props }: HTMLAttributes<HTMLElement>) {
  const { resolvedTheme } = useAppAppearance()
  return (
    <header
      {...props}
      className={`reader-toolbar book-reader-toolbar ${className}`}
      data-chrome-theme={resolvedTheme}
      style={{ ...readerChromeVariables(resolvedTheme), ...style } as CSSProperties}
    />
  )
}

export function ReaderFooter({ className = '', style, ...props }: HTMLAttributes<HTMLElement>) {
  const { resolvedTheme } = useAppAppearance()
  return (
    <footer
      {...props}
      className={`book-reader-footer ${className}`}
      style={
        {
          ...readerChromeVariables(resolvedTheme),
          '--reader-text': 'var(--ui-text)',
          '--reader-muted': 'var(--ui-muted)',
          '--reader-surface': 'var(--ui-panel)',
          '--reader-border': 'var(--ui-line)',
          '--reader-field': resolvedTheme === 'light' ? '#F5F8F5' : '#17221C',
          ...style,
        } as CSSProperties
      }
    />
  )
}

export function readerChromeVariables(theme: 'light' | 'dark') {
  return {
    '--ui-panel': theme === 'light' ? '#FFFFFF' : '#1C2822',
    '--ui-text': theme === 'light' ? '#213C31' : '#EEF5EF',
    '--ui-muted': theme === 'light' ? '#54695E' : '#ABBDB2',
    '--ui-line': theme === 'light' ? '#D0DCD3' : '#3B5044',
    '--ui-hover': theme === 'light' ? '#E7EEE8' : '#293E31',
    '--ui-accent': theme === 'light' ? '#17633F' : '#79D9A2',
    '--ui-accent-soft': theme === 'light' ? '#E1EFE4' : '#263F30',
    '--ui-control-line': theme === 'light' ? '#7D9086' : '#718B7B',
    colorScheme: theme,
  }
}

/** One icon action keeps its native button, focus/ref and accessible action name. */
export function ReaderAction({
  label,
  icon,
  tooltip = label,
  className = '',
  ...props
}: Omit<ComponentPropsWithRef<'button'>, 'children' | 'aria-label' | 'title'> & {
  label: string
  icon: IconName
  tooltip?: string
}) {
  return (
    <Tooltip content={tooltip} disabled={props['aria-expanded'] === true}>
      <button
        {...props}
        type={props.type ?? 'button'}
        className={`reader-icon-button reader-action ${className}`}
        aria-label={label}
      >
        <Icon
          name={icon}
          className={
            icon === 'chevron' && className.includes('reader-action-previous')
              ? 'reader-turn-left'
              : ''
          }
        />
      </button>
    </Tooltip>
  )
}
