import { Icon } from './Icons'
import './settings-disclosure.css'

/** Native details keeps keyboard and expanded-state semantics. */
export function SettingsDisclosureSummary({
  title,
  description,
  status,
}: {
  title: string
  description?: string
  status?: string
}) {
  return (
    <summary className="settings-disclosure-summary" aria-label={title}>
      <span className="settings-disclosure-chevron" aria-hidden="true">
        <Icon name="chevron" />
      </span>
      <span className="settings-disclosure-heading">
        <span className="settings-disclosure-title">{title}</span>
        {description && <span className="settings-disclosure-description">{description}</span>}
      </span>
      <span className="settings-disclosure-meta" aria-hidden="true">
        {status && <span className="settings-disclosure-status">{status}</span>}
        <span className="settings-disclosure-action">
          <span className="settings-disclosure-expand">展开</span>
          <span className="settings-disclosure-collapse">收起</span>
        </span>
      </span>
    </summary>
  )
}
