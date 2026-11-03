import type { ReactNode } from 'react'
import { BookCover, Icon, type IconName } from './Icons'
import { Popover } from './Popover'
import { Tooltip } from './Tooltip'
import './library-shelf.css'

export function ShelfPagination({
  page,
  pages,
  onPage,
  label,
}: {
  page: number
  pages: number
  onPage: (page: number) => void
  label: string
}) {
  if (pages <= 1) return null
  return (
    <nav className="shelf-pagination" aria-label={label}>
      <Tooltip content="上一页">
        <button
          className="icon-button"
          aria-label={`${label}上一页`}
          disabled={page === 0}
          onClick={() => onPage(page - 1)}
        >
          <Icon name="arrow" />
        </button>
      </Tooltip>
      <span aria-live="polite">
        {page + 1} / {pages}
      </span>
      <Tooltip content="下一页">
        <button
          className="icon-button"
          aria-label={`${label}下一页`}
          disabled={page + 1 >= pages}
          onClick={() => onPage(page + 1)}
        >
          <span className="shelf-pagination-next">
            <Icon name="arrow" />
          </span>
        </button>
      </Tooltip>
    </nav>
  )
}

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
  coverUrl,
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
  coverUrl?: string | null
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
            <BookCover title={title} id={id} coverUrl={coverUrl} />
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
