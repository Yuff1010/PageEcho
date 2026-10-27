import type { ReactNode } from 'react'
import { BookCover, Icon, type IconName } from './Icons'
import { Popover } from './Popover'
import { Tooltip } from './Tooltip'
import './library-shelf.css'

interface ShelfAction {
  label: string
  icon: IconName
  onClick: () => void
  disabled?: boolean
  title?: string
}

/** Both formats share the same cover, metadata slots, actions and menu placement. */
export function ShelfBookCard({
  id,
  title,
  kind,
  metadata,
  source,
  position,
  availability,
  linked = false,
  openLabel,
  onOpen,
  primary,
  secondary,
  children,
}: {
  id: string
  title: string
  kind: 'audio' | 'ebook'
  metadata: string
  source?: { label: string; icon: IconName }
  position: string
  availability: string
  linked?: boolean
  openLabel: string
  onOpen: () => void
  primary: ShelfAction
  secondary?: ShelfAction
  children: ReactNode
}) {
  return (
    <li className="book-card shelf-card" data-book-kind={kind} data-linked={linked}>
      <div className="cover-container">
        <Tooltip content={openLabel}>
          <button className="book-cover-button" aria-label={openLabel} onClick={onOpen}>
            <BookCover title={title} id={id} />
          </button>
        </Tooltip>
        {secondary ? (
          <Tooltip content={`${availability}，${secondary.title ?? secondary.label}`}>
            <button
              className="icon-button shelf-cross-action"
              aria-label={secondary.label}
              disabled={secondary.disabled}
              onClick={secondary.onClick}
            >
              <Icon name={secondary.icon} />
            </button>
          </Tooltip>
        ) : (
          linked && (
            <Tooltip content={availability}>
              <span
                className="shelf-cross-action shelf-link-status"
                role="img"
                tabIndex={0}
                aria-label={availability}
              >
                <Icon name={kind === 'audio' ? 'book' : 'headphones'} />
              </span>
            </Tooltip>
          )
        )}
        <Tooltip content={primary.title ?? primary.label}>
          <button
            className="card-play"
            aria-label={primary.label}
            disabled={primary.disabled}
            onClick={primary.onClick}
          >
            <Icon name={primary.icon} />
          </button>
        </Tooltip>
      </div>
      <div className="file-info">
        <div className="book-title-row">
          <Tooltip content={title}>
            <h3 tabIndex={0}>{title}</h3>
          </Tooltip>
          <Popover label={`更多 ${title} 的操作`} className="book-menu">
            {children}
          </Popover>
        </div>
        <p className="shelf-book-meta">
          <span>{metadata}</span>
          {source && (
            <Tooltip content={source.label}>
              <span className="shelf-book-source" role="img" tabIndex={0} aria-label={source.label}>
                <Icon name={source.icon} />
              </span>
            </Tooltip>
          )}
        </p>
        <Tooltip content={position}>
          <p className="shelf-book-position" tabIndex={0}>
            {position}
          </p>
        </Tooltip>
      </div>
    </li>
  )
}
