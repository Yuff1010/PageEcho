import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Icon, type IconName } from './Icons'
import { Tooltip } from './Tooltip'

export function SourceCenterAction({
  label,
  icon,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: IconName }) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        {...props}
        className={`source-center-action ${className}`}
        aria-label={label}
      >
        <Icon name={icon} />
      </button>
    </Tooltip>
  )
}
export function SourceCenterEmpty({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <div className="source-center-empty">
      <Icon name={icon} />
      <p>{children}</p>
    </div>
  )
}
